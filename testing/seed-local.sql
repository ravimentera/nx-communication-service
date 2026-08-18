-- =============================================================================
-- seed-local.sql — fixtures for manual/local testing
--
-- NOT A MIGRATION. It lives in `testing/`, not `migrations/`, on purpose:
-- nothing here is schema, nothing here ships, and the numbered series must stay
-- readable as "the schema, in order". Applying it is a testing action, not a
-- deploy step.
--
-- Apply with:
--   docker compose exec -T postgres psql -U outreach -d outreach \
--     -v ON_ERROR_STOP=1 -f /testing/seed-local.sql
--
-- (requires the `./testing` bind mount added to docker-compose.yml; without it,
--  pipe the file in:  docker compose exec -T postgres psql -U outreach \
--    -d outreach -v ON_ERROR_STOP=1 < testing/seed-local.sql)
--
-- Requires migrations 0001–0021 (minus 0013) to have been applied.
--
-- -----------------------------------------------------------------------------
-- WHY FIXED UUIDs
--
-- Every id below is a literal, not `gen_random_uuid()`. A Postman collection
-- built on generated ids has to create-then-capture before it can read, which
-- means one failing request cascades into every request after it and the
-- collection can only be run in order, from the top. Literal ids make each
-- request independently runnable — the property that makes a collection useful
-- for *manual* testing, which is what this is for.
--
-- The prefixes are legible on sight: `...aaa1` is tenant A's first recipient,
-- `...bbb1` is tenant B's. When a response carries an id you did not expect,
-- you can tell whose it is without a lookup.
--
-- -----------------------------------------------------------------------------
-- WHY TWO TENANTS
--
-- Hard rule 4 of the extraction plan is that every table carries `tenant_id` and
-- no query runs without a tenant predicate, and `docs/api/BREAKING.md` lists
-- cross-tenant tightening as the most consequential change in the whole
-- extraction (Seam A: the source's entire `/templates` router had no tenant
-- predicate at all — a cross-tenant DELETE cascaded into `template_versions`).
--
-- A single-tenant seed cannot test any of that. `t-beta` exists so that every
-- isolation claim is falsifiable: read tenant A's recipient with tenant B's
-- header and you must get a 404, not a row.
--
-- -----------------------------------------------------------------------------
-- IDEMPOTENT
--
-- Every statement is ON CONFLICT DO UPDATE or guarded. Re-run it as often as
-- you like; it converges rather than erroring or duplicating. Re-running is the
-- intended way to reset fixture state after a test run has mutated it.
-- =============================================================================

BEGIN;

-- ── tenants ──────────────────────────────────────────────────────────────────
--
-- `t-alpha` is the medspa-style tenant used for the happy path.
-- `t-beta` exists to be the *other* tenant in every isolation test.
-- `t-gdpr` carries a compliance profile, because the GDPR endpoints
-- (`/v1/recipients/:id/erase`, `/export`) 403 unless the tenant has
-- `{"gdpr": true}` — with `{}` everywhere, as ships today, those two endpoints
-- are untestable. See BREAKING.md, "API keys, usage and GDPR".
--
-- Timezones differ deliberately. `{{formatDate}}` resolves timezone from the
-- recipient first, then the tenant — never the server — and a seed where every
-- row is UTC cannot show the difference between a correct render and a pod
-- rendering in its own zone.

INSERT INTO tenants (id, name, industry, timezone, locale, compliance_profile, settings, is_active)
VALUES
  ('t-alpha', 'Alpha Aesthetics',   'medspa',    'America/New_York',    'en', '{}'::jsonb,
   '{"style": {"tone": "warm and professional"}}'::jsonb, true),
  ('t-beta',  'Beta Wellness',      'medspa',    'America/Los_Angeles', 'en', '{}'::jsonb,
   '{}'::jsonb, true),
  ('t-gdpr',  'Gamma Clinic (EU)',  'medspa',    'Europe/Berlin',       'de',
   '{"gdpr": true, "hipaa": true}'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      industry = EXCLUDED.industry,
      timezone = EXCLUDED.timezone,
      locale = EXCLUDED.locale,
      compliance_profile = EXCLUDED.compliance_profile,
      settings = EXCLUDED.settings,
      is_active = EXCLUDED.is_active,
      updated_at = now();

-- ── sub-tenants (locations) ──────────────────────────────────────────────────
--
-- `x-sub-tenant-id` narrows scope below the tenant. Two under alpha, so a
-- sub-tenant-scoped read can be shown to exclude the sibling rather than just
-- "return something".

INSERT INTO sub_tenants (id, tenant_id, name, timezone, external_ref, is_active)
VALUES
  ('5b000000-0000-4000-8000-000000000001', 't-alpha', 'Alpha — Downtown', 'America/New_York',
   '{"system": "mentera", "id": "loc-downtown"}'::jsonb, true),
  ('5b000000-0000-4000-8000-000000000002', 't-alpha', 'Alpha — Uptown',   'America/Chicago',
   '{"system": "mentera", "id": "loc-uptown"}'::jsonb, true),
  ('5b000000-0000-4000-8000-000000000003', 't-beta',  'Beta — Main',      'America/Los_Angeles',
   '{"system": "mentera", "id": "loc-main"}'::jsonb, true)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, updated_at = now();

-- ── channel configuration ────────────────────────────────────────────────────
--
-- `tenant_channel_configs` has UNIQUE(tenant_id) — one row per tenant, which is
-- why `POST /config/medspa` twice is a 201 upsert rather than the source's 409
-- (BREAKING.md, "Shape and semantics").
--
-- CREDENTIALS ARE DELIBERATELY FAKE AND THE CHANNELS ARE DELIBERATELY ENABLED.
-- With `CHANNEL_DRY_RUN=true` (the default in `.env.example`) the adapters log
-- instead of dialling out, so a fake SID exercises the whole resolve → render →
-- gate → dispatch path and stops at the wire. Turning DRY_RUN off with these
-- values in place fails at the provider, which is the correct and safe failure.
--
-- The Twilio SID differs per tenant on purpose: 0021 added
-- UNIQUE(twilio_account_sid) because a Twilio account belongs to exactly one
-- tenant, and reusing one value here would make the seed fail on that
-- constraint — which is itself worth seeing once.
--
-- KEEP THEM STRUCTURALLY INVALID, not merely wrong. A real Twilio SID is
-- `AC` + 32 HEX characters, a SendGrid key is `SG.<22>.<43>`, and a Slack bot
-- token is `xoxb-<digits>-<digits>-<alnum>`. None of the values below can match
-- those shapes — they carry the tenant's name where the entropy would be — so a
-- secret scanner has nothing to flag and nobody has to decide whether a
-- committed credential is real. A plausible-looking fake would cost someone an
-- afternoon.
--
-- `require_opt_in` is false for alpha and true for gdpr. D108 changed the
-- default for an *unconfigured* tenant to true; alpha opts out so the happy
-- path sends without a consent record, and t-gdpr keeps it so the consent gate
-- is observable.

INSERT INTO tenant_channel_configs (
  id, tenant_id, name,
  twilio_account_sid, twilio_auth_token, twilio_phone_number, twilio_enabled,
  sendgrid_api_key, sendgrid_from_email, sendgrid_from_name, sendgrid_enabled,
  slack_bot_token, slack_default_channel, slack_enabled,
  timezone, default_language, business_hours_start, business_hours_end, business_days,
  require_opt_in, retention_days, is_active, webhook_allowed_hosts
)
VALUES
  ('c0000000-0000-4000-8000-00000000000a', 't-alpha', 'Alpha Aesthetics',
   'ACalpha0000000000000000000000001', 'fake-auth-token-alpha', '+15550100', true,
   'SG.fake-alpha-key', 'hello@alpha.example', 'Alpha Aesthetics', true,
   'xoxb-fake-alpha', '#alpha-alerts', true,
   'America/New_York', 'en', '09:00', '18:00', ARRAY['MON','TUE','WED','THU','FRI'],
   false, 365, true, ARRAY['example.com']),
  ('c0000000-0000-4000-8000-00000000000b', 't-beta', 'Beta Wellness',
   'ACbeta00000000000000000000000001', 'fake-auth-token-beta', '+15550200', true,
   'SG.fake-beta-key', 'hello@beta.example', 'Beta Wellness', true,
   NULL, NULL, false,
   'America/Los_Angeles', 'en', '08:00', '17:00', ARRAY['MON','TUE','WED','THU','FRI'],
   false, 365, true, NULL),
  ('c0000000-0000-4000-8000-00000000000c', 't-gdpr', 'Gamma Clinic (EU)',
   'ACgdpr00000000000000000000000001', 'fake-auth-token-gdpr', '+4930000000', true,
   'SG.fake-gdpr-key', 'hallo@gamma.example', 'Gamma Clinic', true,
   NULL, NULL, false,
   'Europe/Berlin', 'de', '09:00', '17:00', ARRAY['MON','TUE','WED','THU','FRI'],
   true, 90, true, NULL)
-- EVERY seeded column is restored, not just the interesting ones.
--
-- This is the difference between "the seed converges" and "the seed is a
-- RESET", and the gap is not theoretical: the Postman collection contains
-- `POST /config/medspa` and `POST /v1/channels/configs`, both of which upsert
-- this row. Running the collection therefore overwrites the fixture with
-- whatever example values those requests carry — including `is_active`, which
-- landed false and made every subsequent send fail 503 CHANNEL_NOT_CONFIGURED
-- for a reason that looked like a credential-resolution bug and was not.
--
-- A partial ON CONFLICT leaves the row in a state that is neither the fixture
-- nor the collection's, which is the worst of the three.
ON CONFLICT (tenant_id) DO UPDATE
  SET name = EXCLUDED.name,
      twilio_account_sid = EXCLUDED.twilio_account_sid,
      twilio_auth_token = EXCLUDED.twilio_auth_token,
      twilio_phone_number = EXCLUDED.twilio_phone_number,
      twilio_enabled = EXCLUDED.twilio_enabled,
      sendgrid_api_key = EXCLUDED.sendgrid_api_key,
      sendgrid_from_email = EXCLUDED.sendgrid_from_email,
      sendgrid_from_name = EXCLUDED.sendgrid_from_name,
      sendgrid_enabled = EXCLUDED.sendgrid_enabled,
      slack_bot_token = EXCLUDED.slack_bot_token,
      slack_default_channel = EXCLUDED.slack_default_channel,
      slack_enabled = EXCLUDED.slack_enabled,
      timezone = EXCLUDED.timezone,
      default_language = EXCLUDED.default_language,
      business_hours_start = EXCLUDED.business_hours_start,
      business_hours_end = EXCLUDED.business_hours_end,
      business_days = EXCLUDED.business_days,
      require_opt_in = EXCLUDED.require_opt_in,
      retention_days = EXCLUDED.retention_days,
      is_active = EXCLUDED.is_active,
      webhook_allowed_hosts = EXCLUDED.webhook_allowed_hosts,
      updated_at = now();

-- ── recipients ───────────────────────────────────────────────────────────────
--
-- Chosen to cover the branches the compliance gate and the dispatcher take,
-- not to look like a customer list. Each one exists to make a specific
-- assertion possible:
--
--   aaa1  happy path        both channels, active, consented
--   aaa2  email only        no phone → an SMS send must fail on *no contact
--                           point*, not on a provider error
--   aaa3  unsubscribed      status='unsubscribed' → suppressed regardless of
--                           channel or priority
--   aaa4  quiet hours       Asia/Tokyo, so "now" in the recipient's zone is
--                           reliably outside a US business-hours window —
--                           marketing defers, transactional does not
--   aaa5  external ref      carries external_ref, for
--                           GET /v1/recipients/by-external-ref/:system/:id/preferences
--                           (the one v1 route patient-service already calls)
--   bbb1  other tenant      the target of every cross-tenant negative test
--   ggg1  gdpr tenant       the subject for erase/export
--
-- TWO NAMING TRAPS IN ONE FIELD, BOTH WORTH STATING:
--
--   1. The key is `type`, not `kind` — matching the Zod schema at
--      `api/v1/recipients.ts:56`. `kind` is the word used for approver
--      resolution three files away.
--
--   2. The SMS contact point's type is **`phone`**, not `sms`. The channel is
--      called `sms` and the contact point is called `phone`, and every call
--      site maps between them explicitly (`channels.ts:224`,
--      `communications.ts:307`, `mcp/index.ts:404`); the canonical list is the
--      comment at `db/schema/recipients.ts:38`.
--
-- Either mistake produces a recipient with no usable address, and the resulting
-- failure names the channel rather than the contact point — "No phone contact
-- point for this recipient" on a row that visibly has one. This seed had it
-- wrong until the bootstrap script tried to generate an SMS draft.

INSERT INTO recipients (id, tenant_id, sub_tenant_id, display_name, first_name, last_name,
                        timezone, locale, contact_points, external_ref, status, attributes)
VALUES
  ('11111111-0000-4000-8000-00000000aaa1', 't-alpha', '5b000000-0000-4000-8000-000000000001',
   'Ada Lovelace', 'Ada', 'Lovelace', 'America/New_York', 'en',
   '[{"type":"email","value":"ada@example.com","verified":true,"primary":true},
     {"type":"phone","value":"+15551110001","verified":true,"primary":true}]'::jsonb,
   '{"system":"mentera-patient","id":"pat-ada"}'::jsonb, 'active',
   '{"segment":"vip","lastTreatment":"hydrafacial"}'::jsonb),

  ('11111111-0000-4000-8000-00000000aaa2', 't-alpha', '5b000000-0000-4000-8000-000000000001',
   'Grace Hopper', 'Grace', 'Hopper', 'America/New_York', 'en',
   '[{"type":"email","value":"grace@example.com","verified":true,"primary":true}]'::jsonb,
   '{"system":"mentera-patient","id":"pat-grace"}'::jsonb, 'active',
   '{"segment":"standard"}'::jsonb),

  ('11111111-0000-4000-8000-00000000aaa3', 't-alpha', '5b000000-0000-4000-8000-000000000002',
   'Alan Turing', 'Alan', 'Turing', 'America/Chicago', 'en',
   '[{"type":"email","value":"alan@example.com","verified":true,"primary":true},
     {"type":"phone","value":"+15551110003","verified":true,"primary":true}]'::jsonb,
   '{"system":"mentera-patient","id":"pat-alan"}'::jsonb, 'unsubscribed',
   '{"segment":"lapsed"}'::jsonb),

  ('11111111-0000-4000-8000-00000000aaa4', 't-alpha', '5b000000-0000-4000-8000-000000000002',
   'Kiyoshi Ito', 'Kiyoshi', 'Ito', 'Asia/Tokyo', 'ja',
   '[{"type":"email","value":"kiyoshi@example.com","verified":true,"primary":true},
     {"type":"phone","value":"+815500000004","verified":true,"primary":true}]'::jsonb,
   '{"system":"mentera-patient","id":"pat-kiyoshi"}'::jsonb, 'active',
   '{"segment":"standard"}'::jsonb),

  ('11111111-0000-4000-8000-00000000aaa5', 't-alpha', NULL,
   'Rosalind Franklin', 'Rosalind', 'Franklin', 'America/New_York', 'en',
   '[{"type":"email","value":"rosalind@example.com","verified":true,"primary":true}]'::jsonb,
   '{"system":"mentera-patient","id":"pat-external-9001"}'::jsonb, 'active',
   '{"segment":"new"}'::jsonb),

  ('22222222-0000-4000-8000-00000000bbb1', 't-beta', '5b000000-0000-4000-8000-000000000003',
   'Barbara McClintock', 'Barbara', 'McClintock', 'America/Los_Angeles', 'en',
   '[{"type":"email","value":"barbara@example.com","verified":true,"primary":true},
     {"type":"phone","value":"+15552220001","verified":true,"primary":true}]'::jsonb,
   '{"system":"mentera-patient","id":"pat-barbara"}'::jsonb, 'active',
   '{"segment":"vip"}'::jsonb),

  ('33333333-0000-4000-8000-00000000dd01', 't-gdpr', NULL,
   'Emmy Noether', 'Emmy', 'Noether', 'Europe/Berlin', 'de',
   '[{"type":"email","value":"emmy@example.de","verified":true,"primary":true},
     {"type":"phone","value":"+4915100000001","verified":true,"primary":true}]'::jsonb,
   '{"system":"mentera-patient","id":"pat-emmy"}'::jsonb, 'active',
   '{"segment":"standard"}'::jsonb)
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      contact_points = EXCLUDED.contact_points,
      -- external_ref MUST be in this list. Leaving it out meant a seed that had
      -- written the wrong `system` could never correct it: the row already
      -- existed, so every re-run updated the other columns and left the bad ref
      -- in place. Every seeded column belongs here, for the same reason the
      -- channel-config upsert above lists all of its own.
      external_ref = EXCLUDED.external_ref,
      status = EXCLUDED.status,
      attributes = EXCLUDED.attributes,
      timezone = EXCLUDED.timezone,
      locale = EXCLUDED.locale,
      sub_tenant_id = EXCLUDED.sub_tenant_id,
      updated_at = now();

-- ── preferences ──────────────────────────────────────────────────────────────
--
-- `unsubscribe_token` is fixed so `GET /unsubscribe/:token` is directly
-- callable. That route is mounted BEFORE the auth middleware in `app.ts` — it
-- arrives from an email client with no gateway headers — so it is the one path
-- in the service you test with no headers at all.
--
-- The five `*_opt_in` booleans are stored and returned but **not enforced**
-- (D85, BREAKING.md): `PUT` ignores them and no send is gated on them.
-- `allow_communications` and `preferred_channels` are what actually gate a
-- send. aaa3 has allow_communications=false so the two mechanisms can be told
-- apart — a suppression there is preference, not the `unsubscribed` status.

INSERT INTO recipient_preferences (
  id, tenant_id, recipient_id, allow_communications, preferred_channels,
  preferred_language, preferred_frequency, quiet_hours_start, quiet_hours_end,
  quiet_hours_timezone, event_opt_outs, unsubscribe_token,
  email_opt_in, sms_opt_in, push_opt_in, voice_opt_in, direct_mail_opt_in
)
VALUES
  ('a1000000-0000-4000-8000-00000000aaa1', 't-alpha', '11111111-0000-4000-8000-00000000aaa1',
   true, ARRAY['email','sms'], 'en', 'MODERATE', NULL, NULL, NULL, '{}',
   'unsub-token-ada-0001', true, true, true, true, true),

  ('a1000000-0000-4000-8000-00000000aaa2', 't-alpha', '11111111-0000-4000-8000-00000000aaa2',
   true, ARRAY['email'], 'en', 'LOW', NULL, NULL, NULL, ARRAY['APPOINTMENT_REMINDER'],
   'unsub-token-grace-0002', true, false, true, true, true),

  ('a1000000-0000-4000-8000-00000000aaa3', 't-alpha', '11111111-0000-4000-8000-00000000aaa3',
   false, ARRAY[]::text[], 'en', 'LOW', NULL, NULL, NULL, '{}',
   'unsub-token-alan-0003', false, false, false, false, false),

  ('a1000000-0000-4000-8000-00000000aaa4', 't-alpha', '11111111-0000-4000-8000-00000000aaa4',
   true, ARRAY['email','sms'], 'ja', 'MODERATE', '22:00', '08:00', 'Asia/Tokyo', '{}',
   'unsub-token-kiyoshi-0004', true, true, true, true, true),

  ('a1000000-0000-4000-8000-00000000aaa5', 't-alpha', '11111111-0000-4000-8000-00000000aaa5',
   true, ARRAY['email'], 'en', 'HIGH', NULL, NULL, NULL, '{}',
   'unsub-token-rosalind-0005', true, true, true, true, true),

  ('b1000000-0000-4000-8000-00000000bbb1', 't-beta', '22222222-0000-4000-8000-00000000bbb1',
   true, ARRAY['email','sms'], 'en', 'MODERATE', NULL, NULL, NULL, '{}',
   'unsub-token-barbara-0006', true, true, true, true, true),

  ('d1000000-0000-4000-8000-00000000dd01', 't-gdpr', '33333333-0000-4000-8000-00000000dd01',
   true, ARRAY['email'], 'de', 'MODERATE', NULL, NULL, NULL, '{}',
   'unsub-token-emmy-0007', true, true, true, true, true)
ON CONFLICT (tenant_id, recipient_id) DO UPDATE
  SET allow_communications = EXCLUDED.allow_communications,
      preferred_channels = EXCLUDED.preferred_channels,
      quiet_hours_start = EXCLUDED.quiet_hours_start,
      quiet_hours_end = EXCLUDED.quiet_hours_end,
      quiet_hours_timezone = EXCLUDED.quiet_hours_timezone,
      event_opt_outs = EXCLUDED.event_opt_outs,
      unsubscribe_token = EXCLUDED.unsubscribe_token,
      updated_at = now();

-- ── consent ──────────────────────────────────────────────────────────────────
--
-- `consent_records` is empty in production and the GDPR consent check is in
-- shadow mode because of it (open items, D41): with no records, enforcing would
-- block everything. These rows exist so the check can be turned on locally and
-- observed doing something other than refusing every send.
--
-- Grants for alpha; nothing for `t-gdpr`'s Emmy, deliberately — that tenant has
-- require_opt_in=true and no consent, so it is the negative case.

INSERT INTO consent_records (id, tenant_id, recipient_id, channel, granted, source, proof, granted_at)
VALUES
  ('c1000000-0000-4000-8000-00000000aaa1', 't-alpha', '11111111-0000-4000-8000-00000000aaa1',
   'email', true, 'seed', '{"method":"web-form","ip":"203.0.113.10"}'::jsonb, now()),
  ('c1000000-0000-4000-8000-00000000aaa2', 't-alpha', '11111111-0000-4000-8000-00000000aaa1',
   'sms', true, 'seed', '{"method":"web-form","ip":"203.0.113.10"}'::jsonb, now()),
  ('c1000000-0000-4000-8000-00000000aaa3', 't-alpha', '11111111-0000-4000-8000-00000000aaa2',
   'email', true, 'seed', '{"method":"web-form"}'::jsonb, now()),
  ('c1000000-0000-4000-8000-00000000bbb1', 't-beta', '22222222-0000-4000-8000-00000000bbb1',
   'email', true, 'seed', '{"method":"web-form"}'::jsonb, now())
ON CONFLICT (tenant_id, recipient_id, channel) DO UPDATE
  SET granted = EXCLUDED.granted,
      source = EXCLUDED.source,
      revoked_at = NULL,
      updated_at = now();

COMMIT;

-- ── what landed ──────────────────────────────────────────────────────────────
--
-- RAISE NOTICE rather than psql's `\echo`, deliberately. `\echo` is a psql
-- meta-command, so a file using it can only be run by psql — and
-- `tests/integration/seed.test.ts` applies this file through a plain client to
-- prove it still matches the schema. A fixture that only one client can execute
-- is a fixture that cannot be tested. psql prints notices too, so the operator
-- sees the same thing.
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'seed-local.sql applied. Contents:';
END $$;

SELECT 'tenants'      AS table, count(*) FROM tenants      WHERE id LIKE 't-%'
UNION ALL SELECT 'sub_tenants',            count(*) FROM sub_tenants            WHERE tenant_id LIKE 't-%'
UNION ALL SELECT 'tenant_channel_configs', count(*) FROM tenant_channel_configs WHERE tenant_id LIKE 't-%'
UNION ALL SELECT 'recipients',             count(*) FROM recipients             WHERE tenant_id LIKE 't-%'
UNION ALL SELECT 'recipient_preferences',  count(*) FROM recipient_preferences  WHERE tenant_id LIKE 't-%'
UNION ALL SELECT 'consent_records',        count(*) FROM consent_records        WHERE tenant_id LIKE 't-%';

DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'Packs are NOT seeded here — they install through the API, which';
  RAISE NOTICE 'is the path worth testing. Run testing/seed-packs.sh, or:';
  RAISE NOTICE '  POST /v1/packs/core/install    {}';
  RAISE NOTICE '  POST /v1/packs/medspa/install  {"config": {...}}  <- enforced';
END $$;
