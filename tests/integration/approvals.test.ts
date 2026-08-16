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

import { baselineMigrations } from '../helpers/migrations.js';

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

/**
 * Set to a reason to make the queue refuse every job, as a disabled or
 * unreachable one does. Reset in `afterEach`.
 */
let queueRefuses: string | null = null;

const queue: NotificationQueue = {
  enqueue: async (job, options) => {
    if (queueRefuses) return { queued: false, reason: queueRefuses };
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
  for (const file of baselineMigrations(dir)) {
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

/**
 * D105. A queue outage is not a decision, and must not be recorded as one.
 *
 * `release()` used to cancel any approval whose dispatch came back un-queued and
 * non-deferrable — which is right when compliance refused, and wrong when the
 * queue simply would not take the job. The two were indistinguishable in
 * `DispatchResult`, so an unreachable Redis silently threw away a human's
 * decision and left nothing to retry.
 */
describe('a queue that will not take the job', () => {
  afterEach(() => {
    queueRefuses = null;
  });

  async function approveWithQueueDown() {
    const recipient = await makeRecipient();
    const { approval } = await service.submit(scope, draft({ recipientId: recipient.id }), {
      key: 'medspa.provider-always',
    });

    queueRefuses = 'queue disabled';
    return { approval, result: await service.approve(scope, approval.id, provider) };
  }

  it('leaves the approval APPROVED — nothing decided against it', async () => {
    const { result } = await approveWithQueueDown();

    expect(result.dispatch).toMatchObject({ queued: false, transient: true });
    expect(result.approval.status).toBe('APPROVED');
    // And nothing pretends the compliance gate had an opinion about it.
    expect(result.approval.auditTrail.at(-1)).not.toMatchObject({
      actorRef: 'compliance.gate',
    });
  });

  it('marks the message FAILED rather than leaving it QUEUED with no job', async () => {
    const { approval } = await approveWithQueueDown();

    const [row] = await db.select().from(messages).where(eq(messages.id, approval.messageId));
    // QUEUED is the state that means something will pick this up. Nothing will.
    expect(row!.status).toBe('FAILED');
    expect((row!.metadata as { dispatchFailure?: { reason: string } }).dispatchFailure).toMatchObject(
      { reason: 'queue disabled' },
    );
    // Not a suppression: that column means the compliance gate stopped it.
    expect(row!.suppressionReason).toBeNull();
  });

  it('retries the send when approve is called again and the queue is back', async () => {
    const { approval } = await approveWithQueueDown();
    expect(queued).toHaveLength(0);

    queueRefuses = null;
    const retry = await service.approve(scope, approval.id, provider);

    // NOT reported as idempotent — that is what used to strand it.
    expect(retry.idempotent).toBeUndefined();
    expect(retry.dispatch).toMatchObject({ queued: true });
    expect(queued.map((q) => q.messageId)).toContain(approval.messageId);

    const [row] = await db.select().from(messages).where(eq(messages.id, approval.messageId));
    expect(row!.status).toBe('QUEUED');
    // The marker is cleared, or the next FAILED row would look like this one
    // and re-approving would send the message twice.
    expect((row!.metadata as { dispatchFailure?: unknown }).dispatchFailure).toBeUndefined();
  });

  it('is idempotent again once the retry has succeeded', async () => {
    const { approval } = await approveWithQueueDown();
    queueRefuses = null;
    await service.approve(scope, approval.id, provider);
    const before = queued.length;

    const third = await service.approve(scope, approval.id, provider);

    expect(third.idempotent).toBe(true);
    expect(queued).toHaveLength(before);
  });

  it('still cancels when compliance refuses — the two are not the same thing', async () => {
    // The behaviour this fix must not weaken. A permanent refusal leaves an
    // approval that can never be delivered, and it should not sit there looking
    // actionable.
    const recipient = await makeRecipient('unsubscribed');
    const { approval } = await service.submit(scope, draft({ recipientId: recipient.id }), {
      key: 'medspa.provider-always',
    });

    const result = await service.approve(scope, approval.id, provider);

    expect(result.dispatch).toMatchObject({ queued: false, skipped: 'RECIPIENT_UNSUBSCRIBED' });
    expect(result.dispatch?.transient).toBeUndefined();
    expect(result.approval.status).toBe('CANCELLED');
  });

  it('does not retry a message that failed at the worker rather than at the queue', async () => {
    // A delivery failure carries no `dispatchFailure` marker, so re-approving
    // must not re-send it. This is the double-send the marker exists to bound.
    const recipient = await makeRecipient();
    const { approval } = await service.submit(scope, draft({ recipientId: recipient.id }), {
      key: 'medspa.provider-always',
    });
    await service.approve(scope, approval.id, provider);
    const before = queued.length;

    await db
      .update(messages)
      .set({ status: 'FAILED' })
      .where(eq(messages.id, approval.messageId));

    const again = await service.approve(scope, approval.id, provider);

    expect(again.idempotent).toBe(true);
    expect(queued).toHaveLength(before);
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

  /**
   * `approve()` has an idempotency guard and `schedule()` had none, while
   * APPROVED → SCHEDULED is a legal transition — so scheduling after an approve
   * ran `release()` a second time. A second BullMQ job went out, and
   * `dispatcher.persist()` reset the message row from SENT back to QUEUED, so
   * the recipient got it twice and the log showed one send.
   */
  it('refuses to schedule an approval that has already been released', async () => {
    const { approval } = await service.submit(scope, draft({ senderId: 'provider-Sched' }), {
      key: 'medspa.provider-always',
    });

    await service.approve(scope, approval.id, {
      ...provider,
      senderId: 'provider-Sched',
    });
    expect(queued).toHaveLength(1);

    await expect(
      service.schedule(
        scope,
        approval.id,
        { ...provider, senderId: 'provider-Sched' },
        new Date(Date.now() + 3_600_000),
      ),
    ).rejects.toThrow(/already been released/);

    // Still one job, and the message row was not walked back to QUEUED.
    expect(queued).toHaveLength(1);
  });

  it('will not let a second dispatch move a SENT message back to QUEUED', async () => {
    const { approval } = await service.submit(scope, draft({ senderId: 'provider-Sent' }), {
      key: 'medspa.provider-always',
    });
    await service.approve(scope, approval.id, { ...provider, senderId: 'provider-Sent' });

    // The worker reports the send.
    await db
      .update(messages)
      .set({ status: 'SENT', sentAt: new Date() })
      .where(and(eq(messages.tenantId, TENANT), eq(messages.id, approval.messageId)));

    // Anything reaching the dispatcher for this row now is a duplicate.
    await expect(
      dispatcher(false).dispatch({
        messageId: approval.messageId,
        tenantId: TENANT,
        channel: 'email',
        to: { type: 'email', value: 'ada@example.test' },
        rendered: { body: 'again' },
      }),
    ).rejects.toThrow(/cannot be dispatched again/);

    const [row] = await db
      .select({ status: messages.status })
      .from(messages)
      .where(and(eq(messages.tenantId, TENANT), eq(messages.id, approval.messageId)));
    expect(row!.status).toBe('SENT');
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

/**
 * Reads are authorized the same way writes are.
 *
 * The mutations were tightened per row in P6 (D45) and the reads were missed —
 * so `getById` applied the tenant predicate and nothing else, and the list
 * filter was dropped entirely when the caller had no sender identity. Both
 * failed OPEN, which is the one direction an access check must not fail.
 */
describe('reading an approval is authorized per row', () => {
  it('hides another sender’s approval behind 404, not 403', async () => {
    const { approval } = await service.submit(scope, draft({ senderId: 'provider-Owner' }), {
      key: 'medspa.provider-always',
    });

    const owner: Actor = { type: 'user', ref: 'u-1', senderId: 'provider-Owner', role: 'provider', permissions: [] };
    const other: Actor = { type: 'user', ref: 'u-2', senderId: 'provider-Other', role: 'provider', permissions: [] };

    expect(await service.getByIdFor(scope, approval.id, owner)).not.toBeNull();

    // Not 403: answering "forbidden" would confirm an approval with this id
    // exists in the tenant, which is more than this caller should learn.
    expect(await service.getByIdFor(scope, approval.id, other)).toBeNull();
  });

  it('lets an approve-permission holder read any queue', async () => {
    const { approval } = await service.submit(scope, draft({ senderId: 'provider-Owner2' }), {
      key: 'medspa.provider-always',
    });

    const lead: Actor = {
      type: 'user',
      ref: 'u-3',
      senderId: 'provider-Lead',
      role: 'provider',
      permissions: ['outreach:approve'],
    };
    expect(await service.getByIdFor(scope, approval.id, lead)).not.toBeNull();
  });

  it('still hides it from another tenant', async () => {
    const { approval } = await service.submit(scope, draft({ senderId: PROVIDER }), {
      key: 'medspa.provider-always',
    });
    const admin: Actor = { type: 'user', ref: 'u-4', role: 'admin', permissions: ['outreach:admin'] };
    expect(await service.getByIdFor({ tenantId: 'other-tenant' }, approval.id, admin)).toBeNull();
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

  /**
   * The regression this suite did not have.
   *
   * The unit test asserted that the sweeper *called* `approve()` — against a
   * mock. It did, and `approve()` returned immediately: `AUTO_APPROVED` is in
   * `APPROVED_STATES`, so the idempotency guard treated an approval the sweeper
   * had just written as one already handled, and `release()` was never reached.
   * One of the three documented SLA outcomes sent nothing while the audit trail
   * said it had been approved. Only a real service and a real queue show it.
   */
  it('onExpiry: approve actually dispatches the message', async () => {
    const [policy] = await db
      .insert(approvalPolicies)
      .values({
        tenantId: TENANT,
        key: 'test.sla-auto-approve',
        name: 'Auto-approve on expiry',
        mode: 'always',
        approverResolution: { kind: 'agent' },
        rights: { approve: true },
        sla: { deadlineMs: 1, onExpiry: 'approve' },
      })
      .returning();

    const { approval } = await service.submit(scope, draft({ senderId: 'provider-Auto' }), {
      policyId: policy!.id,
    });

    const sweeper = new SlaSweeper({ db, logger, approvals: service, policies });
    const report = await sweeper.sweep(new Date(Date.now() + 60_000));
    expect(report).toMatchObject({ approved: 1, failed: 0 });

    const after = await service.getById(scope, approval.id);
    expect(after!.status).toBe('AUTO_APPROVED');
    // The policy decided, not a person — and the trail says so.
    expect(after!.decidedBy).toBe('sla.worker');
    expect(after!.auditTrail.map((e) => e.to)).toEqual([
      'PENDING_APPROVAL',
      'EXPIRED',
      'AUTO_APPROVED',
    ]);

    // The assertion that matters: a job exists for this message.
    expect(queued.map((j) => j.messageId)).toContain(approval.messageId);

    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.tenantId, TENANT), eq(messages.id, approval.messageId)));
    expect(row!.status).toBe('QUEUED');
  });

  it('recovers a row left EXPIRED by a crash between the two writes', async () => {
    const [policy] = await db
      .insert(approvalPolicies)
      .values({
        tenantId: TENANT,
        key: 'test.sla-stranded',
        name: 'Auto-approve on expiry (stranded)',
        mode: 'always',
        approverResolution: { kind: 'agent' },
        rights: { approve: true },
        sla: { deadlineMs: 1, onExpiry: 'approve' },
      })
      .returning();

    const { approval } = await service.submit(scope, draft({ senderId: 'provider-Stranded' }), {
      policyId: policy!.id,
    });

    // Exactly what a crash between `markExpired` and its follow-up leaves
    // behind. The old scan filtered on PENDING_APPROVAL, so from here on the
    // row was invisible: never sent, never declined, never seen again.
    await db
      .update(approvals)
      .set({ status: 'EXPIRED' })
      .where(and(eq(approvals.tenantId, TENANT), eq(approvals.id, approval.id)));

    const sweeper = new SlaSweeper({ db, logger, approvals: service, policies });
    const report = await sweeper.sweep(new Date(Date.now() + 60_000));

    expect(report).toMatchObject({ approved: 1, failed: 0 });
    expect((await service.getById(scope, approval.id))!.status).toBe('AUTO_APPROVED');
    expect(queued.map((j) => j.messageId)).toContain(approval.messageId);
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
