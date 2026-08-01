-- =============================================================================
-- 9005_templates.sql
--
-- communication_templates → templates, PRESERVING ids.
-- template_versions → template_versions, preserving ids.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9005_templates.sql
--
-- Requires 9000, 9001, 9002. Idempotent.
--
-- -----------------------------------------------------------------------------
-- IDS ARE LOAD-BEARING HERE, UNLIKE ANYWHERE ELSE IN THIS SERIES
--
-- This is §0.5 Seam A. providers-service holds the real foreign keys today:
--   template_versions.template_id  -> ON DELETE CASCADE
--   notification_rules.email_template_id / .sms_template_id -> ON DELETE SET NULL
--
-- P10 drops those constraints and keeps the columns as soft references. Every
-- one of those UUIDs must still resolve after the move, so `templates.id` is
-- copied, never regenerated. A regenerated id would leave every notification
-- rule pointing at nothing, silently, and the failure would show up as
-- "some emails stopped having a template" weeks later.
--
-- 9010 checks this directly: every notification_rules template reference must
-- exist in `templates` afterwards.
--
-- -----------------------------------------------------------------------------
-- WHY THIS FILE BUILDS ITS INSERT WITH format()
--
-- One physical table, two owners, two different column sets (§0.5 Seam A):
-- providers-service declares `status`, communication-service declares
-- `template_type`, `created_by` and `updated_by`. Which of them the table
-- actually has depends on which service last ran `drizzle push`, and that is
-- not answerable from the code. `mig.src_col` asks the database and substitutes
-- a default for whatever is absent. It is the only dynamic SQL in the series,
-- and this drift is the reason for it.
--
-- -----------------------------------------------------------------------------
-- THREE VALUE NORMALISATIONS, EACH FORCED BY A TARGET CONSTRAINT
--
--   status  providers-service writes 'active'; the target CHECK (0001) is
--           ('draft','published','archived'). active -> published, NULL -> published.
--   format  the target CHECK is ('TEXT','HTML','MARKDOWN','MJML'). Uppercased,
--           and anything unrecognised becomes TEXT rather than failing the load.
--   channel lowercased. `templates.channel` is matched exactly by the engine
--           (content/store.ts:56, :179) and every pack-loaded template is
--           lowercase, so a migrated 'SMS' would be invisible to the same
--           lookup that finds 'sms'. See docs/api/BREAKING.md.
-- =============================================================================

BEGIN;

SELECT mig.require_source('communication_templates');

-- ── templates ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_status   text := mig.src_col('communication_templates', 'status', '''active''');
  v_type     text := mig.src_col('communication_templates', 'template_type', 'NULL::text');
  v_created  text := mig.src_col('communication_templates', 'created_by', 'NULL::text');
  v_updated  text := mig.src_col('communication_templates', 'updated_by', 'NULL::text');
  v_fallback text := mig.setting('template_fallback_tenant');
  n bigint;
BEGIN
  EXECUTE format($sql$
    INSERT INTO templates (
      id, tenant_id, pack_id, key, name, description, channel, subject, content,
      html_version, preview_text, variables, format, category, template_type,
      tags, attachments, status, is_active, is_default, version, usage_count,
      last_used_at, created_by, updated_by, created_at, updated_at
    )
    SELECT
      s.id,
      COALESCE(s.medspa_id, %L),
      NULL, NULL,
      COALESCE(NULLIF(btrim(s.name), ''), 'Untitled template ' || left(s.id::text, 8)),
      s.description,
      lower(btrim(s.channel)),
      s.subject,
      COALESCE(s.content, ''),
      s.html_version,
      s.preview_text,
      s.variables::jsonb,
      CASE upper(COALESCE(NULLIF(btrim(s.format), ''), 'TEXT'))
        WHEN 'HTML' THEN 'HTML' WHEN 'MARKDOWN' THEN 'MARKDOWN' WHEN 'MJML' THEN 'MJML'
        ELSE 'TEXT' END,
      s.category,
      %s,
      s.tags,
      COALESCE(s.attachments::jsonb, '[]'::jsonb),
      CASE lower(COALESCE(NULLIF(btrim(%s), ''), 'active'))
        WHEN 'draft' THEN 'draft' WHEN 'archived' THEN 'archived' ELSE 'published' END,
      COALESCE(s.is_active, true),
      COALESCE(s.is_default, false),
      COALESCE(s.version, 1),
      COALESCE(s.usage_count, 0),
      mig.to_tz(s.last_used_at),
      %s, %s,
      COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.updated_at), now())
    FROM src.communication_templates s
    WHERE COALESCE(s.medspa_id, %L) IS NOT NULL
      AND NULLIF(btrim(s.channel), '') IS NOT NULL
    ON CONFLICT (id) DO NOTHING
  $sql$, v_fallback, v_type, v_status, v_created, v_updated, v_fallback);

  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO mig.log (loader, detail, n) VALUES ('9005_templates', 'templates migrated', n);
END $$;

-- Quarantine, with the reason spelled out. Both cases are unfixable here:
-- `tenant_id` is NOT NULL in the target and guessing a tenant for a template is
-- how one clinic's message body ends up in another clinic's inbox; `channel` is
-- NOT NULL and a template whose channel we invent renders to the wrong place.
--
-- Both are fixable in the SOURCE and then re-runnable — that is the point of
-- quarantining rather than dropping. If the medspa_id really is unknowable, set
-- `template_fallback_tenant` (runbook §5.4) and re-run this file.
INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
SELECT '9005_templates', 'communication_templates', s.id::text,
       CASE WHEN s.medspa_id IS NULL AND mig.setting('template_fallback_tenant') IS NULL
              THEN 'medspa_id is NULL and template_fallback_tenant is unset'
            ELSE 'channel is NULL' END,
       jsonb_build_object('name', s.name, 'channel', s.channel, 'medspaId', s.medspa_id)
FROM src.communication_templates s
WHERE (s.medspa_id IS NULL AND mig.setting('template_fallback_tenant') IS NULL)
   OR NULLIF(btrim(s.channel), '') IS NULL
ON CONFLICT DO NOTHING;

-- ── template_versions ───────────────────────────────────────────────────────
-- The version rows move with the templates (§0.5 Seam A: they live in
-- providers-service today and its FK is what P10 drops). `tenant_id` comes from
-- the parent, which is the only place it exists.
--
-- Three source columns have no home in the target: `channel`, `format` and
-- `status`. They are properties of the template, not of a revision of its text,
-- and the parent row carries all three. The count is logged rather than left to
-- be noticed.
WITH ins AS (
  INSERT INTO template_versions (
    id, tenant_id, template_id, version, name, subject, content, html_version,
    variables, changed_by, change_note, created_at, updated_at
  )
  SELECT v.id, t.tenant_id, v.template_id, COALESCE(v.version, 1), v.name, v.subject,
         COALESCE(v.content, ''), v.html_version, v.variables::jsonb,
         v.created_by, NULL,
         COALESCE(mig.to_tz(v.created_at), now()), COALESCE(mig.to_tz(v.created_at), now())
  FROM src.template_versions v
  JOIN templates t ON t.id = v.template_id
  ON CONFLICT DO NOTHING
  RETURNING 1
)
INSERT INTO mig.log (loader, detail, n)
SELECT '9005_templates', 'template_versions migrated', count(*) FROM ins;

INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
SELECT '9005_templates', 'template_versions', v.id::text,
       'parent template did not migrate',
       jsonb_build_object('templateId', v.template_id, 'version', v.version)
FROM src.template_versions v
WHERE NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = v.template_id)
ON CONFLICT DO NOTHING;

INSERT INTO mig.log (loader, detail, n)
SELECT '9005_templates',
       'template_versions columns with no target home (channel/format/status) — the parent template carries them',
       count(*) FROM src.template_versions;

INSERT INTO mig.progress (loader, watermark, rows_done, started_at, updated_at)
VALUES ('9005_templates', now(),
        (SELECT count(*) FROM templates) + (SELECT count(*) FROM template_versions), now(), now())
ON CONFLICT (loader) DO UPDATE
  SET watermark = EXCLUDED.watermark, rows_done = EXCLUDED.rows_done, updated_at = now();

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING — the id-preservation check, which is the one that matters:
--
--   -- must be 0: every source template exists in the target under its own id
--   SELECT count(*) FROM src.communication_templates s
--   WHERE NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = s.id);
--
--   -- must be 0: every notification rule still resolves (P10 depends on it)
--   SELECT count(*) FROM src.notification_rules r
--   WHERE (r.email_template_id IS NOT NULL
--          AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = r.email_template_id))
--      OR (r.sms_template_id IS NOT NULL
--          AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = r.sms_template_id));
--
--   SELECT * FROM mig.rejects WHERE loader = '9005_templates';
-- -----------------------------------------------------------------------------
