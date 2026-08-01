-- =============================================================================
-- inspect-source.sql — P9 Step 1, reconnaissance
--
-- READ-ONLY. Run this against the mentera-core database — the shared
-- `postgres` one — BEFORE anything in migrations/9xxx.
--
--   psql "$SOURCE_DATABASE_URL" -f scripts/inspect-source.sql
--
-- Nothing here writes. There is not an INSERT, UPDATE, DELETE or CREATE in the
-- file, and that is checked by tests/integration/migration.test.ts.
--
-- -----------------------------------------------------------------------------
-- WHY IT RUNS FIRST
--
-- Four things in the migration are assumptions until this has been run, and
-- each of them changes what the operator does next:
--
--   §2  Which columns actually exist. `medspa_id`, `message_direction`,
--       `conversation_id`, `sender_name` and `participant_phone` are declared in
--       schema/db.ts but appear in NO source migration — they arrived through
--       `drizzle push`. The migration reads them; if one is missing, the load
--       fails on the first row rather than at the end.
--   §4  The size of the approval backlog, IN BOTH STORAGE SHAPES (D46). One
--       shape alone reports half the queue.
--   §5  How many messages were approved and never sent (D44). This number
--       decides `historic_approved_disposition`, and it should be read off a
--       screen rather than guessed at.
--   §8  Whether the seven §0.5 Seam D ghost tables are still empty. P2 closed
--       that seam on the evidence that they are. If one is not, stop.
--
-- Keep the output. The runbook compares it against the migration's own counts.
-- =============================================================================

\echo '==== 0. server, database, and the timezone every naked timestamp implies'

SELECT current_database()                     AS database,
       current_setting('server_version')      AS server_version,
       current_setting('TimeZone')            AS session_timezone,
       now()                                  AS now_tz,
       now()::timestamp                        AS now_naive;

-- The migration converts every `timestamp without time zone` with
-- `mig.settings.source_timezone` (default 'UTC'). This is the check that the
-- default is right: `written_naive` is what the application stored, and it
-- should equal the UTC rendering of the same instant, not the local one.
SELECT max(created_at)                              AS latest_written_naive,
       max(created_at) AT TIME ZONE 'UTC'           AS read_back_as_utc,
       now() AT TIME ZONE 'UTC'                     AS utc_now_naive
FROM message_history;

\echo '==== 1. columns — the migration reads every one of these by name'

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN (
  'communication_preferences','communication_batches','communication_events',
  'message_analytics','notifications','communication_templates','message_history',
  'scheduled_communications','ai_interactions','communication_memories',
  'campaigns','campaign_recipients','patient_feedback',
  'medspa_configurations','provider_configurations',
  'template_versions','notification_rules',
  'promotions','gift_cards','lead_profiles','treatment_follow_up_rules',
  'outreach_rules','farewell_messages'
)
ORDER BY table_name, ordinal_position;

\echo '==== 2. row counts (live estimates; run ANALYZE first if these look stale)'

SELECT relname, n_live_tup
FROM pg_stat_user_tables
WHERE relname IN (
  'communication_preferences','communication_batches','communication_events',
  'message_analytics','notifications','communication_templates','message_history',
  'scheduled_communications','ai_interactions','communication_memories',
  'campaigns','campaign_recipients','patient_feedback',
  'medspa_configurations','provider_configurations',
  'template_versions','notification_rules',
  'promotions','gift_cards','lead_profiles','treatment_follow_up_rules',
  'outreach_rules','farewell_messages'
)
ORDER BY n_live_tup DESC;

\echo '==== 3. tenancy — how many medspas, and how many rows cannot be attributed'

SELECT count(*) AS medspa_configurations FROM medspa_configurations;

SELECT count(*) AS distinct_medspa_ids_seen FROM (
  SELECT medspa_id FROM medspa_configurations    WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM message_history           WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM communication_events      WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM communication_memories    WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM communication_preferences WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM campaigns                 WHERE medspa_id IS NOT NULL
  UNION SELECT medspa_id FROM communication_templates   WHERE medspa_id IS NOT NULL
) u;

-- Every one of these is quarantined by the migration, not migrated. If a
-- number here is large, fix it in the SOURCE and re-run the loader.
SELECT 'message_history.medspa_id IS NULL'          AS unattributable, count(*) FROM message_history          WHERE medspa_id IS NULL
UNION ALL SELECT 'communication_events.medspa_id IS NULL',      count(*) FROM communication_events      WHERE medspa_id IS NULL
UNION ALL SELECT 'communication_templates.medspa_id IS NULL',   count(*) FROM communication_templates   WHERE medspa_id IS NULL
UNION ALL SELECT 'communication_preferences.patient_id IS NULL', count(*) FROM communication_preferences WHERE patient_id IS NULL
UNION ALL SELECT 'communication_preferences.medspa_id IS NULL',  count(*) FROM communication_preferences WHERE medspa_id IS NULL
UNION ALL SELECT 'notifications with no event',                 count(*) FROM notifications n
  WHERE NOT EXISTS (SELECT 1 FROM communication_events e WHERE e.id = n.event_id AND e.medspa_id IS NOT NULL)
ORDER BY 2 DESC;

\echo '==== 4. approval backlog — BOTH storage shapes, counted separately (D46)'

-- Shape A is "has an approvalStatus key", NOT "status = QUEUED": the controller
-- flips the status column to APPROVED as well as the blob
-- (approvals.controller.ts:360), so a QUEUED-only predicate misses every
-- already-decided row. Shape B is the exact complement, so the two together
-- cover the table with no overlap.
SELECT 'A' AS shape, queued_message->>'approvalStatus' AS state, count(*)
FROM message_history
WHERE queued_message->>'approvalStatus' IS NOT NULL
GROUP BY 1, 2
UNION ALL
SELECT 'B', status, count(*)
FROM message_history
WHERE queued_message->>'approvalStatus' IS NULL
  AND status IN ('PENDING_APPROVAL','APPROVED','SCHEDULED','REJECTED','DECLINED')
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '==== 5. the historic APPROVED backlog — the number behind 9009 (D44)'

-- Approving has never dispatched anything, so "approved" and "sent" are
-- unrelated in this data. `sent_at` is NOT NULL in this schema and is written
-- at INSERT time, so `AND sent_at IS NULL` (which an earlier draft of the plan
-- carried) matches nothing and would report a comforting zero. Both numbers are
-- printed so the difference is visible rather than assumed.
SELECT count(*) FILTER (
         WHERE status = 'APPROVED' OR queued_message->>'approvalStatus' = 'APPROVED'
       ) AS approved_any,
       count(*) FILTER (
         WHERE (status = 'APPROVED' OR queued_message->>'approvalStatus' = 'APPROVED')
           AND sent_at IS NULL
       ) AS approved_and_sent_at_is_null,
       count(*) FILTER (
         WHERE status = 'PENDING_APPROVAL'
            OR queued_message->>'approvalStatus' = 'PENDING_APPROVAL'
       ) AS still_pending
FROM message_history;

-- Oldest and newest of them. A backlog reaching back a year is the argument for
-- the CANCELLED disposition; a backlog from this week may be worth releasing.
SELECT min(created_at) AS oldest, max(created_at) AS newest
FROM message_history
WHERE status = 'APPROVED' OR queued_message->>'approvalStatus' = 'APPROVED';

\echo '==== 6. message vocabulary — every status and channel spelling in the data'

-- `mig.map_message_status` must recognise every status listed here. Anything it
-- does not know quarantines the row, so read this list against the prelude
-- before the load rather than after it.
SELECT status, count(*) FROM message_history GROUP BY 1 ORDER BY 2 DESC;
SELECT channel, count(*) FROM message_history GROUP BY 1 ORDER BY 2 DESC;
SELECT message_direction, count(*) FROM message_history GROUP BY 1 ORDER BY 2 DESC;
SELECT channel, count(*) FROM communication_templates GROUP BY 1 ORDER BY 2 DESC;

\echo '==== 7. Seam A — the two owners of communication_templates'

SELECT count(*) AS templates                      FROM communication_templates;
SELECT count(*) AS template_versions              FROM template_versions;
SELECT count(*) AS notification_rules_with_refs   FROM notification_rules
  WHERE email_template_id IS NOT NULL OR sms_template_id IS NOT NULL;

-- Rules whose template no longer exists AT THE SOURCE. These are already broken
-- today; the migration neither fixes nor worsens them, but P10 will look like
-- the cause if nobody wrote the number down first.
SELECT count(*) AS notification_rules_already_dangling
FROM notification_rules r
WHERE (r.email_template_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM communication_templates t WHERE t.id = r.email_template_id))
   OR (r.sms_template_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM communication_templates t WHERE t.id = r.sms_template_id));

\echo '==== 8. Seam D guard — these seven MUST still be empty (§0.5, D11)'

-- A non-zero count here is not a migration problem to work around. It means the
-- premise P2 closed Seam D on has changed: there is now vertical data with no
-- tenant column and nowhere in the engine's schema to put it. Stop, and re-open
-- §0.5 Seam D.
SELECT t.name,
       CASE WHEN to_regclass('public.' || t.name) IS NULL THEN 'absent'
            ELSE 'present' END AS table_state
FROM (VALUES ('promotions'),('gift_cards'),('lead_profiles'),
             ('treatment_follow_up_rules'),('outreach_rules'),
             ('farewell_messages'),('patient_feedback')) AS t(name);

-- Run these individually for whichever of the above came back 'present':
--   SELECT count(*) FROM promotions;
--   SELECT count(*) FROM gift_cards;
--   SELECT count(*) FROM lead_profiles;
--   SELECT count(*) FROM treatment_follow_up_rules;
--   SELECT count(*) FROM outreach_rules;
--   SELECT count(*) FROM farewell_messages;
--   SELECT count(*) FROM patient_feedback;

\echo '==== 9. recipient cardinality — how big `recipients` will be'

SELECT count(*) AS recipients_expected FROM (
  SELECT medspa_id AS t, patient_id AS p FROM message_history
    WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  UNION SELECT medspa_id, patient_id FROM communication_events
    WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  UNION SELECT medspa_id, patient_id FROM communication_memories
    WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  UNION SELECT medspa_id, patient_id FROM communication_preferences
    WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  UNION SELECT c.medspa_id, cr.patient_id FROM campaign_recipients cr
    JOIN campaigns c ON c.id = cr.campaign_id
    WHERE c.medspa_id IS NOT NULL AND cr.patient_id IS NOT NULL
  UNION SELECT mh.medspa_id, ma.patient_id FROM message_analytics ma
    JOIN message_history mh ON mh.id = ma.message_id
    WHERE mh.medspa_id IS NOT NULL AND ma.patient_id IS NOT NULL
) u;

-- How many of them will arrive with a display name, and how many will wait for
-- the context provider to fill one in on first contact.
SELECT count(DISTINCT (medspa_id, patient_id)) AS with_a_name
FROM message_history
WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  AND NULLIF(btrim(metadata->>'patientName'), '') IS NOT NULL
  AND lower(btrim(metadata->>'patientName')) <> 'unknown patient';

\echo '==== 10. duplicates the target schema will not accept'

-- recipient_preferences is UNIQUE (tenant_id, recipient_id); the source has no
-- such constraint. The migration keeps the most recently updated row.
SELECT count(*) AS preference_rows_that_will_collapse
FROM (
  SELECT medspa_id, patient_id FROM communication_preferences
  WHERE medspa_id IS NOT NULL AND patient_id IS NOT NULL
  GROUP BY 1, 2 HAVING count(*) > 1
) d;

-- message_analytics is UNIQUE (message_id) from 0008. These fold rather than
-- collapse: the earliest row survives and the others' non-null engagement
-- fields are merged into it.
SELECT count(*) AS analytics_messages_with_several_rows
FROM (
  SELECT message_id FROM message_analytics
  WHERE message_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1
) d;

\echo '==== 11. volume shape — the window size for the chunked loaders'

SELECT date_trunc('month', created_at) AS month, count(*)
FROM message_history GROUP BY 1 ORDER BY 1;
