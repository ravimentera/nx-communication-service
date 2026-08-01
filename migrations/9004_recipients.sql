-- =============================================================================
-- 9004_recipients.sql
--
-- One `recipients` row per (medspa_id, patient_id) the data has ever mentioned.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9004_recipients.sql
--
-- Requires 9000, 9001, 9002. Idempotent — the ids are derived, not generated.
--
-- -----------------------------------------------------------------------------
-- THIS TABLE IS THE ANSWER TO SEAM C
--
-- `communications.controller.ts` resolves display names by reaching into
-- patient-service's table (`SELECT patient_id, first_name || ' ' || last_name
-- FROM patients` at :1240, :1441, :1671). The outreach engine owns no such
-- table and must not read one it does not own, so every name it can show has to
-- already be here.
--
-- What it can be seeded from is thinner than the source's join: the last
-- `metadata->>'patientName'` the source itself recorded on a message, and the
-- phone/email on the preference row. That is deliberate — P5's
-- MenteraContextProvider refreshes a recipient from patient-service on first
-- contact, so a name that is missing or stale here is corrected the first time
-- the recipient is messaged, and no cross-database read survives the cutover.
--
-- 'Unknown Patient' is filtered out. It is the source's own fallback literal
-- (communications.controller.ts:845, :1323) and it leaks into stored metadata;
-- migrating it would turn "we do not know this name" into "this person's name
-- is Unknown Patient", which renders into a template.
--
-- -----------------------------------------------------------------------------
-- WHY THE ID IS DERIVED RATHER THAN GENERATED
--
-- `mig.recipient_id(tenant_id, patient_id)` is UUID v5 over the pair (see the
-- prelude). Every later script computes a message's recipient with the same
-- function and no lookup table, re-runs are exact no-ops, and the delta sync
-- lands on the same rows days later. A generated uuid would need a permanent
-- crosswalk table that nothing else in the schema knows about.
-- =============================================================================

BEGIN;

SELECT mig.require_source('message_history');
SELECT mig.require_source('communication_preferences');

WITH pairs AS (
  SELECT medspa_id AS tenant_id, patient_id, min(created_at) AS first_seen
  FROM src.message_history
  WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  GROUP BY 1, 2

  UNION ALL
  SELECT medspa_id, patient_id, min(created_at)
  FROM src.communication_events
  WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  GROUP BY 1, 2

  UNION ALL
  SELECT medspa_id, patient_id, min(created_at)
  FROM src.communication_memories
  WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  GROUP BY 1, 2

  UNION ALL
  SELECT medspa_id, patient_id, min(created_at)
  FROM src.communication_preferences
  WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  GROUP BY 1, 2

  -- campaign_recipients has no tenant column; the campaign carries it.
  UNION ALL
  SELECT c.medspa_id, cr.patient_id, min(cr.created_at)
  FROM src.campaign_recipients cr
  JOIN src.campaigns c ON c.id = cr.campaign_id
  WHERE c.medspa_id IS NOT NULL AND cr.patient_id IS NOT NULL
  GROUP BY 1, 2

  -- message_analytics has no tenant column either, and its patient_id is not
  -- guaranteed to equal the message's — it is carried separately in the source.
  UNION ALL
  SELECT mh.medspa_id, ma.patient_id, min(ma.created_at)
  FROM src.message_analytics ma
  JOIN src.message_history mh ON mh.id = ma.message_id
  WHERE mh.medspa_id IS NOT NULL AND ma.patient_id IS NOT NULL
  GROUP BY 1, 2
),
merged AS (
  SELECT tenant_id, patient_id, min(first_seen) AS first_seen
  FROM pairs GROUP BY 1, 2
),
-- Latest name the source itself recorded, per recipient.
names AS (
  SELECT DISTINCT ON (medspa_id, patient_id)
         medspa_id AS tenant_id, patient_id,
         btrim(metadata->>'patientName') AS display_name
  FROM src.message_history
  WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
    AND NULLIF(btrim(metadata->>'patientName'), '') IS NOT NULL
    AND lower(btrim(metadata->>'patientName')) <> 'unknown patient'
  ORDER BY medspa_id, patient_id, created_at DESC
),
-- The other party's number on the most recent SMS. For an outbound message
-- that is the recipient's phone, which is what makes it usable here.
phones AS (
  SELECT DISTINCT ON (medspa_id, patient_id)
         medspa_id AS tenant_id, patient_id,
         NULLIF(btrim(participant_phone), '') AS phone
  FROM src.message_history
  WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
    AND NULLIF(btrim(participant_phone), '') IS NOT NULL
  ORDER BY medspa_id, patient_id, created_at DESC
),
prefs AS (
  SELECT DISTINCT ON (medspa_id, patient_id)
         medspa_id AS tenant_id, patient_id,
         NULLIF(btrim(contact_info->>'email'), '') AS email,
         NULLIF(btrim(contact_info->>'phone'), '') AS phone
  FROM src.communication_preferences
  WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  ORDER BY medspa_id, patient_id, updated_at DESC
),
ins AS (
  INSERT INTO recipients (
    id, tenant_id, display_name, first_name, last_name,
    contact_points, external_ref, status, attributes, created_at, updated_at
  )
  SELECT
    mig.recipient_id(m.tenant_id, m.patient_id),
    m.tenant_id,
    n.display_name,
    -- The source composed display names as `first_name || ' ' || last_name`, so
    -- splitting on the first space recovers the parts for `{{recipient.firstName}}`
    -- without inventing anything. A single-token name yields a first name only.
    NULLIF(split_part(n.display_name, ' ', 1), ''),
    CASE WHEN position(' ' IN COALESCE(n.display_name, '')) > 0
         THEN NULLIF(btrim(substring(n.display_name FROM position(' ' IN n.display_name) + 1)), '')
    END,
    COALESCE(cp.points, '[]'::jsonb),
    jsonb_build_object('system', 'mentera-patient', 'id', m.patient_id),
    'active',
    '{}'::jsonb,
    COALESCE(mig.to_tz(m.first_seen), now()),
    COALESCE(mig.to_tz(m.first_seen), now())
  FROM merged m
  LEFT JOIN names  n  ON n.tenant_id  = m.tenant_id AND n.patient_id  = m.patient_id
  LEFT JOIN phones ph ON ph.tenant_id = m.tenant_id AND ph.patient_id = m.patient_id
  LEFT JOIN prefs  pr ON pr.tenant_id = m.tenant_id AND pr.patient_id = m.patient_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(point ORDER BY ord) AS points FROM (
      SELECT 1 AS ord, jsonb_build_object('type', 'email', 'value', pr.email, 'primary', true) AS point
      WHERE pr.email IS NOT NULL
      UNION ALL
      SELECT 2, jsonb_build_object('type', 'phone', 'value', COALESCE(pr.phone, ph.phone),
                                   'primary', pr.email IS NULL)
      WHERE COALESCE(pr.phone, ph.phone) IS NOT NULL
    ) z
  ) cp ON true
  -- Covers both the primary key and the partial unique index on
  -- (tenant_id, external_ref->>'system', external_ref->>'id') — they agree by
  -- construction, since the id is derived from the same pair.
  ON CONFLICT DO NOTHING
  RETURNING 1
)
INSERT INTO mig.log (loader, detail, n)
SELECT '9004_recipients', 'recipients created', count(*) FROM ins;

-- Not a rejection here — 9008 quarantines these message rows when it reaches
-- them — but the count belongs next to the recipient count, because "why are
-- there fewer recipients than I expected?" is answered by it.
INSERT INTO mig.log (loader, detail, n)
SELECT '9004_recipients', 'source message rows with no medspa_id (quarantined later by 9008)', count(*)
FROM src.message_history WHERE medspa_id IS NULL;

INSERT INTO mig.log (loader, detail, n)
SELECT '9004_recipients', 'recipients with no name from any source', count(*)
FROM recipients WHERE display_name IS NULL;

INSERT INTO mig.progress (loader, watermark, rows_done, started_at, updated_at)
VALUES ('9004_recipients', now(), (SELECT count(*) FROM recipients), now(), now())
ON CONFLICT (loader) DO UPDATE
  SET watermark = EXCLUDED.watermark, rows_done = EXCLUDED.rows_done, updated_at = now();

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING
--
--   -- must match the recon's "recipient cardinality" number
--   SELECT count(*) FROM recipients;
--
--   -- the derivation is reproducible: this must return true for every row
--   SELECT bool_and(id = mig.recipient_id(tenant_id, external_ref->>'id'))
--   FROM recipients WHERE external_ref->>'system' = 'mentera-patient';
--
--   SELECT detail, n FROM mig.log WHERE loader = '9004_recipients' ORDER BY id;
-- -----------------------------------------------------------------------------
