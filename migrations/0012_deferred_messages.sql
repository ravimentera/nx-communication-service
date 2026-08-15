-- =============================================================================
-- 0012_deferred_messages.sql
--
-- `messages.deferred_until` — when a held message becomes sendable.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0012_deferred_messages.sql
--
-- Requires 0001 (messages).
--
-- -----------------------------------------------------------------------------
-- WHY
--
-- P5's compliance gate defers rather than blocks: a message caught by quiet
-- hours or a rate limit is written `SUPPRESSED` with a `retryAt`, to be sent
-- when the window opens. The source blocked instead, so a reminder that arrived
-- during someone's quiet hours was simply lost (D40).
--
-- Nothing consumed `retryAt` until `engine/delivery/deferral.worker.ts`, which
-- means that until now a deferred message was lost too — while its row claimed
-- it would be retried, which is worse than the source's honest drop.
--
-- -----------------------------------------------------------------------------
-- WHY A COLUMN AND NOT THE JSONB IT WAS ALREADY IN
--
-- `retryAt` was already being written to `messages.metadata`, and the first cut
-- of this migration indexed it there:
--
--   CREATE INDEX ... ON messages (((metadata->>'retryAt')::timestamptz)) WHERE ...
--
-- Postgres rejects that outright — `functions in index expression must be marked
-- IMMUTABLE`. `text::timestamptz` is STABLE, not IMMUTABLE, because parsing a
-- timestamp without an offset depends on the session's TimeZone. It cannot be
-- indexed, and an unindexed predicate over `messages` — the largest table in the
-- service — is a sequential scan once a minute, forever.
--
-- The workaround would have been to index and compare the raw text, which is
-- correct only while every writer emits fixed-width UTC (`toISOString()`), and
-- silently wrong the first time one does not. A typed column costs one
-- `ADD COLUMN` and removes the whole class of question.
--
-- Nullable with no default, so this is a catalogue-only change: no table
-- rewrite, no lock held while rows are touched, safe on a large table.
--
-- `metadata.retryAt` is still written alongside it, because that is what the API
-- returns to callers and what `docs/api/BREAKING.md` documents. The column is
-- the queryable copy; the JSON is the reported one.
--
-- -----------------------------------------------------------------------------
-- THE INDEX IS PARTIAL, AND ROWS LEAVE IT ON THEIR OWN
--
-- The predicate matches the sweeper's query, so only messages actually awaiting
-- retry are indexed at all — the index is sized by the backlog, not the table,
-- and is close to empty on a healthy tenant.
--
-- Both exits maintain themselves. A message that sends flips `status` and drops
-- out; a message the sweeper gives up on has `deferred_until` set to NULL and
-- drops out. Neither needs a second pass to mark what it already handled.
-- -----------------------------------------------------------------------------

BEGIN;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deferred_until timestamptz;

COMMENT ON COLUMN messages.deferred_until IS
  'When a message the compliance gate held becomes sendable again. Set on the SUPPRESSED-with-retry path, cleared when the deferral sweeper gives up. NULL on everything else.';

CREATE INDEX IF NOT EXISTS idx_messages_awaiting_retry
  ON messages (deferred_until)
  WHERE status = 'SUPPRESSED' AND deferred_until IS NOT NULL;

COMMIT;

-- -----------------------------------------------------------------------------
-- VERIFY
--
--   -- must exist
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'messages' AND indexname = 'idx_messages_awaiting_retry';
--
--   -- the current backlog, which is also the gauge the sweeper exports
--   SELECT count(*) FROM messages
--   WHERE status = 'SUPPRESSED' AND deferred_until IS NOT NULL;
--
--   -- must report an Index Scan once that count is non-trivial
--   EXPLAIN SELECT id FROM messages
--   WHERE status = 'SUPPRESSED' AND deferred_until IS NOT NULL
--     AND deferred_until <= now()
--   ORDER BY deferred_until;
-- -----------------------------------------------------------------------------
