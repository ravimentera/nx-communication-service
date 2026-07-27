-- =============================================================================
-- 0007_playbook_runs.sql
--
-- Evidence that a playbook ran, and the guard that stops it running twice.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0007_playbook_runs.sql
--
-- Requires 0003 (playbooks).
--
-- -----------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS
--
-- `enhanced-event-handler.ts` returns a bare `boolean` and logs. When a message
-- does not arrive there is no row anywhere saying which of its 17 cases ran,
-- what it decided, or where it stopped — the only evidence is a log line that
-- has since rotated away. "Did the reminder fire?" is currently unanswerable.
--
-- Each run records the whole trigger, so a failed run can be replayed exactly
-- rather than reconstructed from what someone remembers sending.
--
-- WHY THE IDEMPOTENCY INDEX IS PARTIAL
--
-- BullMQ retries a failed job up to five times. A handler that threw *after*
-- queueing its first channel re-queues that channel on every attempt — five
-- messages to one recipient, which is the failure mode D21 fixed at the adapter
-- level and this fixes at the playbook level.
--
-- The index must be PARTIAL. A trigger with no idempotency key is legitimate
-- (a manual send, a test), and NULLs are distinct in a plain unique index in
-- Postgres — but making it total would still be wrong the moment anyone adds
-- NULLS NOT DISTINCT. Stating `WHERE idempotency_key IS NOT NULL` says what is
-- meant instead of relying on NULL semantics.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS playbook_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  sub_tenant_id   uuid,
  playbook_id     uuid NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  -- The whole OutreachTrigger, so a run can be replayed byte for byte.
  trigger         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL,
  -- Populated on FAILED / SKIPPED / SUPPRESSED. The contract errors land here,
  -- which is what makes "which field was missing?" answerable.
  error           text,
  -- A playbook may fan out across channels; each produces its own message.
  message_ids     uuid[] NOT NULL DEFAULT '{}'::uuid[],
  correlation_id  text,
  idempotency_key text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playbook_runs_status_check CHECK (status IN (
    'SENT','QUEUED','PENDING_APPROVAL','SUPPRESSED','SKIPPED','FAILED'
  ))
);

-- The redelivery guard. See the header for why it is partial.
CREATE UNIQUE INDEX IF NOT EXISTS playbook_runs_idempotency_unique
  ON playbook_runs (tenant_id, playbook_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- "What has this playbook done lately?" — the operator's first question.
CREATE INDEX IF NOT EXISTS idx_playbook_runs_tenant_playbook
  ON playbook_runs (tenant_id, playbook_id, started_at DESC);

-- Ties every run, message and approval produced by one event back together.
CREATE INDEX IF NOT EXISTS idx_playbook_runs_correlation
  ON playbook_runs (correlation_id);

-- "What is failing right now?" Partial, because the healthy states dominate and
-- nobody pages on a SENT.
CREATE INDEX IF NOT EXISTS idx_playbook_runs_failures
  ON playbook_runs (tenant_id, status, started_at DESC)
  WHERE status IN ('FAILED','SUPPRESSED');

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING — the two queries this table exists to answer:
--
--   -- Why did nothing send for this event?
--   SELECT p.key, r.status, r.error, r.started_at
--   FROM playbook_runs r JOIN playbooks p ON p.id = r.playbook_id
--   WHERE r.correlation_id = '<id>' ORDER BY r.started_at;
--
--   -- Which playbooks are failing, and on what?
--   SELECT p.key, r.error, count(*)
--   FROM playbook_runs r JOIN playbooks p ON p.id = r.playbook_id
--   WHERE r.status = 'FAILED' AND r.started_at > now() - interval '1 day'
--   GROUP BY 1, 2 ORDER BY 3 DESC;
-- -----------------------------------------------------------------------------
