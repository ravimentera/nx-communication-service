-- =============================================================================
-- 9001_source_link.sql
--
-- Attach the mentera-core database as schema `src`, read-only.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9001_source_link.sql
--
-- Requires 9000, and requires the operator to have filled in the connection
-- settings first:
--
--   UPDATE mig.settings SET value = '…' WHERE key = 'source_host';
--   UPDATE mig.settings SET value = '…' WHERE key = 'source_dbname';
--   UPDATE mig.settings SET value = '…' WHERE key = 'source_user';
--   UPDATE mig.settings SET value = '…' WHERE key = 'source_password';
--
-- -----------------------------------------------------------------------------
-- WHY FDW, AND WHY `updatable 'false'`
--
-- Source and target are two databases on the same RDS instance, so the rows
-- never leave the machine. postgres_fdw makes them look like local tables and
-- every loader becomes a plain INSERT … SELECT — no CSV round trip, no
-- intermediate files holding PHI on someone's laptop, no chance of a partial
-- export being mistaken for a complete one.
--
-- The server is declared `updatable 'false'`. The runbook's central promise is
-- that no 9xxx script writes to the source, so rollback is "drop the target
-- database". That promise is worth more as a database constraint than as a
-- convention: with this option, an UPDATE against src.* fails at plan time
-- rather than succeeding against production. Use a READ-ONLY role for
-- `source_user` as well — belt and braces, and the role is the only one of the
-- two that also survives someone dropping this option.
--
-- If FDW is unavailable (no extension privileges, or a network path that does
-- not exist), the CSV transport in scripts/csv-staging.sql builds the same
-- `src` schema from files. Every later script is identical either way.
-- =============================================================================

BEGIN;

-- Refuse to clobber a CSV-staged `src` full of real rows. The foreign-table
-- variant is disposable — it holds no data — so this file recreates it every
-- time and stays idempotent. A staged one is not.
DO $$
DECLARE n integer;
BEGIN
  IF to_regnamespace('src') IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO n
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'src' AND c.relkind = 'r';
  IF n > 0 THEN
    RAISE EXCEPTION 'schema src already holds % ordinary table(s) — that is the CSV transport (scripts/csv-staging.sql). Drop it deliberately before switching to FDW.', n;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- Re-runnable: the credentials are only DEMANDED when there is nothing to reuse.
-- This file clears `source_password` at the end (see below), so requiring it
-- unconditionally would make the second run of an otherwise idempotent series
-- fail on a file that had nothing left to do.
DO $$
DECLARE
  v_host text := mig.setting('source_host');
  v_port text := COALESCE(mig.setting('source_port'), '5432');
  v_db   text := COALESCE(mig.setting('source_dbname'), 'postgres');
  v_user text := mig.setting('source_user');
  v_pass text := mig.setting('source_password');
  v_has_server  boolean := EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'mentera_source');
  v_has_mapping boolean := EXISTS (
    SELECT 1 FROM pg_user_mappings
    WHERE srvname = 'mentera_source' AND usename = current_user);
BEGIN
  -- fetch_size: postgres_fdw's default is 100 rows per round trip, which turns
  -- the message_history load into millions of round trips.
  IF NOT v_has_server THEN
    IF v_host IS NULL THEN
      RAISE EXCEPTION 'source_host must be set in mig.settings first — see the header of this file.';
    END IF;
    EXECUTE format(
      'CREATE SERVER mentera_source FOREIGN DATA WRAPPER postgres_fdw '
      || 'OPTIONS (host %L, port %L, dbname %L, fetch_size %L, updatable %L)',
      v_host, v_port, v_db, '10000', 'false');
  ELSIF v_host IS NOT NULL THEN
    EXECUTE format(
      'ALTER SERVER mentera_source OPTIONS (SET host %L, SET port %L, SET dbname %L)',
      v_host, v_port, v_db);
  END IF;

  IF NOT v_has_mapping THEN
    IF v_user IS NULL OR v_pass IS NULL THEN
      RAISE EXCEPTION 'source_user and source_password must be set in mig.settings first — see the header of this file.';
    END IF;
    EXECUTE format('CREATE USER MAPPING FOR CURRENT_USER SERVER mentera_source OPTIONS (user %L, password %L)', v_user, v_pass);
  ELSIF v_user IS NOT NULL AND v_pass IS NOT NULL THEN
    EXECUTE format('ALTER USER MAPPING FOR CURRENT_USER SERVER mentera_source OPTIONS (SET user %L, SET password %L)', v_user, v_pass);
  END IF;
END $$;

DROP SCHEMA IF EXISTS src CASCADE;
CREATE SCHEMA src;

-- LIMIT TO names every table the series reads, plus the seven §0.5 Seam D
-- ghosts. A name in LIMIT TO that does not exist on the remote is skipped
-- silently, which is exactly what is wanted: the ghosts are expected to be
-- absent or empty, and 9010 turns "absent" into a PASS rather than an error.
IMPORT FOREIGN SCHEMA public LIMIT TO (
  -- communication-service
  communication_preferences,
  communication_batches,
  communication_events,
  communication_memories,
  communication_templates,
  message_analytics,
  message_history,
  notifications,
  scheduled_communications,
  ai_interactions,
  campaigns,
  campaign_recipients,
  patient_feedback,
  medspa_configurations,
  provider_configurations,
  -- providers-service (§0.5 Seam A): same physical database
  template_versions,
  notification_rules,
  -- §0.5 Seam D ghosts — read only to prove they are still empty
  promotions,
  gift_cards,
  lead_profiles,
  treatment_follow_up_rules,
  outreach_rules,
  farewell_messages
) FROM SERVER mentera_source INTO src;

-- The password is in the user mapping now; there is no reason for a second
-- copy to sit in a table an operator will later screenshot into a ticket.
UPDATE mig.settings SET value = '', updated_at = now() WHERE key = 'source_password';

-- ─────────────────────────────────────────────────────────────────────────────
-- BASELINE
--
-- The runbook's rollback procedure rests on one claim: no 9xxx script writes to
-- the source, so recovering from a bad run is "drop the target database". A
-- claim that load-bearing deserves evidence, so the source's row counts are
-- recorded here and re-counted by 9010. A row that appears in the source during
-- the bulk load is expected during a parallel run and must be zero in the final
-- cutover window; a row that DISAPPEARS is a five-alarm fire.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mig.source_baseline (
  table_name text PRIMARY KEY,
  n          bigint NOT NULL,
  taken_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text; c bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'medspa_configurations','provider_configurations','communication_templates',
    'template_versions','communication_preferences','communication_batches',
    'communication_events','notifications','scheduled_communications',
    'ai_interactions','communication_memories','campaigns','campaign_recipients',
    'message_history','message_analytics'
  ] LOOP
    IF to_regclass('src.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM src.%I', t) INTO c;
      -- DO NOTHING, not DO UPDATE: the baseline is the count at FIRST link, and
      -- re-stamping it on a re-run would quietly erase the evidence that the
      -- source has been growing — which is exactly what 9010 reports on.
      INSERT INTO mig.source_baseline (table_name, n) VALUES (t, c)
      ON CONFLICT (table_name) DO NOTHING;
    END IF;
  END LOOP;
END $$;

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING — three checks, in order:
--
--   -- 1. what came across
--   SELECT foreign_table_name FROM information_schema.foreign_tables
--   WHERE foreign_table_schema = 'src' ORDER BY 1;
--
--   -- 2. the link works and the row counts look like production
--   SELECT count(*) FROM src.message_history;
--
--   -- 3. the link is READ-ONLY (this must fail)
--   UPDATE src.message_history SET status = status WHERE false;
--   -- expected: ERROR: foreign table "message_history" does not allow updates
-- -----------------------------------------------------------------------------
