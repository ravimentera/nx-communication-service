-- =============================================================================
-- delta-sync.sql — keep the target current during the parallel run
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/delta-sync.sql
--
-- Requires the full 9000-9010 series to have been applied. Run it on a
-- schedule between the bulk load and the P10 cutover, and once more inside the
-- cutover window with the old service stopped (runbook §7).
--
-- -----------------------------------------------------------------------------
-- IT IS THE SAME CODE, NOT A COPY OF IT
--
-- Every loader in 9007-9009 is a procedure that takes `p_since` and resumes
-- from its own watermark, so a delta is just those procedures called again.
-- There is no second set of INSERTs here to drift out of step with the first
-- set the day someone adds a column — which is what a hand-written delta script
-- always becomes.
--
-- -----------------------------------------------------------------------------
-- THE PART THE WATERMARKS CANNOT DO: ROWS THAT CHANGE IN PLACE
--
-- `message_history` HAS NO `updated_at`. A message migrated last Tuesday that
-- was delivered on Wednesday, read on Thursday and approved on Friday still has
-- Tuesday's `created_at` and nothing else to sort on, so a watermark on
-- `created_at` will never see any of it.
--
-- So the second half of this script re-reads a trailing window —
-- `mig.settings.delta_refresh_days`, default 7 — and refreshes the fields that
-- move: delivery timestamps, status, edited content, approval state. Rows older
-- than the window that change are NOT picked up. That is a real limit and the
-- runbook says so plainly; widen the window if the source has long-lived
-- pending approvals, at the cost of a longer scan each run.
--
-- -----------------------------------------------------------------------------
-- RUN THIS ONLY WHILE THE NEW SERVICE IS NOT TAKING WRITES
--
-- The refresh treats mentera-core as the source of truth for every migrated
-- row. Until the P10 repoint that is exactly right — the old service is the
-- only writer. After it, this script would overwrite the new service's own work
-- with a stale copy. The last delta belongs INSIDE the cutover window, with the
-- old service stopped and before the new one starts serving.
--
-- The approval refresh is narrower on purpose: it only touches approvals whose
-- audit trail is still the single entry the migration wrote. Anything a human
-- has decided in the new system is left exactly as they left it.
-- =============================================================================

-- ── 1. new rows, from each loader's own watermark ───────────────────────────
CALL mig.load_events_all('-infinity');

-- @@ SPLIT @@

CALL mig.load_messages_all('-infinity');

-- @@ SPLIT @@

CALL mig.load_approvals('-infinity');

-- @@ SPLIT @@

-- ── 2. the trailing refresh ─────────────────────────────────────────────────
CALL mig.refresh_recent();

-- @@ SPLIT @@

SELECT loader, watermark, rows_done, updated_at FROM mig.progress ORDER BY loader;
