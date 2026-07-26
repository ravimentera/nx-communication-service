-- =============================================================================
-- 0006_approval_policies.sql
--
-- The two baseline approval policies, and the one index the approvals plane
-- turned out to need beyond what 0002 created.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0006_approval_policies.sql
--
-- Requires 0002 (approval_policies and approvals) and 0001 (messages).
--
-- -----------------------------------------------------------------------------
-- WHY THE TABLES ARE NOT HERE
--
-- `approvals` and `approval_policies` were both created in 0002, because P2
-- built the whole schema up front rather than deferring tables to the phase that
-- uses them (the same reason P4 shipped no migration at all, D36). This file
-- carries only what P6 discovered it needed: the seed rows, and an index for the
-- message-side lookup.
--
-- WHY tenant_id IS NULL ON BOTH SEEDS
--
-- A NULL tenant is a pack-provided default shared by every tenant that installed
-- the pack (D19, the same convention as prompt_packs). A tenant overrides one by
-- creating its own row with the same key — `PolicyService.load` sorts the
-- tenant's row first. The API cannot author a NULL-tenant row; only a migration
-- or the P7 pack loader can.
-- =============================================================================

BEGIN;

-- The unique indexes come FIRST, because the `ON CONFLICT DO NOTHING` on the
-- seeds below needs something to conflict on. Without them, a second apply
-- duplicates both rows and `load()` then has two pack defaults to choose
-- between.
--
-- Partial, because they constrain only the pack defaults: two tenants may each
-- hold their own row keyed 'medspa.provider-always', and must.
CREATE UNIQUE INDEX IF NOT EXISTS approval_policies_pack_key_unique
  ON approval_policies (key)
  WHERE tenant_id IS NULL;

-- One tenant may hold only one policy per key, for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS approval_policies_tenant_key_unique
  ON approval_policies (tenant_id, key)
  WHERE tenant_id IS NOT NULL;

-- `ApprovalService.getByMessageId` and the P9 backfill both look an approval up
-- by its message. The UNIQUE(message_id) constraint from 0002 already indexes
-- that, but only without a tenant predicate — and every read here carries one.
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_message
  ON approvals (tenant_id, message_id);

-- The medspa policy. This is today's behaviour, exactly: every AI-generated
-- message waits for the provider it belongs to. `ai-message-generator.ts:258`
-- writes `approvalStatus: 'PENDING_APPROVAL'` unconditionally and the approver
-- is whatever `providerId` is on the row — which is what {always, agent} says.
--
-- `bulk: true` matches the source's `/bulk-action` endpoint, which has no
-- permission check of any kind. The engine additionally requires the
-- `outreach:approve:bulk` permission, so this right alone does not grant it.
INSERT INTO approval_policies
  (id, tenant_id, pack_id, key, name, mode, approver_resolution, rights, sla)
VALUES (
  gen_random_uuid(), NULL, 'medspa', 'medspa.provider-always',
  'Provider approves everything',
  'always',
  '{"kind":"agent"}'::jsonb,
  '{"approve":true,"edit":true,"decline":true,"reschedule":true,"bulk":true}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT DO NOTHING;

-- Transactional messages — receipts, password resets, appointment confirmations.
-- Nobody reviews these, and `rights` is all-false so nobody can act on one
-- either: a `none` policy never produces an approval row to act on.
INSERT INTO approval_policies
  (id, tenant_id, pack_id, key, name, mode, approver_resolution, rights, sla)
VALUES (
  gen_random_uuid(), NULL, 'system', 'system.transactional',
  'Transactional — no approval',
  'none',
  '{"kind":"agent"}'::jsonb,
  '{"approve":false,"edit":false,"decline":false,"reschedule":false,"bulk":false}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT DO NOTHING;

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING, VERIFY THE SEEDS ARE SINGULAR:
--
--   SELECT key, count(*) FROM approval_policies WHERE tenant_id IS NULL
--   GROUP BY key HAVING count(*) > 1;
--
-- Must return zero rows. A non-empty result means this file was applied before
-- the partial unique index existed; delete the duplicates before continuing.
-- -----------------------------------------------------------------------------
