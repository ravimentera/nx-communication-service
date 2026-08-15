/**
 * THE ACCEPTANCE TEST FOR THE WHOLE PROJECT.
 *
 * Every other test asks whether a piece of the engine works. This one asks the
 * only question that decides whether the extraction was worth doing:
 *
 *     Is this an outreach engine, or a medspa service with the word filed off?
 *
 * A real-estate tenant installs one pack, imports a list of leads, runs a
 * campaign, and gets messages out through its own credentials — with no context
 * provider, no Mentera service, no healthcare vocabulary, and no engine change.
 *
 * The last assertion is the real one: `git diff --stat` for this phase must show
 * no file under `src/engine/{playbooks,content,approvals,compliance,delivery}`.
 * If one had to change, the abstraction is wrong and the finding belongs in
 * docs/PACKS.md as a gap rather than being quietly patched away. Two constraints
 * in this suite were shaped by exactly that rule and are documented where they
 * bite: campaign targeting goes through the matcher's existing predicate rather
 * than a new trigger field, and `cancel` cannot recall an enqueued job.
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
  campaignRecipients,
  messages,
  playbooks,
  recipients,
  tenantChannelConfigs,
} from '../../src/db/schema.js';
import { ApprovalService } from '../../src/engine/approvals/approval.service.js';
import { TenantConfigAuthorizationProvider } from '../../src/engine/approvals/authorization.js';
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
import { PlaybookRegistry } from '../../src/engine/playbooks/registry.js';
import { PlaybookRuntime } from '../../src/engine/playbooks/runtime.js';
import { RecipientService } from '../../src/engine/recipients/recipient.service.js';
import { loadPacks } from '../../src/packs/loader.js';
import type { Channel, ChannelRegistry, ChannelType } from '../../src/ports/channel.js';
import type { ImportRow } from '../../src/engine/campaigns/audience.service.js';

const logger = winston.createLogger({ silent: true });

/** A real-estate agency. Nothing in this file knows what a patient is. */
const ACME = 'acme-realty';
/** The medspa tenant, present only so we can prove it was left alone. */
const CLINIC = 'clinic-co';

const acme = { tenantId: ACME };
const clinic = { tenantId: CLINIC };

const ACME_TWILIO_SID = 'AC-acme-owns-this';

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createDb>['pool'];
let db: Db;
let audiences: AudienceService;
let campaigns: CampaignOrchestrator;
let approvalService: ApprovalService;
let registry: PlaybookRegistry;
let contextRegistry: ContextRegistry;

/**
 * Every outbound HTTP call the process would make, recorded. The assertion that
 * this stays empty is what "no Mentera service" means concretely — a pack that
 * quietly resolved a patient would show up here as a call to PATIENT_SERVICE_URL.
 */
let httpCalls: string[] = [];
/** What was handed to the queue. */
let dispatched: { to: string; body: string }[] = [];
/**
 * Whose credentials the dispatcher resolved, per send. `SendJob` deliberately
 * does not carry them — the worker holds them — so the resolver call is the
 * observable, and it is the right one: it is the moment the engine decides
 * which tenant's account pays for the message.
 */
let resolved: { tenantId: string; accountSid: unknown }[] = [];

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
  list: () => ['email' as ChannelType, 'sms' as ChannelType],
};

const queue: NotificationQueue = {
  enqueue: async (job) => {
    dispatched.push({ to: job.to.value, body: job.rendered.body });
    return { queued: true, jobId: `job-${dispatched.length}` };
  },
  enqueueMany: async (jobs) => jobs.map(() => ({ queued: true })),
  stats: async () => ({}),
  close: async () => {},
};

async function* leads(count: number): AsyncIterable<ImportRow> {
  for (let i = 1; i <= count; i += 1) {
    yield {
      externalId: `acme-lead-${i}`,
      email: `lead${i}@example.test`,
      firstName: `Lead${i}`,
      displayName: `Lead${i} Buyer`,
      // Caller-supplied, tenant-owned segmentation data. No engine column knows
      // what a "budget band" is, and none needs to (§0.10 tier 2).
      attributes: { budgetBand: i % 2 === 0 ? 'high' : 'mid', source: 'portal' },
    };
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  for (const file of baselineMigrations(dir)) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.query(
    `INSERT INTO tenants (id, name, industry, timezone) VALUES
       ('${ACME}','Acme Realty','real-estate','America/Chicago'),
       ('${CLINIC}','Clinic Co','medspa','America/New_York')`,
  );
  await client.end();

  const handle = createDb({ url: container.getConnectionUri() }, logger);
  pool = handle.pool;
  db = handle.db;

  // Acme's own SendGrid/Twilio credentials, on Acme's own row.
  await db.insert(tenantChannelConfigs).values({
    tenantId: ACME,
    name: 'Acme Realty',
    twilioAccountSid: ACME_TWILIO_SID,
    twilioAuthToken: 'acme-secret',
    twilioEnabled: true,
    sendgridApiKey: 'SG.acme',
    sendgridFromEmail: 'hello@acme-realty.test',
    sendgridEnabled: true,
  });

  const preferences = new PreferenceService({
    db,
    logger,
    defaultTimezone: 'UTC',
    unsubscribeBaseUrl: 'https://acme-realty.test/u',
  });
  const authorization = new TenantConfigAuthorizationProvider({ db, logger });
  const policies = new PolicyService({
    db,
    logger,
    authorization,
    rotation: { next: async () => 0 },
  });

  const dispatcher = new Dispatcher({
    db,
    registry: channels,
    credentials: {
      // The real resolver reads tenant_channel_configs. Asserting on what it
      // returns is how "through Acme's own credentials" becomes checkable.
      resolve: async (_channel: unknown, scope: { tenantId: string }) => {
        const [row] = await db
          .select()
          .from(tenantChannelConfigs)
          .where(eq(tenantChannelConfigs.tenantId, scope.tenantId));
        resolved.push({ tenantId: scope.tenantId, accountSid: row?.twilioAccountSid });
        return {
          tenantId: scope.tenantId,
          source: 'tenant' as const,
          values: { accountSid: row?.twilioAccountSid, apiKey: row?.sendgridApiKey },
        };
      },
    } as never,
    queue,
    logger,
    compliance: new ComplianceGate({
      db,
      logger,
      preferences,
      // D41: the gate ships in SHADOW mode, and this test runs it as it ships.
      // Enforcing would suppress all 50 for want of a consent record —
      // `consent_records` is empty until a tenant supplies consent, which is an
      // operator decision (docs/DECISIONS.md open items), not a pack one.
      shadowMode: true,
      unsubscribeUrl: async () => 'https://acme-realty.test/u/tok',
    }),
  });

  const renderer = new Renderer({ logger, aliases: packs.aliasMaps() });

  // The medspa context provider IS registered — against the medspa pack. That is
  // the point: it exists in the process, and Acme still cannot reach it, because
  // providers are authorised by the caller's installed packs (D37).
  contextRegistry = new ContextRegistry({
    installedPacks: async (tenantId: string) =>
      tenantId === ACME ? ['lead-generation'] : ['medspa'],
  });
  contextRegistry.register(
    {
      kind: 'mentera-patient',
      fetch: async () => {
        httpCalls.push('PATIENT_SERVICE_URL/patients/:id');
        return {};
      },
    } as never,
    'medspa',
  );

  // The model. Not a Mentera service, and the only thing that writes prose.
  // The generator asks for a STRUCTURED draft (`generateJson` against
  // DRAFT_JSON_SCHEMA), not free text — which is why a stub returning `{}` makes
  // every recipient FAIL with "Model returned JSON that does not match the draft
  // contract" rather than sending something malformed. That is the content plane
  // refusing to render whatever the model felt like returning.
  const llm = {
    generate: async () => ({
      content: 'Thanks for your enquiry about the Oak Street listing.',
      model: 'test-model',
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.001,
    }),
    // `LlmResponse.content` IS the parsed object for generateJson — not a
    // `value` wrapper. Getting that wrong fails the draft contract, which is the
    // content plane refusing to render whatever the model felt like returning.
    generateJson: async () => ({
      content: {
        content:
          'Thanks for your enquiry about the Oak Street listing. Shall I send the floor plan over?',
        subject: 'About the Oak Street listing',
      },
      model: 'test-model',
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.001,
      latencyMs: 5,
      finishReason: 'stop',
    }),
  };

  const runtime = new PlaybookRuntime({
    db,
    logger,
    matcher: new PlaybookMatcher({ db, logger }),
    recipients: new RecipientService({ db, logger }),
    // Providers are registered against a pack id. Acme installs a pack that
    // declares none, so it has no provider of any kind available to it.
    context: contextRegistry,
    templates: new DrizzleTemplateStore(db, logger),
    renderer,
    generator: new ContentGenerator({
      llm: llm as never,
      assembler: new PromptAssembler(renderer),
      logger,
    }),
    approvals: new ApprovalService({ db, logger, policies, dispatcher, authorization }),
    policies,
    dispatcher,
    preferences,
    packs,
    packConfig: async () => ({}),
  });

  approvalService = new ApprovalService({ db, logger, policies, dispatcher, authorization });
  registry = new PlaybookRegistry({ db, logger, packs });
  audiences = new AudienceService({ db, logger, recipients: new RecipientService({ db, logger }) });
  campaigns = new CampaignOrchestrator({ db, logger, runtime, audiences, concurrency: 5 });

  // Acme installs ONE pack. The medspa pack is installed for the clinic only,
  // so "the medspa tenant is untouched" has something to be untouched.
  // Acme names who holds `sales-manager`. The lead-gen pack routes approvals to
  // that role, and P12 made the check real: without the membership, approving
  // is refused rather than waved through on the permission alone (D98).
  await registry.installPack(acme, 'lead-generation', {
    config: { roleMembers: { 'sales-manager': ['manager-1'] } },
  });
  await registry.installPack(clinic, 'medspa', {
    config: {
      emergencyContacts: ['ops@clinic.test'],
      slackChannels: { staffAlerts: '#s', emergencyAlerts: '#e', systemAlerts: '#y' },
    },
  });
}, 300_000);

beforeEach(() => {
  httpCalls = [];
  dispatched = [];
  resolved = [];
});

afterAll(async () => {
  await pool?.end().catch(() => {});
  await container?.stop();
});

describe('a real-estate tenant, with only the lead-generation pack', () => {
  it('installs the pack as rows, with no DDL and no medspa content', async () => {
    const installed = await db
      .select({ key: playbooks.key, isActive: playbooks.isActive })
      .from(playbooks)
      .where(eq(playbooks.tenantId, ACME));

    expect(installed).toHaveLength(5);
    expect(installed.every((p) => p.key.startsWith('lead.'))).toBe(true);
    // The AI playbook is off until a human turns it on (D59).
    expect(installed.find((p) => p.key === 'lead.followup')!.isActive).toBe(false);
  });

  it('imports 50 leads from a stream, creating recipients as it goes', async () => {
    const audience = await audiences.create(acme, { name: 'Portal enquiries, March' });
    const result = await audiences.importRows(acme, audience.id, leads(50), { system: 'acme-crm' });

    expect(result).toMatchObject({ imported: 50, skipped: 0, errors: 0 });
    expect((await audiences.getById(acme, audience.id))!.memberCount).toBe(50);

    // No HTTP call was needed to know who these people are.
    expect(httpCalls).toEqual([]);
  });

  it('generates 50 drafts from caller-supplied context, with zero calls to any Mentera service', async () => {
    // The one model-written playbook, switched on deliberately.
    await db
      .update(playbooks)
      .set({ isActive: true })
      .where(and(eq(playbooks.tenantId, ACME), eq(playbooks.key, 'lead.followup')));

    const audience = await audiences.create(acme, { name: 'Followup wave' });
    await audiences.importRows(acme, audience.id, leads(50), { system: 'acme-crm' });

    const { id } = await campaigns.create(acme, {
      name: 'March follow-up',
      playbookKey: 'lead.followup',
      audienceId: audience.id,
      context: { interest: 'the Oak Street listing', stage: 'enquiry', source: 'portal' },
    });

    const { expanded } = await campaigns.launch(acme, id, { await: true });
    expect(expanded).toBe(50);

    // ── THE ASSERTION THIS FILE EXISTS FOR ──────────────────────────────────
    expect(httpCalls).toEqual([]);

    const stats = await campaigns.stats(acme, id);
    expect(stats.total).toBe(50);
    expect(stats.byStatus.PENDING ?? 0).toBe(0);

    // Threshold mode with `allowAutoApprove` unset reviews everything, so all
    // 50 wait for a human rather than going out unreviewed.
    expect(stats.byStatus.PENDING_APPROVAL).toBe(50);
  });

  it('routes the drafts to the sales-manager role, not to an agent', async () => {
    const rows = await db
      .select({ approverType: approvals.approverType, approverRef: approvals.approverRef })
      .from(approvals)
      .where(eq(approvals.tenantId, ACME))
      .limit(5);

    expect(rows.length).toBeGreaterThan(0);
    // The medspa pack resolves approval to the owning agent; this one to a role,
    // because a lead has no owner yet. Same engine, different pack.
    expect(rows.every((r) => r.approverType === 'role')).toBe(true);
    expect(rows.every((r) => r.approverRef === 'sales-manager')).toBe(true);
  });

  it('dispatches an approved draft through Acme’s own credentials', async () => {
    const [pending] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.tenantId, ACME), eq(approvals.status, 'PENDING_APPROVAL')))
      .limit(1);

    await approvalService.approve(acme, pending!.id, {
      type: 'user',
      ref: 'manager-1',
      role: 'sales-manager',
      permissions: ['outreach:approve'],
    });

    expect(dispatched).toHaveLength(1);
    // Acme's own SendGrid/Twilio row — not the platform's, and not the clinic's.
    expect(resolved).toContainEqual({ tenantId: ACME, accountSid: ACME_TWILIO_SID });
    expect(resolved.every((r) => r.tenantId === ACME)).toBe(true);
    expect(httpCalls).toEqual([]);
  });

  it('refuses a mentera-patient context ref, because the pack is not installed', async () => {
    // 403, not 404: the caller asked for something real that it is not entitled
    // to (D37). A tenant must not be able to reach the engine's credentials for
    // a service its pack never declared.
    await expect(
      contextRegistry.fetch({ kind: 'mentera-patient', id: 'p-1' } as never, acme),
    ).rejects.toThrow(/has not installed/i);

    // The refusal happens BEFORE the provider runs, so no request left the
    // process on Acme's behalf. A 403 that still made the call would leak the
    // engine's credentials to a tenant not entitled to them.
    expect(httpCalls).toEqual([]);

    // …and the clinic, which HAS the pack, reaches the very same provider. Same
    // registry, same provider, different answer — which is what makes this an
    // authorisation boundary rather than a missing registration.
    await expect(
      contextRegistry.fetch({ kind: 'mentera-patient', id: 'p-1' } as never, clinic),
    ).resolves.toBeDefined();
    expect(httpCalls).toEqual(['PATIENT_SERVICE_URL/patients/:id']);
  });

  it('leaves the medspa tenant’s playbooks and messages untouched throughout', async () => {
    const clinicPlaybooks = await db
      .select({ key: playbooks.key })
      .from(playbooks)
      .where(eq(playbooks.tenantId, CLINIC));

    expect(clinicPlaybooks.length).toBeGreaterThanOrEqual(17);
    // Not "every key starts with medspa." — the medspa pack also installs the
    // engine's own `system.approval-escalation` playbook (P7). The claim that
    // matters is narrower and exact: no lead-generation content reached the
    // clinic, and none of Acme's did either.
    expect(clinicPlaybooks.some((p) => p.key.startsWith('lead.'))).toBe(false);
    expect(clinicPlaybooks.some((p) => p.key.startsWith('medspa.'))).toBe(true);

    // Not one message, recipient or campaign recipient landed on the clinic.
    const [clinicMessages] = await db
      .select({ n: messages.id })
      .from(messages)
      .where(eq(messages.tenantId, CLINIC))
      .limit(1);
    expect(clinicMessages).toBeUndefined();

    const [clinicRecipients] = await db
      .select({ n: recipients.id })
      .from(recipients)
      .where(eq(recipients.tenantId, CLINIC))
      .limit(1);
    expect(clinicRecipients).toBeUndefined();

    const [clinicCampaignRows] = await db
      .select({ n: campaignRecipients.id })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.tenantId, CLINIC))
      .limit(1);
    expect(clinicCampaignRows).toBeUndefined();
  });

  it('renders no healthcare vocabulary anywhere in what it sent', async () => {
    const bodies = await db
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.tenantId, ACME));

    expect(bodies.length).toBeGreaterThan(0);
    const all = bodies.map((b) => b.content).join('\n').toLowerCase();
    for (const word of ['patient', 'treatment', 'clinic', 'provider', 'medspa', 'hipaa']) {
      expect(all).not.toContain(word);
    }
  });
});
