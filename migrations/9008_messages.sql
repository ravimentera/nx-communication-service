-- =============================================================================
-- 9008_messages.sql
--
-- message_history → messages, and message_analytics → message_analytics.
-- The largest table in the migration, and the only one loaded in windows.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9008_messages.sql
--
-- Requires 9000-9007. Idempotent and resumable — a run that is interrupted
-- keeps every window it committed and restarts from the watermark.
--
-- -----------------------------------------------------------------------------
-- FOUR THINGS CHANGE ON THE WAY ACROSS, AND NONE OF THEM IS COSMETIC
--
-- 1. `direction` COMES FROM A COLUMN, NOT FROM metadata.
--    The plan said `metadata->>'direction'`. The real source has BOTH: a
--    `message_direction` column (schema/db.ts:158, NOT NULL, written as
--    'INBOUND'/'OUTBOUND' at eight call sites) and a metadata key that some
--    paths also set. The column wins, metadata is the fallback, and the target
--    CHECK wants lowercase.
--
-- 2. `status` SPLITS IN TWO.
--    The source keeps delivery state and approval state in one column, so
--    'APPROVED' is both "a human said yes" and "this message's delivery state".
--    Here the approval lives in `approvals` (9009) and this column keeps only
--    what happened to the message. `mig.map_message_status` is the whole map,
--    with its reasoning, in the prelude. A status it does not recognise
--    quarantines the row rather than inventing a state.
--
-- 3. `sent_at` IS COPIED VERBATIM, INCLUDING ON MESSAGES THAT WERE NEVER SENT.
--    `message_history.sent_at` is NOT NULL in the source and is written at
--    insert time, so it is really "when this row was made", and a draft has one.
--    The target's read paths order conversations and inboxes by `sent_at DESC`
--    (idx_messages_conversation), and NULLs sort FIRST in a DESC ordering — so
--    nulling it out for unsent rows would float every draft to the top of every
--    conversation. `status` is what says whether a message was sent; this column
--    is what says where it belongs in the thread.
--
-- 4. `provider_message_id` IS LEFT NULL, AND THAT HAS A CONSEQUENCE.
--    The source never records one: `twilio.ts:161` returns `message.sid` to its
--    caller and nothing persists it, which is why the source matches an inbound
--    reply by (patient, provider, channel, most recent) at
--    webhooks-controller.ts:353 instead of by id. There is nothing to migrate.
--    A delivery receipt that arrives after cutover for a message sent before it
--    will therefore not find its row and will be recorded as unmatched. Runbook
--    §7 says so; it is a one-off that decays within the provider's retry window.
-- =============================================================================

BEGIN;

SELECT mig.require_source('message_history');

-- ── messages (chunked by month) ─────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE mig.load_messages(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since   timestamp := mig.to_src(GREATEST(p_since, mig.watermark('messages')));
  v_ceiling timestamp := mig.to_src(mig.ceiling());
  v_from    timestamp;
  v_to      timestamp;
  v_min     timestamp;
  n         bigint;
  total     bigint := 0;
BEGIN
  SELECT min(created_at) INTO v_min FROM src.message_history;
  IF v_min IS NULL THEN
    CALL mig.advance('messages', mig.ceiling(), 0);
    RETURN;
  END IF;

  v_from := GREATEST(date_trunc('month', v_min), date_trunc('month', v_since));

  WHILE v_from < v_ceiling LOOP
    v_to := LEAST(v_from + interval '1 month', v_ceiling);

    INSERT INTO messages (
      id, tenant_id, sub_tenant_id, notification_id, event_id, recipient_id,
      sender_id, channel, direction, content, status, sent_at, delivered_at,
      read_at, ai_generated, queued_message, metadata, engagement_data,
      conversation_id, thread_id, sender_name, participant_phone,
      created_at, updated_at
    )
    SELECT
      s.id, s.medspa_id, s.location_id,
      (SELECT nt.id FROM notifications nt WHERE nt.id = s.notification_id),
      (SELECT e.id  FROM outreach_events e WHERE e.id = s.event_id),
      (SELECT r.id  FROM recipients r WHERE r.id = mig.recipient_id(s.medspa_id, s.patient_id)),
      s.provider_id,
      -- Lower-cased, because that is what the engine stores and what three of
      -- its own readers require: `ApprovalService.release` casts this column to
      -- ChannelType and hands it to `registry.get()`, the compliance gate counts
      -- per channel with an equality on it, and analytics groups by it. A
      -- migrated 'SMS' would throw on release and be invisible to the rate
      -- limiter. The legacy surface is unaffected — `toLegacyChannel` puts the
      -- upper case back on the way out (api/compat/translate.ts:93).
      lower(btrim(s.channel)),
      CASE WHEN upper(COALESCE(NULLIF(btrim(s.message_direction), ''),
                               s.metadata->>'direction', 'OUTBOUND')) = 'INBOUND'
           THEN 'inbound' ELSE 'outbound' END,
      COALESCE(s.content, ''),
      mig.map_message_status(s.status),
      mig.to_tz(s.sent_at), mig.to_tz(s.delivered_at), mig.to_tz(s.read_at),
      -- Written as a JSON boolean or a string depending on the path; neither
      -- casts cleanly, so read it as text and compare.
      COALESCE(lower(s.metadata->>'aiGenerated') IN ('true', 't', '1'), false),
      s.queued_message,
      -- Stamped on EVERY migrated row, not only the ones whose status changed
      -- (D99). Two readers depend on it:
      --
      --   `migrated: true`  — 9009's backlog rewrite cancels never-sent messages
      --                       that have no approval row, and this is how it tells
      --                       a migrated row from one the engine wrote. A message
      --                       has no audit trail to check the way an approval
      --                       does, so without this the rewrite could not be
      --                       made safe to re-run.
      --   `migration.sourceStatus` — the original word. Cancelling the backlog
      --                       is lossy otherwise, and "how many were approved
      --                       and never sent?" is a question someone will ask
      --                       after the fact (D44).
      COALESCE(s.metadata::jsonb, '{}'::jsonb)
        || jsonb_build_object(
             'migrated', true,
             'migration', jsonb_build_object(
               'sourceStatus', COALESCE(s.status, ''),
               'from', 'message_history')),
      s.engagement_data::jsonb, s.conversation_id, s.thread_id, s.sender_name,
      s.participant_phone,
      COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.created_at), now())
    FROM src.message_history s
    WHERE s.medspa_id IS NOT NULL
      AND mig.map_message_status(s.status) IS NOT NULL
      AND s.created_at >= v_from AND s.created_at < v_to AND s.created_at > v_since
    ON CONFLICT (id) DO NOTHING;

    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    CALL mig.advance('messages', mig.to_tz(v_to), n);
    COMMIT;
    v_from := v_to;
  END LOOP;

  -- Two reasons, both unfixable without a decision: no tenant to attribute the
  -- message to, or a status word nobody has seen before. Either is worth an
  -- operator's attention before cutover, and neither is worth a guess.
  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9008_messages', 'message_history', s.id::text,
         CASE WHEN s.medspa_id IS NULL THEN 'medspa_id is NULL'
              ELSE 'unrecognised status: ' || COALESCE(s.status, '(null)') END,
         jsonb_build_object('patientId', s.patient_id, 'providerId', s.provider_id,
                            'channel', s.channel, 'status', s.status,
                            'createdAt', s.created_at)
  FROM src.message_history s
  WHERE s.created_at > v_since
    AND (s.medspa_id IS NULL OR mig.map_message_status(s.status) IS NULL)
  ON CONFLICT DO NOTHING;

  CALL mig.note('9008_messages', 'messages migrated', total);
END $$;

-- ── message_analytics ───────────────────────────────────────────────────────
-- 0008 made `message_analytics` one row per message and gave the reason: two
-- rows for one message make it appear twice in every list while `total` counts
-- it once. The source has no such constraint, so several rows per message are
-- expected here and they are FOLDED — earliest row wins the id and the
-- timestamps, first non-null wins each scalar — rather than one being picked
-- and the rest dropped. That is the same fold 0008 applies to a database that
-- already took duplicate receipts.
--
-- ON CONFLICT ... DO UPDATE, not DO NOTHING: on the delta sync a message that
-- has been migrated already may have acquired its first open or click since,
-- and DO NOTHING would discard it.
CREATE OR REPLACE PROCEDURE mig.load_analytics(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since timestamp := mig.to_src(GREATEST(p_since, mig.watermark('analytics')));
  n bigint;
  m bigint;
BEGIN
  WITH folded AS (
    SELECT a.message_id,
           (array_agg(a.id ORDER BY a.created_at, a.id))[1] AS id,
           min(a.created_at)  AS created_at,
           min(a.opened_at)   AS opened_at,
           min(a.clicked_at)  AS clicked_at,
           min(a.replied_at)  AS replied_at,
           max(a.engagement_score) AS engagement_score,
           (array_remove(array_agg(a.clicked_link    ORDER BY a.created_at), NULL))[1] AS clicked_link,
           (array_remove(array_agg(a.reply_content   ORDER BY a.created_at), NULL))[1] AS reply_content,
           (array_remove(array_agg(a.device          ORDER BY a.created_at), NULL))[1] AS device,
           (array_remove(array_agg(a.platform        ORDER BY a.created_at), NULL))[1] AS platform,
           (array_remove(array_agg(a.location        ORDER BY a.created_at), NULL))[1] AS location,
           (array_remove(array_agg(a.patient_id      ORDER BY a.created_at), NULL))[1] AS patient_id,
           (array_remove(array_agg(a.notification_id ORDER BY a.created_at), NULL))[1] AS notification_id,
           (array_remove(array_agg(a.metadata::jsonb ORDER BY a.created_at), NULL))[1] AS metadata
    FROM src.message_analytics a
    WHERE a.message_id IS NOT NULL AND a.created_at > v_since
    GROUP BY a.message_id
  )
  INSERT INTO message_analytics (
    id, tenant_id, sub_tenant_id, message_id, notification_id, recipient_id,
    opened_at, clicked_at, clicked_link, replied_at, reply_content,
    engagement_score, device, platform, location, metadata, created_at, updated_at
  )
  SELECT f.id, m2.tenant_id, m2.sub_tenant_id, f.message_id,
         (SELECT nt.id FROM notifications nt WHERE nt.id = f.notification_id),
         COALESCE(
           (SELECT r.id FROM recipients r WHERE r.id = mig.recipient_id(m2.tenant_id, f.patient_id)),
           m2.recipient_id),
         mig.to_tz(f.opened_at), mig.to_tz(f.clicked_at), f.clicked_link,
         mig.to_tz(f.replied_at), f.reply_content, f.engagement_score,
         f.device, f.platform, f.location, f.metadata,
         COALESCE(mig.to_tz(f.created_at), now()), COALESCE(mig.to_tz(f.created_at), now())
  FROM folded f
  JOIN messages m2 ON m2.id = f.message_id
  ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO UPDATE
    SET opened_at        = COALESCE(message_analytics.opened_at, EXCLUDED.opened_at),
        clicked_at       = COALESCE(message_analytics.clicked_at, EXCLUDED.clicked_at),
        clicked_link     = COALESCE(message_analytics.clicked_link, EXCLUDED.clicked_link),
        replied_at       = COALESCE(message_analytics.replied_at, EXCLUDED.replied_at),
        reply_content    = COALESCE(message_analytics.reply_content, EXCLUDED.reply_content),
        engagement_score = GREATEST(message_analytics.engagement_score, EXCLUDED.engagement_score),
        updated_at       = now();
  GET DIAGNOSTICS n = ROW_COUNT;

  -- Analytics rows that describe a notification rather than a message. No
  -- unique constraint applies to them (the index is partial on message_id), and
  -- their tenant comes from the notification's event.
  INSERT INTO message_analytics (
    id, tenant_id, sub_tenant_id, notification_id, recipient_id,
    opened_at, clicked_at, clicked_link, replied_at, reply_content,
    engagement_score, device, platform, location, metadata, created_at, updated_at
  )
  SELECT a.id, nt.tenant_id, nt.sub_tenant_id, nt.id,
         COALESCE(
           (SELECT r.id FROM recipients r WHERE r.id = mig.recipient_id(nt.tenant_id, a.patient_id)),
           nt.recipient_id),
         mig.to_tz(a.opened_at), mig.to_tz(a.clicked_at), a.clicked_link,
         mig.to_tz(a.replied_at), a.reply_content, a.engagement_score,
         a.device, a.platform, a.location, a.metadata::jsonb,
         COALESCE(mig.to_tz(a.created_at), now()), COALESCE(mig.to_tz(a.created_at), now())
  FROM src.message_analytics a
  JOIN notifications nt ON nt.id = a.notification_id
  WHERE a.message_id IS NULL AND a.created_at > v_since
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS m = ROW_COUNT;

  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9008_messages', 'message_analytics', a.id::text,
         CASE WHEN a.message_id IS NOT NULL THEN 'message did not migrate'
              ELSE 'neither a migrated message nor a migrated notification' END,
         jsonb_build_object('messageId', a.message_id, 'notificationId', a.notification_id,
                            'patientId', a.patient_id)
  FROM src.message_analytics a
  WHERE a.created_at > v_since
    AND NOT EXISTS (SELECT 1 FROM messages m3 WHERE m3.id = a.message_id)
    AND NOT EXISTS (SELECT 1 FROM notifications nt WHERE nt.id = a.notification_id)
  ON CONFLICT DO NOTHING;

  CALL mig.advance('analytics', mig.ceiling(), n + m);
  CALL mig.note('9008_messages', 'message_analytics folded onto messages', n);
  CALL mig.note('9008_messages', 'message_analytics attached to notifications only', m);
END $$;

CREATE OR REPLACE PROCEDURE mig.load_messages_all(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
BEGIN
  CALL mig.load_messages(p_since);
  CALL mig.load_analytics(p_since);
END $$;

COMMIT;

-- @@ SPLIT @@

CALL mig.load_messages_all('-infinity');

-- -----------------------------------------------------------------------------
-- AFTER APPLYING
--
--   -- how far it got, and how long each window took
--   SELECT loader, watermark, rows_done, updated_at FROM mig.progress
--   WHERE loader IN ('messages','analytics');
--
--   -- parity, ignoring the quarantined rows
--   SELECT (SELECT count(*) FROM src.message_history)                      AS source,
--          (SELECT count(*) FROM messages)                                 AS target,
--          (SELECT count(*) FROM mig.rejects
--            WHERE loader = '9008_messages' AND source_table = 'message_history') AS quarantined;
--
--   -- must be 0: the 0008 invariant holds after the load too
--   SELECT count(*) FROM (
--     SELECT message_id FROM message_analytics
--     WHERE message_id IS NOT NULL GROUP BY message_id HAVING count(*) > 1
--   ) dupes;
-- -----------------------------------------------------------------------------
