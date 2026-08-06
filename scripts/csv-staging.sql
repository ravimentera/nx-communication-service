-- =============================================================================
-- csv-staging.sql — the transport of last resort
--
-- Builds the same `src` schema that migrations/9001_source_link.sql builds with
-- postgres_fdw, but as ordinary tables you load from CSV. Every 9xxx script
-- after that is byte-identical either way: they read `src.<table>` and never
-- name a database.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/csv-staging.sql
--
-- USE FDW IF YOU POSSIBLY CAN (runbook §3). This path exists for the case where
-- the target cannot reach the source directly or the role cannot create an
-- extension. Its costs are real:
--
--   - the export lands on someone's disk as plaintext PHI and plaintext
--     provider credentials, and has to be destroyed afterwards;
--   - a truncated export looks exactly like a small table, and the 9010
--     baseline check cannot catch it — `mig.source_baseline` is populated from
--     whatever is staged here, so it would agree with itself;
--   - `mig.verify()` compares the target against the STAGED copy, which means it
--     verifies the load and not the export.
--
-- So the export step gets its own verification, by hand: the runbook has you
-- record the source's row counts before exporting and compare them against
-- §CHECK at the bottom of this file after loading.
--
-- -----------------------------------------------------------------------------
-- THE COLUMN TYPES ARE THE SOURCE'S, NOT THE TARGET'S
--
-- `timestamp` without a zone, `json` rather than `jsonb`, `text` identity
-- columns. That is deliberate: the loaders convert on the way across
-- (mig.to_tz, ::jsonb, mig.recipient_id) and they must be given exactly what
-- the FDW path would give them, or the two transports diverge in the one place
-- nobody would think to look.
-- =============================================================================

BEGIN;

DO $$
DECLARE n integer;
BEGIN
  IF to_regnamespace('src') IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO n
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'src' AND c.relkind = 'f';
  IF n > 0 THEN
    RAISE EXCEPTION 'schema src already holds % foreign table(s) — that is the FDW transport. Drop it deliberately before switching to CSV.', n;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS src;

CREATE TABLE IF NOT EXISTS src.medspa_configurations (
  id uuid PRIMARY KEY, medspa_id text, name text,
  twilio_account_sid text, twilio_auth_token text, twilio_phone_number text,
  twilio_enabled boolean, sendgrid_api_key text, sendgrid_from_email text,
  sendgrid_from_name text, sendgrid_enabled boolean, slack_bot_token text,
  slack_default_channel text, slack_enabled boolean, timezone text,
  default_language text, business_hours_start text, business_hours_end text,
  business_days text[], sms_rate_limit json, email_rate_limit json,
  require_opt_in boolean, retention_days integer, metadata json,
  is_active boolean, created_at timestamp, updated_at timestamp,
  created_by text, updated_by text
);

CREATE TABLE IF NOT EXISTS src.provider_configurations (
  id uuid PRIMARY KEY, provider_id text, medspa_id text, name text,
  twilio_phone_number text, twilio_enabled boolean, email_from_address text,
  email_from_name text, email_enabled boolean, slack_user_id text,
  slack_enabled boolean, preferred_channel text, timezone text, language text,
  working_hours_start text, working_hours_end text, working_days text[],
  sms_rate_limit json, email_rate_limit json,
  receive_patient_notifications boolean, receive_system_notifications boolean,
  receive_marketing_notifications boolean, auto_response_enabled boolean,
  auto_response_message text, auto_response_delay_minutes integer,
  metadata json, is_active boolean, created_at timestamp, updated_at timestamp,
  created_by text, updated_by text
);

-- The union of both owners' declarations (§0.5 Seam A). `mig.src_col` checks
-- for `status`, `template_type`, `created_by` and `updated_by` at load time, so
-- export whichever of them the source really has and leave the rest empty.
CREATE TABLE IF NOT EXISTS src.communication_templates (
  id uuid PRIMARY KEY, medspa_id text, name text, description text,
  channel text, subject text, content text, variables json, format text,
  html_version text, preview_text text, category text, template_type text,
  tags text[], attachments jsonb, is_active boolean, is_default boolean,
  status text, created_at timestamp, updated_at timestamp, last_used_at timestamp,
  usage_count integer, version integer, created_by text, updated_by text
);

CREATE TABLE IF NOT EXISTS src.template_versions (
  id uuid PRIMARY KEY, template_id uuid, version integer, name text,
  channel text, subject text, content text, html_version text, variables jsonb,
  format text, status text, created_by text, created_at timestamp
);

CREATE TABLE IF NOT EXISTS src.notification_rules (
  id uuid PRIMARY KEY, medspa_id text, event_key text, is_enabled boolean,
  email_enabled boolean, sms_enabled boolean, email_template_id uuid,
  sms_template_id uuid, email_attachment jsonb, sms_attachment jsonb,
  updated_by text, created_at timestamp, updated_at timestamp
);

CREATE TABLE IF NOT EXISTS src.communication_preferences (
  id uuid PRIMARY KEY, user_id text, patient_id text, provider_id text,
  medspa_id text, location_id uuid, allow_communications boolean,
  preferred_channels text[], preferred_language text, preferred_frequency text,
  preferred_time_of_day text, quiet_hours_start text, quiet_hours_end text,
  contact_info json, created_at timestamp, updated_at timestamp,
  updated_by text, metadata json,
  -- Display-only flags 9006 carries through for FE parity. Present here because
  -- this transport declares columns explicitly, unlike the FDW path where
  -- IMPORT FOREIGN SCHEMA ... LIMIT TO restricts tables and not columns.
  email_opt_in boolean, sms_opt_in boolean, push_opt_in boolean,
  voice_opt_in boolean, direct_mail_opt_in boolean
);

CREATE TABLE IF NOT EXISTS src.communication_batches (
  id uuid PRIMARY KEY, name text, description text, status text,
  event_count integer, success_count integer, failure_count integer,
  scheduled_for timestamp, metadata json, created_at timestamp,
  created_by text, completed_at timestamp
);

CREATE TABLE IF NOT EXISTS src.communication_events (
  id uuid PRIMARY KEY, type text, priority text, status text, data json,
  channels text[], metadata json, patient_id text, provider_id text,
  medspa_id text, location_id uuid, created_at timestamp, processed_at timestamp,
  error text, retry_count integer, next_retry_at timestamp,
  scheduled_for timestamp, batch_id uuid
);

CREATE TABLE IF NOT EXISTS src.notifications (
  id uuid PRIMARY KEY, event_id uuid, channel text, recipient_id text,
  content text, status text, sent_at timestamp, delivered_at timestamp,
  read_at timestamp, error text, metadata json, created_at timestamp
);

CREATE TABLE IF NOT EXISTS src.message_history (
  id uuid PRIMARY KEY, notification_id uuid, event_id uuid, patient_id text,
  provider_id text, medspa_id text, location_id uuid, channel text,
  content text, status text, sent_at timestamp, delivered_at timestamp,
  read_at timestamp, queued_message jsonb, metadata json, engagement_data json,
  created_at timestamp, conversation_id uuid, thread_id uuid,
  message_direction text, sender_name text, participant_phone text
);

CREATE TABLE IF NOT EXISTS src.message_analytics (
  id uuid PRIMARY KEY, message_id uuid, notification_id uuid, patient_id text,
  opened_at timestamp, clicked_at timestamp, clicked_link text,
  replied_at timestamp, reply_content text, engagement_score integer,
  device text, platform text, location text, metadata json, created_at timestamp
);

CREATE TABLE IF NOT EXISTS src.scheduled_communications (
  id uuid PRIMARY KEY, event_id uuid, scheduled_for timestamp,
  recurrence_rule text, status text, metadata json, created_at timestamp,
  created_by text, processed_at timestamp
);

CREATE TABLE IF NOT EXISTS src.ai_interactions (
  id uuid PRIMARY KEY, event_id uuid, notification_id uuid, agent_id text,
  model_id text, action_group text, input_summary text, output_summary text,
  tokens_used integer, processing_time integer, success boolean,
  error_message text, metadata json, created_at timestamp
);

CREATE TABLE IF NOT EXISTS src.communication_memories (
  id uuid PRIMARY KEY, patient_id text, provider_id text, medspa_id text,
  location_id uuid, memory_type text, content text, metadata json,
  tags text[], relevance_score integer, created_at timestamp
);

CREATE TABLE IF NOT EXISTS src.campaigns (
  id uuid PRIMARY KEY, name text, description text, type text, status text,
  start_date timestamp, end_date timestamp, target_audience json,
  template_id uuid, provider_id text, medspa_id text, location_id uuid,
  metadata json, created_at timestamp, updated_at timestamp
);

CREATE TABLE IF NOT EXISTS src.campaign_recipients (
  id uuid PRIMARY KEY, campaign_id uuid, patient_id text, status text,
  sent_at timestamp, delivered_at timestamp, error text, metadata json,
  created_at timestamp
);

-- The chunked loaders window on created_at and the joins are all by id.
-- Without these, every window is a sequential scan of the staged copy.
CREATE INDEX IF NOT EXISTS src_message_history_created  ON src.message_history (created_at);
CREATE INDEX IF NOT EXISTS src_events_created           ON src.communication_events (created_at);
CREATE INDEX IF NOT EXISTS src_notifications_created    ON src.notifications (created_at);
CREATE INDEX IF NOT EXISTS src_analytics_message        ON src.message_analytics (message_id);
CREATE INDEX IF NOT EXISTS src_campaign_recipients_camp ON src.campaign_recipients (campaign_id);

COMMIT;

-- -----------------------------------------------------------------------------
-- EXPORT AND LOAD
--
-- On the SOURCE (nothing here writes to it):
--
--   \copy (SELECT * FROM message_history) TO 'message_history.csv' WITH (FORMAT csv, HEADER)
--   … one per table above …
--
-- On the TARGET, column-listed rather than `*`, because the staged tables
-- deliberately carry the UNION of two services' columns and the source's own
-- column order is not guaranteed to match:
--
--   \copy src.message_history (id, notification_id, event_id, patient_id, …) FROM 'message_history.csv' WITH (FORMAT csv, HEADER)
--
-- §CHECK — compare against the counts scripts/inspect-source.sql printed. This
-- is the only thing standing between a truncated export and a migration that
-- verifies itself green against half the data:
--
--   SELECT 'message_history' AS t, count(*) FROM src.message_history
--   UNION ALL SELECT 'communication_events', count(*) FROM src.communication_events
--   UNION ALL SELECT 'notifications',        count(*) FROM src.notifications
--   UNION ALL SELECT 'message_analytics',    count(*) FROM src.message_analytics
--   UNION ALL SELECT 'communication_templates', count(*) FROM src.communication_templates
--   ORDER BY 1;
--
-- Then continue at migrations/9002_tenants.sql. Skip 9001 entirely — but do run
-- its baseline block by hand if you want the 9010 deletion check to work:
--
--   INSERT INTO mig.source_baseline (table_name, n)
--   SELECT 'message_history', count(*) FROM src.message_history
--   ON CONFLICT (table_name) DO UPDATE SET n = EXCLUDED.n, taken_at = now();
--
-- AFTERWARDS: delete the CSVs. They are full of message bodies and, in
-- medspa_configurations.csv, live provider credentials.
-- -----------------------------------------------------------------------------
