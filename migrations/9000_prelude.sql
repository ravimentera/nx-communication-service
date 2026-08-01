-- =============================================================================
-- 9000_prelude.sql
--
-- The machinery every other 9xxx script leans on: a schema of its own, the
-- operator's knobs, the watermark table, the quarantine table, and the handful
-- of functions that must produce the same answer in every script and on every
-- re-run.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9000_prelude.sql
--
-- Requires 0001-0008 (the schema migrations) to have been applied to the TARGET
-- database. Requires nothing of the source.
--
-- Read docs/MIGRATION_RUNBOOK.md before running this or anything after it.
--
-- -----------------------------------------------------------------------------
-- EVERYTHING HERE LIVES IN THE `mig` SCHEMA
--
-- Not `public`. Three reasons, in order of how much they matter:
--
--   1. `tests/integration/schema.test.ts` asserts that `public` contains exactly
--      the tables the Drizzle model declares, in both directions. A watermark
--      table in `public` would either fail that test or have to be modelled in
--      Drizzle, and it is not part of the engine's schema — it is scaffolding.
--   2. After the P10 cutover the whole apparatus is removed with one statement:
--      DROP SCHEMA mig CASCADE. Nothing else in the database changes.
--   3. `mig.rejects` and `mig.log` are the migration's own audit trail. Keeping
--      them beside the data they describe, but out of the engine's namespace,
--      is what lets an operator answer "what did it skip, and why?" months
--      later without wondering whether the table is load-bearing.
--
-- The source tables are imported into a schema called `src` by 9001. Every
-- script reads `src.<table>` and never names a database, which is what makes
-- the FDW transport and the CSV transport interchangeable (runbook §3).
--
-- -----------------------------------------------------------------------------
-- ON `-- @@ SPLIT @@` MARKERS
--
-- Some later files define a procedure that COMMITs between chunks and then CALL
-- it. psql runs a file statement by statement, so it does not care. A driver
-- using the PostgreSQL simple-query protocol (node-postgres, and therefore
-- tests/integration/migration.test.ts) sends a whole file as ONE message, which
-- Postgres wraps in an implicit transaction — and a procedure cannot COMMIT
-- inside one. The marker is a SQL comment psql ignores and the test splits on.
-- Do not remove it, and do not put a statement on the same line as one.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS mig;

COMMENT ON SCHEMA mig IS
  'One-shot migration scaffolding from mentera-core (P9). Safe to DROP ... CASCADE after cutover.';

-- ─────────────────────────────────────────────────────────────────────────────
-- OPERATOR KNOBS
--
-- Settings live in a table rather than in psql `\set` variables for one reason:
-- these files must behave identically under psql and under the integration
-- test's driver, which does not implement psql's meta-commands. A table also
-- leaves a record of what the run was actually configured with, which a
-- command-line flag does not.
--
-- The runbook tells the operator which of these to set, and when. Every one has
-- a default that is either correct or deliberately refuses to guess.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mig.settings (
  key        text PRIMARY KEY,
  value      text,
  note       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO mig.settings (key, value, note) VALUES
  ('source_host', '',
   '9001 only. Host of the mentera-core database. Empty = 9001 refuses to run.'),
  ('source_port', '5432',
   '9001 only.'),
  ('source_dbname', 'postgres',
   '9001 only. The shared database every mentera service uses today.'),
  ('source_user', '',
   '9001 only. A READ-ONLY role. Nothing in the 9xxx series writes to the source and the role should make that structural.'),
  ('source_password', '',
   '9001 only. Cleared by 9001 once the user mapping exists (the mapping keeps its own copy).'),
  ('source_timezone', 'UTC',
   'The zone the source''s `timestamp without time zone` values were written in. Confirm with scripts/inspect-source.sql before running 9002.'),
  ('default_tenant_timezone', 'America/New_York',
   'Timezone for a tenant discovered in message rows but absent from medspa_configurations. Matches the source''s own default (0001_add_communication_configs.sql).'),
  ('template_fallback_tenant', '',
   'Tenant to attribute templates whose medspa_id is NULL. Empty = quarantine them instead of guessing. See runbook §5.4.'),
  ('historic_approved_disposition', 'CANCELLED',
   'What to do with approvals that were APPROVED but never sent (D44). CANCELLED (default) or APPROVED. Read the count from the recon before changing it.'),
  ('delta_refresh_days', '7',
   'Trailing window, in days, that scripts/delta-sync.sql re-reads for status changes. message_history has no updated_at, so an older row that changes is not detected.'),
  ('watermark_lag_minutes', '5',
   'How far behind now() a watermark is allowed to advance. Covers the in-flight-transaction race described beside mig.ceiling(). Set to 0 for the final delta, once the old service is stopped.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION mig.setting(p_key text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(value, '') FROM mig.settings WHERE key = p_key;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PROGRESS, QUARANTINE, LOG
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per loader. `watermark` is the exclusive upper bound of source
-- `created_at` already copied; a re-run starts there. Chunked loaders COMMIT
-- after every window, so a run killed halfway keeps what it finished.
CREATE TABLE IF NOT EXISTS mig.progress (
  loader     text PRIMARY KEY,
  watermark  timestamptz NOT NULL DEFAULT '-infinity',
  rows_done  bigint NOT NULL DEFAULT 0,
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Rows that could not be migrated, kept whole. A row lands here instead of
-- being dropped because "how many did it skip" must have an answer, and because
-- almost every reason is a data problem an operator can fix and re-run.
--
-- The dominant reason, by construction: a source table with no tenant column
-- whose parent row is missing, so the tenant cannot be established. The target
-- schema has `tenant_id NOT NULL` everywhere and Rule 4 does not bend for a
-- migration — a guessed tenant is a cross-tenant leak with a paper trail.
CREATE TABLE IF NOT EXISTS mig.rejects (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  loader       text NOT NULL,
  source_table text NOT NULL,
  source_id    text,
  reason       text NOT NULL,
  payload      jsonb
);
CREATE INDEX IF NOT EXISTS idx_mig_rejects_loader ON mig.rejects (loader, reason);

-- Re-running a loader must not multiply its rejects. The expression form covers
-- the rows where `source_id` is NULL, which a plain unique index would treat as
-- distinct every time.
CREATE UNIQUE INDEX IF NOT EXISTS mig_rejects_unique
  ON mig.rejects (loader, source_table, COALESCE(source_id, ''), reason);

-- Narrative for the runbook's "what happened" section: counts that are not
-- failures but that someone will ask about (collapsed duplicates, tenants
-- invented from message rows, template versions whose columns had no home).
CREATE TABLE IF NOT EXISTS mig.log (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  loader text NOT NULL,
  detail text NOT NULL,
  n      bigint
);

CREATE OR REPLACE PROCEDURE mig.note(p_loader text, p_detail text, p_n bigint DEFAULT NULL)
LANGUAGE sql AS $$
  INSERT INTO mig.log (loader, detail, n) VALUES (p_loader, p_detail, p_n);
$$;

-- The high-water mark a loader may advance to: now(), less a lag.
--
-- Without the lag there is a silent hole. A loader computes its ceiling, scans
-- under one MVCC snapshot, and records the ceiling as done. A transaction that
-- started before that snapshot and commits after it inserts rows whose
-- `created_at` falls INSIDE the window just marked complete — and no later run
-- will ever look there again. On a busy source that is a handful of messages
-- lost per pass, invisibly.
--
-- With the lag, each pass stops short of the present and the next pass re-reads
-- the overlap. Re-reading is free: every INSERT in the series is ON CONFLICT DO
-- NOTHING. The cost is that the most recent few minutes always wait for the
-- next run, which is why the runbook has the operator set it to 0 for the final
-- delta — by then the old service is stopped and nothing can still be in flight.
CREATE OR REPLACE FUNCTION mig.ceiling() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT now() - make_interval(mins => COALESCE(NULLIF(mig.setting('watermark_lag_minutes'), '')::int, 5));
$$;

CREATE OR REPLACE FUNCTION mig.watermark(p_loader text) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT watermark FROM mig.progress WHERE loader = p_loader), '-infinity'::timestamptz);
$$;

CREATE OR REPLACE PROCEDURE mig.advance(p_loader text, p_watermark timestamptz, p_rows bigint)
LANGUAGE sql AS $$
  INSERT INTO mig.progress (loader, watermark, rows_done, started_at, updated_at)
  VALUES (p_loader, p_watermark, p_rows, now(), now())
  ON CONFLICT (loader) DO UPDATE
    SET watermark  = GREATEST(mig.progress.watermark, EXCLUDED.watermark),
        rows_done  = mig.progress.rows_done + EXCLUDED.rows_done,
        started_at = COALESCE(mig.progress.started_at, EXCLUDED.started_at),
        updated_at = now();
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TIME
--
-- The source stores `timestamp without time zone` on every column (0001's
-- header, divergence 1). The target stores `timestamptz`. An implicit cast
-- between them uses the SESSION's TimeZone, which means the same script run by
-- two operators with different `TZ` environments produces different instants —
-- silently, and only visibly wrong months later in a quiet-hours check.
--
-- So every timestamp crosses through mig.to_tz(), which states the zone the
-- source wrote in. Confirm that zone with the recon script (`SHOW timezone` on
-- the source, plus the sanity check at the bottom of it) BEFORE running 9002.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mig.src_tz() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(mig.setting('source_timezone'), 'UTC');
$$;

CREATE OR REPLACE FUNCTION mig.to_tz(ts timestamp) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT timezone(mig.src_tz(), ts);
$$;

-- The inverse, and it is not decoration. The chunked loaders window on the
-- SOURCE's `created_at`, and postgres_fdw can only push a predicate to the
-- remote server when it compares a bare column to a value of the same type.
-- `mig.to_tz(s.created_at) >= $1` would be evaluated HERE — after fetching the
-- whole table across the link, once per chunk. Converting the window bounds
-- into source time instead keeps the predicate pushable.
CREATE OR REPLACE FUNCTION mig.to_src(ts timestamptz) RETURNS timestamp
LANGUAGE sql STABLE AS $$
  SELECT timezone(mig.src_tz(), ts);
$$;

-- Already-zoned input passes through untouched. Present so a script does not
-- have to care whether a given source column was pushed as timestamp or
-- timestamptz — the drift between schema/db.ts and the source's own migrations
-- makes that genuinely uncertain for the columns added by `drizzle push`.
CREATE OR REPLACE FUNCTION mig.to_tz(ts timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT ts;
$$;

-- Timestamps that live inside JSONB are ISO-8601 strings written by
-- `new Date().toISOString()` (approvals.controller.ts:362, :393, :603) — they
-- already carry a zone, so they are cast, not converted. A malformed one must
-- not abort a whole chunk, hence the exception handler: one unparseable
-- `approvedAt` costs that timestamp, not the migration.
CREATE OR REPLACE FUNCTION mig.try_ts(s text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF s IS NULL OR btrim(s) = '' THEN RETURN NULL; END IF;
  RETURN s::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- DETERMINISTIC RECIPIENT IDS
--
-- `recipients.id` is a uuid; the source's identity is the text pair
-- (medspa_id, patient_id). Deriving the uuid from that pair with UUID v5 buys
-- three things a lookup table does not:
--
--   - re-running any script produces the same id, so ON CONFLICT DO NOTHING is
--     a real no-op rather than a duplicate;
--   - 9007/9008/9009 compute a message's recipient without joining anything;
--   - the delta sync, run days later against rows created since, lands on the
--     same recipient rows as the bulk load.
--
-- Implemented on pgcrypto's digest() rather than uuid-ossp's uuid_generate_v5,
-- because 0001 already requires pgcrypto and adding a second extension
-- dependency to a production RDS instance for one function is not worth it.
--
-- THE NAMESPACE BELOW IS PERMANENT. Changing it re-keys every recipient and
-- orphans every message, preference and approval that points at one.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mig.uuid_v5(ns uuid, name text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  h bytea;
BEGIN
  h := public.digest(decode(replace(ns::text, '-', ''), 'hex') || convert_to(name, 'utf8'), 'sha1');
  h := set_byte(h, 6, (get_byte(h, 6) & 15) | 80);   -- version 5
  h := set_byte(h, 8, (get_byte(h, 8) & 63) | 128);  -- RFC 4122 variant
  RETURN encode(substring(h from 1 for 16), 'hex')::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION mig.recipient_namespace() RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'b7f4a2d6-9c31-4f0a-9b6e-2d5c8a1e73f4'::uuid;
$$;

CREATE OR REPLACE FUNCTION mig.recipient_id(p_tenant text, p_patient text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_tenant IS NULL OR p_patient IS NULL THEN NULL
           ELSE mig.uuid_v5(mig.recipient_namespace(), p_tenant || ':' || p_patient)
         END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- VOCABULARY MAPS
--
-- The source writes statuses the engine does not have words for, because the
-- source keeps approval state in the same column as delivery state. The engine
-- separates them: `messages.status` is where a message got to in delivery,
-- `approvals.status` is what a human decided. One source value therefore
-- becomes two target values, and neither map is the identity.
--
-- Source values observed in the code (controllers/*.controller.ts,
-- services/ai/*.ts, webhooks-controller.ts):
--   QUEUED, SENT, DELIVERED, FAILED, RECEIVED, PENDING,
--   PENDING_APPROVAL, APPROVED, DECLINED, REJECTED, SCHEDULED
-- ─────────────────────────────────────────────────────────────────────────────

-- The target's message vocabulary is MESSAGE_STATUSES (src/domain/index.ts:14)
--   PENDING QUEUED SENT DELIVERED READ FAILED SKIPPED
-- plus three values the engine's own writers use that predate that list:
--   PENDING_APPROVAL   approval.service.ts:316
--   SUPPRESSED         dispatcher.ts:213
--   RECEIVED           receipt.service.ts:232, on every inbound message
-- There is no CHECK on the column, so what matters is agreeing with those
-- writers — a migrated row must be indistinguishable from one the engine wrote.
--
--   PENDING_APPROVAL -> PENDING_APPROVAL   exactly what the engine writes while
--                                          an approval is open
--   APPROVED         -> PENDING            approved, and then nothing happened
--                                          (D44). 9009 rewrites these to
--                                          CANCELLED under the default
--                                          disposition.
--   SCHEDULED        -> PENDING            same: no job was ever created, and
--                                          the migration does not create one
--   DECLINED         -> CANCELLED          matches approval.service.ts:585,
--   REJECTED         -> CANCELLED          which sets the message to CANCELLED
--                                          when a human declines
--   CANCELLED        -> CANCELLED
--
-- `suppression_reason` stays NULL for all of them: its CHECK (0005) enumerates
-- the compliance gate's reasons, and "a human said no" is not one of them.
CREATE OR REPLACE FUNCTION mig.map_message_status(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE upper(COALESCE(s, ''))
    WHEN 'PENDING_APPROVAL' THEN 'PENDING_APPROVAL'
    WHEN 'APPROVED'         THEN 'PENDING'
    WHEN 'SCHEDULED'        THEN 'PENDING'
    WHEN 'DECLINED'         THEN 'CANCELLED'
    WHEN 'REJECTED'         THEN 'CANCELLED'
    WHEN 'CANCELLED'        THEN 'CANCELLED'
    WHEN 'PENDING'          THEN 'PENDING'
    WHEN 'QUEUED'           THEN 'QUEUED'
    WHEN 'SENT'             THEN 'SENT'
    WHEN 'DELIVERED'        THEN 'DELIVERED'
    WHEN 'READ'             THEN 'READ'
    WHEN 'FAILED'           THEN 'FAILED'
    WHEN 'SKIPPED'          THEN 'SKIPPED'
    WHEN 'SUPPRESSED'       THEN 'SUPPRESSED'
    WHEN 'RECEIVED'         THEN 'RECEIVED'
    WHEN ''                 THEN 'PENDING'
    ELSE NULL   -- unrecognised: 9008 quarantines the row rather than inventing
  END;
$$;

-- The 10 states of `approvals.status` (0002). DECLINED is canonical; the
-- ai-enhanced controller's REJECTED maps onto it.
CREATE OR REPLACE FUNCTION mig.map_approval_status(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE upper(COALESCE(s, ''))
    WHEN 'PENDING_APPROVAL' THEN 'PENDING_APPROVAL'
    WHEN 'PENDING'          THEN 'PENDING_APPROVAL'
    WHEN 'QUEUED'           THEN 'PENDING_APPROVAL'
    WHEN 'APPROVED'         THEN 'APPROVED'
    WHEN 'DECLINED'         THEN 'DECLINED'
    WHEN 'REJECTED'         THEN 'DECLINED'
    WHEN 'SCHEDULED'        THEN 'SCHEDULED'
    WHEN 'CANCELLED'        THEN 'CANCELLED'
    WHEN 'SENT'             THEN 'SENT'
    WHEN 'EXPIRED'          THEN 'EXPIRED'
    ELSE NULL
  END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEMA DRIFT
--
-- `communication_templates` is declared in TWO services with different column
-- sets (§0.5 Seam A): providers-service has `status`, comm-service has
-- `template_type`, `created_by` and `updated_by`. Only one physical table
-- exists, and which columns it actually has depends on which service last ran
-- `drizzle push` — a question no one can answer from the code.
--
-- So 9005 asks the database instead. This returns `s.<col>` when the column is
-- really there and the caller's fallback expression when it is not, and the
-- INSERT is assembled with format(). It is the one place in the series that
-- builds SQL dynamically, and the drift is why.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mig.src_col(p_table text, p_column text, p_fallback text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'src' AND table_name = p_table AND column_name = p_column
    ) THEN 's.' || quote_ident(p_column)
    ELSE p_fallback
  END;
$$;

-- Count a source table by name. Used by the baseline check and the Seam D ghost
-- guard in 9010, both of which iterate over a list of table names and one of
-- which must tolerate a table that does not exist at all.
CREATE OR REPLACE FUNCTION mig.src_count(p_table text) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE n bigint;
BEGIN
  IF to_regclass('src.' || quote_ident(p_table)) IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT count(*) FROM src.%I', p_table) INTO n;
  RETURN n;
END;
$$;

-- Guard used by every loader: refuse to run if 9001 has not linked the source.
CREATE OR REPLACE FUNCTION mig.require_source(p_table text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF to_regclass('src.' || quote_ident(p_table)) IS NULL THEN
    RAISE EXCEPTION 'src.% is not available. Run 9001_source_link.sql (or scripts/csv-staging.sql) first — see docs/MIGRATION_RUNBOOK.md §3.', p_table;
  END IF;
END;
$$;

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING
--
--   SELECT key, value, note FROM mig.settings ORDER BY key;
--
-- Fill in source_host / source_user / source_password before 9001, e.g.
--
--   UPDATE mig.settings SET value = 'mentera-proxy.…rds.amazonaws.com'
--     WHERE key = 'source_host';
--
-- Confirm the UUID helper agrees with any other implementation you might use
-- (this is the RFC 4122 §4.3 test vector for the DNS namespace):
--
--   SELECT mig.uuid_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')
--          = '2ed6657d-e927-568b-95e1-2665a8aea6a2' AS uuid_v5_ok;
-- -----------------------------------------------------------------------------
