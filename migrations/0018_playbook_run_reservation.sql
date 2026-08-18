-- =============================================================================
-- 0018 — a playbook run is reserved before it sends, not recorded after
--
-- `playbook_runs_idempotency_unique` has existed since 0007 and deduped the
-- BOOKKEEPING rather than the SENDS. The runtime read the table for a prior
-- run, dispatched, and inserted the row at the end with ON CONFLICT DO NOTHING
-- — check-then-act, with the entire fan-out sitting in the gap. Two concurrent
-- deliveries of the same event (BullMQ concurrency above 1, a stalled-job
-- reclaim, a crash between the dispatch and the insert) both found no prior run
-- and both sent.
--
-- The INSERT moves to the front and becomes the reservation: exactly one caller
-- gets a row back from `ON CONFLICT DO NOTHING … RETURNING`, and only that one
-- sends. The row is then updated in place as the run progresses.
--
-- That needs one new state. `RUNNING` is what a reservation looks like before
-- there is an outcome, and it is what a second delivery arriving mid-flight
-- sees — without it, the loser of the race would find nothing, because the
-- winner had not finished writing its result yet.
--
-- `finished_at` stays NULL for a RUNNING row, which also makes a run that died
-- mid-flight findable: status RUNNING with an old started_at is a crashed
-- process, and it was previously indistinguishable from an event nobody sent.
-- =============================================================================

BEGIN;

ALTER TABLE playbook_runs DROP CONSTRAINT IF EXISTS playbook_runs_status_check;

ALTER TABLE playbook_runs ADD CONSTRAINT playbook_runs_status_check CHECK (status IN (
  'RUNNING','SENT','QUEUED','PENDING_APPROVAL','SUPPRESSED','SKIPPED','FAILED'
));

-- "Which runs died on their feet?" — a RUNNING row whose start is not recent.
-- Partial and tiny: healthy runs leave RUNNING within seconds.
CREATE INDEX IF NOT EXISTS idx_playbook_runs_in_flight
  ON playbook_runs (tenant_id, started_at)
  WHERE status = 'RUNNING';

COMMIT;
