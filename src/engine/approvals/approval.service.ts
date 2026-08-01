/**
 * The one place approval state is read or written.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE THINGS THE SOURCE GETS WRONG THAT THIS DOES NOT
 *
 * 1. NO TENANT PREDICATE ON ANY MUTATION. Every write path in
 *    `approvals.controller.ts` looks the row up as
 *    `where(eq(messageHistory.id, messageId))` — approve (:325), decline (:426),
 *    edit (:687), edit-approve (:534), schedule (:981) and bulk (:792). No
 *    `medspaId`, no `tenantWhere`. A user in tenant A holding a message id from
 *    tenant B can approve, edit, decline or schedule it. `getApprovalHistory`
 *    (:921) reads across tenants for the same reason. Rule 4 exists for this.
 *
 * 2. THE PROVIDER CHECK GUARDS ONLY THE LIST. The `req.user.providerId !==
 *    providerId` rejection lives at :65–71, inside `getPendingApprovals` — and
 *    nowhere else. Provider A cannot *see* provider B's queue but can approve
 *    any message in it. Here authorization is applied per row, on every action.
 *
 * 3. APPROVING SENDS NOTHING. Approval flips `message_history.status` and
 *    `communication_events.status` to `'APPROVED'`, and no code reads either
 *    back — `grep -rn APPROVED src` outside these two controllers finds one
 *    unrelated enum value and one read-only display flag. The approved message
 *    sits forever. `approve()` here hands the message to `dispatcher.dispatch()`,
 *    which is also what puts the compliance gate downstream of approval:
 *    APPROVAL IS NOT A COMPLIANCE BYPASS. A provider approving a message to
 *    someone who unsubscribed produces a SUPPRESSED row, not a send.
 *
 * WHERE THE MESSAGE ROW COMES FROM
 *
 * `approvals.message_id` is NOT NULL and references `messages`, so a message row
 * must exist before an approval can. `submit()` writes it with status
 * `PENDING_APPROVAL` — which is precisely why P2 made `messages.sent_at`
 * nullable (D18). The dispatcher then *adopts* that row rather than inserting a
 * second one, so a single row carries the whole lifecycle:
 *
 *   PENDING_APPROVAL ──▶ QUEUED ──▶ SENT | FAILED
 *                    └─▶ SUPPRESSED  (compliance said no, after approval)
 *                    └─▶ CANCELLED   (declined)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto';

import { and, asc, count, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { approvals, messages } from '../../db/schema.js';
import type { ApprovalStatus } from '../../db/schema/approvals.js';
import type { Priority } from '../../domain/index.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { normalizeChannel, type ChannelType, type ContactPoint, type RenderedMessage } from '../../ports/channel.js';
import type { Dispatcher, DispatchResult } from '../delivery/dispatcher.js';
import {
  APPROVED_STATES,
  appendAudit,
  isTerminal,
  transition,
  type Actor,
  type AuditEntry,
} from './state-machine.js';
import {
  FALLBACK_POLICY,
  type ApprovalDecision,
  type ApprovalPolicy,
  type PolicyService,
} from './policy.service.js';

/** Permissions checked here rather than in middleware, because they are per row. */
const PERMISSION_APPROVE = 'outreach:approve';
const PERMISSION_APPROVE_BULK = 'outreach:approve:bulk';
const PERMISSION_ADMIN = 'outreach:admin';

/**
 * The delivery envelope, stashed on `messages.metadata` at submit time so
 * `approve()` can rebuild the dispatch call days later without the caller
 * having to hold anything.
 */
export interface DispatchEnvelope {
  to: ContactPoint;
  priority: Priority;
  playbookKey?: string;
  transactional?: boolean;
  throttle?: { maxPerRecipientPerDay?: number; cooldownHours?: number };
  html?: string;
  correlationId?: string;
}

export interface SubmitDraft {
  channel: ChannelType;
  to: ContactPoint;
  rendered: RenderedMessage;
  priority?: Priority;
  recipientId?: string;
  senderId?: string;
  playbookId?: string;
  playbookKey?: string;
  templateId?: string;
  aiGenerated?: boolean;
  aiConfidence?: number;
  lintErrors?: number;
  transactional?: boolean;
  throttle?: { maxPerRecipientPerDay?: number; cooldownHours?: number };
  correlationId?: string;
  /**
   * An existing `messages` row to attach to. Supplied by callers that already
   * persisted one; `UNIQUE(message_id)` makes a retried submit idempotent.
   */
  messageId?: string;
}

export interface Approval {
  id: string;
  tenantId: string;
  subTenantId: string | null;
  messageId: string;
  playbookId: string | null;
  status: ApprovalStatus;
  approverType: string | null;
  approverRef: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  slaDeadline: Date | null;
  originalContent: string | null;
  editedContent: string | null;
  declineReason: string | null;
  aiConfidence: number | null;
  policyId: string | null;
  auditTrail: AuditEntry[];
}

/** An approval joined to the parts of its message a reviewer needs to see. */
export interface ApprovalView extends Approval {
  channel: string;
  subject?: string;
  /** What would actually be sent: the edit if there is one, else the original. */
  content: string;
  priority: Priority;
  playbookKey?: string;
  recipientId: string | null;
  senderId: string | null;
  messageStatus: string;
}

export interface SubmitResult {
  approval: Approval;
  decision: ApprovalDecision;
  /** Present when the policy auto-approved and the message went straight out. */
  dispatch?: DispatchResult;
}

export interface ActionResult {
  approval: Approval;
  dispatch?: DispatchResult;
  /** True when the row was already in the requested state and nothing changed. */
  idempotent?: boolean;
}

export interface ListFilters {
  approverRef?: string;
  status?: ApprovalStatus | ApprovalStatus[];
  priority?: string;
  channel?: string;
  playbookKey?: string;
  page?: number;
  pageSize?: number;
  sortBy?: 'requestedAt' | 'slaDeadline';
  sortOrder?: 'asc' | 'desc';
}

export interface ApprovalServiceDeps {
  db: Db;
  logger: Logger;
  policies: PolicyService;
  dispatcher: Dispatcher;
}

export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  // ── submit ────────────────────────────────────────────────────────────────

  /**
   * Bring a draft under approval. Idempotent on the message: a second submit for
   * the same `messageId` returns the existing approval rather than opening a
   * second review, which `UNIQUE(message_id)` enforces even under a race.
   */
  async submit(
    scope: TenantScope,
    draft: SubmitDraft,
    policyRef: { policyId?: string | null; key?: string | null } = {},
  ): Promise<SubmitResult> {
    const policy =
      (await this.deps.policies.load(scope, policyRef)) ??
      (policyRef.policyId || policyRef.key
        ? null
        : FALLBACK_POLICY);

    if (!policy) {
      // Naming a policy that does not exist is a caller bug. Silently falling
      // back to "no approval needed" would send an unreviewed message; silently
      // falling back to "review" would strand it. Say so instead.
      throw new ValidationError('The referenced approval policy does not exist', {
        ...policyRef,
        tenantId: scope.tenantId,
      });
    }

    const messageId = draft.messageId ?? (await this.persistPendingMessage(scope, draft));

    const decision = await this.deps.policies.decide({
      policy,
      scope,
      draft: {
        messageId,
        aiConfidence: draft.aiConfidence,
        lintErrors: draft.lintErrors,
        senderId: draft.senderId,
        playbookId: draft.playbookId,
      },
    });

    const auto = decision.kind === 'auto';
    const actor: Actor = { type: 'system', ref: `policy:${policy.key}` };
    const initial = transition({
      from: 'DRAFT',
      to: auto ? 'AUTO_APPROVED' : 'PENDING_APPROVAL',
      actor,
      reason: auto ? decision.reason : `assigned to ${decision.approverRef}`,
    });

    const [inserted] = await this.deps.db
      .insert(approvals)
      .values({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        messageId,
        playbookId: draft.playbookId,
        status: initial.status,
        approverType: auto ? null : decision.approverType,
        approverRef: auto ? null : decision.approverRef,
        slaDeadline: auto ? null : (decision.slaDeadline ?? null),
        originalContent: draft.rendered.body,
        aiConfidence: draft.aiConfidence === undefined ? null : String(draft.aiConfidence),
        policyId: policy.id === FALLBACK_POLICY.id ? null : policy.id,
        auditTrail: [initial.entry],
      })
      // The unique index on message_id decides the race; the loser reads the winner's row.
      .onConflictDoNothing({ target: approvals.messageId })
      .returning();

    if (!inserted) {
      const existing = await this.getByMessageId(scope, messageId);
      if (!existing) {
        // The conflict was on a row belonging to another tenant — which means
        // the caller handed us someone else's message id.
        throw new NotFoundError(`No approval is visible for message '${messageId}'`);
      }
      this.deps.logger.info('submit is a no-op — this message is already under approval', {
        messageId,
        approvalId: existing.id,
        status: existing.status,
      });
      return { approval: existing, decision };
    }

    const approval = toApproval(inserted);

    if (auto) {
      const dispatch = await this.release(scope, approval, draft.rendered.body);
      return { approval: dispatch.approval, decision, dispatch: dispatch.dispatch };
    }

    this.deps.logger.info('approval opened', {
      approvalId: approval.id,
      messageId,
      approverType: approval.approverType,
      policyKey: policy.key,
      slaDeadline: approval.slaDeadline?.toISOString(),
    });
    return { approval, decision };
  }

  /**
   * The `messages` row for a draft that has not been approved yet.
   *
   * `status = 'PENDING_APPROVAL'` and `sent_at` NULL. The delivery envelope goes
   * on `metadata` because the approval row has no column for a contact point,
   * and reconstructing one from `recipients.contact_points` at approve time
   * would silently retarget a message whose recipient changed their address in
   * between.
   */
  private async persistPendingMessage(scope: TenantScope, draft: SubmitDraft): Promise<string> {
    const envelope: DispatchEnvelope = {
      to: draft.to,
      priority: draft.priority ?? 'MEDIUM',
      ...(draft.playbookKey ? { playbookKey: draft.playbookKey } : {}),
      ...(draft.transactional === undefined ? {} : { transactional: draft.transactional }),
      ...(draft.throttle ? { throttle: draft.throttle } : {}),
      ...(draft.rendered.html ? { html: draft.rendered.html } : {}),
      ...(draft.correlationId ? { correlationId: draft.correlationId } : {}),
    };

    const [row] = await this.deps.db
      .insert(messages)
      .values({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        recipientId: draft.recipientId,
        senderId: draft.senderId,
        channel: draft.channel,
        direction: 'outbound',
        content: draft.rendered.body,
        status: 'PENDING_APPROVAL',
        playbookId: draft.playbookId,
        templateId: draft.templateId,
        aiGenerated: draft.aiGenerated ?? false,
        metadata: {
          subject: draft.rendered.subject,
          to: draft.to.value,
          priority: envelope.priority,
          ...(draft.playbookKey ? { playbookKey: draft.playbookKey } : {}),
          ...(draft.correlationId ? { correlationId: draft.correlationId } : {}),
          dispatch: envelope,
        },
      })
      .returning({ id: messages.id });

    if (!row) throw new Error('failed to persist the pending message row');
    return row.id;
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async getById(scope: TenantScope, id: string): Promise<ApprovalView | null> {
    const [row] = await this.selectView().where(
      and(eq(approvals.tenantId, scope.tenantId), eq(approvals.id, id)),
    );
    return row ? toView(row) : null;
  }

  async getByMessageId(scope: TenantScope, messageId: string): Promise<Approval | null> {
    const [row] = await this.deps.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.tenantId, scope.tenantId), eq(approvals.messageId, messageId)))
      .limit(1);
    return row ? toApproval(row) : null;
  }

  /**
   * The approver's inbox. Defaults to PENDING_APPROVAL, which is what the
   * source's `/pending/:providerId` returns; `history()` is the same query with
   * the decided states instead.
   */
  async listPending(
    scope: TenantScope,
    filters: ListFilters = {},
  ): Promise<{ approvals: ApprovalView[]; total: number; page: number; pageSize: number }> {
    return this.list(scope, { status: 'PENDING_APPROVAL', ...filters });
  }

  async history(
    scope: TenantScope,
    filters: ListFilters = {},
  ): Promise<{ approvals: ApprovalView[]; total: number; page: number; pageSize: number }> {
    return this.list(scope, {
      status: ['APPROVED', 'EDITED_APPROVED', 'AUTO_APPROVED', 'DECLINED', 'SENT', 'CANCELLED'],
      sortBy: 'requestedAt',
      sortOrder: 'desc',
      ...filters,
    });
  }

  async list(
    scope: TenantScope,
    filters: ListFilters = {},
  ): Promise<{ approvals: ApprovalView[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
    const where = this.filterClause(scope, filters);

    const column = filters.sortBy === 'slaDeadline' ? approvals.slaDeadline : approvals.requestedAt;
    const order = filters.sortOrder === 'asc' ? asc(column) : desc(column);

    const [rows, [counted]] = await Promise.all([
      this.selectView()
        .where(where)
        .orderBy(order)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.deps.db
        .select({ count: count() })
        .from(approvals)
        .innerJoin(messages, eq(messages.id, approvals.messageId))
        .where(where),
    ]);

    return { approvals: rows.map(toView), total: counted?.count ?? 0, page, pageSize };
  }

  /** Counts by status, priority and age, for the approver's dashboard header. */
  async dashboard(
    scope: TenantScope,
    approverRef?: string,
  ): Promise<{
    pending: number;
    approvedToday: number;
    approvedThisWeek: number;
    declined: number;
    overdue: number;
    byPriority: Record<string, number>;
    oldestPendingAt: string | null;
  }> {
    const base: SQL[] = [eq(approvals.tenantId, scope.tenantId)];
    if (approverRef) base.push(eq(approvals.approverRef, approverRef));

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

    const decided = ['APPROVED', 'EDITED_APPROVED', 'AUTO_APPROVED', 'SENT'];

    const [[pending], [today], [week], [declined], [overdue], priorities, [oldest]] =
      await Promise.all([
        this.count([...base, eq(approvals.status, 'PENDING_APPROVAL')]),
        this.count([...base, inArray(approvals.status, decided), gte(approvals.decidedAt, startOfToday)]),
        this.count([...base, inArray(approvals.status, decided), gte(approvals.decidedAt, startOfWeek)]),
        this.count([...base, eq(approvals.status, 'DECLINED')]),
        this.count([
          ...base,
          eq(approvals.status, 'PENDING_APPROVAL'),
          lt(approvals.slaDeadline, new Date()),
        ]),
        this.deps.db
          .select({
            priority: sql<string>`coalesce(${messages.metadata}->>'priority', 'MEDIUM')`,
            count: count(),
          })
          .from(approvals)
          .innerJoin(messages, eq(messages.id, approvals.messageId))
          .where(and(...base, eq(approvals.status, 'PENDING_APPROVAL')))
          .groupBy(sql`coalesce(${messages.metadata}->>'priority', 'MEDIUM')`),
        this.deps.db
          .select({ at: approvals.requestedAt })
          .from(approvals)
          .where(and(...base, eq(approvals.status, 'PENDING_APPROVAL')))
          .orderBy(asc(approvals.requestedAt))
          .limit(1),
      ]);

    return {
      pending: pending?.count ?? 0,
      approvedToday: today?.count ?? 0,
      approvedThisWeek: week?.count ?? 0,
      declined: declined?.count ?? 0,
      overdue: overdue?.count ?? 0,
      byPriority: Object.fromEntries(priorities.map((p) => [p.priority, p.count])),
      oldestPendingAt: oldest?.at?.toISOString() ?? null,
    };
  }

  // ── actions ───────────────────────────────────────────────────────────────

  async approve(scope: TenantScope, id: string, actor: Actor): Promise<ActionResult> {
    const current = await this.require(scope, id);
    this.authorize(current, actor, 'approve');

    // Idempotent: the FE double-clicks, the network retries, the operator runs
    // the same bulk action twice. Approving an approved row is a no-op that
    // returns 200 — and crucially does NOT dispatch a second time.
    if (APPROVED_STATES.includes(current.status) || current.status === 'SENT') {
      return { approval: current, idempotent: true };
    }

    const body = current.editedContent ?? current.originalContent ?? '';
    const edited = current.editedContent !== null;

    const approval = await this.move(scope, current, {
      to: edited ? 'EDITED_APPROVED' : 'APPROVED',
      actor,
      set: { decidedAt: new Date(), decidedBy: actor.ref },
      ...(edited ? { contentHash: hashOf(body) } : {}),
    });

    const released = await this.release(scope, approval, body);
    return { approval: released.approval, dispatch: released.dispatch };
  }

  /** Save an edit without deciding. The row stays PENDING_APPROVAL. */
  async edit(
    scope: TenantScope,
    id: string,
    actor: Actor,
    content: string,
    subject?: string,
  ): Promise<Approval> {
    const current = await this.require(scope, id);
    this.authorize(current, actor, 'edit');

    if (current.status !== 'PENDING_APPROVAL') {
      throw new ValidationError(`Only a pending approval can be edited; this one is ${current.status}`);
    }
    if (!content.trim()) {
      throw new ValidationError('Content is required for an edit');
    }

    // `original_content` is written once, at submit, and never overwritten —
    // repeated edits must not lose what the engine actually produced. The source
    // gets this right at `approvals.controller.ts:711` and it is worth keeping.
    const [row] = await this.deps.db
      .update(approvals)
      .set({
        editedContent: content,
        auditTrail: appendAudit(current.auditTrail, {
          at: new Date().toISOString(),
          from: 'PENDING_APPROVAL',
          to: 'PENDING_APPROVAL',
          actorType: actor.type,
          actorRef: actor.ref,
          reason: 'content edited',
          contentHash: hashOf(content),
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(approvals.tenantId, scope.tenantId), eq(approvals.id, id)))
      .returning();

    if (!row) throw new NotFoundError(`Approval '${id}' not found`);

    // Keep the message row in step, so a reviewer reading `messages.content`
    // and one reading the approval see the same text.
    await this.deps.db
      .update(messages)
      .set({
        content,
        ...(subject === undefined
          ? {}
          : { metadata: sql`${messages.metadata} || ${JSON.stringify({ subject })}::jsonb` }),
        updatedAt: new Date(),
      })
      .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.id, current.messageId)));

    return toApproval(row);
  }

  async editThenApprove(
    scope: TenantScope,
    id: string,
    actor: Actor,
    content: string,
    subject?: string,
  ): Promise<ActionResult> {
    await this.edit(scope, id, actor, content, subject);
    return this.approve(scope, id, actor);
  }

  async decline(
    scope: TenantScope,
    id: string,
    actor: Actor,
    reason?: string,
  ): Promise<ActionResult> {
    const current = await this.require(scope, id);
    this.authorize(current, actor, 'decline');

    if (current.status === 'DECLINED') {
      return { approval: current, idempotent: true };
    }

    const approval = await this.move(scope, current, {
      to: 'DECLINED',
      actor,
      reason,
      set: { decidedAt: new Date(), decidedBy: actor.ref, declineReason: reason ?? null },
    });

    // A declined message is not deleted — it stays as evidence, marked. The
    // source leaves it QUEUED forever, which is indistinguishable from a message
    // waiting to be sent.
    await this.setMessageStatus(scope, current.messageId, 'CANCELLED');

    return { approval };
  }

  /**
   * Approve for later. The message is dispatched now with a BullMQ delay, so the
   * send is durable across a restart; the source stored a `scheduledFor` string
   * that nothing ever read.
   */
  async schedule(
    scope: TenantScope,
    id: string,
    actor: Actor,
    sendAt: Date,
  ): Promise<ActionResult> {
    const current = await this.require(scope, id);
    this.authorize(current, actor, 'reschedule');

    if (Number.isNaN(sendAt.getTime())) {
      throw new ValidationError('sendAt is not a valid date');
    }
    if (sendAt.getTime() <= Date.now()) {
      throw new ValidationError('sendAt must be in the future');
    }

    const body = current.editedContent ?? current.originalContent ?? '';

    // A pending approval is approved on the way through, so scheduling from the
    // inbox is one action rather than approve-then-schedule.
    let approval = current;
    if (current.status === 'PENDING_APPROVAL') {
      approval = await this.move(scope, current, {
        to: current.editedContent !== null ? 'EDITED_APPROVED' : 'APPROVED',
        actor,
        reason: `scheduled for ${sendAt.toISOString()}`,
        set: { decidedAt: new Date(), decidedBy: actor.ref },
      });
    }

    approval = await this.move(scope, approval, {
      to: 'SCHEDULED',
      actor,
      reason: `send at ${sendAt.toISOString()}`,
    });

    const released = await this.release(scope, approval, body, sendAt);
    return { approval: released.approval, dispatch: released.dispatch };
  }

  async cancel(scope: TenantScope, id: string, actor: Actor, reason?: string): Promise<Approval> {
    const current = await this.require(scope, id);
    this.authorize(current, actor, 'decline');
    const approval = await this.move(scope, current, { to: 'CANCELLED', actor, reason });
    await this.setMessageStatus(scope, current.messageId, 'CANCELLED');
    return approval;
  }

  /**
   * Called by the delivery worker once the message has actually left, so `SENT`
   * on an approval means sent rather than "queued and hoped for".
   *
   * Never throws: a bookkeeping failure must not fail a delivery that succeeded.
   */
  async markSent(scope: TenantScope, messageId: string): Promise<void> {
    try {
      const current = await this.getByMessageId(scope, messageId);
      if (!current || current.status === 'SENT' || isTerminal(current.status)) return;

      await this.move(scope, current, {
        to: 'SENT',
        actor: { type: 'system', ref: 'delivery.worker' },
      });
    } catch (error) {
      this.deps.logger.warn('could not mark the approval as sent', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Apply one action across many approvals.
   *
   * Requires BOTH `outreach:approve:bulk` and `policy.rights.bulk`: the
   * permission says this user may act in bulk at all, the right says this
   * particular policy tolerates it. A tenant whose policy forbids bulk approval
   * of clinical messages is not overridden by a broadly-granted permission.
   *
   * One failure does not abort the batch — each id reports its own outcome, as
   * the source does at `approvals.controller.ts:882`.
   */
  async bulk(
    scope: TenantScope,
    ids: string[],
    action: 'approve' | 'decline' | 'cancel',
    actor: Actor,
    reason?: string,
  ): Promise<{ results: { id: string; ok: boolean; status?: ApprovalStatus; error?: string }[] }> {
    if (ids.length === 0) throw new ValidationError('ids must not be empty');
    if (ids.length > 500) throw new ValidationError('A bulk action is limited to 500 approvals');

    if (!this.isAdmin(actor) && !actor.permissions?.includes(PERMISSION_APPROVE_BULK)) {
      throw new ForbiddenError('Bulk approval requires the outreach:approve:bulk permission');
    }

    const results: { id: string; ok: boolean; status?: ApprovalStatus; error?: string }[] = [];

    for (const id of ids) {
      try {
        const outcome =
          action === 'approve'
            ? await this.approve(scope, id, actor)
            : action === 'decline'
              ? await this.decline(scope, id, actor, reason)
              : { approval: await this.cancel(scope, id, actor, reason) };
        results.push({ id, ok: true, status: outcome.approval.status });
      } catch (error) {
        results.push({
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { results };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Hand an approved message to delivery. This is the only path from an
   * approval to a send, and it goes through the dispatcher — so the P5
   * compliance gate runs *after* approval, not instead of it.
   */
  private async release(
    scope: TenantScope,
    approval: Approval,
    body: string,
    sendAt?: Date,
  ): Promise<{ approval: Approval; dispatch: DispatchResult }> {
    const [row] = await this.deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.id, approval.messageId)))
      .limit(1);

    if (!row) throw new NotFoundError(`Message '${approval.messageId}' not found`);

    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const envelope = (metadata.dispatch ?? {}) as Partial<DispatchEnvelope>;

    if (!envelope.to?.value) {
      throw new ValidationError(
        'The message carries no delivery envelope, so there is nowhere to send it',
        { messageId: approval.messageId },
      );
    }

    const dispatch = await this.deps.dispatcher.dispatch({
      messageId: approval.messageId,
      tenantId: scope.tenantId,
      subTenantId: scope.subTenantId,
      // Sound because `messages.channel` holds the normalised spelling — see
      // normalizeChannel(). `registry.get()` on the other side has no fallback.
      channel: normalizeChannel(row.channel) as ChannelType,
      to: envelope.to,
      rendered: {
        body,
        subject: metadata.subject as string | undefined,
        ...(envelope.html ? { html: envelope.html } : {}),
      },
      priority: envelope.priority ?? 'MEDIUM',
      recipientId: row.recipientId ?? undefined,
      senderId: row.senderId ?? undefined,
      playbookId: row.playbookId ?? undefined,
      playbookKey: envelope.playbookKey,
      templateId: row.templateId ?? undefined,
      approvalId: approval.id,
      aiGenerated: row.aiGenerated,
      correlationId: envelope.correlationId,
      transactional: envelope.transactional,
      throttle: envelope.throttle,
      sendAt,
    });

    // Compliance said no, permanently. The approval is cancelled rather than
    // left looking approved-and-pending forever, and the audit trail records
    // why. Deferrals are left alone: `retryAt` means later, not never, and P7's
    // scheduler picks them back up.
    if (!dispatch.queued && dispatch.skipped && !dispatch.deferrable) {
      const cancelled = await this.move(this.scopeOf(approval), approval, {
        to: 'CANCELLED',
        actor: { type: 'system', ref: 'compliance.gate' },
        reason: dispatch.skipped,
      });
      this.deps.logger.info('approved message was not released', {
        approvalId: approval.id,
        reason: dispatch.skipped,
      });
      return { approval: cancelled, dispatch };
    }

    return { approval, dispatch };
  }

  /** Validate the move, write the new status and append to the trail — one UPDATE. */
  private async move(
    scope: TenantScope,
    current: Approval,
    input: {
      to: ApprovalStatus;
      actor: Actor;
      reason?: string;
      contentHash?: string;
      set?: Partial<{
        decidedAt: Date;
        decidedBy: string;
        declineReason: string | null;
        approverRef: string;
        approverType: string;
        slaDeadline: Date | null;
      }>;
    },
  ): Promise<Approval> {
    const outcome = transition({
      from: current.status,
      to: input.to,
      actor: input.actor,
      reason: input.reason,
      contentHash: input.contentHash,
    });

    const [row] = await this.deps.db
      .update(approvals)
      .set({
        status: outcome.status,
        auditTrail: appendAudit(current.auditTrail, outcome.entry),
        updatedAt: new Date(),
        ...(input.set ?? {}),
      })
      .where(
        and(
          eq(approvals.tenantId, scope.tenantId),
          eq(approvals.id, current.id),
          // Optimistic concurrency: two approvers clicking at once means one
          // UPDATE matches nothing, rather than both writing over each other.
          eq(approvals.status, current.status),
        ),
      )
      .returning();

    if (!row) {
      throw new NotFoundError(
        `Approval '${current.id}' changed underneath this request; re-read it and try again`,
      );
    }

    return toApproval(row);
  }

  private async require(scope: TenantScope, id: string): Promise<Approval> {
    const [row] = await this.deps.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.tenantId, scope.tenantId), eq(approvals.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError(`Approval '${id}' not found`);
    return toApproval(row);
  }

  /**
   * Per-row authorization, applied to every action.
   *
   * `agent` is today's rule generalized: the sender the message belongs to is
   * the one who may act on it — `approvals.controller.ts:65–71`, which the
   * source applies to the pending list and to nothing else. Every other
   * approver kind requires `outreach:approve`, because "is this user in that
   * role or group" is not a question this service can answer until P12 wires a
   * real authorization provider, and a permission is the honest stand-in.
   */
  private authorize(approval: Approval, actor: Actor, right: keyof ApprovalRightsShape): void {
    if (this.isAdmin(actor)) return;

    if (approval.approverType === 'agent' || approval.approverType === null) {
      if (!actor.senderId || actor.senderId !== approval.approverRef) {
        throw new ForbiddenError(
          'Access denied: you can only act on approvals assigned to you',
          { right },
        );
      }
      return;
    }

    if (!actor.permissions?.includes(PERMISSION_APPROVE)) {
      throw new ForbiddenError(
        `This approval is assigned to a ${approval.approverType}; acting on it requires the ${PERMISSION_APPROVE} permission`,
        { right, approverRef: approval.approverRef },
      );
    }

    // `group` with `all_of` semantics needs every member to decide. The
    // aggregate lives in the audit trail; until a second decider is modelled,
    // membership in the group is the requirement.
    if (approval.approverType === 'group' && approval.approverRef) {
      const members = approval.approverRef.split(',');
      const identity = actor.senderId ?? actor.ref;
      if (!members.includes(identity)) {
        throw new ForbiddenError('Access denied: you are not a member of this approval group', {
          right,
        });
      }
    }
  }

  private isAdmin(actor: Actor): boolean {
    return (
      actor.type === 'system' ||
      actor.role === 'admin' ||
      (actor.permissions?.includes(PERMISSION_ADMIN) ?? false)
    );
  }

  private scopeOf(approval: Approval): TenantScope {
    return { tenantId: approval.tenantId, subTenantId: approval.subTenantId ?? undefined };
  }

  private async setMessageStatus(
    scope: TenantScope,
    messageId: string,
    status: string,
  ): Promise<void> {
    await this.deps.db
      .update(messages)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.id, messageId)));
  }

  private count(clauses: SQL[]) {
    return this.deps.db
      .select({ count: count() })
      .from(approvals)
      .where(and(...clauses));
  }

  private selectView() {
    return this.deps.db
      .select({
        approval: approvals,
        channel: messages.channel,
        recipientId: messages.recipientId,
        senderId: messages.senderId,
        messageStatus: messages.status,
        metadata: messages.metadata,
      })
      .from(approvals)
      .innerJoin(messages, eq(messages.id, approvals.messageId));
  }

  private filterClause(scope: TenantScope, filters: ListFilters): SQL {
    const clauses: SQL[] = [eq(approvals.tenantId, scope.tenantId)];

    if (scope.subTenantId) clauses.push(eq(approvals.subTenantId, scope.subTenantId));
    if (filters.approverRef) clauses.push(eq(approvals.approverRef, filters.approverRef));

    if (filters.status) {
      clauses.push(
        Array.isArray(filters.status)
          ? inArray(approvals.status, filters.status)
          : eq(approvals.status, filters.status),
      );
    }

    if (filters.channel) clauses.push(eq(messages.channel, normalizeChannel(filters.channel)));

    // Priority and playbook key live on the message's JSONB, not on a column of
    // their own — the same shape the source filtered on
    // (`queued_message->>'priority'`), read from the new home.
    if (filters.priority) {
      clauses.push(sql`${messages.metadata}->>'priority' = ${filters.priority}`);
    }
    if (filters.playbookKey) {
      clauses.push(sql`${messages.metadata}->>'playbookKey' = ${filters.playbookKey}`);
    }

    return and(...clauses) as SQL;
  }
}

type ApprovalRightsShape = { approve: true; edit: true; decline: true; reschedule: true };

type ApprovalRow = typeof approvals.$inferSelect;

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    tenantId: row.tenantId,
    subTenantId: row.subTenantId,
    messageId: row.messageId,
    playbookId: row.playbookId,
    status: row.status as ApprovalStatus,
    approverType: row.approverType,
    approverRef: row.approverRef,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    slaDeadline: row.slaDeadline,
    originalContent: row.originalContent,
    editedContent: row.editedContent,
    declineReason: row.declineReason,
    // `numeric` arrives as a string from pg.
    aiConfidence: row.aiConfidence === null ? null : Number(row.aiConfidence),
    policyId: row.policyId,
    auditTrail: Array.isArray(row.auditTrail) ? (row.auditTrail as AuditEntry[]) : [],
  };
}

function toView(row: {
  approval: ApprovalRow;
  channel: string;
  recipientId: string | null;
  senderId: string | null;
  messageStatus: string;
  metadata: unknown;
}): ApprovalView {
  const approval = toApproval(row.approval);
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;

  return {
    ...approval,
    channel: row.channel,
    subject: metadata.subject as string | undefined,
    // What would actually go out. The source recomputes this at four call sites
    // and gets it right at three of them.
    content: approval.editedContent ?? approval.originalContent ?? '',
    priority: (metadata.priority as Priority) ?? 'MEDIUM',
    playbookKey: metadata.playbookKey as string | undefined,
    recipientId: row.recipientId,
    senderId: row.senderId,
    messageStatus: row.messageStatus,
  };
}

/** Short, stable fingerprint of a body, so an edit is provable from the trail. */
function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export type { ApprovalPolicy };
