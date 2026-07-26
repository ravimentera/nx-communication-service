/**
 * Approvals as a real table.
 *
 * Today approval state lives in `message_history.queued_message->>'approvalStatus'`,
 * queried at `approvals.controller.ts:76,209,223,258,337`, with the approver
 * hardwired to `providerId`. Worse, there are TWO parallel implementations with
 * DIFFERENT state vocabularies:
 *
 *   approvals.controller.ts               APPROVED / DECLINED / SCHEDULED
 *   ai-enhanced-communication.controller  APPROVED / SCHEDULED / REJECTED
 *
 * P6 unifies them onto the 10 states below. DECLINED is canonical; REJECTED is
 * mapped to it during the P9 backfill.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, subTenantId, tenantId, ts, updatedAt } from './_shared.js';

export const APPROVAL_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'EDITED_APPROVED',
  'AUTO_APPROVED',
  'DECLINED',
  'EXPIRED',
  'SCHEDULED',
  'SENT',
  'CANCELLED',
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_MODES = ['always', 'threshold', 'sample', 'none'] as const;

/**
 * `tenant_id` is NULLABLE: a NULL row is a pack-provided default policy shared
 * by every tenant that installed the pack (same convention as `prompt_packs`).
 */
export const approvalPolicies = pgTable(
  'approval_policies',
  {
    id: id(),
    tenantId: text('tenant_id'),
    packId: text('pack_id'),
    key: text('key').notNull(),
    name: text('name').notNull(),
    /**
     * always    — every message waits for a human
     * threshold — auto-approve when ai_confidence >= confidence_threshold
     * sample    — auto-approve all but sample_rate of messages, for QA
     * none      — never require approval
     */
    mode: text('mode').notNull().default('always'),
    confidenceThreshold: numeric('confidence_threshold', { precision: 4, scale: 3 }),
    sampleRate: numeric('sample_rate', { precision: 4, scale: 3 }),
    /** {kind:'agent'} | {kind:'role',role} | {kind:'group',ids,semantics} | {kind:'round_robin',ids} */
    approverResolution: jsonb('approver_resolution').notNull().default(sql`'{"kind":"agent"}'::jsonb`),
    /** {approve,edit,decline,reschedule,bulk} */
    rights: jsonb('rights').notNull().default(sql`'{}'::jsonb`),
    /** {deadlineMs, onExpiry:'escalate'|'decline'|'approve', fallbackApproverRef} */
    sla: jsonb('sla').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('approval_policies_mode_check', sql`${t.mode} IN ('always','threshold','sample','none')`),
    index('idx_approval_policies_key').on(t.key),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    /** -> playbooks.id. Cross-file: FK declared in 0003. */
    playbookId: uuid('playbook_id'),
    /** -> messages.id. Cross-file: FK declared in 0002. */
    messageId: uuid('message_id').notNull(),
    status: text('status').notNull().default('PENDING_APPROVAL'),
    /** 'agent' | 'role' | 'group' | 'user' — how approver_ref should be read. */
    approverType: text('approver_type'),
    approverRef: text('approver_ref'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    decidedAt: ts('decided_at'),
    decidedBy: text('decided_by'),
    slaDeadline: ts('sla_deadline'),
    /** What the engine produced, before any human edit. Kept for audit. */
    originalContent: text('original_content'),
    editedContent: text('edited_content'),
    declineReason: text('decline_reason'),
    aiConfidence: numeric('ai_confidence', { precision: 4, scale: 3 }),
    /** -> approval_policies.id (same file, but nullable for ad-hoc approvals). */
    policyId: uuid('policy_id').references(() => approvalPolicies.id, { onDelete: 'set null' }),
    /** Append-only: [{at, actor, from, to, note}] */
    auditTrail: jsonb('audit_trail').notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'approvals_status_check',
      sql`${t.status} IN ('DRAFT','PENDING_APPROVAL','APPROVED','EDITED_APPROVED','AUTO_APPROVED','DECLINED','EXPIRED','SCHEDULED','SENT','CANCELLED')`,
    ),
    // One approval per message — this is the idempotency key. A retried
    // enqueue must not create a second pending approval for the same message.
    unique('approvals_message_unique').on(t.messageId),
    // The SLA sweeper's query: what is pending and past deadline?
    index('idx_approvals_tenant_status_deadline').on(t.tenantId, t.status, t.slaDeadline),
    // Every read here carries a tenant predicate, so the bare UNIQUE(message_id)
    // above cannot serve `getByMessageId`. Added in 0006.
    index('idx_approvals_tenant_message').on(t.tenantId, t.messageId),
    // The approver's inbox query.
    index('idx_approvals_tenant_approver').on(
      t.tenantId,
      t.approverRef,
      t.status,
      t.requestedAt.desc(),
    ),
  ],
);
