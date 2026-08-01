-- =============================================================================
-- 9003_channel_configs.sql
--
-- medspa_configurations → tenant_channel_configs
-- provider_configurations → agent_channel_configs
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9003_channel_configs.sql
--
-- Requires 9000, 9001, 9002. Idempotent.
--
-- -----------------------------------------------------------------------------
-- THE SECRETS COPY ACROSS IN PLAINTEXT, AND THAT IS THE PLAN
--
-- `twilio_auth_token`, `sendgrid_api_key` and `slack_bot_token` are plaintext
-- columns in the source and plaintext columns in the target — 0001 kept the
-- flat credential columns exactly as the source has them so this script has
-- somewhere to land. Encryption is P12, and it has `credentials_encrypted` and
-- `encryption_key_id` already waiting on both tables so it needs no further
-- migration.
--
-- Two consequences the operator owns, both in the runbook's pre-flight:
--   - the target database inherits the source's exposure, so it needs the same
--     access controls from the moment this runs, not from cutover;
--   - the `pg_dump` taken before the run contains live provider credentials.
--
-- -----------------------------------------------------------------------------
-- IDS ARE PRESERVED
--
-- Nothing references these rows, so preserving the primary keys buys only one
-- thing — but it is the thing that matters during a parallel run: an operator
-- comparing a config in the old system with the new one can do it by id
-- instead of by eye.
-- =============================================================================

BEGIN;

SELECT mig.require_source('medspa_configurations');
SELECT mig.require_source('provider_configurations');

-- ── tenant_channel_configs ──────────────────────────────────────────────────
WITH ins AS (
  INSERT INTO tenant_channel_configs (
    id, tenant_id, name,
    twilio_account_sid, twilio_auth_token, twilio_phone_number, twilio_enabled,
    sendgrid_api_key, sendgrid_from_email, sendgrid_from_name, sendgrid_enabled,
    slack_bot_token, slack_default_channel, slack_enabled,
    timezone, default_language,
    business_hours_start, business_hours_end, business_days,
    sms_rate_limit, email_rate_limit,
    require_opt_in, retention_days, metadata, is_active,
    created_at, updated_at, created_by, updated_by
  )
  -- The COALESCEs cover the columns the target declares NOT NULL. They are all
  -- NOT NULL in the source too, so under the FDW transport they never fire —
  -- but a CSV-staged copy carries no constraints, and one NULL flag would
  -- otherwise abort the load rather than default the way the column says it
  -- should. Only values with an unambiguous default are treated this way;
  -- anything semantic is left to fail loudly.
  SELECT s.id, s.medspa_id, COALESCE(NULLIF(btrim(s.name), ''), s.medspa_id),
         s.twilio_account_sid, s.twilio_auth_token, s.twilio_phone_number,
         COALESCE(s.twilio_enabled, false),
         s.sendgrid_api_key, s.sendgrid_from_email, s.sendgrid_from_name,
         COALESCE(s.sendgrid_enabled, false),
         s.slack_bot_token, s.slack_default_channel,
         COALESCE(s.slack_enabled, false),
         COALESCE(NULLIF(btrim(s.timezone), ''),
                  COALESCE(mig.setting('default_tenant_timezone'), 'America/New_York')),
         COALESCE(NULLIF(btrim(s.default_language), ''), 'en'),
         s.business_hours_start, s.business_hours_end, s.business_days,
         s.sms_rate_limit::jsonb, s.email_rate_limit::jsonb,
         COALESCE(s.require_opt_in, true), COALESCE(s.retention_days, 365),
         s.metadata::jsonb, COALESCE(s.is_active, true),
         COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.updated_at), now()),
         s.created_by, s.updated_by
  FROM src.medspa_configurations s
  WHERE s.medspa_id IS NOT NULL
  ON CONFLICT DO NOTHING
  RETURNING 1
)
INSERT INTO mig.log (loader, detail, n)
SELECT '9003_channel_configs', 'tenant_channel_configs migrated', count(*) FROM ins;

-- ── agent_channel_configs ───────────────────────────────────────────────────
-- `receive_patient_notifications` is the one column whose name changes with the
-- vocabulary (§0.7); everything else is a straight copy. `provider_id` becomes
-- `sender_id` — the agent on whose behalf the engine sends.
WITH ins AS (
  INSERT INTO agent_channel_configs (
    id, tenant_id, sender_id, name,
    twilio_phone_number, twilio_enabled,
    email_from_address, email_from_name, email_enabled,
    slack_user_id, slack_enabled,
    preferred_channel, timezone, language,
    working_hours_start, working_hours_end, working_days,
    sms_rate_limit, email_rate_limit,
    receive_recipient_notifications, receive_system_notifications, receive_marketing_notifications,
    auto_response_enabled, auto_response_message, auto_response_delay_minutes,
    metadata, is_active, created_at, updated_at, created_by, updated_by
  )
  SELECT s.id, s.medspa_id, s.provider_id, COALESCE(NULLIF(btrim(s.name), ''), s.provider_id),
         s.twilio_phone_number, COALESCE(s.twilio_enabled, false),
         s.email_from_address, s.email_from_name, COALESCE(s.email_enabled, false),
         s.slack_user_id, COALESCE(s.slack_enabled, false),
         s.preferred_channel, s.timezone, s.language,
         s.working_hours_start, s.working_hours_end, s.working_days,
         s.sms_rate_limit::jsonb, s.email_rate_limit::jsonb,
         COALESCE(s.receive_patient_notifications, true),
         COALESCE(s.receive_system_notifications, true),
         COALESCE(s.receive_marketing_notifications, false),
         COALESCE(s.auto_response_enabled, false), s.auto_response_message,
         s.auto_response_delay_minutes,
         s.metadata::jsonb, COALESCE(s.is_active, true),
         COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.updated_at), now()),
         s.created_by, s.updated_by
  FROM src.provider_configurations s
  WHERE s.medspa_id IS NOT NULL AND s.provider_id IS NOT NULL
  ON CONFLICT DO NOTHING
  RETURNING 1
)
INSERT INTO mig.log (loader, detail, n)
SELECT '9003_channel_configs', 'agent_channel_configs migrated', count(*) FROM ins;

-- Anything with no tenant or no provider cannot be attributed. There should be
-- none — both columns are NOT NULL in the source — but the count is recorded
-- rather than assumed.
INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
SELECT '9003_channel_configs', 'provider_configurations', s.id::text,
       'provider_id or medspa_id is NULL',
       jsonb_build_object('providerId', s.provider_id, 'medspaId', s.medspa_id)
FROM src.provider_configurations s
WHERE s.medspa_id IS NULL OR s.provider_id IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO mig.progress (loader, watermark, rows_done, started_at, updated_at)
VALUES ('9003_channel_configs', now(),
        (SELECT count(*) FROM tenant_channel_configs) + (SELECT count(*) FROM agent_channel_configs),
        now(), now())
ON CONFLICT (loader) DO UPDATE
  SET watermark = EXCLUDED.watermark, rows_done = EXCLUDED.rows_done, updated_at = now();

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING
--
--   -- counts must match the source exactly
--   SELECT (SELECT count(*) FROM src.medspa_configurations)  AS src_tenant_cfgs,
--          (SELECT count(*) FROM tenant_channel_configs)     AS dst_tenant_cfgs,
--          (SELECT count(*) FROM src.provider_configurations) AS src_agent_cfgs,
--          (SELECT count(*) FROM agent_channel_configs)      AS dst_agent_cfgs;
--
--   -- credentials arrived intact (compares fingerprints, prints no secrets)
--   SELECT tenant_id, md5(coalesce(twilio_auth_token,'')) FROM tenant_channel_configs ORDER BY 1;
-- -----------------------------------------------------------------------------
