-- =============================================================================
-- 0015 — consent records get the uniqueness the compliance gate depends on
--
-- `consent_records` shipped in 0001 with a plain lookup index and no writer.
-- P13 adds the writer (ConsentService, the /v1/recipients/:id/consent routes,
-- the campaign importer and the unsubscribe path), and the moment rows can be
-- written the missing constraint becomes load-bearing.
--
-- WHY UNIQUE (tenant_id, recipient_id, channel)
--
-- The gate asks one question: is there a granted, un-revoked row for this
-- recipient on this channel? With repeated grants appending rows, revocation
-- could only revoke the rows it matched, and any older granted row would keep
-- answering that question `true` — so an unsubscribe would appear to work and
-- the recipient would keep receiving messages. Revocation must win, and it can
-- only reliably win against exactly one row.
--
-- The constraint is also what every writer's ON CONFLICT targets. Without it
-- the upserts raise `there is no unique or exclusion constraint matching the
-- ON CONFLICT specification` — loudly, at the first grant, rather than quietly.
--
-- SAFE ON A POPULATED TABLE
--
-- The dedupe below runs first and keeps, per (tenant, recipient, channel), the
-- row that a human would consider current: a revocation beats a grant, and
-- among equals the most recently updated wins. Revocation beats grant rather
-- than the other way round because the cost of the two mistakes is not
-- symmetric — keeping a stale grant sends a message to somebody who withdrew,
-- keeping a stale revocation withholds one from somebody who did not.
--
-- In practice this deletes nothing today: the table has no writer before this
-- migration, so it is empty in every environment. The block exists so that
-- re-running the migration after the writers have shipped is still safe.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Collapse any duplicate (tenant, recipient, channel) groups.
-- ─────────────────────────────────────────────────────────────────────────────
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY tenant_id, recipient_id, channel
      ORDER BY
        -- A withdrawal outranks a grant, whenever it was made.
        (revoked_at IS NOT NULL) DESC,
        updated_at DESC,
        created_at DESC,
        id DESC
    ) AS rank
  FROM consent_records
)
DELETE FROM consent_records c
USING ranked r
WHERE c.id = r.id AND r.rank > 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The constraint itself.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS consent_records_recipient_channel_unique
  ON consent_records (tenant_id, recipient_id, channel);

-- The 0001 index is now redundant: it has the same leading columns in the same
-- order, so every lookup it served is served by the unique one above.
DROP INDEX IF EXISTS idx_consent_recipient_channel;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. A partial index for the gate's actual predicate.
--
-- `hasConsent()` filters on granted = true AND revoked_at IS NULL, and that is
-- the query on the hot path of every send once enforcement is on.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_consent_active
  ON consent_records (tenant_id, recipient_id, channel)
  WHERE granted AND revoked_at IS NULL;

COMMIT;
