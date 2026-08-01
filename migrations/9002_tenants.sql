-- =============================================================================
-- 9002_tenants.sql
--
-- tenants ← medspa_configurations, plus every medspa_id the data mentions.
-- sub_tenants ← every location_id the data mentions.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9002_tenants.sql
--
-- Requires 9000, 9001. Idempotent: re-running inserts nothing new.
--
-- -----------------------------------------------------------------------------
-- WHY A SECOND PASS OVER THE DATA
--
-- `medspa_configurations` is the tenant registry only by accident — a medspa
-- gets a row there when somebody configures Twilio or SendGrid for it, not when
-- it starts existing. Any medspa that has only ever used the platform default
-- credentials has messages and no config row.
--
-- Every one of those still needs a `tenants` row: `tenant_id` is NOT NULL on
-- every table in the target schema, and Rule 4 has no exception for a tenant we
-- happen not to have a name for. So pass 2 sweeps every table carrying a
-- medspa_id and invents a row for anything pass 1 missed, named after its own
-- id, and logs how many it had to invent.
--
-- Their timezone comes from `default_tenant_timezone` (default
-- 'America/New_York'), which is the source's own default for a medspa
-- configuration — NOT the target schema's 'UTC'. A tenant that has been sending
-- 9am reminders in New York time must not start sending them at 4am because
-- the migration preferred the column default.
--
-- -----------------------------------------------------------------------------
-- sub_tenants
--
-- `location_id` is a bare uuid on five source tables and there is no locations
-- table in this database — locations live in providers-service. Nothing in the
-- target schema has a foreign key to `sub_tenants` (0001), so these rows are
-- not load-bearing; they exist so that an operator reading a message's
-- `sub_tenant_id` can join it to something, and so P10's seam work has a place
-- to hang a real name off `external_ref`.
-- =============================================================================

BEGIN;

SELECT mig.require_source('medspa_configurations');
SELECT mig.require_source('message_history');

-- ── 1. tenants that have a configuration row ────────────────────────────────
WITH ins AS (
  INSERT INTO tenants (id, name, timezone, locale, is_active, created_at, updated_at)
  SELECT s.medspa_id,
         COALESCE(NULLIF(btrim(s.name), ''), s.medspa_id),
         COALESCE(NULLIF(btrim(s.timezone), ''), COALESCE(mig.setting('default_tenant_timezone'), 'America/New_York')),
         COALESCE(NULLIF(btrim(s.default_language), ''), 'en'),
         COALESCE(s.is_active, true),
         COALESCE(mig.to_tz(s.created_at), now()),
         COALESCE(mig.to_tz(s.updated_at), now())
  FROM src.medspa_configurations s
  WHERE s.medspa_id IS NOT NULL
  ON CONFLICT (id) DO NOTHING
  RETURNING 1
)
INSERT INTO mig.log (loader, detail, n)
SELECT '9002_tenants', 'tenants created from medspa_configurations', count(*) FROM ins;

-- ── 2. tenants the data mentions but the config table does not ──────────────
WITH seen AS (
  SELECT medspa_id FROM src.message_history          WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM src.communication_events      WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM src.communication_memories    WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM src.communication_preferences WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM src.campaigns                 WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM src.communication_templates   WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM src.provider_configurations   WHERE medspa_id IS NOT NULL
),
ins AS (
  INSERT INTO tenants (id, name, timezone, locale, is_active)
  SELECT s.medspa_id,
         s.medspa_id,
         COALESCE(mig.setting('default_tenant_timezone'), 'America/New_York'),
         'en',
         true
  FROM seen s
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO mig.log (loader, detail, n)
SELECT '9002_tenants',
       'tenants invented from message/event rows (no medspa_configurations row): ' ||
       COALESCE(string_agg(id, ', ' ORDER BY id), 'none'),
       count(*)
FROM ins;

-- ── 3. sub_tenants ──────────────────────────────────────────────────────────
-- A location that appears under two different medspa_ids is a data problem, not
-- something to average out: it is quarantined and reported rather than
-- arbitrarily attributed to one of them.
WITH pairs AS (
  SELECT medspa_id, location_id FROM src.message_history          WHERE location_id IS NOT NULL AND medspa_id IS NOT NULL
  UNION SELECT medspa_id, location_id FROM src.communication_events      WHERE location_id IS NOT NULL AND medspa_id IS NOT NULL
  UNION SELECT medspa_id, location_id FROM src.communication_memories    WHERE location_id IS NOT NULL AND medspa_id IS NOT NULL
  UNION SELECT medspa_id, location_id FROM src.communication_preferences WHERE location_id IS NOT NULL AND medspa_id IS NOT NULL
  UNION SELECT medspa_id, location_id FROM src.campaigns                 WHERE location_id IS NOT NULL AND medspa_id IS NOT NULL
),
grouped AS (
  SELECT location_id, min(medspa_id) AS tenant_id, count(DISTINCT medspa_id) AS tenants
  FROM pairs GROUP BY location_id
),
ambiguous AS (
  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9002_tenants', 'location_id', location_id::text,
         'location_id appears under more than one medspa_id',
         jsonb_build_object('tenantCount', tenants)
  FROM grouped WHERE tenants > 1
  ON CONFLICT DO NOTHING
  RETURNING 1
),
ins AS (
  INSERT INTO sub_tenants (id, tenant_id, name, external_ref, is_active)
  SELECT g.location_id, g.tenant_id, g.location_id::text,
         jsonb_build_object('system', 'mentera-location', 'id', g.location_id),
         true
  FROM grouped g WHERE g.tenants = 1
  ON CONFLICT (id) DO NOTHING
  RETURNING 1
)
INSERT INTO mig.log (loader, detail, n)
SELECT '9002_tenants', 'sub_tenants created from location_id', count(*) FROM ins;

-- A flat loader records its progress directly; `mig.advance` accumulates, which
-- is what the chunked loaders in 9007-9009 need and this does not. (A top-level
-- CALL cannot take a subquery argument, either.)
INSERT INTO mig.progress (loader, watermark, rows_done, started_at, updated_at)
VALUES ('9002_tenants', now(), (SELECT count(*) FROM tenants), now(), now())
ON CONFLICT (loader) DO UPDATE
  SET watermark = EXCLUDED.watermark,
      rows_done = EXCLUDED.rows_done,
      updated_at = now();

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING
--
--   SELECT detail, n FROM mig.log WHERE loader = '9002_tenants' ORDER BY id;
--   SELECT id, name, timezone FROM tenants ORDER BY id;
--
-- A tenant whose `name` equals its `id` had no configuration row. That is
-- expected for a medspa on platform-default credentials, and worth a glance if
-- it is a medspa you thought was configured.
-- -----------------------------------------------------------------------------
