/**
 * The approvals plane against a real Postgres.
 *
 * Three things this suite exists to prove, in order of how expensive they would
 * be to get wrong:
 *
 *  1. APPROVAL IS NOT A COMPLIANCE BYPASS. A provider approving a message to
 *     someone who unsubscribed produces a SUPPRESSED row, not a send.
 *  2. ONE MESSAGE, ONE ROW. Submit writes it, the dispatcher adopts it. Two
 *     rows would double-count every rate-limit window and retention sweep.
 *  3. DOUBLE-APPROVE IS A NO-OP. Not an error, and — critically — not a second
 *     send.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import winston from 'winston';

import { createDb, type Db } from '../../src/db/index.js';
import { approvalPolicies, approvals, messages, recipients } from '../../src/db/schema.js';
import { ApprovalService } from '../../src/engine/approvals/approval.service.js';
import { PolicyService } from '../../src/engine/approvals/policy.service.js';
import { SlaSweeper } from '../../src/engine/approvals/sla.worker.js';
import type { Actor } from '../../src/engine/approvals/state-machine.js';
import { ComplianceGate } from '../../src/engine/compliance/gate.js';
import { PreferenceService } from '../../src/engine/compliance/preference.service.js';
import { Dispatcher } from '../../src/engine/delivery/dispatcher.js';
import type { NotificationQueue } from '../../src/engine/delivery/notification-queue.js';
import type {
  Channel,
  ChannelCredentials,
  ChannelRegistry,
  ChannelType,
} from '../../src/ports/channel.js';

const logger = winston.createLogger({ silent: true });
const TENANT = 't-appr';
const scope = { tenantId: TENANT };
const PROVIDER = 'provider-A';

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createDb>['pool'];
let db: Db;
let service: ApprovalService;
let policies: PolicyService;
let preferences: PreferenceService;

/** Every job the queue was asked to run, so "did this send?" is answerable. */
let queued: { messageId: string; delayMs?: number }[] = [];

const provider: Actor = {
  type: 'user',
  ref: 'user-a',
  senderId: PROVIDER,
  role: 'provider',
  permissions: [],
};

const email: Channel = {
  type: 'email',
  capabilities: { subject: true, html: true, attachments: true, supportsDeliveryReceipts: true },
  validate: () => ({ ok: true }),
  send: async () => ({ success: true, providerMessageId: 'prov-1', dispatched: false }),
};

const registry: ChannelRegistry = {
  register: () => {},
  get: () => email,
  has: () => true,
  list: () => ['email' as ChannelType],
};

const queue: NotificationQueue = {
  enqueue: async (job, options) => {
    queued.push({ messageId: job.messageId, delayMs: options?.delayMs });
    return { queued: true, jobId: `job-${queued.length}` };
  },
  enqueueMany: async (jobs) => jobs.map(() => ({ queued: true })),
  stats: async () => ({}),
  close: async () => {},
};

const credentials = {
  resolve: async (): Promise<ChannelCredentials> => ({
    tenantId: TENANT,
    source: 'env',
    values: {},
    from: 'clinic@example.test',
  }),
};

function dispatcher(enforceCompliance: boolean): Dispatcher {
  return new Dispatcher({
    db,
    registry,
    credentials: credentials as never,
    queue,
    logger,
    compliance: new ComplianceGate({
      db,
      logger,
      preferences,
      // Enforcing, not shadowing: the point of the test is that the gate can
      // actually stop an approved message.
      shadowMode: !enforceCompliance,
      unsubscribeUrl: async () => 'https://example.test/unsubscribe/tok',
    }),
  });
}

async function makeRecipient(status = 'active') {
  const [row] = await db
    .insert(recipients)
    .values({
      tenantId: TENANT,
      externalRef: { system: 'test', id: `r-${Math.random().toString(36).slice(2)}` },
      displayName: 'Ada',
      status,
    })
    .returning();
  return row!;
}

const draft = (over: Record<string, unknown> = {}) =>
  ({
    channel: 'email' as const,
    to: { type: 'email', value: 'ada@example.test' },
    rendered: { body: 'Hello Ada', subject: 'Your follow-up' },
    senderId: PROVIDER,
    priority: 'MEDIUM' as const,
    aiGenerated: true,
    ...over,
  }) as Parameters<ApprovalService['submit']>[1];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  // The 0xxx schema series only — the 9xxx files are the one-shot mentera-core
  // data migration and need a linked source database (migration.test.ts covers them).
  for (const file of readdirSync(dir).filter((f) => /^0\d{3}_.*\.sql$/.test(f)).sort()) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.query(`INSERT INTO tenants (id, name, timezone) VALUES ('${TENANT}','Appr','UTC')`);
  await client.end();

  const handle = createDb({ url: container.getConnectionUri() }, logger);
  pool = handle.pool;
  db = handle.db;

  preferences = new PreferenceService({
    db,
    logger,
    defaultTimezone: 'UTC',
    unsubscribeBaseUrl: 'https://example.test/unsubscribe',
  });
  policies = new PolicyService({
    db,
    logger,
    rotation: { next: async () => 0 },
  });
  service = new ApprovalService({ db, logger, policies, dispatcher: false as never });
}, 240_000);

beforeEach(() => {
  queued = [];
  // Rebuilt per test so a suite can choose whether the gate enforces.
  service = new ApprovalService({ db, logger, policies, dispatcher: dispatcher(true) });
});

afterAll(async () => {
  await pool?.end().catch(() => {});
  await container?.stop();
});

describe('migration 0006 seeds', () => {
  it('ships the two baseline policies as pack defaults', async () => {
    const rows = await db.select().from(approvalPolicies);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    expect(byKey['medspa.provider-always']).toMatchObject({
      tenantId: null,
      packId: 'medspa',
      mode: 'always',
      approverResolution: { kind: 'agent' },
    });
    expect(byKey['system.transactional']).toMatchObject({ tenantId: null, mode: 'none' });
  });

  it('is idempotent — re-applying does not duplicate a seed', async () => {
    const before = await db.select().from(approvalPolicies);
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query(
      readFileSync(join(process.cwd(), 'migrations', '0006_approval_policies.sql'), 'utf8'),
    );
    await client.end();

    expect(await db.select().from(approvalPolicies)).toHaveLength(before.length);
  });
});

describe('the full lifecycle', () => {
  it('DRAFT → PENDING_APPROVAL → EDITED_APPROVED → SENT', async () => {
    const recipient = await makeRecipient();
    const { approval } = await service.submit(scope, draft({ recipientId: recipient.id }), {
      key: 'medspa.provider-always',
    });

    // The submit itself is the DRAFT → PENDING_APPROVAL move, recorded.
    expect(approval.status).toBe('PENDING_APPROVAL');
    expect(approval.approverType).toBe('agent');
    expect(approval.approverRef).toBe(PROVIDER);
    expect(approval.auditTrail).toHaveLength(1);
    expect(approval.auditTrail[0]).toMatchObject({ from: 'DRAFT', to: 'PENDING_APPROVAL' });

    // The message row exists and is not pretending to have been sent.
    const [pending] = await db.select().from(messages).where(eq(messages.id, approval.messageId));
    expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', sentAt: null });

    const edited = await service.edit(scope, approval.id, provider, 'Hello Ada — see you Tuesday');
    expect(edited.status).toBe('PENDING_APPROVAL');
    expect(edited.originalContent).toBe('Hello Ada');
    expect(edited.editedContent).toBe('Hello Ada — see you Tuesday');

    const { approval: approved } = await service.approve(scope, approval.id, provider);
    expect(approved.status).toBe('EDITED_APPROVED');
    expect(approved.decidedBy).toBe('user-a');
    expect(queued).toHaveLength(1);

    // The body that went out is the edit, not the original — plus the CAN-SPAM
    // footer the gate appends to non-transactional email, which is the gate
    // doing its job downstream of the approval.
    const [sent] = await db.select().from(messages).where(eq(messages.id, approval.messageId));
    expect(sent!.content).toContain('Hello Ada — see you Tuesday');
    expect(sent!.content).toContain('unsubscribe');
    expect(sent!.content).not.toContain('Hello Ada\n'); // not the pre-edit body
    expect(sent!.status).toBe('QUEUED');

    // SENT is written by delivery, not by the approval — an approval that says
    // SENT before anything left is the lie the source's status columns tell.
    await service.markSent(scope, approval.messageId);
    const final = await service.getById(scope, approval.id);
    expect(final!.status).toBe('SENT');
    expect(final!.auditTrail.map((e) => e.to)).toEqual([
      'PENDING_APPROVAL',
      'PENDING_APPROVAL', // the edit
      'EDITED_APPROVED',
      'SENT',
    ]);
  });

  it('preserves the AI original across repeated edits', async () => {
    const { approval } = await service.submit(scope, draft(), { key: 'medspa.provider-always' });
    await service.edit(scope, approval.id, provider, 'first edit');
    const second = await service.edit(scope, approval.id, provider, 'second edit');

    expect(second.originalContent).toBe('Hello Ada');
    expect(second.editedContent).toBe('second edit');
  });

  it('writes exactly one message row for one message', async () => {
    const recipient = await makeRecipient();
    const { approval } = await service.submit(
      scope,
      draft({ recipientId: recipient.id, correlationId: 'corr-one-row' }),
      { key: 'medspa.provider-always' },
    );
    await service.approve(scope, approval.id, provider);

    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.tenantId, TENANT), eq(messages.recipientId, recipient.id)));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.approvalId).toBe(approval.id);
  });

  it('keeps the submit-time metadata when the dispatcher adopts the row', async () => {
    const { approval } = await service.submit(scope, draft({ playbookKey: 'medspa.followup' }), {
      key: 'medspa.provider-always',
    });
    await service.approve(scope, approval.id, provider);

    const [row] = await db.select().from(messages).where(eq(messages.id, approval.messageId));
    const metadata = row!.metadata as Record<string, unknown>;

    // The playbook key survives the adopt — the P5 cooldown check reads it.
    expect(metadata.playbookKey).toBe('medspa.followup');
    expect(metadata.dispatch).toMatchObject({ to: { value: 'ada@example.test' } });
  });
});

describe('a legacy-cased message row', () => {
  /**
   * The release path casts `messages.channel` straight to `ChannelType` and
   * hands it to `registry.get()`, which has no fallback. Every row migrated from
   * mentera-core, and every inbound row the receipt service used to write, held
   * the source's upper case — so approving one of them would have looked for an
   * adapter registered as 'EMAIL' and thrown. P9 normalises the column on the
   * way in; this asserts the read side tolerates a row that slipped through.
   */
  it('still finds its channel adapter when the row says EMAIL', async () => {
    const recipient = await makeRecipient();
    const { approval } = await service.submit(scope, draft({ recipientId: recipient.id }), {
      key: 'medspa.provider-always',
    });

    await db
      .update(messages)
      .set({ channel: 'EMAIL' })
      .where(eq(messages.id, approval.messageId));

    const { approval: approved } = await service.approve(scope, approval.id, provider);
    expect(approved.status).toBe('APPROVED');
    expect(queued).toHaveLength(1);
  });
});

describe('idempotency', () => {
  it('double-approve returns the same row and does not send twice', async () => {
    const { approval } = await service.submit(scope, draft(), { key: 'medspa.provider-always' });

    const first = await service.approve(scope, approval.id, provider);
    const second = await service.approve(scope, approval.id, provider);

    expect(first.approval.status).toBe('APPROVED');
    expect(second.approval.status).toBe('APPROVED');
    expect(second.idempotent).toBe(true);
    expect(queued).toHaveLength(1);
  });

  it('a resubmitted message does not open a second approval', async () => {
    const { approval } = await service.submit(scope, draft(), { key: 'medspa.provider-always' });

    const again = await service.submit(
      scope,
      draft({ messageId: approval.messageId }),
      { key: 'medspa.provider-always' },
    );

    expect(again.approval.id).toBe(approval.id);
    const rows = await db
      .select()
      .from(approvals)
      .where(eq(approvals.messageId, approval.messageId));
    expect(rows).toHaveLength(1);
  });

  it('survives concurrent submits for the same message', async () => {
    const { approval } = await service.submit(scope, draft(), { key: 'medspa.provider-always' });

    const racers = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.submit(scope, draft({ messageId: approval.messageId }), {
          key: 'medspa.provider-always',
        }),
      ),
    );

    expect(new Set(racers.map((r) => r.approval.id)).size).toBe(1);
  });
});

describe('declining', () => {
  it('does not dispatch, and marks the message rather than leaving it queued', async () => {
    const { approval } = await service.submit(scope, draft(), { key: 'medspa.provider-always' });
    const { approval: declined } = await service.decline(
      scope,
      approval.id,
      provider,
      'wrong patient',
    );

    expect(declined.status).toBe('DECLINED');
    expect(declined.declineReason).toBe('wrong patient');
    expect(queued).toHaveLength(0);

    const [row] = await db.select().from(messages).where(eq(messages.id, approval.messageId));
    expect(row!.status).toBe('CANCELLED');
  });

  it('refuses to approve after declining', async () => {
    const { approval } = await service.submit(scope, draft(), { key: 'medspa.provider-always' });
    await service.decline(scope, approval.id, provider);

    await expect(service.approve(scope, approval.id, provider)).rejects.toThrow(/already DECLINED/);
  });
});

describe('compliance runs after approval', () => {
  it('an approved message to an unsubscribed recipient is SUPPRESSED, not SENT', async () => {
    // The single most important assertion in this file. Approval is a human
    // saying "this is good content"; it is not a licence to contact someone who
    // asked us to stop.
    const recipient = await makeRecipient('unsubscribed');
    const { approval } = await service.submit(scope, draft({ recipientId: recipient.id }), {
      key: 'medspa.provider-always',
    });

    const result = await service.approve(scope, approval.id, provider);

    expect(queued).toHaveLength(0);
    expect(result.dispatch).toMatchObject({
      queued: false,
      skipped: 'RECIPIENT_UNSUBSCRIBED',
      deferrable: false,
    });

    const [row] = await db.select().from(messages).where(eq(messages.id, approval.messageId));
    expect(row!.status).toBe('SUPPRESSED');
    expect(row!.suppressionReason).toBe('RECIPIENT_UNSUBSCRIBED');

    // And the approval does not sit there looking approved-and-pending forever.
    expect(result.approval.status).toBe('CANCELLED');
    expect(result.approval.auditTrail.at(-1)).toMatchObject({
      actorRef: 'compliance.gate',
      reason: 'RECIPIENT_UNSUBSCRIBED',
    });
  });
});

describe('auto-approval', () => {
  it('mode none sends immediately and opens no review', async () => {
    const { approval, decision, dispatch } = await service.submit(scope, draft(), {
      key: 'system.transactional',
    });

    expect(decision).toEqual({ kind: 'auto', reason: 'mode_none' });
    expect(approval.status).toBe('AUTO_APPROVED');
    expect(approval.approverRef).toBeNull();
    expect(dispatch?.queued).toBe(true);
    expect(queued).toHaveLength(1);
  });

  it('rejects a policy reference that does not resolve, rather than guessing', async () => {
    await expect(service.submit(scope, draft(), { key: 'does.not.exist' })).rejects.toThrow(
      /policy does not exist/,
    );
  });
});

describe('scheduling', () => {
  it('approves and enqueues with a delay the queue owns', async () => {
    const { approval } = await service.submit(scope, draft(), { key: 'medspa.provider-always' });
    const sendAt = new Date(Date.now() + 3_600_000);

    const { approval: scheduled } = await service.schedule(scope, approval.id, provider, sendAt);

    expect(scheduled.status).toBe('SCHEDULED');
    expect(queued).toHaveLength(1);
    // The source stored a scheduledFor string nothing ever read; here BullMQ
    // holds the job, so the wait survives a restart.
    expect(queued[0]!.delayMs).toBeGreaterThan(3_500_000);

    expect(scheduled.auditTrail.map((e) => e.to)).toEqual([
      'PENDING_APPROVAL',
      'APPROVED',
      'SCHEDULED',
    ]);
  });

  it('refuses a time in the past', async () => {
    const { approval } = await service.submit(scope, draft(), { key: 'medspa.provider-always' });
    await expect(
      service.schedule(scope, approval.id, provider, new Date(Date.now() - 1000)),
    ).rejects.toThrow(/must be in the future/);
  });
});

describe('tenant isolation', () => {
  it('hides another tenant’s approval entirely', async () => {
    const { approval } = await service.submit(scope, draft(), { key: 'medspa.provider-always' });
    const other = { tenantId: 't-other' };

    expect(await service.getById(other, approval.id)).toBeNull();
    await expect(service.approve(other, approval.id, provider)).rejects.toThrow(/not found/);
    await expect(service.decline(other, approval.id, provider)).rejects.toThrow(/not found/);
    await expect(service.edit(other, approval.id, provider, 'x')).rejects.toThrow(/not found/);

    // Untouched.
    const mine = await service.getById(scope, approval.id);
    expect(mine!.status).toBe('PENDING_APPROVAL');
  });
});

describe('the inbox', () => {
  it('lists what is pending for one approver, with the content that would be sent', async () => {
    const { approval } = await service.submit(
      scope,
      draft({ senderId: 'provider-List', priority: 'HIGH', playbookKey: 'medspa.reminder' }),
      { key: 'medspa.provider-always' },
    );
    await service.edit(
      scope,
      approval.id,
      { ...provider, senderId: 'provider-List' },
      'edited body',
    );

    const page = await service.listPending(scope, { approverRef: 'provider-List' });

    expect(page.total).toBe(1);
    expect(page.approvals[0]).toMatchObject({
      id: approval.id,
      channel: 'email',
      subject: 'Your follow-up',
      content: 'edited body',
      priority: 'HIGH',
      playbookKey: 'medspa.reminder',
    });
  });

  it('filters on priority, channel and playbook — the JSONB the source filtered on', async () => {
    const approver = 'provider-Filter';
    await service.submit(scope, draft({ senderId: approver, priority: 'URGENT' }), {
      key: 'medspa.provider-always',
    });
    await service.submit(scope, draft({ senderId: approver, priority: 'LOW' }), {
      key: 'medspa.provider-always',
    });

    const urgent = await service.listPending(scope, { approverRef: approver, priority: 'URGENT' });
    expect(urgent.total).toBe(1);

    const sms = await service.listPending(scope, { approverRef: approver, channel: 'sms' });
    expect(sms.total).toBe(0);
  });

  it('counts the dashboard from the same rows', async () => {
    const approver = 'provider-Dash';
    const a = await service.submit(scope, draft({ senderId: approver }), {
      key: 'medspa.provider-always',
    });
    await service.submit(scope, draft({ senderId: approver }), { key: 'medspa.provider-always' });
    await service.decline(scope, a.approval.id, { ...provider, senderId: approver }, 'no');

    const dash = await service.dashboard(scope, approver);
    expect(dash).toMatchObject({ pending: 1, declined: 1, overdue: 0 });
    expect(dash.byPriority).toEqual({ MEDIUM: 1 });
    expect(dash.oldestPendingAt).not.toBeNull();
  });

  it('history shows the decided rows, not the waiting ones', async () => {
    const approver = 'provider-Hist';
    const a = await service.submit(scope, draft({ senderId: approver }), {
      key: 'medspa.provider-always',
    });
    await service.submit(scope, draft({ senderId: approver }), { key: 'medspa.provider-always' });
    await service.decline(scope, a.approval.id, { ...provider, senderId: approver });

    const history = await service.history(scope, { approverRef: approver });
    expect(history.total).toBe(1);
    expect(history.approvals[0]!.status).toBe('DECLINED');
  });
});

describe('the SLA sweeper', () => {
  it('expires and escalates a pending approval past its deadline', async () => {
    const [policy] = await db
      .insert(approvalPolicies)
      .values({
        tenantId: TENANT,
        key: 'test.sla-escalate',
        name: 'Escalating',
        mode: 'always',
        approverResolution: { kind: 'agent' },
        rights: { approve: true },
        sla: { deadlineMs: 1, onExpiry: 'escalate', fallbackApproverRef: 'clinic-manager' },
      })
      .returning();

    const { approval } = await service.submit(scope, draft({ senderId: 'provider-Sla' }), {
      policyId: policy!.id,
    });
    expect(approval.slaDeadline).not.toBeNull();

    const escalations: string[] = [];
    const sweeper = new SlaSweeper({
      db,
      logger,
      approvals: service,
      policies,
      notify: async (notice) => {
        escalations.push(notice.fallbackApproverRef);
      },
    });

    const report = await sweeper.sweep(new Date(Date.now() + 60_000));
    expect(report.escalated).toBeGreaterThanOrEqual(1);
    expect(escalations).toContain('clinic-manager');

    const after = await service.getById(scope, approval.id);
    expect(after!.status).toBe('PENDING_APPROVAL');
    expect(after!.approverRef).toBe('clinic-manager');
    // EXPIRED is recorded as its own event rather than implied.
    expect(after!.auditTrail.map((e) => e.to)).toEqual([
      'PENDING_APPROVAL',
      'EXPIRED',
      'PENDING_APPROVAL',
    ]);
  });

  it('leaves an approval with no deadline alone forever', async () => {
    const { approval } = await service.submit(scope, draft({ senderId: 'provider-NoSla' }), {
      key: 'medspa.provider-always',
    });
    expect(approval.slaDeadline).toBeNull();

    const sweeper = new SlaSweeper({ db, logger, approvals: service, policies });
    const report = await sweeper.sweep(new Date(Date.now() + 86_400_000));

    const after = await service.getById(scope, approval.id);
    expect(after!.status).toBe('PENDING_APPROVAL');
    expect(report.failed).toBe(0);
  });
});
