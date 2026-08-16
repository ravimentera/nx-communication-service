-- =============================================================================
-- 9009_approvals.sql
--
-- The approval backlog, out of two different JSONB/column hiding places and
-- into the `approvals` table.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9009_approvals.sql
--
-- Requires 9000-9008, and 0006 (the `medspa.provider-always` policy row).
-- Idempotent — UNIQUE (message_id) makes the two passes safe in either order
-- and safe to repeat.
--
-- -----------------------------------------------------------------------------
-- THERE ARE TWO STORAGE SHAPES, AND READING ONLY ONE MIGRATES HALF THE QUEUE
--
-- D46: the two approval implementations do not merely use different words, they
-- use different STORAGE.
--
--   Shape A  approvals.controller.ts — state in `queued_message->>'approvalStatus'`,
--            with approvedBy / approvedAt / declineReason / originalContent /
--            editedContent alongside it in the same blob.
--   Shape B  ai-enhanced-communication.controller.ts — state in the
--            `message_history.status` COLUMN, no queued_message at all.
--
-- The plan's predicates were `status='QUEUED' AND queued_message->>… ` for A and
-- `queued_message IS NULL` for B. Both are too narrow, and each would have lost
-- rows silently:
--
--   - Shape A rows do not stay `QUEUED`. approvals.controller.ts:360 flips the
--     `status` column to 'APPROVED' as well as the blob, so every already-decided
--     Shape A row has status 'APPROVED' and would have been skipped.
--   - `queued_message` is not reliably NULL on Shape B rows. The column was
--     added without a default (0003_fix_queued_message.sql) but the Drizzle
--     model declares `.default('{}'::jsonb)` (schema/db.ts:152), so whether a
--     row holds NULL or `{}` depends on whether anyone ran `drizzle push`.
--
-- The predicates used here are complementary by construction — a row either has
-- an `approvalStatus` key or it does not — so the two passes are provably
-- disjoint and provably cover everything. 9010 checks the totals against the
-- recon's own two-shape count.
--
-- -----------------------------------------------------------------------------
-- THE HISTORIC BACKLOG (the plan's 9007b decision)
--
-- Approving has never sent anything (D44): it flips two status columns that
-- nothing reads back. So the source holds `APPROVED` messages going back to
-- launch that no recipient ever received, and backfilling them as APPROVED
-- would let the engine's release path pick up a year of stale appointment
-- reminders at cutover.
--
-- Default: they become CANCELLED, with the reason in the audit trail, and the
-- message goes to CANCELLED with them. `mig.settings.historic_approved_disposition`
-- is the knob; the recon prints the count so the call is made with a number in
-- front of the operator rather than in the abstract.
--
-- The rewrite only touches approvals whose audit trail is exactly the single
-- entry this migration wrote. Anything a human has since acted on in the new
-- system is left alone.
--
-- -----------------------------------------------------------------------------
-- WIDENED: `PENDING_APPROVAL` IS CANCELLED TOO, AND SO IS EVERY NEVER-SENT
-- MESSAGE WITHOUT AN APPROVAL (D99)
--
-- This used to leave `PENDING_APPROVAL` alone, on the reasoning that those rows
-- were "genuinely in flight". That reasoning belonged to a cutover with a live
-- system on both sides of it. There is no parallel run and no live traffic: the
-- old service is stopped before the migration and never starts again, so a row
-- that was in flight is a row that will never move.
--
-- Leaving them would put a queue of drafts nobody is going to act on into every
-- provider's approvals inbox on day one, each looking like outstanding work.
--
-- So the rule is now one sentence: **nothing migrated may land in a state that
-- looks actionable.** Three groups reach a terminal state here —
--
--   1. approvals at APPROVED / SCHEDULED / PENDING_APPROVAL  -> CANCELLED
--   2. their messages                                        -> CANCELLED
--   3. never-sent messages with no approval row at all       -> CANCELLED
--      (PENDING and QUEUED: submitted or enqueued in the old system, never
--       delivered, and no BullMQ job exists in the new one to deliver them)
--
-- `CANCELLED` rather than `SENT`, which was the alternative considered: nothing
-- in the engine re-sends a message whatever its status — neither the rate
-- limiter nor the throttle reads the column, and no sweeper walks it — so both
-- are mechanically safe. CANCELLED is the one that is also true. Marking them
-- SENT would have the product assert it delivered messages nobody received, and
-- would make `sent_at` (copied verbatim, and written at INSERT time in the
-- source) read as a delivery timestamp for a delivery that never happened.
--
-- Every migrated message carries `metadata.migration.sourceStatus`, so the
-- original word is recoverable and "how many were approved and never sent?"
-- still has an answer:
--
--   SELECT metadata->'migration'->>'sourceStatus' AS was, count(*)
--     FROM messages WHERE metadata->>'migrated' = 'true' GROUP BY 1 ORDER BY 2 DESC;
-- =============================================================================

BEGIN;

SELECT mig.require_source('message_history');

-- The backlog decision, on its own, because it runs twice: once at the end of
-- the bulk load, and again after every delta sync re-reads a status the old
-- service changed during the parallel run.
CREATE OR REPLACE PROCEDURE mig.apply_backlog_disposition()
LANGUAGE plpgsql AS $$
DECLARE
  v_disposition text := upper(COALESCE(mig.setting('historic_approved_disposition'), 'CANCELLED'));
  d bigint := 0;
BEGIN
  IF v_disposition <> 'CANCELLED' THEN
    CALL mig.note('9009_approvals',
                  'historic backlog left as-is (disposition ' || v_disposition || ')', 0);
    RETURN;
  END IF;

  WITH stale AS (
    SELECT ap.id, ap.status, ap.message_id
    FROM approvals ap
    -- APPROVED and SCHEDULED only. `PENDING_APPROVAL` is handled by
    -- `mig.finalize_cutover()` instead, and the split is deliberate — see the
    -- header of that procedure.
    WHERE ap.status IN ('APPROVED', 'SCHEDULED')
      -- Exactly one entry, and it is this migration's: anything a human has
      -- touched in the new system is not ours to rewrite.
      AND jsonb_array_length(ap.audit_trail) = 1
      AND ap.audit_trail @> '[{"actorRef":"migration:p9"}]'::jsonb
  ),
  moved AS (
    UPDATE approvals ap
    SET status = 'CANCELLED',
        audit_trail = ap.audit_trail || jsonb_build_array(jsonb_build_object(
          'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'from', stale.status, 'to', 'CANCELLED',
          'actorType', 'system', 'actorRef', 'migration:p9',
          'reason', 'approved in mentera-core but never dispatched (D44); cancelled at migration rather than released')),
        updated_at = now()
    FROM stale WHERE ap.id = stale.id
    RETURNING ap.message_id
  )
  UPDATE messages m
  SET status = 'CANCELLED', updated_at = now()
  FROM moved
  WHERE m.id = moved.message_id AND m.status = 'PENDING';
  GET DIAGNOSTICS d = ROW_COUNT;

  CALL mig.note('9009_approvals',
                'historic APPROVED/SCHEDULED cancelled rather than released', d);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- FINALIZE (D99) — run ONCE, after the last load, and never again
--
-- `apply_backlog_disposition` above runs on every delta and only touches rows
-- that were already decided in the old system: APPROVED or SCHEDULED, and then
-- nothing happened. That is safe to repeat, because the source's own word is
-- unchanged by repeating it.
--
-- This procedure is the other half, and it is NOT safe to repeat during a
-- parallel run — which is exactly why it is separate.
--
-- It cancels everything still in flight: approvals at `PENDING_APPROVAL`, and
-- messages at `PENDING` / `PENDING_APPROVAL` / `QUEUED` that have no approval
-- row of their own. Those are only dead once the old service has stopped for
-- good. Run it while the old service can still write and you cancel a draft a
-- provider is about to approve — and worse, the cancellation appends an audit
-- entry, which takes `jsonb_array_length(audit_trail)` past 1 and permanently
-- disqualifies the row from every later delta refresh. It would be frozen
-- CANCELLED even after the source moved on.
--
-- (That is not hypothetical. Folding this into `apply_backlog_disposition` was
-- the first attempt, and two delta-sync tests caught it: a message the source
-- had since DELIVERED stayed CANCELLED, and an approval a human had decided in
-- the new system grew a third audit entry.)
--
-- WHY IT EXISTS AT ALL: with no parallel run and no staging, the old service is
-- stopped before the migration and never starts again. Anything "in flight" at
-- that moment will never move. Leaving it puts a queue of drafts nobody is
-- going to action into every provider's inbox on day one, each looking like
-- outstanding work.
--
-- CANCELLED rather than SENT, which was the alternative considered: nothing in
-- the engine re-sends a message whatever its status — neither the rate limiter
-- nor the per-playbook throttle reads the column, and no sweeper walks it — so
-- both are mechanically safe. CANCELLED is the one that is also true. SENT
-- would have the product assert it delivered messages nobody received, and make
-- `sent_at` (copied verbatim, and written at INSERT time in the source) read as
-- a delivery timestamp for a delivery that never happened.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE mig.finalize_cutover()
LANGUAGE plpgsql AS $$
DECLARE
  v_disposition text := upper(COALESCE(mig.setting('historic_approved_disposition'), 'CANCELLED'));
  d bigint := 0;
BEGIN
  IF v_disposition <> 'CANCELLED' THEN
    CALL mig.note('9009_approvals',
                  'finalize skipped (disposition ' || v_disposition || ')', 0);
    RETURN;
  END IF;

  -- The decided-but-never-sent backlog, in case it has not run since the last load.
  CALL mig.apply_backlog_disposition();

  -- 1. approvals still open. Same audit-trail guard: anything a human has acted
  --    on in the new system is not ours to rewrite.
  WITH stale AS (
    SELECT ap.id, ap.status, ap.message_id
    FROM approvals ap
    WHERE ap.status = 'PENDING_APPROVAL'
      AND jsonb_array_length(ap.audit_trail) = 1
      AND ap.audit_trail @> '[{"actorRef":"migration:p9"}]'::jsonb
  ),
  moved AS (
    UPDATE approvals ap
    SET status = 'CANCELLED',
        audit_trail = ap.audit_trail || jsonb_build_array(jsonb_build_object(
          'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'from', stale.status, 'to', 'CANCELLED',
          'actorType', 'system', 'actorRef', 'migration:p9',
          'reason', 'open for review when the old service stopped, and it does not restart (D99)')),
        updated_at = now()
    FROM stale WHERE ap.id = stale.id
    RETURNING ap.message_id
  )
  UPDATE messages m
  SET status = 'CANCELLED', updated_at = now()
  FROM moved
  WHERE m.id = moved.message_id
    AND m.status IN ('PENDING', 'PENDING_APPROVAL');
  GET DIAGNOSTICS d = ROW_COUNT;
  CALL mig.note('9009_approvals', 'open approvals cancelled at finalize', d);

  -- 2. never-sent messages with no approval row at all. `PENDING` is one the old
  --    system had not sent; `QUEUED` is one it handed to a BullMQ queue that is
  --    about to be thrown away, and the new service has no job for it.
  --
  --    Keyed on `metadata.migrated`, stamped by 9008 on every row it writes, so
  --    anything the new engine wrote is left alone. A message has no audit trail
  --    to check the way an approval does; this is its equivalent.
  UPDATE messages m
  SET status = 'CANCELLED', updated_at = now()
  WHERE m.status IN ('PENDING', 'PENDING_APPROVAL', 'QUEUED')
    AND m.metadata->>'migrated' = 'true';
  GET DIAGNOSTICS d = ROW_COUNT;
  CALL mig.note('9009_approvals', 'never-sent migrated messages cancelled at finalize', d);

  -- Records that this ran, which is what turns 9010's two "nothing is still
  -- actionable" checks from no-ops into hard assertions.
  INSERT INTO mig.settings (key, value, note)
  VALUES ('cutover_finalized', 'true',
          'mig.finalize_cutover() has run. Set by the procedure; do not set by hand.')
  ON CONFLICT (key) DO UPDATE SET value = 'true';
END $$;

CREATE OR REPLACE PROCEDURE mig.load_approvals(p_since timestamptz DEFAULT '-infinity')
LANGUAGE plpgsql AS $$
DECLARE
  v_since timestamp := mig.to_src(GREATEST(p_since, mig.watermark('approvals')));
  a bigint; b bigint; c bigint;
BEGIN
  -- ── Shape A: state in the queued_message blob ─────────────────────────────
  INSERT INTO approvals (
    id, tenant_id, sub_tenant_id, message_id, status, approver_type, approver_ref,
    requested_at, decided_at, decided_by, original_content, edited_content,
    decline_reason, policy_id, audit_trail, created_at, updated_at
  )
  SELECT gen_random_uuid(), m.tenant_id, m.sub_tenant_id, m.id,
         mig.map_approval_status(s.queued_message->>'approvalStatus'),
         'agent', s.provider_id,
         COALESCE(mig.to_tz(s.created_at), now()),
         mig.try_ts(s.queued_message->>'approvedAt'),
         s.queued_message->>'approvedBy',
         COALESCE(s.queued_message->>'originalContent', s.queued_message->>'content', s.content),
         s.queued_message->>'editedContent',
         s.queued_message->>'declineReason',
         COALESCE(
           (SELECT p.id FROM approval_policies p
             WHERE p.key = 'medspa.provider-always' AND p.tenant_id = m.tenant_id),
           (SELECT p.id FROM approval_policies p
             WHERE p.key = 'medspa.provider-always' AND p.tenant_id IS NULL)),
         jsonb_build_array(jsonb_build_object(
           'at', to_char(mig.to_tz(s.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'from', 'DRAFT',
           'to', mig.map_approval_status(s.queued_message->>'approvalStatus'),
           'actorType', 'system', 'actorRef', 'migration:p9',
           'reason', 'migrated from message_history.queued_message')),
         COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.created_at), now())
  FROM src.message_history s
  JOIN messages m ON m.id = s.id
  WHERE s.queued_message->>'approvalStatus' IS NOT NULL
    AND mig.map_approval_status(s.queued_message->>'approvalStatus') IS NOT NULL
    AND s.created_at > v_since
  ON CONFLICT (message_id) DO NOTHING;
  GET DIAGNOSTICS a = ROW_COUNT;

  -- ── Shape B: state in the status column ───────────────────────────────────
  -- `metadata->>'originalContent'` is where the ai-enhanced edit path keeps the
  -- pre-edit body, so when it is present the current content is the edit.
  INSERT INTO approvals (
    id, tenant_id, sub_tenant_id, message_id, status, approver_type, approver_ref,
    requested_at, original_content, edited_content, policy_id, audit_trail,
    created_at, updated_at
  )
  SELECT gen_random_uuid(), m.tenant_id, m.sub_tenant_id, m.id,
         mig.map_approval_status(s.status), 'agent', s.provider_id,
         COALESCE(mig.to_tz(s.created_at), now()),
         COALESCE(s.metadata->>'originalContent', s.content),
         CASE WHEN s.metadata->>'originalContent' IS NOT NULL THEN s.content END,
         COALESCE(
           (SELECT p.id FROM approval_policies p
             WHERE p.key = 'medspa.provider-always' AND p.tenant_id = m.tenant_id),
           (SELECT p.id FROM approval_policies p
             WHERE p.key = 'medspa.provider-always' AND p.tenant_id IS NULL)),
         jsonb_build_array(jsonb_build_object(
           'at', to_char(mig.to_tz(s.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'from', 'DRAFT',
           'to', mig.map_approval_status(s.status),
           'actorType', 'system', 'actorRef', 'migration:p9',
           'reason', 'migrated from message_history.status')),
         COALESCE(mig.to_tz(s.created_at), now()), COALESCE(mig.to_tz(s.created_at), now())
  FROM src.message_history s
  JOIN messages m ON m.id = s.id
  WHERE s.queued_message->>'approvalStatus' IS NULL
    AND upper(COALESCE(s.status, '')) IN
        ('PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'REJECTED', 'DECLINED')
    AND s.created_at > v_since
  ON CONFLICT (message_id) DO NOTHING;
  GET DIAGNOSTICS b = ROW_COUNT;

  -- ── the back-reference, and the status that goes with it ──────────────────
  -- A message with an open approval is `PENDING_APPROVAL` in this engine —
  -- that is what approval.service.ts:316 writes, and what
  -- `MessageService.list({status:'PENDING_APPROVAL'})` and the compat pending
  -- views look for. The source calls the same row 'QUEUED', because it keeps
  -- delivery state and approval state in one column. Migrated rows have to look
  -- like rows the engine wrote, or they are invisible to the screens built for
  -- them.
  --
  -- Only QUEUED and PENDING are rewritten: a message that was actually sent
  -- keeps its delivery status whatever its approval says.
  UPDATE messages m
  SET approval_id = ap.id,
      status = CASE WHEN ap.status = 'PENDING_APPROVAL' AND m.status IN ('QUEUED', 'PENDING')
                    THEN 'PENDING_APPROVAL' ELSE m.status END,
      updated_at = now()
  FROM approvals ap
  WHERE ap.message_id = m.id
    AND (m.approval_id IS DISTINCT FROM ap.id
         OR (ap.status = 'PENDING_APPROVAL' AND m.status IN ('QUEUED', 'PENDING')));
  GET DIAGNOSTICS c = ROW_COUNT;

  -- ── the historic backlog ──────────────────────────────────────────────────
  CALL mig.apply_backlog_disposition();

  -- Approval-shaped rows whose message never made it (quarantined in 9008), and
  -- rows carrying a status word neither map recognises.
  INSERT INTO mig.rejects (loader, source_table, source_id, reason, payload)
  SELECT '9009_approvals', 'message_history', s.id::text,
         CASE WHEN NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = s.id)
                THEN 'the message itself did not migrate'
              ELSE 'unrecognised approval status' END,
         jsonb_build_object('status', s.status,
                            'approvalStatus', s.queued_message->>'approvalStatus')
  FROM src.message_history s
  WHERE s.created_at > v_since
    AND (s.queued_message->>'approvalStatus' IS NOT NULL
         OR upper(COALESCE(s.status, '')) IN
            ('PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'REJECTED', 'DECLINED'))
    AND (NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = s.id)
         OR COALESCE(mig.map_approval_status(s.queued_message->>'approvalStatus'),
                     mig.map_approval_status(s.status)) IS NULL)
  ON CONFLICT DO NOTHING;

  CALL mig.advance('approvals', mig.ceiling(), a + b);
  CALL mig.note('9009_approvals', 'approvals from shape A (queued_message blob)', a);
  CALL mig.note('9009_approvals', 'approvals from shape B (status column)', b);
  CALL mig.note('9009_approvals', 'messages given an approval_id', c);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE TRAILING REFRESH
--
-- Defined here because it is the only thing in the series that has to
-- understand both a message and its approval at once. scripts/delta-sync.sql
-- calls it after the loaders on every pass of the parallel run.
--
-- Why it exists at all: `message_history` HAS NO `updated_at`. A row migrated
-- on Tuesday that is delivered on Wednesday and approved on Thursday still
-- carries Tuesday's `created_at`, so no watermark on `created_at` can ever see
-- the change. The only options are a trailing re-read or nothing, and the
-- window is `mig.settings.delta_refresh_days` (default 7). Rows older than the
-- window that change are not picked up — stated here, in the runbook §7, and
-- nowhere else, because it is the one real gap in the parallel-run story.
--
-- It treats mentera-core as the source of truth for every row it touches, which
-- is correct only while the old service is the only writer. See the header of
-- scripts/delta-sync.sql.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE PROCEDURE mig.refresh_recent()
LANGUAGE plpgsql AS $$
DECLARE
  v_days int := COALESCE(NULLIF(mig.setting('delta_refresh_days'), '')::int, 7);
  v_from timestamp := mig.to_src(now()) - make_interval(days => v_days);
  m1 bigint; m2 bigint; m3 bigint;
BEGIN
  -- 1. plain messages — delivery state and body.
  UPDATE messages m
  SET status          = mig.map_message_status(s.status),
      content         = COALESCE(s.content, ''),
      sent_at         = mig.to_tz(s.sent_at),
      delivered_at    = mig.to_tz(s.delivered_at),
      read_at         = mig.to_tz(s.read_at),
      engagement_data = s.engagement_data::jsonb,
      updated_at      = now()
  FROM src.message_history s
  WHERE s.id = m.id
    AND s.created_at >= v_from
    AND m.approval_id IS NULL
    AND mig.map_message_status(s.status) IS NOT NULL
    AND (m.status       IS DISTINCT FROM mig.map_message_status(s.status)
      OR m.content      IS DISTINCT FROM COALESCE(s.content, '')
      OR m.delivered_at IS DISTINCT FROM mig.to_tz(s.delivered_at)
      OR m.read_at      IS DISTINCT FROM mig.to_tz(s.read_at));
  GET DIAGNOSTICS m1 = ROW_COUNT;

  -- 2. approvals nobody has touched in the new system. The single migration
  -- entry is REPLACED rather than appended to, so `jsonb_array_length = 1`
  -- still identifies them next time and the disposition below still applies.
  -- The third COALESCE arm is the parallel run's own case: a message that was
  -- PENDING_APPROVAL when it was migrated, and has since been approved AND
  -- delivered in the old system, no longer carries an approval word anywhere —
  -- its status column has moved on to SENT or DELIVERED. Leaving the approval
  -- PENDING_APPROVAL would put a phantom in an approver's inbox for a message
  -- the recipient has already read.
  UPDATE approvals ap
  SET status = COALESCE(mig.map_approval_status(s.queued_message->>'approvalStatus'),
                        mig.map_approval_status(s.status),
                        CASE WHEN mig.map_message_status(s.status)
                                  IN ('SENT', 'DELIVERED', 'READ') THEN 'SENT' END),
      decided_at     = COALESCE(mig.try_ts(s.queued_message->>'approvedAt'), ap.decided_at),
      decided_by     = COALESCE(s.queued_message->>'approvedBy', ap.decided_by),
      decline_reason = COALESCE(s.queued_message->>'declineReason', ap.decline_reason),
      edited_content = COALESCE(s.queued_message->>'editedContent', ap.edited_content),
      audit_trail = jsonb_build_array(jsonb_build_object(
        'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'from', 'DRAFT',
        'to', COALESCE(mig.map_approval_status(s.queued_message->>'approvalStatus'),
                       mig.map_approval_status(s.status),
                       CASE WHEN mig.map_message_status(s.status)
                                 IN ('SENT', 'DELIVERED', 'READ') THEN 'SENT' END),
        'actorType', 'system', 'actorRef', 'migration:p9',
        'reason', 're-synced from mentera-core during the parallel run')),
      updated_at = now()
  FROM src.message_history s
  WHERE s.id = ap.message_id
    AND s.created_at >= v_from
    AND jsonb_array_length(ap.audit_trail) = 1
    AND ap.audit_trail @> '[{"actorRef":"migration:p9"}]'::jsonb
    AND COALESCE(mig.map_approval_status(s.queued_message->>'approvalStatus'),
                 mig.map_approval_status(s.status),
                 CASE WHEN mig.map_message_status(s.status)
                           IN ('SENT', 'DELIVERED', 'READ') THEN 'SENT' END) IS NOT NULL
    AND COALESCE(mig.map_approval_status(s.queued_message->>'approvalStatus'),
                 mig.map_approval_status(s.status),
                 CASE WHEN mig.map_message_status(s.status)
                           IN ('SENT', 'DELIVERED', 'READ') THEN 'SENT' END) IS DISTINCT FROM ap.status;
  GET DIAGNOSTICS m2 = ROW_COUNT;

  -- 3. the messages behind those approvals follow their source status.
  UPDATE messages m
  SET status = mig.map_message_status(s.status),
      content = COALESCE(s.content, ''),
      updated_at = now()
  FROM src.message_history s, approvals ap
  WHERE m.id = s.id AND ap.message_id = m.id
    AND s.created_at >= v_from
    AND jsonb_array_length(ap.audit_trail) = 1
    AND ap.audit_trail @> '[{"actorRef":"migration:p9"}]'::jsonb
    AND mig.map_message_status(s.status) IS NOT NULL
    AND m.status IS DISTINCT FROM mig.map_message_status(s.status);
  GET DIAGNOSTICS m3 = ROW_COUNT;

  -- 4. and the backlog decision is re-applied to whatever just moved into
  -- APPROVED during the parallel run.
  CALL mig.apply_backlog_disposition();

  CALL mig.note('delta-sync', 'messages refreshed in the trailing window', m1 + m3);
  CALL mig.note('delta-sync', 'approvals refreshed in the trailing window', m2);
END $$;

COMMIT;

-- @@ SPLIT @@

CALL mig.load_approvals('-infinity');

-- -----------------------------------------------------------------------------
-- AFTER APPLYING — compare against the recon, which counts the same two shapes
--
--   SELECT detail, n FROM mig.log WHERE loader = '9009_approvals' ORDER BY id;
--
--   SELECT status, count(*) FROM approvals GROUP BY 1 ORDER BY 2 DESC;
--
--   -- must be 0: every approval points at a message and vice versa
--   SELECT count(*) FROM approvals a
--   WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = a.message_id);
--   SELECT count(*) FROM messages m
--   WHERE m.approval_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.id = m.approval_id);
--
--   -- what is genuinely still in flight, and who owes a decision
--   SELECT approver_ref, count(*) FROM approvals
--   WHERE status = 'PENDING_APPROVAL' GROUP BY 1 ORDER BY 2 DESC;
-- -----------------------------------------------------------------------------
