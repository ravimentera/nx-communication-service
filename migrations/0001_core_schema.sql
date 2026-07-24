-- =============================================================================
-- 0001_core_schema.sql
--
-- Tenancy, recipients, content, messaging and campaigns.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_core_schema.sql
--
-- Idempotent: every object is IF NOT EXISTS-guarded or created inside a guarded
-- DO block, so re-applying is a no-op. The whole file is one transaction.
--
-- -----------------------------------------------------------------------------
-- DELIBERATE DIVERGENCES FROM THE SOURCE SCHEMA (all called out in P2):
--
--  1. TIMESTAMPTZ EVERYWHERE. The source uses naked `timestamp` (no zone) on
--     every column. That is a latent bug, not a style choice: quiet-hours checks
--     and scheduled sends compare wall-clock values whose zone is implied by
--     whichever server wrote them, so the same stored value means different
--     instants for a Los Angeles tenant and a New York one.
--
--  2. IDENTITY COLUMNS ARE NULLABLE. `message_history.patient_id` and
--     `.provider_id` are NOT NULL in the source, as are
--     `message_analytics.patient_id`, `communication_memories.patient_id`,
--     `campaigns.provider_id` and `campaign_recipients.patient_id`. Those
--     constraints are what make a system-to-staff message impossible to record
--     and what block a tenant with no per-agent concept. Here they are nullable.
--
--  3. `messages.sent_at` IS NULLABLE. The source has `sent_at NOT NULL`, which
--     is only coherent if every row is already sent. A message in DRAFT or
--     PENDING_APPROVAL has no send time and P6 must be able to store one.
--
--  4. ENUM-ISH COLUMNS ARE text + CHECK, never Postgres enums — cheaper to
--     evolve, and a CHECK can be replaced in one statement.
--
--  5. `campaigns`/`audiences`/`message_batches` are created HERE rather than
--     deferred to P11. Their runtime still lands in that phase; creating the
--     tables with the rest of the schema keeps the Drizzle model and the
--     database in lockstep. Schema drift between a declared model and the real
--     database is precisely what produced the §0.5 Seam D ghost tables, and it
--     is not worth reproducing for tidiness.
--
--  6. NO VERTICAL-SPECIFIC TABLES AT ALL. See the note at the end of this file
--     and §0.10. The engine's schema contains no industry's vocabulary.
-- =============================================================================

BEGIN;

-- gen_random_uuid() lives in pgcrypto on PG < 13 and in core from 13 onward.
-- Creating the extension is harmless either way.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- TENANCY
-- ─────────────────────────────────────────────────────────────────────────────

-- `tenants.id` IS the tenant identifier, so this table has no `tenant_id`
-- column. Values are today's medspaId strings, preserved verbatim for P9.
CREATE TABLE IF NOT EXISTS tenants (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  industry           text,
  timezone           text NOT NULL DEFAULT 'UTC',
  locale             text NOT NULL DEFAULT 'en',
  compliance_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sub_tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  name         text NOT NULL,
  timezone     text,
  external_ref jsonb,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_tenants_tenant ON sub_tenants (tenant_id);

-- Used by AUTH_MODE=apikey. Table lands now; the lookup is wired in P12.
CREATE TABLE IF NOT EXISTS tenant_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  name         text NOT NULL,
  key_hash     text NOT NULL CONSTRAINT tenant_api_keys_hash_unique UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}'::text[],
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_tenant ON tenant_api_keys (tenant_id);

-- ← medspa_configurations. The flat credential columns are kept EXACTLY as the
-- source has them so the P9 data migration has somewhere to land; they are
-- plaintext there and plaintext here. `credentials_encrypted` and
-- `encryption_key_id` are added now, unused, so P12 can flip to envelope
-- encryption and drop the flat columns without another migration.
CREATE TABLE IF NOT EXISTS tenant_channel_configs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             text NOT NULL CONSTRAINT tenant_channel_configs_tenant_unique UNIQUE,
  name                  text NOT NULL,
  twilio_account_sid    text,
  twilio_auth_token     text,
  twilio_phone_number   text,
  twilio_enabled        boolean NOT NULL DEFAULT false,
  sendgrid_api_key      text,
  sendgrid_from_email   text,
  sendgrid_from_name    text,
  sendgrid_enabled      boolean NOT NULL DEFAULT false,
  slack_bot_token       text,
  slack_default_channel text,
  slack_enabled         boolean NOT NULL DEFAULT false,
  credentials_encrypted jsonb,
  encryption_key_id     text,
  timezone              text NOT NULL DEFAULT 'America/New_York',
  default_language      text NOT NULL DEFAULT 'en',
  business_hours_start  text DEFAULT '09:00',
  business_hours_end    text DEFAULT '17:00',
  business_days         text[] DEFAULT ARRAY['monday','tuesday','wednesday','thursday','friday']::text[],
  sms_rate_limit        jsonb DEFAULT '{"maxPerHour":100,"maxPerDay":500,"burstLimit":10}'::jsonb,
  email_rate_limit      jsonb DEFAULT '{"maxPerHour":200,"maxPerDay":1000,"burstLimit":20}'::jsonb,
  require_opt_in        boolean NOT NULL DEFAULT true,
  retention_days        integer NOT NULL DEFAULT 365,
  metadata              jsonb,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text,
  updated_by            text
);
CREATE INDEX IF NOT EXISTS idx_tenant_channel_configs_active ON tenant_channel_configs (is_active);

-- ← provider_configurations. provider_id -> sender_id, medspa_id -> tenant_id.
CREATE TABLE IF NOT EXISTS agent_channel_configs (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                      text NOT NULL,
  sub_tenant_id                  uuid,
  sender_id                      text NOT NULL,
  name                           text NOT NULL,
  twilio_phone_number            text,
  twilio_enabled                 boolean NOT NULL DEFAULT false,
  email_from_address             text,
  email_from_name                text,
  email_enabled                  boolean NOT NULL DEFAULT false,
  slack_user_id                  text,
  slack_enabled                  boolean NOT NULL DEFAULT false,
  credentials_encrypted          jsonb,
  encryption_key_id              text,
  preferred_channel              text DEFAULT 'SMS',
  timezone                       text,
  language                       text,
  working_hours_start            text,
  working_hours_end              text,
  working_days                   text[],
  sms_rate_limit                 jsonb,
  email_rate_limit               jsonb,
  receive_recipient_notifications boolean NOT NULL DEFAULT true,
  receive_system_notifications   boolean NOT NULL DEFAULT true,
  receive_marketing_notifications boolean NOT NULL DEFAULT false,
  auto_response_enabled          boolean NOT NULL DEFAULT false,
  auto_response_message          text,
  auto_response_delay_minutes    integer DEFAULT 5,
  metadata                       jsonb,
  is_active                      boolean NOT NULL DEFAULT true,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  created_by                     text,
  updated_by                     text,
  CONSTRAINT agent_channel_configs_sender_tenant_unique UNIQUE (sender_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_channel_configs_tenant ON agent_channel_configs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_channel_configs_active ON agent_channel_configs (is_active);

-- ─────────────────────────────────────────────────────────────────────────────
-- RECIPIENTS
--
-- This table is the answer to §0.5 Seam C: communications.controller.ts reads
-- `SELECT ... FROM patients` at :1240, :1441 and :1671 to resolve inbox display
-- names. That cross-database read does not survive.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recipients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  sub_tenant_id  uuid,
  display_name   text,
  first_name     text,
  last_name      text,
  timezone       text,
  locale         text,
  contact_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_ref   jsonb,
  status         text NOT NULL DEFAULT 'active',
  attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipients_status_check
    CHECK (status IN ('active','unsubscribed','bounced','deleted'))
);
CREATE INDEX IF NOT EXISTS idx_recipients_tenant           ON recipients (tenant_id);
CREATE INDEX IF NOT EXISTS idx_recipients_tenant_subtenant ON recipients (tenant_id, sub_tenant_id);
CREATE INDEX IF NOT EXISTS idx_recipients_status           ON recipients (tenant_id, status);

-- One recipient per (tenant, source system, source id). Expression index, so it
-- cannot be declared in the Drizzle model — this is its only definition.
CREATE UNIQUE INDEX IF NOT EXISTS recipients_tenant_external_ref_unique
  ON recipients (tenant_id, (external_ref->>'system'), (external_ref->>'id'))
  WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS consent_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  sub_tenant_id uuid,
  recipient_id  uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  channel       text NOT NULL,
  granted       boolean NOT NULL,
  source        text,
  proof         jsonb,
  granted_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consent_recipient_channel
  ON consent_records (tenant_id, recipient_id, channel);

-- ← communication_preferences, rekeyed to recipient_id (§0.5 Seam B).
-- `quiet_hours_timezone` is new: today quiet hours are bare 'HH:MM' strings and
-- the zone is resolved at check time from a config lookup
-- (preference.service.ts:331). Storing it here removes that ambiguity.
-- `event_opt_outs` is new: per-playbook opt-out, inexpressible in the source.
CREATE TABLE IF NOT EXISTS recipient_preferences (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            text NOT NULL,
  sub_tenant_id        uuid,
  recipient_id         uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  user_id              text,
  allow_communications boolean NOT NULL DEFAULT true,
  preferred_channels   text[],
  preferred_language   text,
  preferred_frequency  text NOT NULL DEFAULT 'MODERATE',
  preferred_time_of_day text,
  quiet_hours_start    text,
  quiet_hours_end      text,
  quiet_hours_timezone text,
  event_opt_outs       text[] NOT NULL DEFAULT '{}'::text[],
  unsubscribe_token    text,
  contact_info         jsonb,
  metadata             jsonb,
  updated_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipient_preferences_tenant_recipient_unique UNIQUE (tenant_id, recipient_id),
  CONSTRAINT recipient_preferences_unsubscribe_token_unique UNIQUE (unsubscribe_token)
);
CREATE INDEX IF NOT EXISTS idx_recipient_prefs_recipient ON recipient_preferences (recipient_id);

-- ← communication_memories.
CREATE TABLE IF NOT EXISTS recipient_memories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  sub_tenant_id   uuid,
  recipient_id    uuid REFERENCES recipients(id) ON DELETE CASCADE,
  sender_id       text,
  memory_type     text NOT NULL,
  content         text NOT NULL,
  metadata        jsonb,
  tags            text[],
  relevance_score integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recipient_memories_tenant_subtenant
  ON recipient_memories (tenant_id, sub_tenant_id);
CREATE INDEX IF NOT EXISTS idx_recipient_memories_recipient
  ON recipient_memories (tenant_id, recipient_id);

-- ContextProvider cache (P5). `lead_profiles` (§0.5 Seam D) folds in here plus
-- recipients.attributes rather than becoming its own table.
CREATE TABLE IF NOT EXISTS recipient_context (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  sub_tenant_id uuid,
  recipient_id  uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  source        text NOT NULL,
  payload       jsonb NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipient_context_recipient_source_unique UNIQUE (recipient_id, source)
);
CREATE INDEX IF NOT EXISTS idx_recipient_context_expiry ON recipient_context (expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- CONTENT (§0.5 Seam A)
--
-- `templates` is the UNION of the communication-service and providers-service
-- column sets. The engine must own this table: a non-medspa tenant has no
-- providers-service. `template_versions` MOVES here — providers-service holds
-- the real FK today (schema.ts:4406).
--
-- HARD REQUIREMENT FOR P9: `templates.id` values must be preserved from the
-- existing `communication_templates` rows. providers-service's
-- `notification_rules.email_template_id` / `sms_template_id` become soft
-- references to them (FK dropped, column kept), and stale UUIDs would silently
-- break every notification rule.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  sub_tenant_id uuid,
  pack_id       text,
  key           text,
  name          text NOT NULL,
  description   text,
  channel       text NOT NULL,
  subject       text,
  content       text NOT NULL,
  html_version  text,
  preview_text  text,
  variables     jsonb,
  format        text NOT NULL DEFAULT 'TEXT',
  category      text,
  template_type text,
  tags          text[],
  attachments   jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'published',
  is_active     boolean NOT NULL DEFAULT true,
  is_default    boolean NOT NULL DEFAULT false,
  version       integer NOT NULL DEFAULT 1,
  usage_count   integer NOT NULL DEFAULT 0,
  last_used_at  timestamptz,
  created_by    text,
  updated_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_format_check CHECK (format IN ('TEXT','HTML','MARKDOWN','MJML')),
  CONSTRAINT templates_status_check CHECK (status IN ('draft','published','archived'))
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant         ON templates (tenant_id);
CREATE INDEX IF NOT EXISTS idx_templates_tenant_channel ON templates (tenant_id, channel);
CREATE INDEX IF NOT EXISTS idx_templates_pack           ON templates (pack_id);

-- Partial unique: keyed templates are unique per tenant, ad-hoc ones are not.
CREATE UNIQUE INDEX IF NOT EXISTS templates_tenant_key_unique
  ON templates (tenant_id, key) WHERE key IS NOT NULL;

CREATE TABLE IF NOT EXISTS template_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  template_id  uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  name         text,
  subject      text,
  content      text NOT NULL,
  html_version text,
  variables    jsonb,
  changed_by   text,
  change_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_versions_template_version_unique UNIQUE (template_id, version)
);
CREATE INDEX IF NOT EXISTS idx_template_versions_tenant ON template_versions (tenant_id);

-- Prompt assembly inputs (P4). This is where the healthcare vocabulary now
-- inlined in ai-message-generator.ts moves to: out of code, into pack rows.
-- `tenant_id` is NULLABLE — a NULL row is a pack-provided default shared by
-- every tenant that installed the pack; a non-null row overrides it.
CREATE TABLE IF NOT EXISTS prompt_packs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text,
  pack_id       text,
  key           text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  persona       text,
  goal          text,
  constraints   text,
  channel_rules jsonb,
  model_hints   jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prompt_packs_key ON prompt_packs (key);

CREATE TABLE IF NOT EXISTS assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  sub_tenant_id uuid,
  kind          text NOT NULL,
  url           text NOT NULL,
  mime_type     text,
  size          integer,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_tenant ON assets (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- CAMPAIGNS (tables only; runtime is P11)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audiences (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             text NOT NULL,
  sub_tenant_id         uuid,
  name                  text NOT NULL,
  kind                  text NOT NULL DEFAULT 'static',
  definition            jsonb NOT NULL DEFAULT '{}'::jsonb,
  member_count          integer NOT NULL DEFAULT 0,
  last_materialized_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audiences_kind_check CHECK (kind IN ('static','query','accumulating'))
);
CREATE INDEX IF NOT EXISTS idx_audiences_tenant ON audiences (tenant_id);

CREATE TABLE IF NOT EXISTS message_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  sub_tenant_id uuid,
  campaign_id   uuid,
  name          text NOT NULL,
  description   text,
  status        text NOT NULL DEFAULT 'DRAFT',
  event_count   integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  scheduled_for timestamptz,
  metadata      jsonb,
  created_by    text,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_batches_status_check
    CHECK (status IN ('DRAFT','QUEUED','PROCESSING','COMPLETED','CANCELLED'))
);
CREATE INDEX IF NOT EXISTS idx_message_batches_tenant_status ON message_batches (tenant_id, status);

-- sender_id was `provider_id NOT NULL`; nullable so a campaign can be org-owned.
CREATE TABLE IF NOT EXISTS campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  sub_tenant_id   uuid,
  name            text NOT NULL,
  description     text,
  type            text NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT',
  start_date      timestamptz,
  end_date        timestamptz,
  target_audience jsonb,
  template_id     uuid REFERENCES templates(id) ON DELETE SET NULL,
  playbook_id     uuid,
  audience_id     uuid REFERENCES audiences(id) ON DELETE SET NULL,
  sender_id       text,
  schedule        jsonb,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_subtenant ON campaigns (tenant_id, sub_tenant_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_status    ON campaigns (tenant_id, status);

DO $$ BEGIN
  ALTER TABLE message_batches
    ADD CONSTRAINT message_batches_campaign_fk
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Join table: composite PK, no surrogate id.
CREATE TABLE IF NOT EXISTS audience_members (
  audience_id  uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  tenant_id    text NOT NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  source       text,
  PRIMARY KEY (audience_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_audience_members_recipient ON audience_members (recipient_id);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  campaign_id  uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id uuid REFERENCES recipients(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'PENDING',
  sent_at      timestamptz,
  delivered_at timestamptz,
  error        text,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign  ON campaign_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_recipient ON campaign_recipients (recipient_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- MESSAGING
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  sub_tenant_id  uuid,
  type           text NOT NULL,
  priority       text NOT NULL DEFAULT 'MEDIUM',
  status         text NOT NULL DEFAULT 'PENDING',
  data           jsonb NOT NULL,
  channels       text[] NOT NULL DEFAULT '{}'::text[],
  metadata       jsonb,
  recipient_id   uuid REFERENCES recipients(id) ON DELETE SET NULL,
  sender_id      text,
  playbook_id    uuid,
  trigger_type   text,
  correlation_id text,
  batch_id       uuid REFERENCES message_batches(id) ON DELETE SET NULL,
  processed_at   timestamptz,
  error          text,
  retry_count    integer NOT NULL DEFAULT 0,
  next_retry_at  timestamptz,
  scheduled_for  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outreach_events_status           ON outreach_events (status);
CREATE INDEX IF NOT EXISTS idx_outreach_events_tenant_subtenant ON outreach_events (tenant_id, sub_tenant_id);
CREATE INDEX IF NOT EXISTS idx_outreach_events_correlation      ON outreach_events (correlation_id);

CREATE TABLE IF NOT EXISTS notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  sub_tenant_id uuid,
  event_id      uuid REFERENCES outreach_events(id) ON DELETE SET NULL,
  channel       text NOT NULL,
  recipient_id  uuid REFERENCES recipients(id) ON DELETE SET NULL,
  channel_ref   text,
  content       text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING',
  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz,
  error         text,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant_status ON notifications (tenant_id, status);

-- ← message_history. See divergences 2 and 3 in the header.
CREATE TABLE IF NOT EXISTS messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           text NOT NULL,
  sub_tenant_id       uuid,
  notification_id     uuid REFERENCES notifications(id) ON DELETE SET NULL,
  event_id            uuid REFERENCES outreach_events(id) ON DELETE SET NULL,
  recipient_id        uuid REFERENCES recipients(id) ON DELETE SET NULL,
  sender_id           text,
  channel             text NOT NULL,
  direction           text NOT NULL DEFAULT 'outbound',
  content             text NOT NULL,
  status              text NOT NULL,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  playbook_id         uuid,
  template_id         uuid REFERENCES templates(id) ON DELETE SET NULL,
  approval_id         uuid,
  ai_generated        boolean NOT NULL DEFAULT false,
  provider_message_id text,
  queued_message      jsonb,
  metadata            jsonb,
  engagement_data     jsonb,
  conversation_id     uuid,
  thread_id           uuid,
  sender_name         text,
  participant_phone   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_direction_check CHECK (direction IN ('outbound','inbound'))
);

-- Carried forward from schema/db.ts:403-421. These were added for real
-- production problems; only the vocabulary changed.
CREATE INDEX IF NOT EXISTS idx_messages_tenant_sender     ON messages (tenant_id, sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation      ON messages (tenant_id, sender_id, recipient_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread            ON messages (tenant_id, sender_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_sent_at           ON messages (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_status            ON messages (status);
CREATE INDEX IF NOT EXISTS idx_messages_channel           ON messages (channel);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_subtenant  ON messages (tenant_id, sub_tenant_id);
-- New: delivery webhooks join on the provider's own message id.
CREATE INDEX IF NOT EXISTS idx_messages_provider_message_id ON messages (tenant_id, provider_message_id);
-- NOT carried forward: message_history_queued_approval_idx on
-- (queued_message->>'approvalStatus'). The approvals table (0002) replaces it.

CREATE TABLE IF NOT EXISTS message_analytics (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL,
  sub_tenant_id    uuid,
  message_id       uuid REFERENCES messages(id) ON DELETE CASCADE,
  notification_id  uuid REFERENCES notifications(id) ON DELETE SET NULL,
  recipient_id     uuid REFERENCES recipients(id) ON DELETE SET NULL,
  opened_at        timestamptz,
  clicked_at       timestamptz,
  clicked_link     text,
  replied_at       timestamptz,
  reply_content    text,
  engagement_score integer,
  device           text,
  platform         text,
  location         text,
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_message ON message_analytics (message_id);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  sub_tenant_id   uuid,
  event_id        uuid REFERENCES outreach_events(id) ON DELETE CASCADE,
  scheduled_for   timestamptz NOT NULL,
  recurrence_rule text,
  status          text NOT NULL DEFAULT 'PENDING',
  metadata        jsonb,
  created_by      text,
  processed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_messages_status_check
    CHECK (status IN ('PENDING','PROCESSED','CANCELLED'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages (status, scheduled_for);

CREATE TABLE IF NOT EXISTS ai_interactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  sub_tenant_id   uuid,
  event_id        uuid REFERENCES outreach_events(id) ON DELETE SET NULL,
  notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
  playbook_id     uuid,
  agent_id        text,
  model_id        text NOT NULL,
  action_group    text,
  input_summary   text,
  output_summary  text,
  tokens_used     integer,
  processing_time integer,
  cost_usd        numeric(12,6),
  success         boolean NOT NULL,
  error_message   text,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_interactions_tenant_created
  ON ai_interactions (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- NO VERTICAL-SPECIFIC TABLES (§0.5 Seam D, §0.10)
--
-- An earlier draft of this migration created pack_medspa_feedback,
-- pack_medspa_promotions and pack_medspa_gift_cards here. They are gone, and
-- nothing replaces them. The rule that removed them:
--
--   THE ENGINE NEEDS A TABLE ONLY IF THE ENGINE READS IT.
--
-- It does not read promotions or gift cards. It needs their fields at render
-- time (name, discount, expiry, code, amount), and those arrive in the event
-- payload, validated against the playbook's `data_contract`. A gift card
-- balance is a ledger and belongs wherever the vertical's commerce lives, not
-- in an outreach engine. Inbound feedback IS a message: it lands in `messages`
-- with direction='inbound', and any sentiment or adverse-event judgment on it
-- goes in `message_analytics.metadata`.
--
-- Two facts made this free rather than expensive. Verified against production
-- on 2026-08-04: all six Seam D tables plus `patient_feedback` contain ZERO
-- rows, and none has a tenant column of any kind. And the code behind them is
-- demo scaffolding — promotion.service.ts:169 returns a hardcoded
-- 'Jane Smith'/'John Doe' from findEligiblePatients(), and
-- feedback-analysis.service.ts:229,251 return a hardcoded patient and provider.
--
-- If a vertical ever genuinely needs relational storage beside engine data, it
-- ships its own migration with its pack. That is opt-in and it is theirs. The
-- core schema stays free of any industry's vocabulary:
--
--   grep -ri medspa src/db/ migrations/    ->  no table or column names
-- ─────────────────────────────────────────────────────────────────────────────

COMMIT;
