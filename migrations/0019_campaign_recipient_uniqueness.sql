-- =============================================================================
-- 0019 — a recipient appears in a campaign once
--
-- `campaign_recipients` shipped in 0001 with two lookup indexes and no
-- uniqueness, and `expand()` deduped by reading the existing rows and inserting
-- the difference. Two concurrent launches both read, both found nothing, and
-- both inserted the whole audience — and every duplicated row is a second
-- message to a real person.
--
-- `launch()` now claims the campaign with an atomic status update, which closes
-- the race at the campaign level. This is the constraint underneath it: a
-- guard in one code path is a convention, and `expand()` is also reachable from
-- a relaunch and a resume.
--
-- IT ALSO MAKES THE EXPANDER SIMPLER AND MORE CORRECT. With the constraint in
-- place the read-then-filter becomes `ON CONFLICT DO NOTHING`, so a relaunch
-- that adds newcomers cannot race with anything either.
--
-- SAFE ON A POPULATED TABLE: the dedupe keeps, per (campaign, recipient), the
-- row that has actually done something — a SENT or SUPPRESSED row outranks a
-- PENDING one, because deleting the one that recorded a send would erase the
-- evidence that a message went out.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Collapse duplicates, keeping the row that carries the outcome.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE mig_dup_campaign_recipients ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY campaign_id, recipient_id
      ORDER BY
        -- A row that produced a message outranks one that never did.
        (message_id IS NOT NULL) DESC,
        -- Then anything decided over anything still waiting.
        (status <> 'PENDING') DESC,
        created_at,
        id
    ) AS rank
  FROM campaign_recipients
  WHERE campaign_id IS NOT NULL AND recipient_id IS NOT NULL
)
SELECT id FROM ranked WHERE rank > 1;

DELETE FROM campaign_recipients c
USING mig_dup_campaign_recipients d
WHERE c.id = d.id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The constraint.
--
-- Partial on both columns being present: 0001 made them nullable (a campaign
-- row whose campaign or recipient was deleted keeps its history), and NULLs
-- would otherwise all be distinct and the index would not say what it means.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_campaign_recipient_unique
  ON campaign_recipients (campaign_id, recipient_id)
  WHERE campaign_id IS NOT NULL AND recipient_id IS NOT NULL;

COMMIT;
