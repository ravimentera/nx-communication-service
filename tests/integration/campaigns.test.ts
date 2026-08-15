/**
 * Audiences and the campaign orchestrator.
 *
 * The two things worth proving here, because both are load-bearing and neither
 * is obvious from reading the code:
 *
 *  1. A CAMPAIGN RUNS ITS OWN PLAYBOOK AND ONLY ITS OWN. `OutreachTrigger` has
 *     no "run this playbook" field, so the orchestrator targets through the
 *     matcher's existing `where` predicate on `campaignPlaybookKey`. If that
 *     mechanism did not work, a campaign would fan out across every
 *     campaign-triggered playbook a tenant has — so there is a decoy playbook
 *     here that must never fire.
 *
 *  2. GENERATION GOES THROUGH THE RUNTIME. The messages a campaign produces are
 *     ordinary `messages` rows with a playbook, an approval decision and a
 *     compliance verdict, indistinguishable from a single send. The assertion
 *     that they carry a `playbook_id` is what says the campaign did not grow its
 *     own private send path.
 *
 * The container is a throwaway; nothing here touches a real database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import winston from 'winston';

import { createDb, type Db } from '../../src/db/index.js';
import {
  approvalPolicies,
  campaignRecipients,
  messages,
  playbookTriggers,
  playbooks,
  recipients,
  templates,
} from '../../src/db/schema.js';
import { ApprovalService } from '../../src/engine/approvals/approval.service.js';
import { PolicyService } from '../../src/engine/approvals/policy.service.js';
import { AudienceService } from '../../src/engine/campaigns/audience.service.js';
import { CampaignOrchestrator } from '../../src/engine/campaigns/orchestrator.js';
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
import { PlaybookRuntime } from '../../src/engine/playbooks/runtime.js';
import { RecipientService } from '../../src/engine/recipients/recipient.service.js';
import { loadPacks } from '../../src/packs/loader.js';
import type { Channel, ChannelRegistry, ChannelType } from '../../src/ports/channel.js';
import type { ImportRow } from '../../src/engine/campaigns/audience.service.js';

const logger = winston.createLogger({ silent: true });
const TENANT = 't-camp';
const OTHER = 't-other';
const scope = { tenantId: TENANT };

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createDb>['pool'];
let db: Db;
let audiences: AudienceService;
let campaigns: CampaignOrchestrator;
let sent: { messageId: string }[] = [];

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

/** Job ids the fake queue should refuse to remove, standing in for a worker
 *  that already holds the lock. */
const lockedJobs = new Set<string>();

const queue: NotificationQueue = {
  enqueue: async (job) => {
    sent.push({ messageId: job.messageId });
    return { queued: true, jobId: `job-${sent.length}` };
  },
  enqueueMany: async (jobs) => jobs.map(() => ({ queued: true })),
  remove: async (jobIds) => ({
    removed: jobIds.filter((id) => !lockedJobs.has(id)),
    inFlight: jobIds.filter((id) => lockedJobs.has(id)),
    notFound: [],
  }),
  stats: async () => ({}),
  close: async () => {},
};

async function* rowsOf(rows: ImportRow[]): AsyncIterable<ImportRow> {
  for (const row of rows) yield row;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  for (const file of readdirSync(dir).filter((f) => /^0\d{3}_.*\.sql$/.test(f)).sort()) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.query(
    `INSERT INTO tenants (id, name, timezone) VALUES ('${TENANT}','Acme','UTC'), ('${OTHER}','Other','UTC')`,
  );
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
  const runtime = new PlaybookRuntime({
    db,
    logger,
    matcher: new PlaybookMatcher({ db, logger }),
    recipients: new RecipientService({ db, logger }),
    context: new ContextRegistry({ installedPacks: async () => [] }),
    templates: new DrizzleTemplateStore(db, logger),
    renderer,
    generator: new ContentGenerator({
      llm: {
        generate: async () => {
          throw new Error('a template campaign must not call a model');
        },
        generateJson: async () => {
          throw new Error('a template campaign must not call a model');
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
    packConfig: async () => ({}),
  });

  audiences = new AudienceService({ db, logger, recipients: new RecipientService({ db, logger }) });
  campaigns = new CampaignOrchestrator({ db, logger, runtime, audiences, concurrency: 3, queue });

  // ── the playbook a campaign targets, and a decoy that must never fire ──────
  const [policy] = await db
    .select({ id: approvalPolicies.id })
    .from(approvalPolicies)
    .where(eq(approvalPolicies.key, 'system.transactional'));

  await db.insert(templates).values({
    tenantId: TENANT,
    key: 'acme.nurture.email',
    name: 'Nurture',
    channel: 'email',
    subject: 'Hello {{recipient.firstName}}',
    content: 'Hi {{recipient.firstName}}, about {{context.topic}}.',
    format: 'TEXT',
  });

  for (const key of ['acme.nurture', 'acme.decoy']) {
    const [playbook] = await db
      .insert(playbooks)
      .values({
        tenantId: TENANT,
        key,
        name: key,
        isActive: true,
        priority: 100,
        // A campaign's context goes through the SAME contract validation an
        // event's does — `validation.context` is what reaches the renderer
        // (runtime.ts:240), so an undeclared field renders empty rather than
        // leaking whatever the caller happened to send.
        dataContract: { properties: { topic: { type: 'string', default: 'NOTHING SUPPLIED' } } },
        contentSource: { kind: 'template', templateKey: 'acme.nurture.email' },
        channelPlan: [{ channel: 'email', templateKey: 'acme.nurture.email' }],
        approvalPolicyId: policy!.id,
        throttle: {},
      })
      .returning({ id: playbooks.id });

    await db.insert(playbookTriggers).values({
      tenantId: TENANT,
      playbookId: playbook!.id,
      triggerType: 'campaign',
      // The targeting mechanism under test: without this predicate both
      // playbooks match every campaign.
      matchRules: { where: { campaignPlaybookKey: { eq: key } } },
      isActive: true,
    });
  }
}, 240_000);

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  await pool?.end().catch(() => {});
  await container?.stop();
});

async function makeRecipient(tenantId: string, email: string, status = 'active') {
  const [row] = await db
    .insert(recipients)
    .values({
      tenantId,
      externalRef: { system: 'test', id: email },
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      status,
      contactPoints: [{ type: 'email', value: email, primary: true }],
    })
    .returning({ id: recipients.id });
  return row!.id;
}

describe('audiences', () => {
  it('adds only recipients this tenant owns', async () => {
    const audience = await audiences.create(scope, { name: 'Mine' });
    const mine = await makeRecipient(TENANT, 'mine@example.test');
    const theirs = await makeRecipient(OTHER, 'theirs@example.test');

    const { added } = await audiences.addMembers(scope, audience.id, [mine, theirs]);

    // The other tenant's id is silently not added rather than erroring — it is
    // indistinguishable from an id that does not exist, and saying which would
    // confirm the row exists to someone who should not know that.
    expect(added).toBe(1);
    expect(await audiences.memberIds(scope, audience.id)).toEqual([mine]);
  });

  it('is idempotent — adding the same member twice adds one', async () => {
    const audience = await audiences.create(scope, { name: 'Twice' });
    const r = await makeRecipient(TENANT, 'twice@example.test');

    await audiences.addMembers(scope, audience.id, [r]);
    const second = await audiences.addMembers(scope, audience.id, [r]);

    expect(second.added).toBe(0);
    expect((await audiences.getById(scope, audience.id))!.memberCount).toBe(1);
  });

  it('imports rows, creating recipients, and quarantines the bad ones by line', async () => {
    const audience = await audiences.create(scope, { name: 'Imported' });

    const result = await audiences.importRows(
      scope,
      audience.id,
      rowsOf([
        { externalId: 'lead-1', email: 'lead1@example.test', firstName: 'Grace' },
        { externalId: '', email: 'nobody@example.test' },
        { externalId: 'lead-3', email: 'not-an-email' },
        { externalId: 'lead-4' },
        { externalId: 'lead-5', phone: '+15550001' },
      ]),
      { system: 'crm' },
    );

    expect(result.imported).toBe(2); // lead-1 and lead-5
    expect(result.errors).toBe(3);

    const errors = await audiences.listImportErrors(scope, audience.id);
    // Row numbers count the header, so the first data row is 3 — which is what
    // the operator sees in their spreadsheet.
    expect(errors.map((e) => e.rowNumber)).toEqual([3, 4, 5]);
    expect(errors[0]!.reason).toMatch(/externalId is required/);
    expect(errors[1]!.reason).toMatch(/not a usable email/);
    expect(errors[2]!.reason).toMatch(/email or phone/);
  });

  it('re-importing the same list does not duplicate the recipients', async () => {
    const audience = await audiences.create(scope, { name: 'Reimport' });
    const rows: ImportRow[] = [{ externalId: 'stable-1', email: 'stable@example.test' }];

    const first = await audiences.importRows(scope, audience.id, rowsOf(rows), { system: 'crm' });
    const second = await audiences.importRows(scope, audience.id, rowsOf(rows), { system: 'crm' });

    expect((await audiences.getById(scope, audience.id))!.memberCount).toBe(1);
    // The second pass reports honestly rather than claiming to have added
    // everyone again — `skipped` is a real count, not a decorative zero.
    expect(first).toMatchObject({ imported: 1, skipped: 0 });
    expect(second).toMatchObject({ imported: 0, skipped: 1 });
  });

  it('materializes a query audience and rejects an unqueryable field', async () => {
    await makeRecipient(TENANT, 'bounced@example.test', 'bounced');
    const audience = await audiences.create(scope, {
      name: 'Bounced',
      kind: 'query',
      definition: { where: { status: { eq: 'bounced' } } },
    });

    const { count } = await audiences.materialize(scope, audience.id);
    expect(count).toBe(1);

    await expect(
      audiences.create(scope, {
        name: 'Bad',
        kind: 'query',
        definition: { where: { 'secret.column': { eq: 'x' } } },
      }),
    ).rejects.toThrow(/not a queryable field/);
  });
});

describe('the orchestrator', () => {
  async function campaignOver(emails: string[], name: string) {
    const audience = await audiences.create(scope, { name: `${name}-audience` });
    const ids = await Promise.all(emails.map((e) => makeRecipient(TENANT, e)));
    await audiences.addMembers(scope, audience.id, ids);

    const { id } = await campaigns.create(scope, {
      name,
      playbookKey: 'acme.nurture',
      audienceId: audience.id,
      context: { topic: 'your roof quote' },
    });
    return { campaignId: id, recipientIds: ids };
  }

  it('expands, generates through the runtime, and tracks every recipient', async () => {
    const { campaignId } = await campaignOver(
      ['c1@example.test', 'c2@example.test', 'c3@example.test'],
      'launch',
    );

    const { expanded } = await campaigns.launch(scope, campaignId, { await: true });
    expect(expanded).toBe(3);

    const stats = await campaigns.stats(scope, campaignId);
    expect(stats.status).toBe('COMPLETED');
    expect(stats.total).toBe(3);
    expect(stats.byStatus.PENDING ?? 0).toBe(0);

    // Every recipient produced a real message row, carrying the playbook — the
    // proof that generation went through the runtime and not around it.
    const rows = await campaigns.recipients(scope, campaignId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.messageId)).toBe(true);

    const produced = await db
      .select({ playbookId: messages.playbookId, content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, TENANT),
          eq(messages.id, rows[0]!.messageId as string),
        ),
      );
    expect(produced[0]!.playbookId).not.toBeNull();
    expect(produced[0]!.content).toContain('about your roof quote');
  });

  it('drops campaign context the playbook did not declare', async () => {
    const audience = await audiences.create(scope, { name: 'undeclared-audience' });
    await audiences.addMembers(scope, audience.id, [
      await makeRecipient(TENANT, 'undeclared@example.test'),
    ]);
    const { id } = await campaigns.create(scope, {
      name: 'undeclared',
      playbookKey: 'acme.nurture',
      audienceId: audience.id,
      context: { topic: 'declared', secret: 'must not render' },
    });
    await campaigns.launch(scope, id, { await: true });

    const rows = await campaigns.recipients(scope, id);
    const [message] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.id, rows[0]!.messageId as string));

    expect(message!.content).toContain('about declared');
    expect(message!.content).not.toContain('must not render');
  });

  it('runs the campaign’s playbook and not the decoy', async () => {
    const { campaignId } = await campaignOver(['solo@example.test'], 'targeting');
    await campaigns.launch(scope, campaignId, { await: true });

    const rows = await campaigns.recipients(scope, campaignId);
    const [message] = await db
      .select({ playbookId: messages.playbookId })
      .from(messages)
      .where(eq(messages.id, rows[0]!.messageId as string));

    const [decoy] = await db
      .select({ id: playbooks.id })
      .from(playbooks)
      .where(and(eq(playbooks.tenantId, TENANT), eq(playbooks.key, 'acme.decoy')));

    // One message, and it is not the decoy's.
    expect(rows).toHaveLength(1);
    expect(message!.playbookId).not.toBe(decoy!.id);
  });

  it('relaunching a completed campaign is refused rather than sending twice', async () => {
    const { campaignId } = await campaignOver(['once@example.test'], 'once');
    await campaigns.launch(scope, campaignId, { await: true });
    const afterFirst = sent.length;

    await expect(campaigns.launch(scope, campaignId, { await: true })).rejects.toThrow(
      /COMPLETED/,
    );
    expect(sent.length).toBe(afterFirst);
  });

  it('cancels everyone not yet generated', async () => {
    const { campaignId } = await campaignOver(['x1@example.test', 'x2@example.test'], 'cancel');

    // Cancel before launching: every recipient is still PENDING.
    await campaigns.launch(scope, campaignId, { await: false });
    await campaigns.cancel(scope, campaignId);

    const rows = await db
      .select({ status: campaignRecipients.status })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.tenantId, TENANT),
          eq(campaignRecipients.campaignId, campaignId),
        ),
      );

    // Whatever the run loop managed before the cancel landed, nothing is left
    // PENDING — a cancelled campaign must not resume later.
    expect(rows.every((r) => r.status !== 'PENDING')).toBe(true);
    expect((await campaigns.stats(scope, campaignId)).status).toBe('CANCELLED');
  });

  it('recalls generated messages still sitting in the queue', async () => {
    // The D83 hole: before P12, generation stopped but anything already handed
    // to the queue went out regardless, and `cancel` did not say so.
    const { campaignId } = await campaignOver(['r1@example.test', 'r2@example.test'], 'recall');
    // `await: true` — the default is fire-and-forget, and cancelling before
    // generation finishes tests the P11 path, not this one.
    await campaigns.launch(scope, campaignId, { await: true });

    // This campaign's messages only. Other tests in this suite leave their own
    // QUEUED rows behind, and a tenant-wide count would silently include them.
    const before = await db
      .select({ id: messages.id })
      .from(campaignRecipients)
      .innerJoin(messages, eq(messages.id, campaignRecipients.messageId))
      .where(
        and(
          eq(campaignRecipients.tenantId, TENANT),
          eq(campaignRecipients.campaignId, campaignId),
          eq(messages.status, 'QUEUED'),
        ),
      );
    expect(before.length).toBeGreaterThan(0);

    const result = await campaigns.cancel(scope, campaignId);

    expect(result.recalled).toBe(before.length);
    expect(result.alreadySending).toBe(0);

    const after = await db
      .select({ status: messages.status })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, TENANT),
          inArray(
            messages.id,
            before.map((m) => m.id),
          ),
        ),
      );
    // Recalled means it will not send, and the row has to say so — leaving it
    // QUEUED would read as "still going out".
    expect(after.every((m) => m.status === 'CANCELLED')).toBe(true);
  });

  it('reports a message a worker already holds instead of claiming it stopped it', async () => {
    const { campaignId } = await campaignOver(['flight@example.test'], 'inflight');
    await campaigns.launch(scope, campaignId, { await: true });

    const queued = await db
      .select({ jobId: sql<string>`${messages.metadata}->>'jobId'` })
      .from(campaignRecipients)
      .innerJoin(messages, eq(messages.id, campaignRecipients.messageId))
      .where(
        and(
          eq(campaignRecipients.tenantId, TENANT),
          eq(campaignRecipients.campaignId, campaignId),
          eq(messages.status, 'QUEUED'),
        ),
      );
    const jobIds = queued.map((q) => q.jobId).filter(Boolean);
    expect(jobIds.length).toBeGreaterThan(0);
    jobIds.forEach((id) => lockedJobs.add(id));

    try {
      const result = await campaigns.cancel(scope, campaignId);

      // The honest limit of a recall. Claiming these were cancelled would tell
      // an operator a message did not go out when it may well have.
      expect(result.alreadySending).toBe(jobIds.length);
      expect(result.recalled).toBe(0);

      const rows = await db
        .select({ status: messages.status })
        .from(campaignRecipients)
        .innerJoin(messages, eq(messages.id, campaignRecipients.messageId))
        .where(
          and(
            eq(campaignRecipients.tenantId, TENANT),
            eq(campaignRecipients.campaignId, campaignId),
          ),
        );
      // Left QUEUED, not marked CANCELLED: the worker owns the outcome now, and
      // it will report what actually happened.
      expect(rows.every((r) => r.status === 'QUEUED')).toBe(true);
    } finally {
      lockedJobs.clear();
    }
  });

  it('refuses a campaign whose playbook the tenant does not have', async () => {
    const audience = await audiences.create(scope, { name: 'no-playbook' });
    await expect(
      campaigns.create(scope, {
        name: 'nope',
        playbookKey: 'does.not.exist',
        audienceId: audience.id,
      }),
    ).rejects.toThrow(/not installed/);
  });
});
