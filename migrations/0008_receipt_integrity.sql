-- =============================================================================
-- 0008_receipt_integrity.sql
--
-- One analytics row per message, and an index the receipt lookup can use.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0008_receipt_integrity.sql
--
-- Requires 0001 (messages, message_analytics).
--
-- -----------------------------------------------------------------------------
-- WHY: TWO DEFECTS IN THE P8b WEBHOOK PATH, BOTH INVISIBLE UNTIL RECEIPTS FLOW
--
-- Nothing in the source service ever consumed a delivery receipt, so
-- `message_analytics` has only ever held rows written one at a time by hand.
-- P8b made a provider's callbacks write to it, and two things that were fine
-- under that assumption stopped being fine.
--
-- 1. NO UNIQUE CONSTRAINT ON message_id
--
-- `idx_message_analytics_message` is a plain index. `ON CONFLICT DO NOTHING`
-- without a target only skips on an actual unique violation, and with no unique
-- constraint there is never one — so **every** receipt inserted a new row. A
-- message with an open and a click got two analytics rows.
--
-- That is not merely untidy. `MessageService.list` and `.getById`, and
-- `ConversationService.thread`, all LEFT JOIN this table. Two analytics rows
-- mean the message appears twice in the list while `total` still counts it
-- once — so `data.length !== total`, a page of 50 can return 80 rows, and the
-- legacy `PaginatedResponse` envelope the FE reads becomes incoherent.
--
-- Reproduced before this migration was written: two receipts for one message
-- produced 2 analytics rows and a list that returned `data.length = 2,
-- total = 1`.
--
-- The index is PARTIAL because `message_id` is nullable — an analytics row may
-- describe a notification rather than a message. NULLs are distinct in a unique
-- index anyway; the predicate states the intent rather than relying on that.
--
-- 2. THE RECEIPT LOOKUP COULD NOT USE ITS INDEX
--
-- `idx_messages_provider_message_id` is on `(tenant_id, provider_message_id)`,
-- which is right for a tenant-scoped query and useless for the one query that
-- actually runs: a provider callback carries no tenant, so `ReceiptService`
-- looks the row up by `provider_message_id` alone and reads the tenant off it.
-- A btree cannot serve a predicate that skips its leading column, so every
-- receipt was a sequential scan of `messages`.
--
-- Harmless on an empty table. On the largest table in the service, with
-- SendGrid batching event callbacks, it is the kind of thing that looks like a
-- database problem rather than a missing index.
--
-- The tenant-scoped index stays: it still serves `WHERE tenant_id = $1 AND
-- provider_message_id = $2`, which is what an operator's query looks like.
--
-- -----------------------------------------------------------------------------
-- BEFORE APPLYING: DEDUPLICATE
--
-- The unique index cannot be created while duplicates exist. This migration
-- collapses them first, keeping the earliest row per message and folding the
-- others' non-null engagement fields into it, so no observed open or click is
-- lost. On a database that has never taken a receipt this is a no-op.
-- -----------------------------------------------------------------------------

BEGIN;

-- ── 1. collapse duplicates, keeping the earliest row per message ─────────────
WITH ranked AS (
  SELECT id,
         message_id,
         row_number() OVER (PARTITION BY message_id ORDER BY created_at, id) AS rn
  FROM message_analytics
  WHERE message_id IS NOT NULL
),
survivors AS (
  SELECT message_id, id FROM ranked WHERE rn = 1
),
folded AS (
  SELECT s.id AS keep_id,
         min(a.opened_at)  AS opened_at,
         min(a.clicked_at) AS clicked_at,
         min(a.replied_at) AS replied_at,
         max(a.engagement_score) AS engagement_score,
         -- First non-null wins, matching the first-event semantics the service
         -- applies from here on.
         (array_remove(array_agg(a.clicked_link ORDER BY a.created_at), NULL))[1] AS clicked_link,
         (array_remove(array_agg(a.reply_content ORDER BY a.created_at), NULL))[1] AS reply_content
  FROM survivors s
  JOIN message_analytics a ON a.message_id = s.message_id
  GROUP BY s.id
)
UPDATE message_analytics t
SET opened_at        = COALESCE(t.opened_at, f.opened_at),
    clicked_at       = COALESCE(t.clicked_at, f.clicked_at),
    replied_at       = COALESCE(t.replied_at, f.replied_at),
    engagement_score = COALESCE(t.engagement_score, f.engagement_score),
    clicked_link     = COALESCE(t.clicked_link, f.clicked_link),
    reply_content    = COALESCE(t.reply_content, f.reply_content),
    updated_at       = now()
FROM folded f
WHERE t.id = f.keep_id;

DELETE FROM message_analytics a
USING (
  SELECT id,
         row_number() OVER (PARTITION BY message_id ORDER BY created_at, id) AS rn
  FROM message_analytics
  WHERE message_id IS NOT NULL
) d
WHERE a.id = d.id AND d.rn > 1;

-- ── 2. one analytics row per message ─────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS message_analytics_message_unique
  ON message_analytics (message_id)
  WHERE message_id IS NOT NULL;

-- ── 3. the index the receipt lookup actually uses ────────────────────────────
-- Partial: only a sent message has a provider id, and that is a small fraction
-- of the table's lifetime rows once drafts and suppressed messages accumulate.
CREATE INDEX IF NOT EXISTS idx_messages_provider_message_id_lookup
  ON messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

COMMIT;

-- -----------------------------------------------------------------------------
-- VERIFY
--
--   -- must return 0
--   SELECT count(*) FROM (
--     SELECT message_id FROM message_analytics
--     WHERE message_id IS NOT NULL GROUP BY message_id HAVING count(*) > 1
--   ) dupes;
--
--   -- must report an Index Scan, not a Seq Scan
--   EXPLAIN SELECT id FROM messages WHERE provider_message_id = 'SM123';
-- -----------------------------------------------------------------------------
