-- =============================================================================
-- 0020 — webhook credentials live where every other channel's do
--
-- The webhook adapter took its signing secret from `msg.metadata.secret` —
-- which means the caller put it in the message, and the message becomes a
-- BullMQ job payload sitting in Redis in plaintext for the queue's retention
-- window (24h completed, 7d failed). Every other channel resolves its
-- credentials through `CredentialResolver` from `tenant_channel_configs`, which
-- 0013 seals at rest.
--
-- `webhook_signing_secret` closes that. `webhook_allowed_hosts` is the other
-- half of the same problem: the adapter accepted any http/https URL and
-- `POST /v1/channels/test` lets an authenticated tenant user name one, so the
-- service would fetch cloud instance metadata or any internal address on
-- request. `src/adapters/channels/url-guard.ts` blocks the private ranges by
-- default; this column is how a tenant narrows it to the hosts it actually uses,
-- which is the only complete answer.
--
-- NULL allow-list means "the default deny-private rules apply", which is what
-- every existing row gets and is strictly safer than what it had.
-- =============================================================================

BEGIN;

ALTER TABLE tenant_channel_configs
  ADD COLUMN IF NOT EXISTS webhook_signing_secret text,
  ADD COLUMN IF NOT EXISTS webhook_allowed_hosts  text[];

COMMENT ON COLUMN tenant_channel_configs.webhook_signing_secret IS
  'HMAC-SHA256 key for outbound webhook signatures. Sealed by 0013 like every other credential; never travels in a message payload.';

COMMENT ON COLUMN tenant_channel_configs.webhook_allowed_hosts IS
  'Suffix-matched host allow-list for outbound webhooks. NULL means the engine default: any public address, no private or link-local ranges.';

COMMIT;
