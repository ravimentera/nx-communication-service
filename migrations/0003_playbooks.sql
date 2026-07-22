-- =============================================================================
-- 0003_playbooks.sql
--
-- Packs and playbooks — the replacement for the EventType enum + handler switch.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0003_playbooks.sql
--
-- Requires 0001 (messages, outreach_events, campaigns, ai_interactions) and
-- 0002 (approval_policies, approvals).
--
-- -----------------------------------------------------------------------------
-- WHAT THIS REPLACES
--
-- models/communication.model.ts declares a 44-value `EventType` enum.
-- events/enhanced-event-handler.ts (725 LOC) is one 17-case switch over it, with
-- 21 hardcoded template-id string literals and `to: 'emergency-team@medspa.com'`
-- at line 549. Adding an event type means editing and redeploying the service,
-- and every tenant shares one hardcoded emergency address.
--
-- Here it is rows: a playbook says what to send, on which channels, whether it
-- needs approval and how often it may fire; playbook_triggers says when. P7
-- seeds the 17 medspa cases.
-- =============================================================================

BEGIN;

-- Global catalogue of installable packs. Like `tenants`, this table has no
-- tenant_id — a pack is not owned by a tenant. tenant_packs records who
-- installed it. These are the only two tables in the schema without tenant_id.
CREATE TABLE IF NOT EXISTS packs (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  version     text NOT NULL,
  description text,
  -- Declares the playbooks, templates, prompts and policies the pack ships.
  manifest    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_packs (
  tenant_id    text NOT NULL,
  pack_id      text NOT NULL REFERENCES packs(id) ON DELETE RESTRICT,
  installed_at timestamptz NOT NULL DEFAULT now(),
  -- Per-tenant overrides of pack defaults.
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pack_id)
);

CREATE TABLE IF NOT EXISTS playbooks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          text NOT NULL,
  sub_tenant_id      uuid,
  pack_id            text,
  -- e.g. 'medspa.appointment_reminder'. Stable across versions.
  key                text NOT NULL,
  name               text NOT NULL,
  description        text,
  is_active          boolean NOT NULL DEFAULT true,
  -- Lower runs first when several playbooks match one event.
  priority           integer NOT NULL DEFAULT 100,
  -- JSON Schema for caller-supplied context, generated from Zod (§0.9).
  data_contract      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {kind:'template',templateKey} | {kind:'ai',promptPackKey} | {kind:'hybrid',...}
  content_source     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{channel, priority, fallbackAfterMs}] — replaces the dispatch switch at
  -- notification-queue.ts:271-294.
  channel_plan       jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_policy_id uuid,
  -- {maxPerRecipientPerDay, cooldownHours}
  throttle           jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata           jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playbooks_tenant_key_unique UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_playbooks_tenant_active ON playbooks (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_playbooks_pack          ON playbooks (pack_id);

CREATE TABLE IF NOT EXISTS playbook_triggers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  playbook_id   uuid NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  trigger_type  text NOT NULL,
  -- {eventType:'APPOINTMENT_REMINDER', where:{...}}
  match_rules   jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule_cron text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playbook_triggers_type_check
    CHECK (trigger_type IN ('event','schedule','manual','campaign','webhook'))
);
CREATE INDEX IF NOT EXISTS idx_playbook_triggers_playbook
  ON playbook_triggers (playbook_id);
CREATE INDEX IF NOT EXISTS idx_playbook_triggers_tenant_type
  ON playbook_triggers (tenant_id, trigger_type, is_active);

-- Cross-migration foreign keys: every column pointing at playbooks was created
-- in 0001/0002 as a plain uuid because playbooks did not exist yet.
DO $$ BEGIN
  ALTER TABLE playbooks
    ADD CONSTRAINT playbooks_approval_policy_fk
    FOREIGN KEY (approval_policy_id) REFERENCES approval_policies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE messages
    ADD CONSTRAINT messages_playbook_fk
    FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE outreach_events
    ADD CONSTRAINT outreach_events_playbook_fk
    FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE approvals
    ADD CONSTRAINT approvals_playbook_fk
    FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ai_interactions
    ADD CONSTRAINT ai_interactions_playbook_fk
    FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE campaigns
    ADD CONSTRAINT campaigns_playbook_fk
    FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
