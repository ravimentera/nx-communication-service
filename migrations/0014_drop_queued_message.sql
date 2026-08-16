-- =============================================================================
-- 0014_drop_queued_message.sql
--
-- Drop `messages.queued_message` from a database that was created before P12
-- removed it from `0001_core_schema.sql`.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0014_drop_queued_message.sql
--
-- **On a database created from the current `0001`, this file does nothing.**
-- Every statement is `IF EXISTS`. It exists for local development databases
-- built from the older schema, which are the only ones that can have the column
-- — see below.
--
-- -----------------------------------------------------------------------------
-- WHY THE COLUMN LEFT `0001` RATHER THAN BEING DROPPED HERE
--
-- It held the source's approval blob (`message_history.queued_message`), copied
-- across by the P9 load so the backfill had something to read. This engine has
-- never written it: `approvals` (0002) has been the only home for approval
-- state since P6, and every message the new service creates has answered `null`
-- for it since P9.
--
-- The obvious shape was to leave `0001` alone and drop the column here. That
-- does not work, for a mechanical reason worth writing down:
--
--   * the 9xxx load *wrote* the column, so this file could only be applied
--     AFTER the load — making it non-baseline, like `0013` (D97);
--   * baseline would therefore keep the column, so `db/schema/messaging.ts`
--     would have to keep it too, or the bidirectional Drizzle↔SQL conformance
--     test fails;
--   * but `ApprovalService.release()` does `db.select().from(messages)`, which
--     emits every column in the model — so the first operator to apply this
--     file would break approvals on a column nobody remembered.
--
-- Keeping the two definitions in sync would have meant an exception in the one
-- test that keeps them in sync. So the column came out of `0001` instead, out
-- of the model, and out of `9008`/`9009`, which no longer write it. **No
-- environment had applied `0001`** — the target database is new and empty
-- (runbook §0) and the cutover has not run — so there was nothing to preserve.
-- See D103.
--
-- -----------------------------------------------------------------------------
-- WHAT WAS READING IT
--
-- Three readers, all removed in the same change:
--
--   * `engine/messaging/conversation.service.ts` selected it into the thread
--     response, and derived `pendingApprovalCount` from
--     `queued_message->>'approvalStatus'`. That count reads `approvals` now and
--     keeps its `status = 'QUEUED'` filter, so its value is unchanged — it is
--     structurally zero, as it has always been.
--   * `api/compat/communications.ts` passed it into the legacy envelope and
--     derived `isPendingApproval` / `isApproved` / `isDeclined` from it. The
--     envelope still carries all four, now constant, because the web app
--     (`inbox.utils.ts:301`) and the mobile app (`ApprovalsScreen.tsx:133`)
--     read `queuedMessage.content` and guard on the object being present —
--     `null` is a path they already take; a missing key is not.
--   * the P9 load, above.
--
-- -----------------------------------------------------------------------------
-- ROLLBACK
--
-- `ALTER TABLE messages ADD COLUMN queued_message jsonb;` restores the column
-- but not its contents. On a development database that is all you need. On one
-- that has taken the P9 load, the values come back from `src.message_history`.
-- =============================================================================

BEGIN;

ALTER TABLE messages DROP COLUMN IF EXISTS queued_message;

-- The two indexes the source built over the JSONB predicate. Postgres drops an
-- index whose only column is dropped, so these are for a database where someone
-- recreated one by hand.
DROP INDEX IF EXISTS message_history_queued_approval_idx;
DROP INDEX IF EXISTS message_history_provider_queued_idx;

COMMIT;

-- =============================================================================
-- VERIFY
--
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'messages' AND column_name = 'queued_message';
--
-- Must return 0.
-- =============================================================================
