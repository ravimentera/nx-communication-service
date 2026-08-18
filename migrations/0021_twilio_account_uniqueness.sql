-- =============================================================================
-- 0021 — one tenant owns a Twilio account
--
-- `getTenantConfigByTwilioAccount()` resolves an inbound Twilio callback to a
-- tenant by `AccountSid`, with `LIMIT 1` and no ORDER BY. Nothing stopped two
-- rows carrying the same SID, so the answer was whichever row the planner
-- returned — not stable between two executions of the same query.
--
-- THE ROUTING BUG IS THE SMALLER HALF. `twilio_account_sid` is settable through
-- `PUT /v1/channels/config`, which a tenant may call for itself. So tenant B
-- could enter tenant A's Account SID and start being resolved as the owner of
-- A's callbacks. `0017` already scopes the receipt lookup to the verified
-- tenant, which turns that from a cross-tenant WRITE into a routing failure —
-- but a failure that silently drops A's delivery receipts is still A's problem
-- caused by B.
--
-- Ownership cannot be verified against Twilio from here. First-registrant-wins
-- is the honest approximation, and a constraint is what makes it true.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS COSTS, STATED PLAINLY
--
-- An agency or reseller running several tenants off ONE Twilio account, each
-- with its own phone number, is now impossible to configure. That is a real
-- model and this forbids it.
--
-- It is the right trade here and it should be revisited when it stops being:
-- the deployment has one tenant, the interception risk is concrete, and the
-- agency case is hypothetical. The proper fix when it arrives is to resolve the
-- callback's tenant by the message's `To` number — which `resolveDestination`
-- already does for inbound — rather than by the account, and to keep the SID
-- only for finding the auth token. Recorded in D108 rather than left implied.
--
-- -----------------------------------------------------------------------------
-- PARTIAL, on two conditions:
--
--   twilio_account_sid IS NOT NULL   most tenants configure no Twilio at all,
--                                    and NULLs are distinct anyway — saying so
--                                    keeps the index small and the intent legible
--   is_active                        a deactivated config has released its claim.
--                                    Without this, retiring a tenant would block
--                                    the account being reassigned for ever.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Report any existing duplicate rather than silently resolving it.
--
-- Unlike the dedupes in 0015/0017/0019, this one cannot pick a winner: both
-- rows are somebody's live credential, and choosing between them by timestamp
-- would take a working configuration away from one tenant without telling
-- anybody. An operator has to decide.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  dup record;
  found boolean := false;
BEGIN
  FOR dup IN
    SELECT twilio_account_sid, count(*) AS n, array_agg(tenant_id ORDER BY tenant_id) AS tenants
    FROM tenant_channel_configs
    WHERE twilio_account_sid IS NOT NULL AND is_active
    GROUP BY twilio_account_sid
    HAVING count(*) > 1
  LOOP
    found := true;
    RAISE WARNING
      'Twilio account % is claimed by % tenants: %. Inbound callbacks for it resolve nondeterministically today.',
      dup.twilio_account_sid, dup.n, dup.tenants;
  END LOOP;

  IF found THEN
    RAISE EXCEPTION
      'Two or more tenants share a Twilio Account SID (listed above). Decide which tenant owns each account and clear twilio_account_sid on the others, then re-run this migration. See docs/MIGRATION_RUNBOOK.md.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The constraint.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS tenant_channel_configs_twilio_account_unique
  ON tenant_channel_configs (twilio_account_sid)
  WHERE twilio_account_sid IS NOT NULL AND is_active;

COMMIT;
