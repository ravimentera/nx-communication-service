-- =============================================================================
-- 0002_approvals.sql
--
-- Approval state becomes a real table.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0002_approvals.sql
--
-- Requires 0001 (approvals.message_id references messages).
--
-- -----------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS
--
-- Today approval state lives inside a JSONB blob:
--   message_history.queued_message->>'approvalStatus'
-- queried at approvals.controller.ts:76, :209, :223, :258 and :337, with the
-- approver hardwired to providerId. There is no constraint, no index that can
-- serve an SLA sweep, and no audit trail.
--
-- Worse, there are TWO parallel implementations with DIFFERENT vocabularies:
--   approvals.controller.ts                 APPROVED / DECLINED / SCHEDULED
--   ai-enhanced-communication.controller.ts APPROVED / SCHEDULED / REJECTED
--
-- The 10 states below unify them. DECLINED is canonical; the P9 backfill maps
-- REJECTED onto it.
-- =============================================================================

BEGIN;

-- `tenant_id` is NULLABLE: a NULL row is a pack-provided default policy shared
-- by every tenant that installed the pack (same convention as prompt_packs).
CREATE TABLE IF NOT EXISTS approval_policies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            text,
  pack_id              text,
  key                  text NOT NULL,
  name                 text NOT NULL,
  -- always    : every message waits for a human
  -- threshold : auto-approve when ai_confidence >= confidence_threshold
  -- sample    : auto-approve all but sample_rate of messages, for QA
  -- none      : never require approval
  mode                 text NOT NULL DEFAULT 'always',
  confidence_threshold numeric(4,3),
  sample_rate          numeric(4,3),
  -- {kind:'agent'} | {kind:'role',role} | {kind:'group',ids,semantics}
  -- | {kind:'round_robin',ids}
  approver_resolution  jsonb NOT NULL DEFAULT '{"kind":"agent"}'::jsonb,
  -- {approve,edit,decline,reschedule,bulk}
  rights               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {deadlineMs, onExpiry:'escalate'|'decline'|'approve', fallbackApproverRef}
  sla                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_policies_mode_check
    CHECK (mode IN ('always','threshold','sample','none'))
);
CREATE INDEX IF NOT EXISTS idx_approval_policies_key ON approval_policies (key);

CREATE TABLE IF NOT EXISTS approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL,
  sub_tenant_id    uuid,
  playbook_id      uuid,
  message_id       uuid NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING_APPROVAL',
  -- How approver_ref should be read: 'agent' | 'role' | 'group' | 'user'.
  approver_type    text,
  approver_ref     text,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  decided_by       text,
  sla_deadline     timestamptz,
  -- What the engine produced before any human edit. Kept for audit.
  original_content text,
  edited_content   text,
  decline_reason   text,
  ai_confidence    numeric(4,3),
  policy_id        uuid REFERENCES approval_policies(id) ON DELETE SET NULL,
  -- Append-only: [{at, actor, from, to, note}]
  audit_trail      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_status_check CHECK (status IN (
    'DRAFT','PENDING_APPROVAL','APPROVED','EDITED_APPROVED','AUTO_APPROVED',
    'DECLINED','EXPIRED','SCHEDULED','SENT','CANCELLED'
  )),
  -- One approval per message. This is the idempotency key: a retried enqueue
  -- must not be able to open a second pending approval for the same message.
  CONSTRAINT approvals_message_unique UNIQUE (message_id)
);

-- The SLA sweeper's query: what is pending and past its deadline?
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_status_deadline
  ON approvals (tenant_id, status, sla_deadline);
-- The approver's inbox query.
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_approver
  ON approvals (tenant_id, approver_ref, status, requested_at DESC);

-- Cross-migration foreign keys. Both sides exist only now, so they are added
-- here rather than inline. Guarded so re-applying is a no-op.
DO $$ BEGIN
  ALTER TABLE approvals
    ADD CONSTRAINT approvals_message_fk
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE messages
    ADD CONSTRAINT messages_approval_fk
    FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
