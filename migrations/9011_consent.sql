-- =============================================================================
-- 9011_consent.sql
--
-- Seed `consent_records` from the legacy preference data, so the compliance
-- gate can be switched on without blocking the entire migrated recipient base.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9011_consent.sql
--
-- Requires 0015 and 9006. Idempotent, and safe to re-run before cutover.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS CAN AND CANNOT HONESTLY CLAIM
--
-- The source has no consent table. It has `communication_preferences`, whose
-- `allow_communications` and per-channel `*_opt_in` flags record whether a
-- recipient has *objected*, not whether they ever *agreed*. Those are different
-- facts and this file must not pretend otherwise.
--
-- So every row written here carries `source = 'migration'` and a `proof` object
-- naming the legacy column it was derived from and the fact that no explicit
-- consent event exists. An auditor reading a row can tell in one glance that it
-- is an inference from a pre-existing relationship rather than a signed form,
-- which is exactly the distinction that matters if anyone ever has to defend it.
--
-- The alternative was worse in both directions. Writing nothing means every
-- migrated recipient becomes unreachable the moment `require_opt_in` is
-- enforced — a hard outage for a tenant whose patients have been receiving
-- appointment reminders for years. Writing rows that claim `signup_form` would
-- be fabricating evidence.
--
-- -----------------------------------------------------------------------------
-- WHO GETS A ROW
--
-- Only recipients the legacy data shows as contactable, per channel:
--
--   email  allow_communications AND email_opt_in
--   sms    allow_communications AND sms_opt_in
--
-- A recipient who opted out gets NO row rather than a revoked one. A revoked
-- row would assert they once consented, which is the thing this file cannot
-- know. Their opt-out already lives in `recipient_preferences` and check 2 of
-- the gate reads it — they are protected either way.
--
-- Only `email` and `sms` are seeded. Push, voice and letter have no live
-- delivery path (the push adapter is unwired; voice and letter are enum-only),
-- and seeding consent for a channel nothing can send on would be recording a
-- claim for no reason.
--
-- `granted_at` is the preference row's `created_at` — when the relationship
-- began, as far as anything here can establish.
-- =============================================================================

BEGIN;

SELECT mig.require_source('communication_preferences');

-- 0015 is what every write here conflicts against. Fail loudly rather than
-- duplicating rows a later constraint would then refuse to create.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'consent_records_recipient_channel_unique'
  ) THEN
    RAISE EXCEPTION
      'migration 0015 has not been applied — consent_records has no unique constraint to upsert against. Apply migrations/0015_consent.sql first. See docs/MIGRATION_RUNBOOK.md.';
  END IF;
END $$;

WITH seeded AS (
  INSERT INTO consent_records (
    tenant_id, sub_tenant_id, recipient_id, channel,
    granted, source, proof, granted_at, revoked_at, created_at, updated_at
  )
  SELECT
    p.tenant_id,
    p.sub_tenant_id,
    p.recipient_id,
    c.channel,
    true,
    'migration',
    jsonb_build_object(
      'derivedFrom', 'communication_preferences',
      'columns', c.columns,
      'note', 'Inferred from a pre-existing contact relationship. The source system recorded no explicit consent event.',
      'migratedAt', now()
    ),
    p.created_at,
    NULL,
    now(),
    now()
  FROM recipient_preferences p
  CROSS JOIN LATERAL (
    VALUES
      ('email', ARRAY['allow_communications', 'email_opt_in'], p.email_opt_in),
      ('sms',   ARRAY['allow_communications', 'sms_opt_in'],   p.sms_opt_in)
  ) AS c(channel, columns, opted_in)
  WHERE p.allow_communications
    AND c.opted_in
    -- Only preference rows this migration brought across.
    --
    -- 9006 preserves the source row's own id, so a preference row whose id
    -- exists in `src.communication_preferences` is one it loaded. That is a
    -- provable test rather than an inference from `external_ref`, which a
    -- recipient created through the compat shim after cutover would also
    -- satisfy — and such a recipient has its own consent story that must not be
    -- overwritten with a guess about a relationship that predates it.
    AND EXISTS (SELECT 1 FROM src.communication_preferences s WHERE s.id = p.id)
  -- Never overwrite. A consent recorded through the API — including one somebody
  -- revoked — is a real event, and a re-run of this file must not restore an
  -- inference over the top of it.
  ON CONFLICT (tenant_id, recipient_id, channel) DO NOTHING
  RETURNING 1
)
INSERT INTO mig.log (loader, detail, n)
SELECT '9011_consent', 'consent records seeded from legacy preferences', count(*) FROM seeded;

-- The other half of the count, so the operator can reconcile. These recipients
-- are deliberately left with no consent row and will be blocked by the gate
-- once enforcement is on — which is the correct outcome, and the runbook makes
-- the operator read this number before flipping COMPLIANCE_SHADOW_MODE.
INSERT INTO mig.log (loader, detail, n)
SELECT '9011_consent',
       'migrated recipients with NO consent on any channel (blocked once enforcement is on)',
       count(*)
FROM recipient_preferences p
WHERE EXISTS (SELECT 1 FROM src.communication_preferences s WHERE s.id = p.id)
  AND NOT EXISTS (
  SELECT 1 FROM consent_records cr
  WHERE cr.tenant_id = p.tenant_id
    AND cr.recipient_id = p.recipient_id
    AND cr.granted
    AND cr.revoked_at IS NULL
);

INSERT INTO mig.progress (loader, watermark, rows_done, started_at, updated_at)
VALUES ('9011_consent', now(), (SELECT count(*) FROM consent_records), now(), now())
ON CONFLICT (loader) DO UPDATE
  SET watermark = EXCLUDED.watermark, rows_done = EXCLUDED.rows_done, updated_at = now();

COMMIT;
