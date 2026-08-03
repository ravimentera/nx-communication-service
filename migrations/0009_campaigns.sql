-- =============================================================================
-- 0009_campaigns.sql
--
-- What the campaign orchestrator needs beyond what 0001 already built.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0009_campaigns.sql
--
-- Requires 0001 (audiences, campaigns, campaign_recipients, message_batches)
-- and 0002 (messages ↔ approvals).
--
-- -----------------------------------------------------------------------------
-- WHY THIS FILE IS TWO OBJECTS AND NOT A SCHEMA
--
-- The plan scheduled `audiences`, `audience_members` and the campaign tables for
-- this phase. All of them already exist: P2 built the whole schema up front (D13)
-- precisely so the Drizzle model and the database could not drift for nine
-- phases. What is genuinely missing is a home for import failures, and a link
-- from a campaign's recipient row to the message it produced.
--
-- **Numbered 0009, not the plan's 0008.** P8b took 0008 for
-- `0008_receipt_integrity.sql` (D69), which the plan's phase map did not
-- anticipate. Numbers are never reused here.
--
-- -----------------------------------------------------------------------------
-- WHY import_errors IS A TABLE AND NOT A jsonb COLUMN
--
-- §0.10 says the engine gets a table only if the engine reads it. It reads this
-- one: `GET /v1/audiences/:id/import-errors` serves it back so the caller can
-- fix a CSV and re-import.
--
-- The alternative — an array on `audiences.definition` — is the wrong shape for
-- the same reason a log is not a column: a 50,000-row lead list with a bad
-- header maps to 50,000 errors, and that belongs in rows that can be paginated
-- and deleted, not in a jsonb blob that has to be read whole to be read at all.
-- =============================================================================

BEGIN;

-- One row per rejected CSV line. `row_number` is the line in the uploaded file,
-- 1-based and counting the header, so the number in the report matches what the
-- operator sees in their spreadsheet.
CREATE TABLE IF NOT EXISTS import_errors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  audience_id uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  -- Groups the errors from one upload, so a re-import does not read as a
  -- worsening of the last one.
  import_id   uuid NOT NULL,
  row_number  integer NOT NULL,
  -- The offending line as parsed, so the report is actionable without the
  -- original file. Bounded by the row itself, not by the file.
  raw         jsonb,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_errors_audience
  ON import_errors (tenant_id, audience_id, import_id, row_number);

-- Which message this campaign recipient actually produced. Nullable, because a
-- recipient that was suppressed or is still pending never gets one — and
-- because the P9 backfill migrates historic `campaign_recipients` rows from a
-- source that had no such link.
--
-- The approval is not duplicated here: `messages.approval_id` already carries
-- it, and two paths to the same fact is how they come to disagree.
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS message_id uuid;

DO $$ BEGIN
  ALTER TABLE campaign_recipients
    ADD CONSTRAINT campaign_recipients_message_fk
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The stats query walks a campaign's recipients and joins their messages and
-- analytics. Without this it sequential-scans campaign_recipients per campaign.
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_message
  ON campaign_recipients (message_id) WHERE message_id IS NOT NULL;

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING
--
--   -- the import report a caller can download
--   SELECT row_number, reason, raw FROM import_errors
--   WHERE audience_id = '<id>' AND import_id = '<import>' ORDER BY row_number;
--
--   -- a campaign's outcome, per recipient
--   SELECT cr.status, count(*) FROM campaign_recipients cr
--   WHERE cr.campaign_id = '<id>' GROUP BY 1 ORDER BY 2 DESC;
-- -----------------------------------------------------------------------------
