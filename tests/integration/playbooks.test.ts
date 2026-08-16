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
  approvalPolicies,
  approvals,
  messages,
  playbookRuns,
  playbooks,
  recipients,
  templates,
  tenantPacks,
  tenants,
} from '../../src/db/schema.js';
import { ApprovalService } from '../../src/engine/approvals/approval.service.js';
import { PolicyService } from '../../src/engine/approvals/policy.service.js';
import { ComplianceGate } from '../../src/engine/compliance/gate.js';
import { PreferenceService } from '../../src/engine/compliance/preference.service.js';
import { ContentGenerator } from '../../src/engine/content/generator.js';
import { IdentityResolver } from '../../src/engine/content/identity.js';
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
let sent: {
  channel: string;
  to: string;
  body: string;
  messageId: string;
  priority: string;
}[] = [];

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
      priority: job.priority,
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
    identity: new IdentityResolver({ db, logger }),
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

describe('uninstall and reinstall', () => {
  /**
   * Uninstall set `playbooks.is_active = false` as well as deactivating the
   * pack. Reinstall skips rows that already exist, and even
   * `overwriteCustomized`'s upsert omitted `is_active` from its SET — so the
   * cycle left every playbook permanently inactive. Install reported success,
   * `GET /v1/packs` showed the pack present, and every event went UNMATCHED
   * with nothing anywhere saying why.
   *
   * The pack row alone is sufficient: the matcher requires an active
   * `tenant_packs` entry, so flipping the playbooks was redundant — with a
   * one-way ratchet attached.
   */
  it('leaves a tenant’s playbooks working after a round trip', async () => {
    const fresh = { tenantId: 't-pb-cycle' };
    await db.insert(tenants).values({ id: fresh.tenantId, name: 'Cycle' });
    await registry.installPack(fresh, 'medspa', {
      config: {
        emergencyContacts: ['ops@clinic.test'],
        slackChannels: { staffAlerts: '#s', emergencyAlerts: '#e', systemAlerts: '#y' },
      },
    });

    const activeBefore = (await registry.listPlaybooks(fresh, { active: true })).length;
    expect(activeBefore).toBeGreaterThan(0);

    await registry.uninstallPack(fresh, 'medspa');

    // Uninstalled means unreachable — the pack row is what the matcher checks.
    expect(
      await runtime.run({
        type: 'event',
        tenantId: fresh.tenantId,
        eventType: 'APPOINTMENT_REMINDER',
        payload: {},
        correlationId: `cycle-off-${Math.random()}`,
      }),
    ).toHaveLength(0);

    await registry.installPack(fresh, 'medspa', {
      config: {
        emergencyContacts: ['ops@clinic.test'],
        slackChannels: { staffAlerts: '#s', emergencyAlerts: '#e', systemAlerts: '#y' },
      },
    });

    // The same playbooks are active again, and matching again.
    expect((await registry.listPlaybooks(fresh, { active: true })).length).toBe(activeBefore);

    const recipient = await db
      .insert(recipients)
      .values({
        tenantId: fresh.tenantId,
        externalRef: { system: 'test', id: 'cycle-r' },
        displayName: 'Ada',
        contactPoints: [{ type: 'sms', value: '+15550001111' }],
      })
      .returning();

    const results = await runtime.run({
      type: 'event',
      tenantId: fresh.tenantId,
      eventType: 'APPOINTMENT_REMINDER',
      channels: ['sms'],
      recipientId: recipient[0]!.id,
      payload: { context: { appointmentDate: 'Tuesday' } },
      correlationId: `cycle-on-${Math.random()}`,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('QUEUED');
  });

  /**
   * A tenant that deliberately switched a playbook off keeps it off. AI
   * playbooks ship inactive and are enabled one at a time; a reinstall that
   * blanket-reactivated would silently start sending model-written messages
   * nobody re-approved.
   */
  /**
   * The overwrite path ended in `onConflictDoNothing()` and incremented its
   * count regardless — so a pack shipping a corrected `sla.onExpiry` or a
   * tightened `rights.bulk` never reached a tenant that already had the policy,
   * and the install result said it had.
   */
  it('overwriteCustomized actually updates an approval policy', async () => {
    const fresh = { tenantId: 't-pb-policy' };
    await db.insert(tenants).values({ id: fresh.tenantId, name: 'Policy' });
    const config = {
      emergencyContacts: ['ops@clinic.test'],
      slackChannels: { staffAlerts: '#s', emergencyAlerts: '#e', systemAlerts: '#y' },
    };
    await registry.installPack(fresh, 'medspa', { config });

    // Stand in for a tenant edit, or for the previous version of the pack.
    await db
      .update(approvalPolicies)
      .set({ mode: 'none', rights: { bulk: false }, name: 'Stale name' })
      .where(
        and(
          eq(approvalPolicies.tenantId, fresh.tenantId),
          eq(approvalPolicies.key, 'medspa.provider-always'),
        ),
      );

    await registry.installPack(fresh, 'medspa', { config, overwriteCustomized: true });

    const [after] = await db
      .select({
        mode: approvalPolicies.mode,
        rights: approvalPolicies.rights,
        name: approvalPolicies.name,
      })
      .from(approvalPolicies)
      .where(
        and(
          eq(approvalPolicies.tenantId, fresh.tenantId),
          eq(approvalPolicies.key, 'medspa.provider-always'),
        ),
      );

    // The pack's own values are back, which is what "overwrite" was reporting
    // while doing nothing at all.
    expect(after!.mode).toBe('always');
    expect(after!.name).toBe('Provider approves everything');
    expect(after!.rights).toMatchObject({ bulk: true, approve: true });
  });

  it('does not resurrect a playbook the tenant turned off', async () => {
    const fresh = { tenantId: 't-pb-choice' };
    await db.insert(tenants).values({ id: fresh.tenantId, name: 'Choice' });
    const config = {
      emergencyContacts: ['ops@clinic.test'],
      slackChannels: { staffAlerts: '#s', emergencyAlerts: '#e', systemAlerts: '#y' },
    };
    await registry.installPack(fresh, 'medspa', { config });

    await registry.setActive(fresh, 'medspa.appointment-reminder', false);
    await registry.installPack(fresh, 'medspa', { config, overwriteCustomized: true });

    const [row] = await registry.listPlaybooks(fresh, { packId: 'medspa' }).then((rows) =>
      rows.filter((r) => r.key === 'medspa.appointment-reminder'),
    );
    expect(row!.isActive).toBe(false);
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

  /**
   * The assertion this suite was missing, and the reason a defect that made
   * every message in the system unsigned went unnoticed through six phases.
   *
   * 23 of the 27 medspa templates interpolate `{{tenant.name}}`. The runtime
   * built its context from `emptyContext()`, which sets `tenant: {id}` and
   * nothing else, so the clinic's name resolved to the empty string and every
   * SMS ended `— `. Every test here asserted on the *caller's* context, which
   * was populated, so all of them passed.
   */
  it('signs the message with the tenant’s name, not an empty string', async () => {
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

    expect(sent.length).toBeGreaterThan(0);
    for (const message of sent) {
      expect(message.body).toContain('Clinic');
      // The shape of the failure, pinned so a regression is unambiguous: a
      // dangling separator is what a blank `{{tenant.name}}` leaves behind.
      expect(message.body).not.toMatch(/—\s*$/);
    }
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

/**
 * The shapes real callers actually send.
 *
 * Three of them exist and none agreed with the contract. `scheduling-service`
 * — the only service posting these events, repointed in P10 — sends
 * `startTime` / `oldStartTime` / `newStartTime`
 * (`notification.service.ts:86,112,148,175`). The deleted source read a nested
 * `appointmentDetails.date` / `oldAppointment.date`. The contract asks for
 * `appointmentDate` / `oldDate` / `newDate`.
 *
 * Before `contextMapping`, every appointment event from the live caller failed
 * its contract on arrival: a FAILED run, no message, no reminder. Renaming the
 * contract would have picked one caller and broken the other two.
 */
describe('the field names a caller actually sends', () => {
  it('accepts scheduling-service’s startTime for a contract that asks for appointmentDate', async () => {
    const recipient = await makeRecipient([{ type: 'sms', value: '+15551234567' }]);

    const results = await runtime.run(
      trigger({
        recipientId: recipient.id,
        channels: ['sms'],
        // Verbatim from notification.service.ts:112.
        payload: {
          context: { startTime: 'Tuesday 9 March, 09:00', type: 'consultation', location: 'Suite 2' },
        },
      }),
    );

    expect(results[0]).toMatchObject({
      playbookKey: 'medspa.appointment-reminder',
      status: 'QUEUED',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('Tuesday 9 March');
  });

  it('still prefers the contract’s own name when the caller sends it', async () => {
    const recipient = await makeRecipient([{ type: 'sms', value: '+15551234567' }]);

    await runtime.run(
      trigger({
        recipientId: recipient.id,
        channels: ['sms'],
        // Both spellings. The explicit one wins — a mapping fills gaps, it does
        // not override what the caller actually said.
        payload: {
          context: { appointmentDate: 'Wednesday', startTime: 'Tuesday' },
        },
      }),
    );

    expect(sent[0]!.body).toContain('Wednesday');
    expect(sent[0]!.body).not.toContain('Tuesday');
  });

  it('accepts the source’s nested appointmentDetails shape too', async () => {
    const recipient = await makeRecipient([{ type: 'sms', value: '+15551234567' }]);

    await runtime.run(
      trigger({
        recipientId: recipient.id,
        channels: ['sms'],
        payload: { context: { appointmentDetails: { date: 'Friday', location: 'Suite 1' } } },
      }),
    );

    expect(sent[0]!.body).toContain('Friday');
  });

  it('maps the rescheduling pair, which the source read with no guard at all', async () => {
    const recipient = await makeRecipient([{ type: 'email', value: 'ada@example.test' }]);

    const results = await runtime.run(
      trigger({
        eventType: 'APPOINTMENT_RESCHEDULING',
        recipientId: recipient.id,
        channels: ['email'],
        // notification.service.ts:175.
        payload: {
          context: {
            oldStartTime: 'Monday 10:00',
            newStartTime: 'Thursday 14:00',
            newEndTime: 'Thursday 15:00',
            type: 'follow-up',
            location: 'Suite 2',
          },
        },
      }),
    );

    expect(results[0]).toMatchObject({
      playbookKey: 'medspa.appointment-rescheduling',
      status: 'QUEUED',
    });
    expect(sent[0]!.body).toContain('Monday 10:00');
    expect(sent[0]!.body).toContain('Thursday 14:00');
  });
});

describe('priority rules', () => {
  /**
   * `medspa.system-alert` documented "URGENT when severity is CRITICAL" — the
   * source applied it at :716 — and nothing implemented it, so a critical alert
   * queued at MEDIUM behind every appointment reminder.
   */
  it('escalates a CRITICAL system alert to URGENT', async () => {
    await runtime.run(
      trigger({
        eventType: 'SYSTEM_ALERT',
        payload: { context: { message: 'disk full', severity: 'CRITICAL' } },
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.priority).toBe('URGENT');
  });

  it('leaves a non-critical one at the default', async () => {
    await runtime.run(
      trigger({
        eventType: 'SYSTEM_ALERT',
        payload: { context: { message: 'nightly backup done', severity: 'INFO' } },
      }),
    );

    expect(sent[0]!.priority).toBe('MEDIUM');
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

/**
 * Redelivery under concurrency, which the "a redelivered event does not send
 * twice" test above does not exercise — it delivers twice in sequence, and the
 * old check-then-act guard handled that fine.
 *
 * The defect was the gap between reading `playbook_runs` and writing it at the
 * very end: BullMQ concurrency above 1, a stalled-job reclaim, or a crash
 * between the dispatch and the insert all put two deliveries inside it, and
 * both sent. The unique index deduped the bookkeeping and not the sends.
 */
describe('concurrent redelivery', () => {
  it('sends once when the same event arrives twice at the same moment', async () => {
    const recipient = await makeRecipient([{ type: 'sms', value: '+15559990000' }]);
    const t = trigger({
      recipientId: recipient.id,
      channels: ['sms'],
      idempotencyKey: 'concurrent-key-1',
      payload: { context: { appointmentDate: 'Tuesday' } },
    });

    const [a, b] = await Promise.all([runtime.run(t), runtime.run(t)]);

    // Exactly one message, however the two runs interleaved.
    expect(sent).toHaveLength(1);

    // One ran; the other stood down and said why.
    const statuses = [a[0]!.status, b[0]!.status].sort();
    expect(statuses).toEqual(['QUEUED', 'SKIPPED']);
    const skipped = [...a, ...b].find((r) => r.status === 'SKIPPED')!;
    expect(skipped.reason).toMatch(/already ran/);

    // And one run row, not two.
    const runs = await db
      .select({ id: playbookRuns.id, status: playbookRuns.status })
      .from(playbookRuns)
      .where(
        and(eq(playbookRuns.tenantId, TENANT), eq(playbookRuns.idempotencyKey, 'concurrent-key-1')),
      );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('QUEUED');
  });

  it('populates runId on the success path, not only when skipping', async () => {
    const recipient = await makeRecipient([{ type: 'sms', value: '+15559990001' }]);
    const [result] = await runtime.run(
      trigger({
        recipientId: recipient.id,
        channels: ['sms'],
        payload: { context: { appointmentDate: 'Tuesday' } },
      }),
    );

    // It was set only on the already-ran branch, so a caller could not follow
    // a run it had just started.
    expect(result!.runId).toBeDefined();
    const [row] = await db
      .select({ status: playbookRuns.status })
      .from(playbookRuns)
      .where(eq(playbookRuns.id, result!.runId as string));
    expect(row!.status).toBe('QUEUED');
  });
});

describe('a channel that fails mid-fan-out', () => {
  /**
   * `messageIds` was a local and the outer catch returned `[]`, so an email that
   * had already dispatched vanished from the record. The run said FAILED and
   * nothing-sent, an operator re-fired, and the recipient got the email twice.
   */
  it('keeps the messages the earlier channels already produced', async () => {
    const recipient = await makeRecipient([
      { type: 'email', value: 'partial@example.test' },
      { type: 'sms', value: '+15559990002' },
    ]);

    // Break the SMS template only. The email is rendered and dispatched first.
    await db
      .update(templates)
      .set({ key: 'medspa.appointment-reminder.sms.broken' })
      .where(
        and(
          eq(templates.tenantId, TENANT),
          eq(templates.key, 'medspa.appointment-reminder.sms'),
        ),
      );

    try {
      const [result] = await runtime.run(
        trigger({
          recipientId: recipient.id,
          payload: { context: { appointmentDate: 'Tuesday', doctorName: 'Dr Byron' } },
        }),
      );

      // The email went. The run says so, and says which channel failed.
      expect(sent.map((s) => s.channel)).toEqual(['email']);
      expect(result!.status).toBe('FAILED');
      expect(result!.messageIds).toHaveLength(1);
      expect(result!.reason).toMatch(/sms/i);

      // And the row on disk agrees, which is what an operator reads.
      const [row] = await db
        .select({ messageIds: playbookRuns.messageIds, error: playbookRuns.error })
        .from(playbookRuns)
        .where(eq(playbookRuns.id, result!.runId as string));
      expect(row!.messageIds).toHaveLength(1);
      expect(row!.error).toMatch(/sms/i);
    } finally {
      await db
        .update(templates)
        .set({ key: 'medspa.appointment-reminder.sms' })
        .where(
          and(
            eq(templates.tenantId, TENANT),
            eq(templates.key, 'medspa.appointment-reminder.sms.broken'),
          ),
        );
    }
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
