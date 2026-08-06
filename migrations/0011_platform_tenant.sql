-- =============================================================================
-- 0011_platform_tenant.sql
--
-- One tenant for mail that belongs to no tenant.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0011_platform_tenant.sql
--
-- Requires 0001 (tenants).
--
-- -----------------------------------------------------------------------------
-- WHY: THREE AUTH FLOWS HAVE NO TENANT TO SEND UNDER
--
-- Found in P10, checking the five inbound callers against the engine's auth
-- before the repoint rather than after it.
--
-- `providers-service/src/services/email.service.ts` sends three kinds of mail
-- through `POST /email/send`: email verification, provider invitation, and
-- password reset. Its parameter interfaces — `VerificationEmailParams`,
-- `InviteEmailParams`, `PasswordResetEmailParams` — carry no medspa id, and
-- that is not an oversight. Verification happens at signup, before a medspa
-- exists; password reset is identity recovery and is deliberately answerable
-- without knowing which medspa the address belongs to.
--
-- The engine resolves the tenant from headers and refuses a request without one
-- (`auth.middleware.ts:171`, `requireTenant` at :213). The source service had no
-- such requirement — `template-engine.ts` does not contain the string `medspaId`
-- at all — so these calls have always worked by virtue of nothing checking.
--
-- At the repoint they would have become 401s on the signup and password-reset
-- paths. That is the whole product's front door, and it would have failed on
-- the first request after the env var flip.
--
-- -----------------------------------------------------------------------------
-- WHY A TENANT ROW RATHER THAN AN EXEMPTION
--
-- The alternative was letting `/email/send` accept a tenant-less transactional
-- send. Rejected: hard rule 4 is that every row carries a tenant and no query
-- runs without a tenant predicate, and a `messages` row with a NULL tenant is
-- exactly the hole that rule exists to prevent. It would also be invisible —
-- platform mail would simply not appear in any tenant's analytics.
--
-- A real row costs one INSERT and buys the opposite: platform mail is
-- attributable, has its own quiet-hours and compliance settings, and can be
-- given its own SendGrid credentials in `tenant_channel_configs` later without
-- touching a line of code.
--
-- Provider invitations are NOT sent under this tenant. `settings.service.ts`
-- has the real medspa in scope at both call sites (:675 and :832), so an invite
-- renders and bills against the medspa doing the inviting. Only the two
-- genuinely identity-level flows land here.
--
-- -----------------------------------------------------------------------------
-- THE ID IS 'platform', AND IT IS CHECKED
--
-- `tenants.id` is `text` and 9002 uses the source's `medspa_id` verbatim, so a
-- medspa whose id is literally 'platform' would collide. This file runs before
-- 9002, so the collision would show up as 9002 silently skipping that medspa
-- and its mail going out under the platform tenant.
--
-- The guard below refuses to proceed if a tenant with this id exists that this
-- migration did not create — identified by the marker in `settings`, not by the
-- name, which an operator may reasonably edit. Runbook §2 asks the operator to
-- confirm no source medspa id is 'platform' while they have the list in front
-- of them at reconnaissance.
-- -----------------------------------------------------------------------------

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenants
    WHERE id = 'platform'
      AND COALESCE(settings->>'engineReserved', 'false') <> 'true'
  ) THEN
    RAISE EXCEPTION
      'a tenant with id ''platform'' already exists and was not created by 0011_platform_tenant.sql — it is almost certainly a migrated medspa. Resolve the collision before continuing: platform mail and that medspa''s mail would otherwise share a tenant.';
  END IF;
END $$;

INSERT INTO tenants (id, name, industry, timezone, locale, settings)
VALUES (
  'platform',
  'Platform',
  NULL,
  'UTC',
  'en',
  jsonb_build_object(
    'engineReserved', 'true',
    'purpose', 'Identity-level mail that belongs to no tenant: email verification and password reset. See 0011_platform_tenant.sql.'
  )
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- -----------------------------------------------------------------------------
-- AFTER APPLYING
--
-- Set the id in providers-service's environment so it stops guessing:
--
--   OUTREACH_PLATFORM_TENANT_ID=platform
--
-- VERIFY
--
--   -- must return exactly one row, marked reserved
--   SELECT id, name, settings->>'engineReserved'
--   FROM tenants WHERE id = 'platform';
-- -----------------------------------------------------------------------------
