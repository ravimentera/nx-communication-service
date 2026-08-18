# Migrations — operator contract

Migrations in this directory are **NEVER** run by tooling or by an agent.
No `drizzle-kit push`. No `drizzle-kit migrate`. No `psql -f` from a script.

Apply in numeric order. **Get the list from the tooling, not from this page:**

```bash
npm run migrate:print
```

It reads the directory, so it is right the moment a phase adds a file. This
section used to carry the commands by hand, and the hand-written list stopped at
`0012` while the directory reached `0021` — nine migrations an operator
following this page would never have applied. `docs/LOCAL_DEV.md` had already
learned the same lesson and replaced its list with a loop; this is the copy that
was missed.

`npm run migrate:print` also separates the two files that are **not** baseline,
with a reason and an instruction for each — see below.

Each file is idempotent (`IF NOT EXISTS` / guarded `DO` blocks) and wrapped in a
transaction, so applying the whole set again after a later phase adds a file is
safe and is the intended workflow.

> **Idempotent is not an upgrade path.** Because the baseline is
> `CREATE TABLE IF NOT EXISTS`, re-running it does **not** apply a change made
> by *editing* an earlier file — that lands only on databases created
> afterwards. `0014` exists for exactly one such change. To check any database
> against a clean build, apply the baseline to a throwaway database and diff the
> two schemas (`testing/TEST_PLAN.md` §0.4).

| File | Creates |
|---|---|
| `0001_core_schema.sql` | tenancy, recipients, content, messaging, campaigns |
| `0002_approvals.sql` | `approval_policies`, `approvals`; links `messages` ↔ `approvals` |
| `0003_playbooks.sql` | `packs`, `tenant_packs`, `playbooks`, `playbook_triggers`; links everything that points at a playbook |
| `0005_compliance.sql` | `messages.suppression_reason` and the gate's three indexes |
| `0006_approval_policies.sql` | the two baseline approval policies, and their uniqueness indexes |
| `0007_playbook_runs.sql` | `playbook_runs` and the partial idempotency index that stops a redelivered event sending twice |
| `0008_receipt_integrity.sql` | One analytics row per message, and the index a provider callback's tenant-less lookup can actually use. **Apply before wiring any provider webhook** — without it every receipt inserts a duplicate analytics row, which duplicates that message in every list. Deduplicates existing rows first; a no-op on a database that has never taken a receipt. |
| `0009_campaigns.sql` | `campaign_recipients.message_id` and `import_errors`. Every other campaign table has existed since `0001`. |
| `0010_recipient_optins.sql` | The five display-only opt-in flags on `recipient_preferences`. **Apply before `9006_preferences.sql`**, which loads them. Adds columns only; no index, nothing reads them for consent. |
| `0011_platform_tenant.sql` | The `platform` tenant, for identity-level mail that belongs to no medspa — email verification and password reset. Refuses to run if a migrated medspa already holds the id. Set `OUTREACH_PLATFORM_TENANT_ID=platform` in providers-service after applying. |
| `0012_deferred_messages.sql` | `messages.deferred_until` and the partial index the deferral sweeper runs on. Without it, a message the compliance gate held for quiet hours or a rate limit is never retried. Catalogue-only `ADD COLUMN`; no table rewrite. |
| `0015_consent.sql` | `UNIQUE (tenant_id, recipient_id, channel)` on `consent_records`. The table shipped in `0001` with no writer; P13 added one, and the moment rows can be written the missing constraint becomes load-bearing. |
| `0016_playbook_context_mapping.sql` | Lets a playbook declare how a caller's field names map onto its `dataContract`. `aliases.json` rewrites names inside a template body and cannot touch the render context's keys, so a contract expecting a different name than the caller sends failed validation with no way to reconcile the two. |
| `0017_receipt_idempotency.sql` | Makes `(tenant_id, provider_message_id)` unique. Twilio retries any callback it does not get a 2xx for and its payload carries no timestamp, so — unlike SendGrid and Slack — nothing at the signature layer rejects a replay, and every retry inserted another inbound message. |
| `0018_playbook_run_reservation.sql` | Turns a playbook run into a reservation taken *before* the send rather than a record written after. The old shape was check-then-act with the whole fan-out in the gap, so two concurrent deliveries of one event both sent. |
| `0019_campaign_recipient_uniqueness.sql` | A recipient appears in a campaign once. `expand()` deduped by reading then inserting the difference, so two concurrent launches both read nothing and both inserted the whole audience — and every duplicated row is a second message to a real person. |
| `0020_webhook_credentials.sql` | Moves the webhook signing secret into `tenant_channel_configs`, where every other channel's credentials live. It used to come off the message, which put it in a BullMQ job payload sitting in Redis in plaintext for the queue's retention window. |
| `0021_twilio_account_uniqueness.sql` | `UNIQUE (twilio_account_sid)`. An inbound Twilio callback resolves to a tenant by `AccountSid` with `LIMIT 1` and no `ORDER BY`, and nothing stopped two rows carrying the same SID. A reseller running several tenants off one Twilio account cannot be configured — see the open items. |

## The two files that are not baseline

Both are excluded from the loop `npm run migrate:print` produces, **for
opposite reasons**. They are listed separately there, with the reasoning, for
the same reason they are separated here.

| File | When |
|---|---|
| `0013_encrypt_credentials.sql` | **Inside the cutover window only.** Retires the plaintext credential columns once `credentials_encrypted` holds the same values sealed. It must run *after* the data load — applying it before `9003_channel_configs.sql` has inserted anything seals credentials that do not exist yet and every send fails. Needs `CREDENTIAL_ENCRYPTION_KEYS`. Runbook §8b. |
| `0014_drop_queued_message.sql` | **Any time, and required if the database predates P12.** Every statement is `IF EXISTS`. It is a genuine no-op against the current `0001` — which is exactly why re-running the baseline will not do its job for you: `0001` is `CREATE TABLE IF NOT EXISTS` and cannot drop a column a *previous* `0001` created. Check with `SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='queued_message'`; a row back means apply it. |

**There is no `0004`.** Everything it was scheduled to create already exists in
`0001`, so the content plane shipped no migration. The number is left unused
rather than reassigned, so the file names keep matching the plan's phase map.

The order matters: `0002` and `0003` add foreign keys whose *other* side was
created in an earlier file. Applying `0003` before `0002` fails on a missing
`approval_policies`, and `0006` seeds rows into a table `0002` creates.

## The `9xxx` series — one-shot data migration from mentera-core

**Read `docs/MIGRATION_RUNBOOK.md` before running any of them.** They need a
source database linked, they take operator decisions along the way, and several
of them are long-running.

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9000_prelude.sql
… fill in mig.settings (runbook §3) …
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9001_source_link.sql
… 9002 … 9009, in order …
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/9010_verify.sql
```

| File | Loads |
|---|---|
| `9000_prelude.sql` | the `mig` schema: settings, watermarks, quarantine, log, helper functions |
| `9001_source_link.sql` | postgres_fdw server + `src` schema, read-only, plus the source's baseline row counts |
| `9002_tenants.sql` | `tenants`, `sub_tenants` |
| `9003_channel_configs.sql` | `tenant_channel_configs`, `agent_channel_configs` |
| `9004_recipients.sql` | `recipients` (§0.5 Seam C) |
| `9005_templates.sql` | `templates`, `template_versions` — **ids preserved** (§0.5 Seam A) |
| `9006_preferences.sql` | `recipient_preferences` (§0.5 Seam B) |
| `9007_events.sql` | batches, events, notifications, schedules, ai interactions, memories, campaigns |
| `9008_messages.sql` | `messages`, `message_analytics` — chunked and resumable |
| `9009_approvals.sql` | `approvals`, both storage shapes, plus the historic-backlog decision |
| `9010_verify.sql` | `mig.verify()` — the PASS/FAIL table. Do not cut over on a FAIL. |

Also: `scripts/inspect-source.sql` (run first, against the **source**),
`scripts/delta-sync.sql` (during the parallel run) and `scripts/csv-staging.sql`
(the transport of last resort).

**Numeric order is dependency order, and it differs from the plan's sketch.**
`messages.event_id` and `messages.notification_id` are real foreign keys, so
events and notifications have to load before messages — which moved messages
from 9006 to 9008 and approvals from 9007 to 9009. Running the files in numeric
order is therefore always correct. **There is no pack migration at any number:**
§0.5 Seam D is closed, nothing migrates from the seven ghost tables, and 9009 is
the approvals backfill (D70).

Unlike the schema series, these are **not** wrapped in a single transaction. The
chunked loaders commit once per month of history, which is what lets an
interrupted run keep what it finished and restart from its watermark. Every
insert is `ON CONFLICT DO NOTHING`, so re-running any of them is safe.

**Nothing in the series writes to the source.** The foreign server is declared
`updatable 'false'`, the connecting role should be read-only, and
`tests/integration/migration.test.ts` greps every file for a write against
`src.*` on each CI run. That is what makes the rollback "drop the target
database".

To see the exact ordered command list for whatever is currently in this
directory:

```
npm run migrate:print
```

## Numbering

| Range | Meaning |
|---|---|
| `0001`–`0999` | Schema. Idempotent, forward-only, safe to re-run. Applied by the integration tests to a throwaway container. |
| `9000`–`9999` | One-shot data migration from mentera-core. Run in order, per the runbook. Safe to re-run; only `migration.test.ts` applies them in tests. |

Tests that apply migrations filter on `/^0\d{3}_/`. The `9xxx` files need a
linked source database and create scaffolding outside `public`, so a harness
that swept the whole directory would fail on the first one.

Numbering restarts at `0001` in this repo. It does **not** continue the source
service's `0000`–`0005` series.

## These files are written by hand

There is no generator. `drizzle-kit generate` does not work in this repo
(verified with 0.30.6): it bundles the schema through esbuild in CJS mode and
resolves relative imports literally, so the `.js` extensions NodeNext ESM
requires resolve to files that do not exist. See the comment in
`drizzle.config.ts`.

What keeps the SQL and the Drizzle model in agreement is
`tests/integration/schema.test.ts`. It starts a throwaway Postgres in Docker,
applies every file in this directory to it, and asserts in both directions —
every Drizzle table and column exists in the database, and every database table
and column exists in the model. Adding a column to one without the other fails
the build.

That test is not a violation of the "never run a migration" rule: the container
is created empty, destroyed at the end, and never has a route to a database
holding data.
