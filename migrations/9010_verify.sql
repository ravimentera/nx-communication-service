-- =============================================================================
-- 9010_verify.sql
--
-- Did it work? One function, one table of answers.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9010_verify.sql
--
-- Requires 9000-9009. Reads only; safe to run as often as you like, including
-- during the parallel run after every delta sync.
--
-- -----------------------------------------------------------------------------
-- WHAT A ROW MEANS
--
--   PASS   expected and actual agree
--   FAIL   they do not, and the difference is not explainable by anything this
--          migration knows about. Do not cut over on a FAIL.
--   WARN   a difference that is expected in some circumstances and not in
--          others. Every WARN has a one-line explanation in the runbook §6, and
--          each one must be read by a person rather than skimmed:
--            - quarantined rows (mig.rejects) — expected only if the recon
--              predicted them
--            - source rows added since the link — expected during a parallel
--              run, and MUST be zero in the final cutover window
--
-- The counts on the source side deliberately restate each loader's own WHERE
-- clause rather than counting the whole table. Comparing a filtered load
-- against an unfiltered count produces a permanent, meaningless FAIL, and a
-- check nobody believes is worse than no check.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION mig.verify()
RETURNS TABLE (check_name text, expected bigint, actual bigint, status text)
LANGUAGE plpgsql AS $$
DECLARE
  g text;
  n bigint;
BEGIN
  -- ── row-count parity, per table ───────────────────────────────────────────
  RETURN QUERY
  WITH c(check_name, expected, actual, on_mismatch) AS (
    VALUES
      ('tenants',
       (SELECT count(*) FROM (
          SELECT medspa_id FROM src.medspa_configurations   WHERE medspa_id IS NOT NULL
          UNION SELECT medspa_id FROM src.message_history          WHERE medspa_id IS NOT NULL
          UNION SELECT medspa_id FROM src.communication_events     WHERE medspa_id IS NOT NULL
          UNION SELECT medspa_id FROM src.communication_memories   WHERE medspa_id IS NOT NULL
          UNION SELECT medspa_id FROM src.communication_preferences WHERE medspa_id IS NOT NULL
          UNION SELECT medspa_id FROM src.campaigns                WHERE medspa_id IS NOT NULL
          UNION SELECT medspa_id FROM src.communication_templates  WHERE medspa_id IS NOT NULL
          UNION SELECT medspa_id FROM src.provider_configurations  WHERE medspa_id IS NOT NULL) u),
       -- Engine-reserved tenants are excluded: they have no counterpart in the
       -- source, by definition. `platform` (0011) exists so that identity-level
       -- mail — email verification, password reset — has a tenant to send under,
       -- and counting it here would report a one-row surplus and FAIL a
       -- migration that is in fact correct.
       (SELECT count(*) FROM tenants
        WHERE COALESCE(settings->>'engineReserved', 'false') <> 'true'), 'FAIL'),

      ('tenant_channel_configs',
       (SELECT count(*) FROM src.medspa_configurations WHERE medspa_id IS NOT NULL),
       (SELECT count(*) FROM tenant_channel_configs), 'FAIL'),

      ('agent_channel_configs',
       (SELECT count(*) FROM src.provider_configurations
         WHERE medspa_id IS NOT NULL AND provider_id IS NOT NULL),
       (SELECT count(*) FROM agent_channel_configs), 'FAIL'),

      ('recipients',
       (SELECT count(*) FROM (
          SELECT medspa_id AS t, patient_id AS p FROM src.message_history
            WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
          UNION SELECT medspa_id, patient_id FROM src.communication_events
            WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
          UNION SELECT medspa_id, patient_id FROM src.communication_memories
            WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
          UNION SELECT medspa_id, patient_id FROM src.communication_preferences
            WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
          UNION SELECT c2.medspa_id, cr.patient_id FROM src.campaign_recipients cr
            JOIN src.campaigns c2 ON c2.id = cr.campaign_id
            WHERE c2.medspa_id IS NOT NULL AND cr.patient_id IS NOT NULL
          UNION SELECT mh.medspa_id, ma.patient_id FROM src.message_analytics ma
            JOIN src.message_history mh ON mh.id = ma.message_id
            WHERE mh.medspa_id IS NOT NULL AND ma.patient_id IS NOT NULL) u),
       (SELECT count(*) FROM recipients), 'FAIL'),

      ('templates',
       (SELECT count(*) FROM src.communication_templates s
         WHERE COALESCE(s.medspa_id, mig.setting('template_fallback_tenant')) IS NOT NULL
           AND NULLIF(btrim(s.channel), '') IS NOT NULL),
       (SELECT count(*) FROM templates), 'FAIL'),

      -- The one that P10 depends on: ids preserved, not regenerated.
      ('templates: source ids missing from target', 0,
       (SELECT count(*) FROM src.communication_templates s
         WHERE COALESCE(s.medspa_id, mig.setting('template_fallback_tenant')) IS NOT NULL
           AND NULLIF(btrim(s.channel), '') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = s.id)), 'FAIL'),

      ('notification_rules pointing at a template that did not migrate', 0,
       (SELECT count(*) FROM src.notification_rules r
         WHERE (r.email_template_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = r.email_template_id))
            OR (r.sms_template_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = r.sms_template_id))), 'FAIL'),

      ('template_versions',
       (SELECT count(*) FROM src.template_versions v
         WHERE EXISTS (SELECT 1 FROM templates t WHERE t.id = v.template_id)),
       (SELECT count(*) FROM template_versions), 'FAIL'),

      ('recipient_preferences',
       (SELECT count(DISTINCT (medspa_id, patient_id)) FROM src.communication_preferences
         WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL),
       (SELECT count(*) FROM recipient_preferences), 'FAIL'),

      ('outreach_events',
       (SELECT count(*) FROM src.communication_events WHERE medspa_id IS NOT NULL),
       (SELECT count(*) FROM outreach_events), 'FAIL'),

      ('notifications',
       (SELECT count(*) FROM src.notifications s
         WHERE EXISTS (SELECT 1 FROM src.communication_events e
                        WHERE e.id = s.event_id AND e.medspa_id IS NOT NULL)),
       (SELECT count(*) FROM notifications), 'FAIL'),

      ('scheduled_messages',
       (SELECT count(*) FROM src.scheduled_communications s
         WHERE EXISTS (SELECT 1 FROM outreach_events e WHERE e.id = s.event_id)),
       (SELECT count(*) FROM scheduled_messages), 'FAIL'),

      ('campaigns',
       (SELECT count(*) FROM src.campaigns WHERE medspa_id IS NOT NULL),
       (SELECT count(*) FROM campaigns), 'FAIL'),

      ('campaign_recipients',
       (SELECT count(*) FROM src.campaign_recipients s
         WHERE EXISTS (SELECT 1 FROM campaigns cp WHERE cp.id = s.campaign_id)),
       (SELECT count(*) FROM campaign_recipients), 'FAIL'),

      ('recipient_memories',
       (SELECT count(*) FROM src.communication_memories WHERE medspa_id IS NOT NULL),
       (SELECT count(*) FROM recipient_memories), 'FAIL'),

      ('messages',
       (SELECT count(*) FROM src.message_history s
         WHERE s.medspa_id IS NOT NULL AND mig.map_message_status(s.status) IS NOT NULL),
       (SELECT count(*) FROM messages), 'FAIL'),

      -- Coverage, in the direction that matters: every approval-shaped source
      -- row must have produced an approval. This is the D46 guard — a missed
      -- storage shape shows up here as a non-zero count, whichever shape it is.
      --
      -- Stated as coverage rather than as count equality on purpose. During the
      -- parallel run a row can stop being approval-shaped (approved, sent, and
      -- now carrying a delivery status) while its approval legitimately remains,
      -- so equality would start failing for a reason that is not a fault.
      ('approval-shaped source rows with no approval row (both shapes)', 0,
       (SELECT count(*) FROM src.message_history s
         JOIN messages m ON m.id = s.id
         WHERE ((s.queued_message->>'approvalStatus' IS NOT NULL
                 AND mig.map_approval_status(s.queued_message->>'approvalStatus') IS NOT NULL)
             OR (s.queued_message->>'approvalStatus' IS NULL
                 AND upper(COALESCE(s.status, '')) IN
                     ('PENDING_APPROVAL','APPROVED','SCHEDULED','REJECTED','DECLINED')))
           AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.message_id = m.id)), 'FAIL'),

      -- ── nothing migrated is still actionable (D99) ──────────────────────
      -- The invariant the disposition rests on: once the old service has stopped
      -- for good, a migrated row in a live state is work that will never move —
      -- and it sits in a provider's inbox looking like work that will.
      --
      -- Both are **no-ops until `mig.finalize_cutover()` has run**, and hard
      -- assertions afterwards. Before that point live rows are the normal state
      -- of a load: the source can still write, and cancelling early would freeze
      -- a row the delta would otherwise have moved on. Skipped entirely when the
      -- operator has chosen another disposition.
      --
      -- Every column reference is table-qualified: this function
      -- `RETURNS TABLE (…, status text)`, so a bare `status` resolves to the
      -- output column and Postgres rejects the query as ambiguous.
      ('migrated messages left in a live state (after finalize)', 0,
       (SELECT CASE
          WHEN COALESCE(mig.setting('cutover_finalized'), '') <> 'true'
            OR upper(COALESCE(mig.setting('historic_approved_disposition'), 'CANCELLED'))
               <> 'CANCELLED' THEN 0
          ELSE (SELECT count(*) FROM messages m
                 WHERE m.metadata->>'migrated' = 'true'
                   AND m.status IN ('PENDING', 'PENDING_APPROVAL', 'QUEUED'))
        END), 'FAIL'),

      ('migrated approvals left in a live state (after finalize)', 0,
       (SELECT CASE
          WHEN COALESCE(mig.setting('cutover_finalized'), '') <> 'true'
            OR upper(COALESCE(mig.setting('historic_approved_disposition'), 'CANCELLED'))
               <> 'CANCELLED' THEN 0
          -- `jsonb_array_length = 1` as well as the containment, matching
          -- `finalize_cutover`'s own predicate exactly. Containment alone is not
          -- enough: an approval a human decided in the NEW system still carries
          -- the migration entry underneath their own, and finalize leaves it
          -- alone on purpose. Without this the check would report a fault every
          -- time somebody did their job.
          ELSE (SELECT count(*) FROM approvals a
                 WHERE jsonb_array_length(a.audit_trail) = 1
                   AND a.audit_trail @> '[{"actorRef":"migration:p9"}]'::jsonb
                   AND a.status IN ('PENDING_APPROVAL', 'APPROVED', 'SCHEDULED'))
        END), 'FAIL'),

      -- Every migrated message keeps the word it arrived with, so cancelling
      -- the backlog is not lossy and D44's count stays answerable.
      ('migrated messages missing their source status', 0,
       (SELECT count(*) FROM messages m
         WHERE m.metadata->>'migrated' = 'true'
           AND m.metadata->'migration'->>'sourceStatus' IS NULL), 'FAIL'),

      -- ── integrity, not parity ───────────────────────────────────────────
      ('message_analytics rows per message never exceeds one', 0,
       (SELECT count(*) FROM (
          SELECT message_id FROM message_analytics
          WHERE message_id IS NOT NULL GROUP BY message_id HAVING count(*) > 1) d), 'FAIL'),

      ('approvals without a message', 0,
       (SELECT count(*) FROM approvals a
         WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = a.message_id)), 'FAIL'),

      ('messages whose approval_id dangles', 0,
       (SELECT count(*) FROM messages m
         WHERE m.approval_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.id = m.approval_id)), 'FAIL'),

      ('messages that had a patient_id but no recipient', 0,
       (SELECT count(*) FROM src.message_history s
         JOIN messages m ON m.id = s.id
         WHERE s.patient_id IS NOT NULL AND m.recipient_id IS NULL), 'FAIL'),

      ('recipient ids are reproducible from (tenant, external_ref)', 0,
       (SELECT count(*) FROM recipients r
         WHERE r.external_ref->>'system' = 'mentera-patient'
           AND r.id <> mig.recipient_id(r.tenant_id, r.external_ref->>'id')), 'FAIL'),

      ('rows with a tenant that has no tenants row', 0,
       (SELECT (SELECT count(*) FROM messages m WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = m.tenant_id))
             + (SELECT count(*) FROM recipients r WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = r.tenant_id))
             + (SELECT count(*) FROM outreach_events e WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = e.tenant_id))), 'FAIL'),

      -- ── things a person has to look at ──────────────────────────────────
      ('quarantined rows (see mig.rejects)', 0,
       (SELECT count(*) FROM mig.rejects), 'WARN'),

      ('source rows added since the link (must be 0 in the cutover window)', 0,
       (SELECT COALESCE(sum(GREATEST(mig.src_count(b.table_name) - b.n, 0)), 0)
          FROM mig.source_baseline b), 'WARN'),

      -- A source row that VANISHED is the one thing the read-only promise
      -- absolutely forbids, so it is a FAIL rather than a WARN.
      ('source rows deleted since the link', 0,
       (SELECT COALESCE(sum(GREATEST(b.n - mig.src_count(b.table_name), 0)), 0)
          FROM mig.source_baseline b), 'FAIL')
  )
  -- Explicit casts: a VALUES list resolves `0` to integer and `count(*)` to
  -- bigint, and the function's declared result type is not negotiable about it.
  SELECT c.check_name::text, c.expected::bigint, c.actual::bigint,
         (CASE WHEN c.actual = c.expected THEN 'PASS' ELSE c.on_mismatch END)::text
  FROM c;

  -- ── §0.5 Seam D: the ghost tables must still be empty ─────────────────────
  -- P2 closed this seam on the evidence that all seven tables hold zero rows.
  -- Nothing migrates from them and the engine has nowhere to put their data, so
  -- a non-zero count here is not a migration failure — it means the premise
  -- changed and Seam D has to be re-opened before cutover. That is a FAIL.
  FOREACH g IN ARRAY ARRAY[
    'promotions','gift_cards','lead_profiles','treatment_follow_up_rules',
    'outreach_rules','farewell_messages','patient_feedback'
  ] LOOP
    -- NULL means the table does not exist at all, which is the strongest
    -- possible form of empty.
    n := COALESCE(mig.src_count(g), 0);
    check_name := format('ghost table %s is absent or empty (§0.5 Seam D)', g);
    expected := 0;
    actual := n;
    status := CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;
    RETURN NEXT;
  END LOOP;

  -- ── the read-only promise, as a structural fact ───────────────────────────
  check_name := 'the source link is declared read-only (updatable=false)';
  expected := 1;
  actual := (SELECT count(*) FROM pg_foreign_server
              WHERE srvname = 'mentera_source'
                AND 'updatable=false' = ANY (srvoptions));
  -- The CSV transport has no foreign server and needs no such option, so its
  -- absence is only a failure when there is a link to speak of.
  status := CASE
              WHEN actual = 1 THEN 'PASS'
              WHEN NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'mentera_source')
                THEN 'PASS'
              ELSE 'FAIL'
            END;
  RETURN NEXT;
END $$;

COMMIT;

-- @@ SPLIT @@

SELECT * FROM mig.verify() ORDER BY status DESC, check_name;

-- -----------------------------------------------------------------------------
-- HOW TO READ THE OUTPUT
--
--   SELECT * FROM mig.verify() WHERE status <> 'PASS';   -- the only rows that matter
--
-- Every WARN needs an explanation before cutover:
--
--   SELECT loader, source_table, reason, count(*) FROM mig.rejects
--   GROUP BY 1, 2, 3 ORDER BY 4 DESC;
--
--   SELECT loader, detail, n FROM mig.log ORDER BY id;
--
-- Not one FAIL, every WARN accounted for, and the delta sync run inside the
-- cutover window with the old service stopped — that is the exit condition
-- P10 needs.
-- -----------------------------------------------------------------------------
