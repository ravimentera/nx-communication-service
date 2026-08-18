-- =============================================================================
-- 0017 — an inbound message arrives once, however many times the provider sends it
--
-- Twilio retries any callback it does not get a 2xx for, and its payload carries
-- no timestamp — so unlike SendGrid and Slack there is nothing to reject a
-- replay against at the signature layer. `0008` added
-- `idx_messages_provider_message_id` on (tenant_id, provider_message_id), but
-- non-unique, and `recordInboundFor` did a bare INSERT. Every retry therefore
-- produced a second copy of the same patient reply, in the thread a provider
-- reads.
--
-- Idempotency at this end is the defence, and it has to be a constraint rather
-- than a read-then-insert: two retries arriving concurrently both find nothing
-- and both insert.
--
-- PARTIAL, on two conditions:
--
--   direction = 'inbound'        outbound rows carry the provider id of the
--                                message WE sent, and are already one row per
--                                send; constraining them too would couple two
--                                unrelated lifecycles.
--   provider_message_id NOT NULL the legacy internal envelope at
--                                `/messages/webhook/*` produces replies with no
--                                provider id at all. Those have nothing to
--                                dedupe on and must still insert.
--
-- SAFE ON A POPULATED TABLE: the dedupe below keeps the earliest row of each
-- group — the one that was genuinely first, whose id anything else may already
-- reference — and deletes the retries.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Collapse duplicates already recorded.
--
-- `message_analytics` has a FK onto messages, so the analytics rows of a
-- deleted duplicate go first. Inbound messages rarely have any — analytics is
-- written against the OUTBOUND message a reply answers — but a delete that
-- fails at 3am on a foreign key is not the way to discover that.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE mig_dup_inbound ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY tenant_id, provider_message_id
      ORDER BY created_at, id
    ) AS rank
  FROM messages
  WHERE direction = 'inbound' AND provider_message_id IS NOT NULL
)
SELECT id FROM ranked WHERE rank > 1;

DELETE FROM message_analytics a USING mig_dup_inbound d WHERE a.message_id = d.id;
DELETE FROM messages m USING mig_dup_inbound d WHERE m.id = d.id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The constraint.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS messages_inbound_provider_id_unique
  ON messages (tenant_id, provider_message_id)
  WHERE direction = 'inbound' AND provider_message_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Deterministic inbound tenant attribution.
--
-- `resolveDestination` unions agent_channel_configs and tenant_channel_configs
-- and takes `LIMIT 1` with no ORDER BY, which in Postgres is whichever row the
-- plan happens to yield first — it can differ between two executions of the
-- same query. For a phone number reassigned from one agent to another, or
-- present at both the agent and tenant level, the inbound reply was attributed
-- to a tenant chosen by the planner.
--
-- The query is ordered and filtered on is_active now (see receipt.service.ts).
-- These indexes are what keep it cheap, and what make "who owns this number?"
-- answerable without a sequential scan of both tables per inbound message.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agent_configs_twilio_number
  ON agent_channel_configs (twilio_phone_number)
  WHERE twilio_phone_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_configs_email_from
  ON agent_channel_configs (email_from_address)
  WHERE email_from_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_configs_twilio_number
  ON tenant_channel_configs (twilio_phone_number)
  WHERE twilio_phone_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_configs_sendgrid_from
  ON tenant_channel_configs (sendgrid_from_email)
  WHERE sendgrid_from_email IS NOT NULL;

COMMIT;
