-- =============================================================================
-- 0005_compliance.sql
--
-- The one column the compliance plane needs that 0001 did not anticipate.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0005_compliance.sql
--
-- Requires 0001.
--
-- -----------------------------------------------------------------------------
-- WHY THIS FILE IS SHORT
--
-- The plan scheduled `consent_records`, `recipient_context`,
-- `recipient_preferences.event_opt_outs`, `.quiet_hours_timezone` and
-- `recipients.status` for this migration. All five already exist: P2 built the
-- whole schema up front rather than deferring tables to the phase that uses
-- them, which is also why P4 shipped no migration at all.
--
-- What was genuinely missing is `messages.suppression_reason`. It matters more
-- than its size suggests: without it a suppressed message is indistinguishable
-- from one that was never created, and the entire point of the gate is that
-- nothing is dropped silently.
-- =============================================================================

BEGIN;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS suppression_reason text;

DO $$ BEGIN
  ALTER TABLE messages
    ADD CONSTRAINT messages_suppression_reason_check
    CHECK (suppression_reason IS NULL OR suppression_reason IN (
      'RECIPIENT_UNSUBSCRIBED','RECIPIENT_BOUNCED','RECIPIENT_DELETED',
      'COMMUNICATIONS_DISABLED','CHANNEL_OPTED_OUT','CONSENT_REQUIRED',
      'PLAYBOOK_OPTED_OUT','QUIET_HOURS','RATE_LIMITED','THROTTLED'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- "What did we suppress, and why?" is the question this whole phase exists to
-- be able to answer. Partial, because the column is NULL on almost every row.
CREATE INDEX IF NOT EXISTS idx_messages_suppressed
  ON messages (tenant_id, suppression_reason, created_at DESC)
  WHERE suppression_reason IS NOT NULL;

-- The rate-limit and throttle checks count recent outbound messages per tenant,
-- channel and recipient. Without this they sequential-scan `messages` on every
-- single send.
CREATE INDEX IF NOT EXISTS idx_messages_rate_window
  ON messages (tenant_id, channel, direction, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_recipient_window
  ON messages (tenant_id, recipient_id, direction, created_at DESC);

COMMIT;
