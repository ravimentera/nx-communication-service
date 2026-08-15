/**
 * The deferral sweeper, end to end against a real database.
 *
 * The thing under test is not "does it re-send" — it is the set of rules that
 * decide WHETHER to re-send, each of which exists because the obvious
 * implementation gets it wrong:
 *
 *   - it must re-run the compliance gate, not re-enqueue, or somebody who
 *     unsubscribed during their own quiet hours receives the message that was
 *     waiting for them;
 *   - it must adopt the existing row, or one logical message becomes two and
 *     every count in the system reads a retry as a second send;
 *   - it must give up, or an appointment reminder arrives two days late.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import winston from 'winston';

import { createDb } from '../../src/platform/db/client.js';
import { messages } from '../../src/db/schema.js';
import { Dispatcher } from '../../src/engine/delivery/dispatcher.js';
import { DeferralSweeper } from '../../src/engine/delivery/deferral.worker.js';

const TENANT = 'tenant-deferral';
const logger = winston.createLogger({ silent: true, transports: [new winston.transports.Console()] });

let container: StartedPostgreSqlContainer;
let pool: Awaited<ReturnType<typeof createDb>>['pool'];
let db: Awaited<ReturnType<typeof createDb>>['db'];

/** What the gate will say next, and what the queue was asked to send. */
let verdict: any = { allow: true };
let enqueued: Array<{ messageId: string }> = [];

function dispatcher(): Dispatcher {
  return new Dispatcher({
    db,
    logger,
    registry: {
      get: () => ({
        validate: () => ({ ok: true }),
        capabilities: { html: true },
      }),
    } as never,
    credentials: { resolve: async () => ({ source: 'env', credentials: {} }) } as never,
    queue: {
      enqueue: async (job: any) => {
        enqueued.push({ messageId: job.messageId });
        return { queued: true, jobId: `job-${enqueued.length}` };
      },
    } as never,
    compliance: { check: async () => verdict } as never,
  } as never);
}

/** Insert a message already deferred, as the dispatcher would have written it. */
async function deferredRow(over: Record<string, unknown> = {}, deferral: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(messages)
    .values({
      tenantId: TENANT,
      channel: 'email',
      direction: 'outbound',
      content: 'Your appointment is tomorrow',
      status: 'SUPPRESSED',
      suppressionReason: 'QUIET_HOURS',
      // An hour ago: due.
      deferredUntil: new Date(Date.now() - 3_600_000),
      metadata: {
        correlationId: 'corr-1',
        subject: 'Reminder',
        to: 'ada@example.test',
        deferrable: true,
        retryAt: new Date(Date.now() - 3_600_000).toISOString(),
        deferral: {
          attempts: 1,
          firstDeferredAt: new Date(Date.now() - 3_600_000).toISOString(),
          toType: 'email',
          priority: 'MEDIUM',
          ...deferral,
        },
        ...(over.metadata as object),
      },
      ...over,
    } as never)
    .returning({ id: messages.id });
  return row!.id;
}

async function readRow(id: string) {
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  return row!;
}

function sweeper(over: Record<string, unknown> = {}) {
  return new DeferralSweeper({ db, logger, dispatcher: dispatcher(), ...over });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  for (const f of readdirSync(dir).filter((f) => /^0\d{3}_.*\.sql$/.test(f)).sort()) {
    await client.query(readFileSync(join(dir, f), 'utf8'));
  }
  await client.query(`INSERT INTO tenants (id, name, timezone) VALUES ('${TENANT}','Defer','UTC')`);
  await client.end();

  const handle = createDb({ url: container.getConnectionUri() }, logger);
  pool = handle.pool;
  db = handle.db;
}, 240_000);

beforeEach(async () => {
  enqueued = [];
  verdict = { allow: true };
  await db.delete(messages).where(eq(messages.tenantId, TENANT));
});

afterAll(async () => {
  await pool?.end().catch(() => {});
  await container?.stop();
});

describe('a message whose window has opened', () => {
  it('is re-dispatched and queued', async () => {
    const id = await deferredRow();
    const report = await sweeper().sweep();

    expect(report).toMatchObject({ scanned: 1, sent: 1, deferred: 0, exhausted: 0, failed: 0 });
    expect(enqueued).toEqual([{ messageId: id }]);
  });

  it('adopts the existing row rather than inserting a second', async () => {
    await deferredRow();
    await sweeper().sweep();

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.tenantId, TENANT));
    // One logical message, one row. A second row here would double-count the
    // send in every list, rate-limit window and retention sweep.
    expect(n).toBe(1);
  });

  it('clears the suppression so the row no longer reads as held', async () => {
    const id = await deferredRow();
    await sweeper().sweep();

    const row = await readRow(id);
    expect(row.status).toBe('QUEUED');
  });

  it('carries the subject and html across, which the row alone does not hold', async () => {
    // `content` is the body; everything else a channel needs was written into
    // metadata at deferral time precisely so this retry can rebuild it.
    await deferredRow({}, { html: '<p>Your appointment is tomorrow</p>' });
    let seen: any;
    const d = dispatcher();
    const original = d.dispatch.bind(d);
    d.dispatch = async (msg: any) => {
      seen = msg;
      return original(msg);
    };
    await new DeferralSweeper({ db, logger, dispatcher: d }).sweep();

    expect(seen.rendered).toMatchObject({
      body: 'Your appointment is tomorrow',
      subject: 'Reminder',
      html: '<p>Your appointment is tomorrow</p>',
    });
    expect(seen.to).toEqual({ type: 'email', value: 'ada@example.test' });
  });
});

describe('a message that is still blocked', () => {
  it('defers again rather than sending, and does not queue anything', async () => {
    verdict = {
      allow: false,
      reason: 'QUIET_HOURS',
      deferrable: true,
      retryAt: new Date(Date.now() + 3_600_000),
    };
    await deferredRow();

    const report = await sweeper().sweep();
    expect(report).toMatchObject({ sent: 0, deferred: 1 });
    expect(enqueued).toEqual([]);
  });

  it('counts the attempt, so repeated refusals eventually exhaust it', async () => {
    verdict = {
      allow: false,
      reason: 'QUIET_HOURS',
      deferrable: true,
      retryAt: new Date(Date.now() + 3_600_000),
    };
    const id = await deferredRow();
    await sweeper().sweep();

    const row = await readRow(id);
    expect((row.metadata as any).deferral.attempts).toBe(2);
  });
});

describe('a recipient who opted out while the message waited', () => {
  it('is not sent, and the message stops being retried', async () => {
    // The whole reason this goes back through the gate instead of the queue.
    verdict = { allow: false, reason: 'RECIPIENT_UNSUBSCRIBED', deferrable: false };
    const id = await deferredRow();

    const report = await sweeper().sweep();

    expect(enqueued).toEqual([]);
    expect(report).toMatchObject({ sent: 0, exhausted: 1 });
    const row = await readRow(id);
    expect((row.metadata as any).deferralExhausted).toBe(true);
    expect((row.metadata as any).deferralExhaustedReason).toMatch(/no longer sendable/);
  });
});

describe('giving up', () => {
  it('stops after maxAttempts', async () => {
    const id = await deferredRow({}, { attempts: 5 });
    const report = await sweeper({ maxAttempts: 5 }).sweep();

    expect(report).toMatchObject({ exhausted: 1, sent: 0 });
    expect(enqueued).toEqual([]);
    expect((await readRow(id)).metadata).toMatchObject({ deferralExhausted: true });
  });

  it('stops once the message is too old, however few attempts it has had', async () => {
    // An appointment reminder delivered two days late is worse than one never
    // delivered — the age bound is the one that matters.
    const id = await deferredRow(
      {},
      { attempts: 1, firstDeferredAt: new Date(Date.now() - 48 * 3_600_000).toISOString() },
    );
    const report = await sweeper({ maxAgeMs: 24 * 3_600_000 }).sweep();

    expect(report).toMatchObject({ exhausted: 1, sent: 0 });
    expect((await readRow(id)).metadata).toMatchObject({
      deferralExhausted: true,
      deferralExhaustedReason: expect.stringMatching(/48h after first deferral/),
    });
  });

  it('retires a row deferred before this feature existed, instead of guessing an address', async () => {
    const [row] = await db
      .insert(messages)
      .values({
        tenantId: TENANT,
        channel: 'email',
        direction: 'outbound',
        content: 'old',
        status: 'SUPPRESSED',
        suppressionReason: 'QUIET_HOURS',
        deferredUntil: new Date(Date.now() - 1000),
        // What P5 wrote: deferrable and a retryAt, and nothing to re-send with.
        metadata: { deferrable: true, retryAt: new Date(Date.now() - 1000).toISOString() },
      } as never)
      .returning({ id: messages.id });

    const report = await sweeper().sweep();
    expect(report).toMatchObject({ exhausted: 1 });
    expect((await readRow(row!.id)).metadata).toMatchObject({
      deferralExhaustedReason: 'no recipient address recorded on the deferred row',
    });
  });

  it('does not pick an exhausted message up again', async () => {
    await deferredRow({}, { attempts: 9 });
    await sweeper({ maxAttempts: 5 }).sweep();

    const second = await sweeper({ maxAttempts: 5 }).sweep();
    expect(second.scanned).toBe(0);
  });
});

describe('what the sweep does not touch', () => {
  it('leaves a message whose retryAt has not arrived', async () => {
    await deferredRow({ deferredUntil: new Date(Date.now() + 3_600_000) });
    expect((await sweeper().sweep()).scanned).toBe(0);
  });

  it('leaves a hard suppression alone', async () => {
    // Unsubscribed is not deferrable: there is no window in which it becomes
    // sendable, and retrying it would be a compliance failure.
    await db.insert(messages).values({
      tenantId: TENANT,
      channel: 'email',
      direction: 'outbound',
      content: 'nope',
      status: 'SUPPRESSED',
      suppressionReason: 'RECIPIENT_UNSUBSCRIBED',
      // No deferredUntil: there is no window in which this becomes sendable.
      metadata: { deferrable: false, to: 'ada@example.test' },
    } as never);

    expect((await sweeper().sweep()).scanned).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it('leaves a message that was actually sent', async () => {
    await db.insert(messages).values({
      tenantId: TENANT,
      channel: 'email',
      direction: 'outbound',
      content: 'sent',
      status: 'SENT',
      deferredUntil: new Date(Date.now() - 1000),
      metadata: { deferrable: true },
    } as never);

    expect((await sweeper().sweep()).scanned).toBe(0);
  });
});

describe('the index this query depends on', () => {
  it('exists, partial, on the column the sweeper orders by', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename='messages' AND indexname='idx_messages_awaiting_retry'`,
    );
    expect(rows).toHaveLength(1);
    // Partial: sized by the backlog rather than by `messages`, which is the
    // largest table in the service and full of long-dead SUPPRESSED rows.
    expect(rows[0].indexdef).toMatch(/WHERE .*status = 'SUPPRESSED'/);
    expect(rows[0].indexdef).toMatch(/deferred_until IS NOT NULL/);
  });
});
