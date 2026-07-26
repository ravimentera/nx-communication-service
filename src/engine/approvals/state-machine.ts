/**
 * The approval state machine. Pure and table-driven: no database, no clock
 * beyond the one the caller supplies, no I/O of any kind. Everything that
 * changes an approval's status goes through `transition()`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A TABLE AND NOT `if` STATEMENTS
 *
 * The source has no state machine at all. It has two of them, implicitly, in
 * different vocabularies and different storage:
 *
 *   approvals.controller.ts               message_history.status = 'QUEUED'
 *                                         + queued_message->>'approvalStatus'
 *                                           in (PENDING_APPROVAL|APPROVED|DECLINED)
 *
 *   ai-enhanced-communication.controller  message_history.status
 *                                           in (PENDING_APPROVAL|APPROVED
 *                                              |SCHEDULED|REJECTED)
 *
 * Each guard is hand-written at the call site as
 * `if (queuedMessage.approvalStatus !== 'PENDING_APPROVAL') return 400`, repeated
 * five times (`approvals.controller.ts:342, :442, :550, :701`, and absent
 * entirely from the bulk path at :798). A sixth caller forgetting the guard is
 * how an already-declined message gets approved.
 *
 * Here the legal moves are data. Adding a state is a row in TRANSITIONS.
 *
 *                 ┌──────────── policy: none / threshold met ────────────┐
 *                 ▼                                                       │
 * [*] ──▶ DRAFT ──▶ AUTO_APPROVED ──┐                                     │
 *           │                        ├──▶ SCHEDULED ──▶ SENT ──▶ [*]      │
 *           └──▶ PENDING_APPROVAL ───┤                    ▲                │
 *                  │  │  │  │        │                    │                │
 *                  │  │  │  └─▶ APPROVED ─────────────────┘                │
 *                  │  │  └────▶ EDITED_APPROVED ──────────┘                │
 *                  │  └───────▶ DECLINED ──▶ [*]                           │
 *                  └──────────▶ EXPIRED ──┬─▶ PENDING_APPROVAL (escalated) │
 *                                         ├─▶ DECLINED  (sla: decline)     │
 *                                         └─▶ AUTO_APPROVED (sla: approve) │
 * Any non-terminal ──▶ CANCELLED
 *
 * WHAT `SENT` MEANS HERE
 *
 * `SENT` is written when the delivery worker reports the message actually left —
 * `record-result.ts` calls `ApprovalService.markSent()`. It is deliberately NOT
 * written when the message is handed to the queue: a scheduled message can sit
 * in a delayed job for days, and an approval row claiming SENT while nothing has
 * been sent is exactly the kind of lie the source's status columns tell today.
 * An approval rests at APPROVED / EDITED_APPROVED / AUTO_APPROVED / SCHEDULED
 * until delivery says otherwise.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { ApprovalStatus } from '../../db/schema/approvals.js';
import { APPROVAL_STATUSES } from '../../db/schema/approvals.js';
import { ConflictError } from '../../platform/http/errors.js';

export type { ApprovalStatus };
export { APPROVAL_STATUSES };

/**
 * Every legal move. A state whose list is empty is terminal.
 *
 * CANCELLED is reachable from every non-terminal state and appears in each list
 * explicitly rather than being special-cased in `transition()` — a reader should
 * be able to answer "can I cancel from here?" from this table alone.
 */
export const TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'AUTO_APPROVED', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'EDITED_APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'],
  APPROVED: ['SCHEDULED', 'SENT', 'CANCELLED'],
  EDITED_APPROVED: ['SCHEDULED', 'SENT', 'CANCELLED'],
  AUTO_APPROVED: ['SCHEDULED', 'SENT', 'CANCELLED'],
  EXPIRED: ['PENDING_APPROVAL', 'DECLINED', 'AUTO_APPROVED', 'CANCELLED'],
  SCHEDULED: ['SENT', 'CANCELLED'],
  DECLINED: [],
  SENT: [],
  CANCELLED: [],
} as const;

/** States from which nothing further can happen. */
export const TERMINAL_STATES: readonly ApprovalStatus[] = APPROVAL_STATUSES.filter(
  (status) => TRANSITIONS[status].length === 0,
);

/**
 * States meaning "a human (or the policy) said yes". The message may be sent.
 * Used for idempotency: approving an already-approved row returns it unchanged.
 */
export const APPROVED_STATES: readonly ApprovalStatus[] = [
  'APPROVED',
  'EDITED_APPROVED',
  'AUTO_APPROVED',
];

export function isTerminal(status: ApprovalStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Who or what made a move. `system` covers the SLA sweeper and the policy engine. */
export interface Actor {
  type: 'user' | 'system';
  /** The authenticated user, or a system component name such as `sla.worker`. */
  ref: string;
  /** The agent the user acts as — today's providerId. Drives `agent` authorization. */
  senderId?: string;
  role?: string;
  permissions?: string[];
}

export const SYSTEM_ACTOR = (ref: string): Actor => ({ type: 'system', ref });

/** One append-only entry on `approvals.audit_trail`. */
export interface AuditEntry {
  at: string;
  from: ApprovalStatus;
  to: ApprovalStatus;
  actorType: Actor['type'];
  actorRef: string;
  reason?: string;
  /** Set when the move changed the message body, so an edit is provable later. */
  contentHash?: string;
}

export class InvalidTransitionError extends ConflictError {
  constructor(
    readonly from: ApprovalStatus,
    readonly to: ApprovalStatus,
  ) {
    super(
      isTerminal(from)
        ? `Approval is already ${from}; no further transitions are possible`
        : `Cannot move an approval from ${from} to ${to}`,
      { from, to, allowed: TRANSITIONS[from] },
    );
  }
}

export interface TransitionInput {
  from: ApprovalStatus;
  to: ApprovalStatus;
  actor: Actor;
  reason?: string;
  contentHash?: string;
  /** Injected so tests and replays are deterministic. */
  now?: Date;
}

export interface TransitionOutcome {
  status: ApprovalStatus;
  entry: AuditEntry;
}

/**
 * Validate a move and produce the audit entry for it. Throws
 * `InvalidTransitionError` (HTTP 409) rather than returning a flag: an illegal
 * transition is a caller bug or a lost race, and both deserve to be loud.
 *
 * This function does not write anything. `appendAudit` puts the entry on the
 * row, and the service does exactly one UPDATE with both.
 */
export function transition(input: TransitionInput): TransitionOutcome {
  const { from, to, actor } = input;

  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }

  return {
    status: to,
    entry: {
      at: (input.now ?? new Date()).toISOString(),
      from,
      to,
      actorType: actor.type,
      actorRef: actor.ref,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.contentHash ? { contentHash: input.contentHash } : {}),
    },
  };
}

/**
 * Append to the trail. Append-only by construction — this returns a new array
 * with the entry at the end and never inspects or rewrites what came before.
 *
 * The stored column is `jsonb` and untyped at the database level, so a trail
 * read back from a legacy row may be anything; a non-array is treated as an
 * empty history rather than throwing, because losing the ability to record the
 * *current* move is worse than losing a malformed past one.
 */
export function appendAudit(existing: unknown, entry: AuditEntry): AuditEntry[] {
  const trail = Array.isArray(existing) ? (existing as AuditEntry[]) : [];
  return [...trail, entry];
}
