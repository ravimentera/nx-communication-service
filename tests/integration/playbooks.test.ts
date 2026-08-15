/**
 * The playbook runtime against a real Postgres, with the medspa pack installed
 * from disk.
 *
 * What this proves that the unit tests cannot: the pack's JSON actually
 * installs; a real `APPOINTMENT_REMINDER` produces the same two messages the
 * 17-case switch produced; and a redelivered event does not send twice.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { baselineMigrations } from '../helpers/migrations.js';

import { and, eq } from 'drizzle-orm';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import winston from 'winston';

import { createDb, type Db } from '../../src/db/index.js';
import {
  approvals,
  messages,
  playbookRuns,
  playbooks,
  recipients,
  tenantPacks,
  tenants,
} from '../../src/db/schema.js';
import { ApprovalService } from '../../src/engine/approvals/approval.service.js';
import { PolicyService } from '../../src/engine/approvals/policy.service.js';
import { ComplianceGate } from '../../src/engine/compliance/gate.js';
import { PreferenceService } from '../../src/engine/compliance/preference.service.js';
import { ContentGenerator } from '../../src/engine/content/generator.js';
import { PromptAssembler } from '../../src/engine/content/prompt-assembler.js';
import { Renderer } from '../../src/engine/content/renderer.js';
import { DrizzleTemplateStore } from '../../src/engine/content/store.js';
import { ContextRegistry } from '../../src/engine/context/registry.js';
import { Dispatcher } from '../../src/engine/delivery/dispatcher.js';
import type { NotificationQueue } from '../../src/engine/delivery/notification-queue.js';
import { PlaybookMatcher } from '../../src/engine/playbooks/matcher.js';
import { PlaybookRegistry } from '../../src/engine/playbooks/registry.js';
import { PlaybookRuntime } from '../../src/engine/playbooks/runtime.js';
import type { OutreachTrigger } from '../../src/engine/playbooks/trigger.js';
import { RecipientService } from '../../src/engine/recipients/recipient.service.js';
import { loadPacks } from '../../src/packs/loader.js';
import type { Channel, ChannelRegistry, ChannelType } from '../../src/ports/channel.js';

const logger = winston.createLogger({ silent: true });
const TENANT = 't-pb';
const scope = { tenantId: TENANT };

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createDb>['pool'];
let db: Db;
let runtime: PlaybookRuntime;
let registry: PlaybookRegistry;
let sent: { channel: string; to: string; body: string; messageId: string }[] = [];

const packs = loadPacks(join(process.cwd(), 'packs'), logger);

const channel: Channel = {
  type: 'email',
  capabilities: { subject: true, html: true, attachments: true, supportsDeliveryReceipts: true },
  validate: () => ({ ok: true }),
  send: async () => ({ success: true, dispatched: false }),
};

const channels: ChannelRegistry = {
  register: () => {},
  get: () => channel,
  has: () => true,
  list: () => ['email' as ChannelType],
};

const queue: NotificationQueue = {
  enqueue: async (job) => {
    sent.push({
      channel: job.channel,
      to: job.to.value,
      body: job.rendered.body,
      messageId: job.messageId,
    });
    return { queued: true, jobId: `job-${sent.length}` };
  },
  enqueueMany: async (jobs) => jobs.map(() => ({ queued: true })),
  stats: async () => ({}),
  close: async () => {},
};

async function makeRecipient(contactPoints: { type: string; value: string }[]) {
  const [row] = await db
    .insert(recipients)
    .values({
      tenantId: TENANT,
      externalRef: { system: 'test', id: `r-${Math.random().toString(36).slice(2)}` },
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      contactPoints,
    })
    .returning();
  return row!;
}

const trigger = (over: Partial<OutreachTrigger> = {}): OutreachTrigger => ({
  type: 'event',
  tenantId: TENANT,
  eventType: 'APPOINTMENT_REMINDER',
  payload: {},
  correlationId: `corr-${Math.random().toString(36).slice(2)}`,
  ...over,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  // The 0xxx schema series only — the 9xxx files are the one-shot mentera-core
  // data migration and need a linked source database (migration.test.ts covers them).
  for (const file of baselineMigrations(dir)) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.query(`INSERT INTO tenants (id, name, timezone) VALUES ('${TENANT}','Clinic','UTC')`);
  await client.end();

  const handle = createDb({ url: container.getConnectionUri() }, logger);
  pool = handle.pool;
  db = handle.db;

  const preferences = new PreferenceService({
    db,
    logger,
    defaultTimezone: 'UTC',
    unsubscribeBaseUrl: 'https://example.test/u',
  });
  const policies = new PolicyService({ db, logger, rotation: { next: async () => 0 } });
  const dispatcher = new Dispatcher({
    db,
    registry: channels,
    credentials: {
      resolve: async () => ({ tenantId: TENANT, source: 'env' as const, values: {} }),
    } as never,
    queue,
    logger,
    compliance: new ComplianceGate({
      db,
      logger,
      preferences,
      shadowMode: true,
      unsubscribeUrl: async () => 'https://example.test/u/tok',
    }),
  });

  const renderer = new Renderer({ logger, aliases: packs.aliasMaps() });
  registry = new PlaybookRegistry({ db, logger, packs });

  runtime = new PlaybookRuntime({
    db,
    logger,
    matcher: new PlaybookMatcher({ db, logger }),
    recipients: new RecipientService({ db, logger }),
    context: new ContextRegistry({ installedPacks: async () => ['medspa'] }),
    templates: new DrizzleTemplateStore(db, logger),
    renderer,
    generator: new ContentGenerator({
      llm: {
        generate: async () => {
          throw new Error('no LLM call should happen in this suite');
        },
        generateJson: async () => {
          throw new Error('no LLM call should happen in this suite');
        },
      } as never,
      assembler: new PromptAssembler(renderer),
      logger,
    }),
    approvals: new ApprovalService({ db, logger, policies, dispatcher }),
    policies,
    dispatcher,
    preferences,
    packs,
    packConfig: async () => ({
      emergencyContacts: ['ops@clinic.test', 'director@clinic.test'],
      slackChannels: {
        staffAlerts: '#clinic-staff',
        emergencyAlerts: '#clinic-emergency',
        systemAlerts: '#clinic-system',
      },
    }),
  });
}, 240_000);

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  await pool?.end().catch(() => {});
  await container?.stop();
});

describe('installing the medspa pack', () => {
  it('loads from disk with no validation errors', () => {
    expect(packs.errors()).toEqual([]);
  });

  it('writes playbooks, templates, policies and triggers as rows — and no DDL', async () => {
    const result = await registry.installPack(scope, 'medspa', {
      config: {
        emergencyContacts: ['ops@clinic.test'],
        slackChannels: { staffAlerts: '#staff', emergencyAlerts: '#urgent', systemAlerts: '#sys' },
      },
    });

    expect(result.playbooks).toBeGreaterThanOrEqual(17);
    expect(result.templates).toBeGreaterThan(0);
    expect(result.policies).toBe(2);

    const installed = await db
      .select()
      .from(playbooks)
      .where(eq(playbooks.tenantId, TENANT));
    expect(installed.length).toBe(result.playbooks);
    expect(installed.every((p) => p.packId === 'medspa')).toBe(true);
  });

  it('records the install on tenant_packs', async () => {
    const [row] = await db
      .select()
      .from(tenantPacks)
      .where(and(eq(tenantPacks.tenantId, TENANT), eq(tenantPacks.packId, 'medspa')));
    expect(row?.isActive).toBe(true);
  });

  it('is idempotent, and does not revert a tenant’s edits', async () => {
    const before = await db.select().from(playbooks).where(eq(playbooks.tenantId, TENANT));

    // No config on a re-install: `requiredConfig` is checked against the config
    // the tenant ends up with, not against this call's body, so adding one
    // setting later does not mean resending all of them.
    await registry.installPack(scope, 'medspa');

    const after = await db.select().from(playbooks).where(eq(playbooks.tenantId, TENANT));
    expect(after.length).toBe(before.length);
  });

  it('refuses an install missing the config the manifest requires', async () => {
    // `requiredConfig` has been in the schema and the manifest since P7 with
    // nothing reading it, so this install used to succeed — and the first sign
    // of trouble was an emergency notification producing a SKIPPED run at 3am,
    // which is the failure docs/PACKS.md says the mechanism exists to prevent.
    const fresh = { tenantId: 'tenant-unconfigured' };
    await db.insert(tenants).values({ id: fresh.tenantId, name: 'Unconfigured' });

    await expect(registry.installPack(fresh, 'medspa')).rejects.toThrow(
      /requires configuration that was not supplied/,
    );

    // And nothing was half-installed.
    const rows = await db
      .select()
      .from(tenantPacks)
      .where(eq(tenantPacks.tenantId, fresh.tenantId));
    expect(rows).toHaveLength(0);
  });

  it('names every missing key, not just the first', async () => {
    const fresh = { tenantId: 'tenant-partial' };
    await db.insert(tenants).values({ id: fresh.tenantId, name: 'Partial' });

    await expect(
      registry.installPack(fresh, 'medspa', {
        config: { emergencyContacts: ['ops@clinic.test'] },
      }),
    ).rejects.toThrow(/slackChannels.staffAlerts.*slackChannels.systemAlerts/);
  });

  it('merges config instead of replacing it', async () => {
    // Before P12 this assigned the new object wholesale, so an operator setting
    // one channel dropped `emergencyContacts` and the other two — and the
    // playbooks that reference them began producing SKIPPED runs. See D95.
    await registry.installPack(scope, 'medspa', {
      config: { slackChannels: { staffAlerts: '#staff-v2' } },
    });

    const [row] = await db
      .select({ config: tenantPacks.config })
      .from(tenantPacks)
      .where(and(eq(tenantPacks.tenantId, TENANT), eq(tenantPacks.packId, 'medspa')));

    expect(row?.config).toEqual({
      emergencyContacts: ['ops@clinic.test'],
      slackChannels: {
        staffAlerts: '#staff-v2',
        // Deep, not shallow: these two live one level down and a shallow merge
        // would have dropped them.
        emergencyAlerts: '#urgent',
        systemAlerts: '#sys',
      },
    });
  });

  it('replaces an array rather than concatenating it', async () => {
    // `emergencyContacts` is a list of who to wake up; a shorter list means
    // shorten it, not "add these too".
    await registry.installPack(scope, 'medspa', {
      config: { emergencyContacts: ['oncall@clinic.test'] },
    });

    const [row] = await db
      .select({ config: tenantPacks.config })
      .from(tenantPacks)
      .where(and(eq(tenantPacks.tenantId, TENANT), eq(tenantPacks.packId, 'medspa')));

    expect((row?.config as { emergencyContacts: string[] }).emergencyContacts).toEqual([
      'oncall@clinic.test',
    ]);
  });
});

describe('an APPOINTMENT_REMINDER, end to end', () => {
  it('produces the same two channels the switch produced', async () => {
    const recipient = await makeRecipient([
      { type: 'email', value: 'ada@example.test' },
      { type: 'sms', value: '+15551234567' },
    ]);

    const results = await runtime.run(
      trigger({
        recipientId: recipient.id,
        payload: {
          context: { appointmentDate: 'Tuesday 9 March', doctorName: 'Dr Byron' },
        },
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ playbookKey: 'medspa.appointment-reminder', status: 'QUEUED' });

    // Two dispatches, exactly as enhanced-event-handler.ts:126 and :145.
    expect(sent.map((s) => s.channel).sort()).toEqual(['email', 'sms']);
    expect(sent.find((s) => s.channel === 'email')!.to).toBe('ada@example.test');
    expect(sent.find((s) => s.channel === 'sms')!.to).toBe('+15551234567');
  });

  it('renders the context into both bodies, and the SMS is the shorter one', async () => {
    const recipient = await makeRecipient([
      { type: 'email', value: 'ada@example.test' },
      { type: 'sms', value: '+15551234567' },
    ]);

    await runtime.run(
      trigger({
        recipientId: recipient.id,
        payload: { context: { appointmentDate: 'Tuesday', doctorName: 'Dr Byron' } },
      }),
    );

    for (const message of sent) {
      expect(message.body).toContain('Tuesday');
      expect(message.body).toContain('Dr Byron');
    }
    const email = sent.find((s) => s.channel === 'email')!;
    const sms = sent.find((s) => s.channel === 'sms')!;
    expect(sms.body.length).toBeLessThan(email.body.length);
  });

  it('honours the caller’s channel choice, as every switch case did', async () => {
    const recipient = await makeRecipient([
      { type: 'email', value: 'ada@example.test' },
      { type: 'sms', value: '+15551234567' },
    ]);

    await runtime.run(
      trigger({
        recipientId: recipient.id,
        channels: ['sms'],
        payload: { context: { appointmentDate: 'Tuesday', doctorName: 'Dr Byron' } },
      }),
    );

    expect(sent.map((s) => s.channel)).toEqual(['sms']);
  });

  it('skips a channel the recipient cannot receive', async () => {
    const recipient = await makeRecipient([{ type: 'email', value: 'ada@example.test' }]);

    await runtime.run(
      trigger({
        recipientId: recipient.id,
        payload: { context: { appointmentDate: 'Tuesday', doctorName: 'Dr Byron' } },
      }),
    );

    expect(sent.map((s) => s.channel)).toEqual(['email']);
  });

  it('sends immediately — no approval, exactly as today (D53)', async () => {
    const recipient = await makeRecipient([{ type: 'email', value: 'ada@example.test' }]);

    await runtime.run(
      trigger({
        recipientId: recipient.id,
        payload: { context: { appointmentDate: 'Tuesday', doctorName: 'Dr Byron' } },
      }),
    );

    expect(sent).toHaveLength(1);
    const opened = await db.select().from(approvals).where(eq(approvals.tenantId, TENANT));
    expect(opened).toHaveLength(0);
  });
});

describe('the data contract', () => {
  it('fails the run before any send when a required field is missing', async () => {
    const recipient = await makeRecipient([{ type: 'email', value: 'ada@example.test' }]);

    const results = await runtime.run(
      trigger({
        recipientId: recipient.id,
        payload: { context: { doctorName: 'Dr Byron' } }, // no appointmentDate
      }),
    );

    expect(results[0]).toMatchObject({ status: 'FAILED' });
    expect(results[0]!.contractErrors).toEqual(["missing required field 'appointmentDate'"]);
    expect(sent).toHaveLength(0);
  });

  it('applies a declared default rather than failing', async () => {
    // doctorName defaults to 'your provider' — the ported form of the source's
    // defensive `data.x || '...'` reads.
    const recipient = await makeRecipient([{ type: 'email', value: 'ada@example.test' }]);

    await runtime.run(
      trigger({
        recipientId: recipient.id,
        payload: { context: { appointmentDate: 'Tuesday' } },
      }),
    );

    expect(sent[0]!.body).toContain('your provider');
  });
});

describe('idempotency', () => {
  it('a redelivered event does not send twice', async () => {
    const recipient = await makeRecipient([{ type: 'email', value: 'ada@example.test' }]);
    const key = `evt-${Math.random().toString(36).slice(2)}`;
    const input = trigger({
      recipientId: recipient.id,
      idempotencyKey: key,
      payload: { context: { appointmentDate: 'Tuesday', doctorName: 'Dr Byron' } },
    });

    const first = await runtime.run(input);
    const second = await runtime.run({ ...input, correlationId: 'corr-retry' });

    expect(first[0]!.status).toBe('QUEUED');
    expect(second[0]).toMatchObject({ status: 'SKIPPED', reason: expect.stringMatching(/already ran/) });
    expect(sent).toHaveLength(1);
  });
});

describe('run bookkeeping', () => {
  it('records every run, which the source could not do at all', async () => {
    const recipient = await makeRecipient([{ type: 'email', value: 'ada@example.test' }]);
    const correlationId = `corr-book-${Math.random().toString(36).slice(2)}`;

    await runtime.run(
      trigger({
        recipientId: recipient.id,
        correlationId,
        payload: { context: { appointmentDate: 'Tuesday', doctorName: 'Dr Byron' } },
      }),
    );

    const [run] = await db
      .select()
      .from(playbookRuns)
      .where(eq(playbookRuns.correlationId, correlationId));

    expect(run).toMatchObject({ status: 'QUEUED', tenantId: TENANT });
    expect(run!.messageIds).toHaveLength(1);
    expect(run!.finishedAt).not.toBeNull();
  });

  it('records an unmatched event instead of dropping it silently', async () => {
    // The source logs `Unknown event type` and returns false; 27 of its 44 enum
    // values reach exactly that branch.
    const results = await runtime.run(trigger({ eventType: 'NOTHING_HANDLES_THIS' }));
    expect(results).toEqual([]);
  });
});

describe('fixed targets come from tenant config', () => {
  it('resolves $config.emergencyContacts to every configured address', async () => {
    const results = await runtime.run(
      trigger({
        eventType: 'EMERGENCY_NOTIFICATION',
        channels: ['email'],
        payload: { context: { message: 'Water leak in treatment room 2', affectedAreas: ['Room 2'] } },
      }),
    );

    expect(results[0]).toMatchObject({ playbookKey: 'medspa.emergency-notification' });

    // Two email addresses configured ⇒ two messages, plus the Slack alert —
    // which fires even though the caller asked for email only, because the
    // source posts it unconditionally (:533). Every destination comes from the
    // tenant's config; not one literal from the source survives.
    expect(sent.map((s) => s.to).sort()).toEqual([
      '#clinic-emergency',
      'director@clinic.test',
      'ops@clinic.test',
    ]);
    expect(sent.some((s) => s.to.includes('medspa.com'))).toBe(false);
  });

  it('skips a fixed-target channel the tenant has not configured, loudly', async () => {
    // Silently sending an emergency alert nowhere is the worst available
    // outcome; the run reports SKIPPED and the log names the missing key.
    const bare = new PlaybookRuntime({
      ...(runtime as unknown as { deps: ConstructorParameters<typeof PlaybookRuntime>[0] }).deps,
      packConfig: async () => ({}),
    });

    const results = await bare.run(
      trigger({
        eventType: 'EMERGENCY_NOTIFICATION',
        idempotencyKey: `unconfigured-${Math.random()}`,
        payload: { context: { message: 'Nowhere to send this' } },
      }),
    );

    expect(results[0]!.status).toBe('SKIPPED');
    expect(sent).toHaveLength(0);
  });
});

describe('a staff-directed playbook', () => {
  it('sends with no recipient at all', async () => {
    // The case that requires messages.recipient_id to be nullable.
    const results = await runtime.run(
      trigger({
        eventType: 'STAFF_ALERT',
        channels: ['email'],
        payload: { context: { message: 'Autoclave needs servicing', urgency: 'HIGH' } },
      }),
    );

    expect(results[0]!.status).toBe('SKIPPED');
    // No contact point and no fixed target on the email entry — the alert has
    // nowhere to go, and the run says so rather than failing silently.
    expect(results[0]!.reason).toMatch(/no channel in the plan/);
  });
});

describe('tenant isolation', () => {
  it('a tenant without the pack matches nothing', async () => {
    const results = await runtime.run(trigger({ tenantId: 't-other' }));
    expect(results).toEqual([]);

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.tenantId, 't-other'));
    expect(rows).toHaveLength(0);
  });
});
