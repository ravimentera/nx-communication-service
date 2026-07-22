# Migrations — operator contract

Migrations in this directory are **NEVER** run by tooling or by an agent.
No `drizzle-kit push`. No `drizzle-kit migrate`. No `psql -f` from a script.

Apply in numeric order:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_core_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0002_approvals.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0003_playbooks.sql
```

Each file is idempotent (`IF NOT EXISTS` / guarded `DO` blocks) and wrapped in a
transaction.

| File | Creates |
|---|---|
| `0001_core_schema.sql` | tenancy, recipients, content, messaging, campaigns, medspa pack tables |
| `0002_approvals.sql` | `approval_policies`, `approvals`; links `messages` ↔ `approvals` |
| `0003_playbooks.sql` | `packs`, `tenant_packs`, `playbooks`, `playbook_triggers`; links everything that points at a playbook |

The order matters: `0002` and `0003` add foreign keys whose *other* side was
created in an earlier file. Applying `0003` before `0002` fails on a missing
`approval_policies`.

The `9xxx` series are one-shot data migrations from the mentera-core database —
read `docs/MIGRATION_RUNBOOK.md` before running any of them.

To see the exact ordered command list for whatever is currently in this
directory:

```
npm run migrate:print
```

## Numbering

| Range | Meaning |
|---|---|
| `0001`–`0999` | Schema. Idempotent, forward-only, safe to re-run. |
| `9001`–`9999` | One-shot data migration from mentera-core. Run once, in order, per the runbook. |

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
