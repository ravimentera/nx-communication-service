-- =============================================================================
-- 9006_preferences.sql
--
-- communication_preferences → recipient_preferences (§0.5 Seam B).
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9006_preferences.sql
--
-- Requires 9000-9004. Idempotent.
--
-- -----------------------------------------------------------------------------
-- THE SOURCE TABLE IS KEYED BY user_id AND THE TARGET IS KEYED BY recipient
--
-- `communication_preferences.patient_id` is NULLABLE, and the table has no
-- uniqueness constraint of any kind. The target's
-- UNIQUE (tenant_id, recipient_id) means two things have to happen here that
-- have no equivalent in the source:
--
--   - rows with a NULL patient_id cannot be attributed to a recipient and are
--     quarantined with a count. The plan predicted these; the count is what the
--     operator checks against the recon.
--   - where the source holds several rows for one (medspa_id, patient_id), the
--     most recently updated one wins and the rest are counted. Picking the
--     latest is the only defensible rule: it is what every read path in the
--     source effectively does by taking the first row an unordered query
--     returns, except deterministic.
--
-- -----------------------------------------------------------------------------
-- quiet_hours_timezone IS NEW, AND IT IS THE POINT OF THE COLUMN
--
-- The source stores quiet hours as bare 'HH:MM' strings and resolves the zone
-- at check time from a config lookup (preference.service.ts:331) — so the same
-- stored '22:00' means a different instant depending on which config the lookup
-- finds, and a missing config silently means the server's zone. Here the zone
-- is written down beside the hours, taken from the tenant (D38, D39).
-- =============================================================================

BEGIN;

SELECT mig.require_source('communication_preferences');

-- ─────────────────────────────────────────────────────────────────────────────
-- REFUSE TO RUN AFTER THE CUTOVER HAS BEEN FINALIZED.
--
-- This is the ONE loader that writes over existing rows (see the DO UPDATE
-- below and its reasoning). That is right while the old service is the sole
-- writer and wrong the moment it is not: after the repoint, re-running this
-- would take the source's `allow_communications` and overwrite an unsubscribe
-- somebody made in the NEW engine — putting a person who asked not to be
-- contacted back on the list, silently.
--
-- The row-level guard further down handles the ordinary case. This is the blunt
-- one, because "I re-ran the loaders to be safe" is a thing an operator does at
-- 2am and it should not be able to un-unsubscribe anybody.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF mig.setting('cutover_finalized') = 'true' THEN
    RAISE EXCEPTION
      '9006_preferences must not run after mig.finalize_cutover(): it overwrites preferences, and the new engine has been the writer since the repoint. If you genuinely need to re-load, clear mig.settings.cutover_finalized deliberately and read docs/MIGRATION_RUNBOOK.md first.';
  END IF;
END $$;

WITH latest AS (
  SELECT DISTINCT ON (s.medspa_id, s.patient_id) s.*
  FROM src.communication_preferences s
  WHERE s.medspa_id IS NOT NULL AND s.patient_id IS NOT NULL
  ORDER BY s.medspa_id, s.patient_id, s.updated_at DESC, s.created_at DESC, s.id
),
ins AS (
  INSERT INTO recipient_preferences (
    id, tenant_id, sub_tenant_id, recipient_id, user_id,
    allow_communications, preferred_channels, preferred_language,
    preferred_frequency, preferred_time_of_day,
    quiet_hours_start, quiet_hours_end, quiet_hours_timezone,
    event_opt_outs, unsubscribe_token, contact_info, metadata, updated_by,
    email_opt_in, sms_opt_in, push_opt_in, voice_opt_in, direct_mail_opt_in,
    created_at, updated_at
  )
  SELECT l.id, l.medspa_id, l.location_id,
         mig.recipient_id(l.medspa_id, l.patient_id),
         l.user_id,
         COALESCE(l.allow_communications, true), l.preferred_channels, l.preferred_language,
         COALESCE(NULLIF(btrim(l.preferred_frequency), ''), 'MODERATE'),
         l.preferred_time_of_day,
         NULLIF(btrim(l.quiet_hours_start), ''),
         NULLIF(btrim(l.quiet_hours_end), ''),
         -- Only meaningful when there are hours to interpret.
         CASE WHEN NULLIF(btrim(l.quiet_hours_start), '') IS NOT NULL
                OR NULLIF(btrim(l.quiet_hours_end), '') IS NOT NULL
              THEN COALESCE(t.timezone, COALESCE(mig.setting('default_tenant_timezone'), 'America/New_York'))
         END,
         '{}'::text[],
         -- P5 mints an unsubscribe token on demand; the source has none, and a
         -- migrated placeholder would collide with the UNIQUE constraint.
         NULL,
         l.contact_info::jsonb, l.metadata::jsonb, l.updated_by,
         -- Reserved per-channel opt-in flags, carried verbatim including NULLs.
         -- Not yet enforced anywhere — kept because the feature is half-built
         -- rather than abandoned, and this is the only moment the values can be
         -- recovered without a backup. See 0010_recipient_optins.sql.
         l.email_opt_in, l.sms_opt_in, l.push_opt_in, l.voice_opt_in, l.direct_mail_opt_in,
         COALESCE(mig.to_tz(l.created_at), now()), COALESCE(mig.to_tz(l.updated_at), now())
  FROM latest l
  LEFT JOIN tenants t ON t.id = l.medspa_id
  -- The recipient always exists: 9004 unions this table into its pair list.
  WHERE EXISTS (SELECT 1 FROM recipients r WHERE r.id = mig.recipient_id(l.medspa_id, l.patient_id))
  -- DO UPDATE, and this is the only loader that updates rather than skips.
  --
  -- Preferences are the one thing that changes during the parallel run whose
  -- staleness is a compliance failure rather than an inconvenience: somebody
  -- opts out of SMS in the old system on Tuesday, the cutover happens on
  -- Thursday, and the new engine — never having been told — messages them on
  -- Friday. Re-running this file before cutover therefore has to carry the
  -- change across, not skip the row because it already exists.
  --
  -- The same argument does not apply to 9003 and 9005: a stale template body or
  -- a rotated credential is visible and fixable, and neither results in
  -- contacting somebody who asked not to be contacted. Those stay insert-only.
  --
  -- Like everything else that writes over an existing row, this is only safe
  -- while the old service is the sole writer. See scripts/delta-sync.sql.
  ON CONFLICT (tenant_id, recipient_id) DO UPDATE SET
    allow_communications  = EXCLUDED.allow_communications,
    preferred_channels    = EXCLUDED.preferred_channels,
    preferred_language    = EXCLUDED.preferred_language,
    preferred_frequency   = EXCLUDED.preferred_frequency,
    preferred_time_of_day = EXCLUDED.preferred_time_of_day,
    quiet_hours_start     = EXCLUDED.quiet_hours_start,
    quiet_hours_end       = EXCLUDED.quiet_hours_end,
    quiet_hours_timezone  = EXCLUDED.quiet_hours_timezone,
    contact_info          = EXCLUDED.contact_info,
    metadata              = EXCLUDED.metadata,
    updated_by            = EXCLUDED.updated_by,
    -- Included so a re-run repairs rows loaded before 0010 added these columns:
    -- those took the ADD COLUMN default of true rather than the source's value.
    email_opt_in          = EXCLUDED.email_opt_in,
    sms_opt_in            = EXCLUDED.sms_opt_in,
    push_opt_in           = EXCLUDED.push_opt_in,
    voice_opt_in          = EXCLUDED.voice_opt_in,
    direct_mail_opt_in    = EXCLUDED.direct_mail_opt_in,
    updated_at            = EXCLUDED.updated_at
  -- ── LAST WRITER WINS, AND THE NEW ENGINE IS A WRITER ──────────────────────
  --
  -- Unconditional, this reverted anything the new engine had written. The case
  -- that matters is an unsubscribe: a recipient opts out after the repoint,
  -- somebody re-runs this loader, and the source's `allow_communications = true`
  -- comes straight back. They start receiving messages again, and nothing
  -- anywhere records that it happened.
  --
  -- The predicate is the honest rule the DO UPDATE always meant: carry the
  -- source's change across only when it is NEWER than what the target holds.
  -- A change made in the old system during the load still wins, which is the
  -- whole reason this loader updates rather than skips.
  WHERE recipient_preferences.updated_at <= EXCLUDED.updated_at
  RETURNING 1
)
INSERT INTO mig.log (loader, detail, n)
SELECT '9006_preferences', 'recipient_preferences migrated', count(*) FROM ins;

-- Collapsed duplicates: same (medspa_id, patient_id), older rows discarded.
INSERT INTO mig.log (loader, detail, n)
SELECT '9006_preferences', 'duplicate preference rows collapsed (kept the most recently updated)',
       count(*) - count(DISTINCT (medspa_id, patient_id))
FROM src.communication_preferences
WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL;

-- Unattributable rows. `user_id` is NOT NULL in the source, so a row with no
-- patient_id belongs to a *user* — a provider's own preference, or a row
-- written before the patient column existed. There is no recipient to hang it
-- on, and inventing one would put a staff member in the recipients table.
INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
SELECT '9006_preferences', 'communication_preferences', s.id::text,
       CASE WHEN s.patient_id IS NULL THEN 'patient_id is NULL — no recipient to key on'
            ELSE 'medspa_id is NULL — no tenant to attribute to' END,
       jsonb_build_object('userId', s.user_id, 'providerId', s.provider_id,
                          'patientId', s.patient_id, 'medspaId', s.medspa_id)
FROM src.communication_preferences s
WHERE s.patient_id IS NULL OR s.medspa_id IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO mig.progress (loader, watermark, rows_done, started_at, updated_at)
VALUES ('9006_preferences', now(), (SELECT count(*) FROM recipient_preferences), now(), now())
ON CONFLICT (loader) DO UPDATE
  SET watermark = EXCLUDED.watermark, rows_done = EXCLUDED.rows_done, updated_at = now();

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING
--
--   SELECT detail, n FROM mig.log WHERE loader = '9006_preferences' ORDER BY id;
--   SELECT reason, count(*) FROM mig.rejects WHERE loader = '9006_preferences' GROUP BY 1;
--
--   -- quiet hours carry a zone wherever there are hours to interpret
--   SELECT count(*) FROM recipient_preferences
--   WHERE quiet_hours_start IS NOT NULL AND quiet_hours_timezone IS NULL;  -- must be 0
-- -----------------------------------------------------------------------------
