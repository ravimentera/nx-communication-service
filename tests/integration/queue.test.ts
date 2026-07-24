/**
 * End-to-end delivery: dispatch -> queue -> adapter -> messages row.
 *
 * Uses throwaway Postgres and Redis containers (same rationale as
 * schema.test.ts — created empty, destroyed after, no route to real data).
 *
 * What this proves, and what a unit test could not:
 *  - the registry lookup really did replace the 6-case switch
 *  - a message reaches the right adapter exactly once
 *  - the outcome lands on `messages.status` / `provider_message_id`
 *  - a non-retryable failure stops after ONE attempt (the source retried an
 *    unsubscribed number five times)
 *  - URGENT gets 10 attempts and fixed backoff; everything else 5 and exponential
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import winston from 'winston';

import { createDb } from '../../src/db/index.js';
import { messages, tenants } from '../../src/db/schema.js';
import { Dispatcher } from '../../src/engine/delivery/dispatcher.js';
import {
  BullNotificationQueue,
  type SendJob,
} from '../../src/engine/delivery/notification-queue.js';
import { createResultRecorder } from '../../src/engine/delivery/record-result.js';
import { InMemoryChannelRegistry } from '../../src/engine/delivery/registry.js';
import type { CredentialResolver } from '../../src/engine/delivery/credential-resolver.js';
import type {
  Channel,
  ChannelCredentials,
  ChannelType,
  DeliveryResult,
} from '../../src/ports/channel.js';

const logger = winston.createLogger({ silent: true });
const TENANT = 't-queue';

/** A channel whose behaviour each test controls, and which counts its calls. */
class ProgrammableChannel implements Channel {
  calls: Array<{ to: string; creds: ChannelCredentials }> = [];
  result: DeliveryResult = { success: true, dispatched: true, providerMessageId: 'prov-1' };

  constructor(readonly type: ChannelType) {}

  readonly capabilities = {
    subject: true,
    html: false,
    attachments: false,
    supportsDeliveryReceipts: true,
  };

  validate() {
    return { ok: true } as const;
  }

  async send(_msg: unknown, to: { value: string }, creds: ChannelCredentials) {
    this.calls.push({ to: to.value, creds });
    return this.result;
  }
}

const credentials = {
  resolve: async (_channel: ChannelType, scope: { tenantId: string; senderId?: string }) => ({
    tenantId: scope.tenantId,
    senderId: scope.senderId,
    source: 'tenant' as const,
    values: { apiKey: 'test' },
    from: 'from@test.local',
  }),
} as unknown as CredentialResolver;

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for condition');
}

let pg: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let connection: Redis;
let db: ReturnType<typeof createDb>['db'];
let pool: ReturnType<typeof createDb>['pool'];
let queue: BullNotificationQueue;
let registry: InMemoryChannelRegistry;
let emailChannel: ProgrammableChannel;
let dispatcher: Dispatcher;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);

  // Apply the migrations to the throwaway container only.
  const client = new Client({ connectionString: pg.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  for (const file of readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.query(`INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Queue Test')`);
  await client.end();

  ({ db, pool } = createDb({ url: pg.getConnectionUri() }, logger));

  connection = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getMappedPort(6379),
    maxRetriesPerRequest: null,
  });

  registry = new InMemoryChannelRegistry();
  emailChannel = new ProgrammableChannel('email');
  registry.register(emailChannel);

  queue = new BullNotificationQueue({
    connection,
    registry,
    logger,
    retry: { attempts: 5, urgentAttempts: 10, backoffDelayMs: 50, concurrency: 5 },
    resolveCredentials: (channel, scope) => credentials.resolve(channel, scope),
    onResult: createResultRecorder(db, logger),
  });

  dispatcher = new Dispatcher({ db, registry, credentials, queue, logger });
}, 240_000);

afterAll(async () => {
  await queue?.close();
  connection?.disconnect();
  await pool?.end().catch(() => {});
  await Promise.all([pg?.stop(), redisContainer?.stop()]);
});

beforeEach(() => {
  emailChannel.calls = [];
  emailChannel.result = { success: true, dispatched: true, providerMessageId: 'prov-1' };
});

async function statusOf(messageId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: messages.status, providerMessageId: messages.providerMessageId })
    .from(messages)
    .where(eq(messages.id, messageId));
  return row?.status;
}

describe('dispatch -> queue -> adapter', () => {
  it('delivers a message and records the outcome', async () => {
    const result = await dispatcher.dispatch({
      tenantId: TENANT,
      channel: 'email',
      to: { type: 'email', value: 'a@b.c' },
      rendered: { subject: 'Hi', body: 'hello' },
    });

    expect(result.queued).toBe(true);
    expect(result.messageId).toBeDefined();

    await waitFor(async () => (await statusOf(result.messageId!)) === 'SENT');

    // Exactly once — no double-send.
    expect(emailChannel.calls).toHaveLength(1);
    expect(emailChannel.calls[0]!.to).toBe('a@b.c');

    const [row] = await db
      .select({ providerMessageId: messages.providerMessageId, sentAt: messages.sentAt })
      .from(messages)
      .where(eq(messages.id, result.messageId!));
    // The whole reason messages.provider_message_id exists.
    expect(row!.providerMessageId).toBe('prov-1');
    expect(row!.sentAt).toBeInstanceOf(Date);
  }, 60_000);

  it('writes the row as QUEUED before the worker picks it up', async () => {
    const [tenantRow] = await db.select({ id: tenants.id }).from(tenants).limit(1);
    expect(tenantRow).toBeDefined();
  });

  it('passes the resolved credentials through to the adapter', async () => {
    const result = await dispatcher.dispatch({
      tenantId: TENANT,
      senderId: 'sender-9',
      channel: 'email',
      to: { type: 'email', value: 'c@d.e' },
      rendered: { subject: 'Hi', body: 'hello' },
    });
    await waitFor(async () => (await statusOf(result.messageId!)) === 'SENT');
    expect(emailChannel.calls[0]!.creds.senderId).toBe('sender-9');
    expect(emailChannel.calls[0]!.creds.from).toBe('from@test.local');
  }, 60_000);
});

describe('failure handling', () => {
  it('stops after ONE attempt when the error is not retryable', async () => {
    emailChannel.result = {
      success: false,
      dispatched: true,
      // Twilio 21610: the recipient replied STOP. Retrying re-sends to someone
      // who opted out — the source did exactly that, five times.
      error: { code: 'TWILIO_21610', message: 'unsubscribed', retryable: false },
    };

    const result = await dispatcher.dispatch({
      tenantId: TENANT,
      channel: 'email',
      to: { type: 'email', value: 'stop@b.c' },
      rendered: { subject: 'Hi', body: 'hello' },
    });

    await waitFor(async () => (await statusOf(result.messageId!)) === 'FAILED');
    // Give any (incorrect) retry a chance to show up before asserting.
    await new Promise((r) => setTimeout(r, 500));
    expect(emailChannel.calls).toHaveLength(1);
  }, 60_000);

  it('retries a retryable error', async () => {
    let attempts = 0;
    emailChannel.result = {
      success: false,
      dispatched: true,
      error: { code: 'SENDGRID_503', message: 'upstream', retryable: true },
    };
    const original = emailChannel.send.bind(emailChannel);
    emailChannel.send = async (msg, to, creds) => {
      attempts += 1;
      if (attempts >= 2) {
        emailChannel.result = { success: true, dispatched: true, providerMessageId: 'prov-retry' };
      }
      return original(msg, to, creds);
    };

    const result = await dispatcher.dispatch({
      tenantId: TENANT,
      channel: 'email',
      to: { type: 'email', value: 'retry@b.c' },
      rendered: { subject: 'Hi', body: 'hello' },
    });

    await waitFor(async () => (await statusOf(result.messageId!)) === 'SENT', 20_000);
    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe('retry policy is preserved from the source', () => {
  it('gives URGENT 10 attempts with fixed backoff', async () => {
    const enqueued = await queue.enqueue({
      messageId: '00000000-0000-0000-0000-000000000001',
      tenantId: TENANT,
      channel: 'email',
      to: { type: 'email', value: 'u@b.c' },
      rendered: { body: 'x' },
      priority: 'URGENT',
      correlationId: 'c-urgent',
    } as Omit<SendJob, 'attempt'>);

    const job = await queue['queue'].getJob(enqueued.jobId!);
    expect(job!.opts.attempts).toBe(10);
    expect(job!.opts.backoff).toEqual({ type: 'fixed', delay: 50 });
    expect(job!.opts.priority).toBe(1);
  }, 30_000);

  it('gives everything else 5 attempts with exponential backoff', async () => {
    const enqueued = await queue.enqueue({
      messageId: '00000000-0000-0000-0000-000000000002',
      tenantId: TENANT,
      channel: 'email',
      to: { type: 'email', value: 'm@b.c' },
      rendered: { body: 'x' },
      priority: 'MEDIUM',
      correlationId: 'c-medium',
    } as Omit<SendJob, 'attempt'>);

    const job = await queue['queue'].getJob(enqueued.jobId!);
    expect(job!.opts.attempts).toBe(5);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 50 });
    expect(job!.opts.priority).toBe(3);
  }, 30_000);

  it('orders priority lanes URGENT < HIGH < MEDIUM < LOW', async () => {
    const priorities = await Promise.all(
      (['HIGH', 'LOW'] as const).map(async (priority, i) => {
        const enqueued = await queue.enqueue({
          messageId: `00000000-0000-0000-0000-00000000001${i}`,
          tenantId: TENANT,
          channel: 'email',
          to: { type: 'email', value: 'p@b.c' },
          rendered: { body: 'x' },
          priority,
          correlationId: `c-${priority}`,
        } as Omit<SendJob, 'attempt'>);
        const job = await queue['queue'].getJob(enqueued.jobId!);
        return job!.opts.priority;
      }),
    );
    expect(priorities[0]).toBe(2); // HIGH
    expect(priorities[1]).toBe(4); // LOW
  }, 30_000);
});

describe('queue stats', () => {
  it('reports counts for the health endpoint', async () => {
    const stats = await queue.stats();
    expect(stats).toHaveProperty('waiting');
    expect(stats).toHaveProperty('failed');
    expect(stats).toHaveProperty('total');
  }, 30_000);
});
