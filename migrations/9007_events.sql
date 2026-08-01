-- =============================================================================
-- 9007_events.sql
--
-- Everything that does NOT hang off a message:
--   communication_batches      → message_batches
--   communication_events       → outreach_events        (chunked)
--   notifications              → notifications          (chunked)
--   scheduled_communications   → scheduled_messages
--   ai_interactions            → ai_interactions
--   communication_memories     → recipient_memories
--   campaigns                  → campaigns
--   campaign_recipients        → campaign_recipients
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9007_events.sql
--
-- Requires 9000-9006. Idempotent and resumable.
--
-- -----------------------------------------------------------------------------
-- WHY THIS RUNS BEFORE THE MESSAGES
--
-- `messages.event_id` and `messages.notification_id` are real foreign keys
-- (0001). Loading messages first would either fail on every row that has one,
-- or force a second pass over the largest table in the database to fill them
-- in afterwards. The dependency decides the order, and the file numbering
-- follows the dependency — see the numbering note in migrations/README.md.
--
-- -----------------------------------------------------------------------------
-- FOUR OF THESE TABLES HAVE NO TENANT COLUMN
--
-- `communication_batches`, `notifications`, `scheduled_communications`,
-- `ai_interactions` and `campaign_recipients` carry no medspa_id. Their tenant
-- is derived from a parent (the event, or the campaign), and a row whose parent
-- is missing or itself tenant-less is quarantined in `mig.rejects` rather than
-- attributed to a guess. `tenant_id` is NOT NULL on every target table and Rule
-- 4 does not bend for a migration: a guessed tenant is a cross-tenant leak that
-- nobody would ever find.
--
-- -----------------------------------------------------------------------------
-- EVERY LOADER IS A PROCEDURE TAKING `p_since`
--
-- scripts/delta-sync.sql calls exactly these procedures with the recorded
-- watermarks during the parallel-run window. One definition, two callers — the
-- alternative was a delta script that re-states every INSERT and drifts from
-- this one the first time a column is added.
--
-- The chunked loaders COMMIT between windows, so a run that dies halfway keeps
-- the windows it finished. That is why this file is not wrapped in a single
-- transaction, and why the `-- @@ SPLIT @@` marker exists (see 9000's header).
-- =============================================================================

BEGIN;

SELECT mig.require_source('communication_events');

-- ── message_batches ─────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE mig.load_batches(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since timestamp := mig.to_src(GREATEST(p_since, mig.watermark('batches')));
  n bigint;
BEGIN
  -- A batch's tenant is whatever its events say. `min` rather than "any": with
  -- one distinct value it is that value, and with several the batch is
  -- ambiguous and gets quarantined below instead.
  WITH owner AS (
    SELECT batch_id, min(medspa_id) AS tenant_id, count(DISTINCT medspa_id) AS tenants
    FROM src.communication_events
    WHERE batch_id IS NOT NULL AND medspa_id IS NOT NULL
    GROUP BY batch_id
  )
  INSERT INTO message_batches (
    id, tenant_id, name, description, status, event_count, success_count,
    failure_count, scheduled_for, metadata, created_by, completed_at,
    created_at, updated_at
  )
  SELECT b.id, o.tenant_id,
         COALESCE(NULLIF(btrim(b.name), ''), 'Batch ' || left(b.id::text, 8)),
         b.description,
         CASE upper(COALESCE(b.status, 'DRAFT'))
           WHEN 'QUEUED' THEN 'QUEUED' WHEN 'PROCESSING' THEN 'PROCESSING'
           WHEN 'COMPLETED' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED'
           ELSE 'DRAFT' END,
         COALESCE(b.event_count, 0), COALESCE(b.success_count, 0), COALESCE(b.failure_count, 0),
         mig.to_tz(b.scheduled_for), b.metadata::jsonb, b.created_by,
         mig.to_tz(b.completed_at),
         COALESCE(mig.to_tz(b.created_at), now()), COALESCE(mig.to_tz(b.created_at), now())
  FROM src.communication_batches b
  JOIN owner o ON o.batch_id = b.id AND o.tenants = 1
  WHERE b.created_at > v_since
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9007_events', 'communication_batches', b.id::text,
         'no event carries a tenant for this batch',
         jsonb_build_object('name', b.name)
  FROM src.communication_batches b
  WHERE NOT EXISTS (
    SELECT 1 FROM src.communication_events e
    WHERE e.batch_id = b.id AND e.medspa_id IS NOT NULL
  )
  ON CONFLICT DO NOTHING;

  CALL mig.advance('batches', mig.ceiling(), n);
  CALL mig.note('9007_events', 'message_batches migrated', n);
END $$;

-- ── outreach_events (chunked) ───────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE mig.load_events(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since   timestamp := mig.to_src(GREATEST(p_since, mig.watermark('events')));
  v_ceiling timestamp := mig.to_src(mig.ceiling());
  v_from    timestamp;
  v_to      timestamp;
  v_min     timestamp;
  n         bigint;
  total     bigint := 0;
BEGIN
  SELECT min(created_at) INTO v_min FROM src.communication_events;
  IF v_min IS NULL THEN
    CALL mig.advance('events', mig.ceiling(), 0);
    RETURN;
  END IF;

  v_from := GREATEST(date_trunc('month', v_min), date_trunc('month', v_since));

  WHILE v_from < v_ceiling LOOP
    v_to := LEAST(v_from + interval '1 month', v_ceiling);

    INSERT INTO outreach_events (
      id, tenant_id, sub_tenant_id, type, priority, status, data, channels,
      metadata, recipient_id, sender_id, batch_id, processed_at, error,
      retry_count, next_retry_at, scheduled_for, created_at, updated_at
    )
    SELECT e.id, e.medspa_id, e.location_id, e.type,
           COALESCE(NULLIF(btrim(e.priority), ''), 'MEDIUM'),
           COALESCE(NULLIF(btrim(e.status), ''), 'PENDING'),
           COALESCE(e.data::jsonb, '{}'::jsonb),
           COALESCE(e.channels, '{}'::text[]),
           e.metadata::jsonb,
           -- NULL when the recipient never materialised: the FK is ON DELETE
           -- SET NULL, so a dangling id would be worse than an absent one.
           (SELECT r.id FROM recipients r
             WHERE r.id = mig.recipient_id(e.medspa_id, e.patient_id)),
           e.provider_id,
           (SELECT b.id FROM message_batches b WHERE b.id = e.batch_id),
           mig.to_tz(e.processed_at), e.error, COALESCE(e.retry_count, 0),
           mig.to_tz(e.next_retry_at), mig.to_tz(e.scheduled_for),
           COALESCE(mig.to_tz(e.created_at), now()), COALESCE(mig.to_tz(e.created_at), now())
    FROM src.communication_events e
    WHERE e.medspa_id IS NOT NULL
      AND e.created_at >= v_from AND e.created_at < v_to AND e.created_at > v_since
    ON CONFLICT (id) DO NOTHING;

    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    CALL mig.advance('events', mig.to_tz(v_to), n);
    COMMIT;                     -- one committed window at a time; see the header
    v_from := v_to;
  END LOOP;

  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9007_events', 'communication_events', e.id::text, 'medspa_id is NULL',
         jsonb_build_object('type', e.type, 'createdAt', e.created_at)
  FROM src.communication_events e
  WHERE e.medspa_id IS NULL AND e.created_at > v_since
  ON CONFLICT DO NOTHING;

  CALL mig.note('9007_events', 'outreach_events migrated', total);
END $$;

-- ── notifications (chunked) ─────────────────────────────────────────────────
-- `notifications.recipient_id` is text and means different things depending on
-- who wrote it: sometimes a patient id, sometimes a bare address. It is matched
-- against the recipients created in 9004, and when it does not match it is kept
-- verbatim in `channel_ref` — the column 0001 added for exactly this. Nothing
-- is dropped and nothing is invented.
CREATE OR REPLACE PROCEDURE mig.load_notifications(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since   timestamp := mig.to_src(GREATEST(p_since, mig.watermark('notifications')));
  v_ceiling timestamp := mig.to_src(mig.ceiling());
  v_from    timestamp;
  v_to      timestamp;
  v_min     timestamp;
  n         bigint;
  total     bigint := 0;
BEGIN
  SELECT min(created_at) INTO v_min FROM src.notifications;
  IF v_min IS NULL THEN
    CALL mig.advance('notifications', mig.ceiling(), 0);
    RETURN;
  END IF;

  v_from := GREATEST(date_trunc('month', v_min), date_trunc('month', v_since));

  WHILE v_from < v_ceiling LOOP
    v_to := LEAST(v_from + interval '1 month', v_ceiling);

    INSERT INTO notifications (
      id, tenant_id, sub_tenant_id, event_id, channel, recipient_id, channel_ref,
      content, status, sent_at, delivered_at, read_at, error, metadata,
      created_at, updated_at
    )
    SELECT s.id, e.medspa_id, e.location_id, e.id, s.channel,
           r.id,
           CASE WHEN r.id IS NULL THEN s.recipient_id END,
           COALESCE(s.content, ''),
           COALESCE(NULLIF(btrim(s.status), ''), 'PENDING'),
           mig.to_tz(s.sent_at), mig.to_tz(s.delivered_at), mig.to_tz(s.read_at),
           s.error, s.metadata::jsonb,
           COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.created_at), now())
    FROM src.notifications s
    JOIN src.communication_events e ON e.id = s.event_id AND e.medspa_id IS NOT NULL
    LEFT JOIN recipients r ON r.id = mig.recipient_id(e.medspa_id, s.recipient_id)
    WHERE s.created_at >= v_from AND s.created_at < v_to AND s.created_at > v_since
    ON CONFLICT (id) DO NOTHING;

    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    CALL mig.advance('notifications', mig.to_tz(v_to), n);
    COMMIT;
    v_from := v_to;
  END LOOP;

  -- No event, or an event with no tenant: nothing to attribute the row to.
  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9007_events', 'notifications', s.id::text,
         CASE WHEN s.event_id IS NULL THEN 'event_id is NULL — no tenant to derive'
              ELSE 'parent event is missing or has no medspa_id' END,
         jsonb_build_object('channel', s.channel, 'recipientId', s.recipient_id)
  FROM src.notifications s
  WHERE s.created_at > v_since
    AND NOT EXISTS (
      SELECT 1 FROM src.communication_events e
      WHERE e.id = s.event_id AND e.medspa_id IS NOT NULL
    )
  ON CONFLICT DO NOTHING;

  CALL mig.note('9007_events', 'notifications migrated', total);
END $$;

-- ── scheduled_messages ──────────────────────────────────────────────────────
-- The FK is ON DELETE CASCADE and `event_id` is how the tenant is derived, so a
-- schedule with no surviving event has nowhere to go.
CREATE OR REPLACE PROCEDURE mig.load_scheduled(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since timestamp := mig.to_src(GREATEST(p_since, mig.watermark('scheduled')));
  n bigint;
BEGIN
  INSERT INTO scheduled_messages (
    id, tenant_id, sub_tenant_id, event_id, scheduled_for, recurrence_rule,
    status, metadata, created_by, processed_at, created_at, updated_at
  )
  SELECT s.id, e.tenant_id, e.sub_tenant_id, e.id,
         mig.to_tz(s.scheduled_for), s.recurrence_rule,
         CASE upper(COALESCE(s.status, 'PENDING'))
           WHEN 'PROCESSED' THEN 'PROCESSED' WHEN 'CANCELLED' THEN 'CANCELLED'
           ELSE 'PENDING' END,
         s.metadata::jsonb, s.created_by, mig.to_tz(s.processed_at),
         COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.created_at), now())
  FROM src.scheduled_communications s
  JOIN outreach_events e ON e.id = s.event_id
  WHERE s.created_at > v_since
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9007_events', 'scheduled_communications', s.id::text,
         'no migrated event to attach to',
         jsonb_build_object('eventId', s.event_id, 'scheduledFor', s.scheduled_for)
  FROM src.scheduled_communications s
  WHERE s.created_at > v_since
    AND NOT EXISTS (SELECT 1 FROM outreach_events e WHERE e.id = s.event_id)
  ON CONFLICT DO NOTHING;

  CALL mig.advance('scheduled', mig.ceiling(), n);
  CALL mig.note('9007_events', 'scheduled_messages migrated', n);
END $$;

-- ── ai_interactions ─────────────────────────────────────────────────────────
-- Tenant comes from the event, or failing that from the notification's event.
-- `cost_usd` is new in the target and stays NULL: the source estimated tokens
-- by word count (D31) and never priced anything, so any number here would be
-- invented.
CREATE OR REPLACE PROCEDURE mig.load_ai_interactions(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since timestamp := mig.to_src(GREATEST(p_since, mig.watermark('ai_interactions')));
  n bigint;
BEGIN
  INSERT INTO ai_interactions (
    id, tenant_id, sub_tenant_id, event_id, notification_id, agent_id, model_id,
    action_group, input_summary, output_summary, tokens_used, processing_time,
    success, error_message, metadata, created_at, updated_at
  )
  SELECT s.id,
         COALESCE(e.tenant_id, ne.tenant_id),
         COALESCE(e.sub_tenant_id, ne.sub_tenant_id),
         e.id, n2.id, s.agent_id, s.model_id, s.action_group,
         s.input_summary, s.output_summary, s.tokens_used, s.processing_time,
         COALESCE(s.success, false), s.error_message, s.metadata::jsonb,
         COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.created_at), now())
  FROM src.ai_interactions s
  LEFT JOIN outreach_events e  ON e.id = s.event_id
  LEFT JOIN notifications  n2  ON n2.id = s.notification_id
  LEFT JOIN outreach_events ne ON ne.id = n2.event_id
  WHERE s.created_at > v_since
    AND COALESCE(e.tenant_id, ne.tenant_id) IS NOT NULL
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9007_events', 'ai_interactions', s.id::text,
         'neither the event nor the notification yields a tenant',
         jsonb_build_object('modelId', s.model_id, 'eventId', s.event_id,
                            'notificationId', s.notification_id)
  FROM src.ai_interactions s
  LEFT JOIN outreach_events e  ON e.id = s.event_id
  LEFT JOIN notifications  n2  ON n2.id = s.notification_id
  LEFT JOIN outreach_events ne ON ne.id = n2.event_id
  WHERE s.created_at > v_since AND COALESCE(e.tenant_id, ne.tenant_id) IS NULL
  ON CONFLICT DO NOTHING;

  CALL mig.advance('ai_interactions', mig.ceiling(), n);
  CALL mig.note('9007_events', 'ai_interactions migrated', n);
END $$;

-- ── recipient_memories ──────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE mig.load_memories(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since timestamp := mig.to_src(GREATEST(p_since, mig.watermark('memories')));
  n bigint;
BEGIN
  INSERT INTO recipient_memories (
    id, tenant_id, sub_tenant_id, recipient_id, sender_id, memory_type, content,
    metadata, tags, relevance_score, created_at, updated_at
  )
  SELECT s.id, s.medspa_id, s.location_id,
         (SELECT r.id FROM recipients r WHERE r.id = mig.recipient_id(s.medspa_id, s.patient_id)),
         s.provider_id, s.memory_type, COALESCE(s.content, ''), s.metadata::jsonb, s.tags,
         s.relevance_score,
         COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.created_at), now())
  FROM src.communication_memories s
  WHERE s.medspa_id IS NOT NULL AND s.created_at > v_since
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9007_events', 'communication_memories', s.id::text, 'medspa_id is NULL',
         jsonb_build_object('patientId', s.patient_id, 'memoryType', s.memory_type)
  FROM src.communication_memories s
  WHERE s.medspa_id IS NULL AND s.created_at > v_since
  ON CONFLICT DO NOTHING;

  CALL mig.advance('memories', mig.ceiling(), n);
  CALL mig.note('9007_events', 'recipient_memories migrated', n);
END $$;

-- ── campaigns and campaign_recipients ───────────────────────────────────────
-- The campaign RUNTIME lands in P11; the rows move now because the tables have
-- existed since 0001 (D13) and leaving a year of campaign history behind in a
-- database that is about to be decommissioned is not a decision anyone would
-- make deliberately.
CREATE OR REPLACE PROCEDURE mig.load_campaigns(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since timestamp := mig.to_src(GREATEST(p_since, mig.watermark('campaigns')));
  n bigint;
  m bigint;
BEGIN
  INSERT INTO campaigns (
    id, tenant_id, sub_tenant_id, name, description, type, status, start_date,
    end_date, target_audience, template_id, sender_id, metadata,
    created_at, updated_at
  )
  SELECT s.id, s.medspa_id, s.location_id,
         COALESCE(NULLIF(btrim(s.name), ''), 'Campaign ' || left(s.id::text, 8)),
         s.description, s.type, COALESCE(NULLIF(btrim(s.status), ''), 'DRAFT'),
         mig.to_tz(s.start_date), mig.to_tz(s.end_date), s.target_audience::jsonb,
         (SELECT t.id FROM templates t WHERE t.id = s.template_id),
         s.provider_id, s.metadata::jsonb,
         COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.updated_at), now())
  FROM src.campaigns s
  WHERE s.medspa_id IS NOT NULL AND s.created_at > v_since
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO campaign_recipients (
    id, tenant_id, campaign_id, recipient_id, status, sent_at, delivered_at,
    error, metadata, created_at, updated_at
  )
  SELECT s.id, c.tenant_id, c.id,
         (SELECT r.id FROM recipients r WHERE r.id = mig.recipient_id(c.tenant_id, s.patient_id)),
         COALESCE(NULLIF(btrim(s.status), ''), 'PENDING'),
         mig.to_tz(s.sent_at), mig.to_tz(s.delivered_at), s.error,
         s.metadata::jsonb,
         COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.created_at), now())
  FROM src.campaign_recipients s
  JOIN campaigns c ON c.id = s.campaign_id
  WHERE s.created_at > v_since
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS m = ROW_COUNT;

  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9007_events', 'campaigns', s.id::text, 'medspa_id is NULL',
         jsonb_build_object('name', s.name)
  FROM src.campaigns s
  WHERE s.medspa_id IS NULL AND s.created_at > v_since
  ON CONFLICT DO NOTHING;

  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9007_events', 'campaign_recipients', s.id::text,
         'no migrated campaign to attach to',
         jsonb_build_object('campaignId', s.campaign_id, 'patientId', s.patient_id)
  FROM src.campaign_recipients s
  WHERE s.created_at > v_since
    AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.id = s.campaign_id)
  ON CONFLICT DO NOTHING;

  CALL mig.advance('campaigns', mig.ceiling(), n + m);
  CALL mig.note('9007_events', 'campaigns migrated', n);
  CALL mig.note('9007_events', 'campaign_recipients migrated', m);
END $$;

-- ── the orchestrator ────────────────────────────────────────────────────────
-- Order matters inside here too: batches before events (FK), events before
-- notifications and schedules, notifications before ai_interactions, campaigns
-- before campaign_recipients.
CREATE OR REPLACE PROCEDURE mig.load_events_all(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
BEGIN
  CALL mig.load_batches(p_since);
  CALL mig.load_events(p_since);
  CALL mig.load_notifications(p_since);
  CALL mig.load_scheduled(p_since);
  CALL mig.load_ai_interactions(p_since);
  CALL mig.load_memories(p_since);
  CALL mig.load_campaigns(p_since);
END $$;

COMMIT;

-- @@ SPLIT @@

CALL mig.load_events_all('-infinity');

-- -----------------------------------------------------------------------------
-- AFTER APPLYING
--
--   SELECT detail, n FROM mig.log WHERE loader = '9007_events' ORDER BY id;
--   SELECT source_table, reason, count(*) FROM mig.rejects
--   WHERE loader = '9007_events' GROUP BY 1, 2 ORDER BY 3 DESC;
--   SELECT loader, watermark, rows_done FROM mig.progress ORDER BY loader;
--
-- Interrupted? Re-run the same file. Each loader resumes from its watermark and
-- every INSERT is ON CONFLICT DO NOTHING, so the completed windows cost a scan
-- and nothing else.
-- -----------------------------------------------------------------------------
