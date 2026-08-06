# Migrations — operator contract

Migrations in this directory are **NEVER** run by tooling or by an agent.
No `drizzle-kit push`. No `drizzle-kit migrate`. No `psql -f` from a script.

Apply in numeric order:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_core_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0002_approvals.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0003_playbooks.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0005_compliance.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0006_approval_policies.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0007_playbook_runs.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0008_receipt_integrity.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0009_campaigns.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0010_recipient_optins.sql
```

Each file is idempotent (`IF NOT EXISTS` / guarded `DO` blocks) and wrapped in a
transaction.

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
