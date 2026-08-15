-- =============================================================================
-- 0013_encrypt_credentials.sql
--
-- Retire the plaintext channel-credential columns, now that
-- `credentials_encrypted` holds the same values sealed.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0013_encrypt_credentials.sql
--
-- Requires 0001 (tenant_channel_configs, and the reserved columns).
--
-- -----------------------------------------------------------------------------
-- DO NOT APPLY THIS UNTIL THREE THINGS ARE TRUE
--
--   1. A build with `CREDENTIAL_ENCRYPTION_KEYS` set is deployed and serving.
--      From then on every credential written through the API is sealed.
--
--   2. `node scripts/encrypt-credentials.mjs --apply` has been run and reports
--      that every credential is sealed. It seals the rows that existed before
--      step 1, which the service does not touch on its own.
--
--   3. **The parallel run is over.** `9003_channel_configs.sql` inserts
--      plaintext credentials, and the delta sync re-runs it. While mentera-core
--      is still the system of record, this migration nulls columns that are
--      about to be repopulated — and every row that arrives after it is
--      unsealed plaintext again. D84 flagged exactly this ordering.
--
-- The guard below enforces (2) and cannot enforce (1) or (3). Read them.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS DOES NOT DO
--
-- It does not encrypt anything. Sealing happens in Node, with a key this
-- database has never seen and must never see — that is the point of doing it in
-- the application rather than with `pgcrypto`, where the key would travel in the
-- statement and land in `pg_stat_statements` and the query log.
--
-- It also does not drop the columns. They are set to NULL and left in place:
--   - dropping is not reversible without a restore, and this is the one step
--     whose failure mode is "nobody can send anything";
--   - `9003_channel_configs.sql` names them, and the runbook keeps that file
--     runnable for the rollback window;
--   - a NULL column costs nothing.
-- Dropping them is a later, separate, boring migration once the rollback window
-- has closed.
--
-- -----------------------------------------------------------------------------
-- ROLLBACK
--
-- There is none from inside the database: the plaintext is gone and only the
-- application can recover it. To go back, restore `tenant_channel_configs` from
-- a backup taken immediately before this ran, or re-run
-- `9003_channel_configs.sql` against a source that still has the values.
-- Take that backup.
-- =============================================================================

BEGIN;

-- ── the guard ────────────────────────────────────────────────────────────────
-- Refuse if any row would lose a credential it cannot get back. `-> 'field'`
-- rather than `->>` so a sealed value that is a JSON object still counts as
-- present; the field names match TENANT_SECRET_COLUMNS in
-- src/engine/tenancy/credential-cipher.ts.
DO $$
DECLARE
  unsealed integer;
  detail   text;
BEGIN
  SELECT count(*),
         coalesce(string_agg(tenant_id, ', ' ORDER BY tenant_id), '')
    INTO unsealed, detail
    FROM tenant_channel_configs
   WHERE (twilio_auth_token IS NOT NULL
          AND (credentials_encrypted -> 'twilioAuthToken') IS NULL)
      OR (sendgrid_api_key IS NOT NULL
          AND (credentials_encrypted -> 'sendgridApiKey') IS NULL)
      OR (slack_bot_token IS NOT NULL
          AND (credentials_encrypted -> 'slackBotToken') IS NULL);

  IF unsealed > 0 THEN
    RAISE EXCEPTION
      'Refusing to null plaintext credentials: % tenant(s) still hold an unsealed credential (%). Run: node scripts/encrypt-credentials.mjs --apply',
      unsealed, detail;
  END IF;
END $$;

-- ── null the plaintext ───────────────────────────────────────────────────────
-- `twilio_account_sid` is NOT nulled. It is an account identifier rather than a
-- secret, it arrives in Twilio's own webhook payloads, and
-- `getTenantConfigByTwilioAccount` looks a row up by it to find the auth token
-- that verifies an inbound signature. Nulling it would break every callback.
UPDATE tenant_channel_configs
   SET twilio_auth_token = NULL,
       sendgrid_api_key  = NULL,
       slack_bot_token   = NULL,
       updated_at        = now()
 WHERE twilio_auth_token IS NOT NULL
    OR sendgrid_api_key IS NOT NULL
    OR slack_bot_token IS NOT NULL;

-- ── keep it that way ─────────────────────────────────────────────────────────
-- Without this, the next `9003` re-run or a hand-written UPDATE quietly puts
-- plaintext back and nothing notices until an audit. NOT VALID would let
-- existing rows through, which is not wanted: the UPDATE above has already made
-- every row conform, so the constraint is validated immediately and a violation
-- here means the UPDATE did not do what it claimed.
ALTER TABLE tenant_channel_configs
  DROP CONSTRAINT IF EXISTS tenant_channel_configs_no_plaintext_credentials;

ALTER TABLE tenant_channel_configs
  ADD CONSTRAINT tenant_channel_configs_no_plaintext_credentials
  CHECK (
    twilio_auth_token IS NULL
    AND sendgrid_api_key IS NULL
    AND slack_bot_token IS NULL
  );

COMMENT ON COLUMN tenant_channel_configs.credentials_encrypted IS
  'AES-256-GCM sealed credentials, keyed by column name. Written by the service and by scripts/encrypt-credentials.mjs. The key lives in CREDENTIAL_ENCRYPTION_KEYS and never reaches this database.';

COMMENT ON COLUMN tenant_channel_configs.encryption_key_id IS
  'Which key in CREDENTIAL_ENCRYPTION_KEYS sealed the most recent write. Values may name an older key; rotation is a backfill, not a single transaction.';

COMMIT;

-- =============================================================================
-- VERIFY
--
--   SELECT tenant_id,
--          credentials_encrypted IS NOT NULL AS sealed,
--          encryption_key_id,
--          twilio_auth_token IS NULL
--            AND sendgrid_api_key IS NULL
--            AND slack_bot_token IS NULL AS plaintext_cleared
--     FROM tenant_channel_configs
--    ORDER BY tenant_id;
--
-- Then send one message per configured channel per tenant. A credential that
-- did not seal correctly fails at resolution, loudly — `credential-cipher.ts`
-- never falls back to plaintext when opening fails.
-- =============================================================================
