# Migrations — operator contract

Migrations in this directory are **NEVER** run by tooling or by an agent.
No `drizzle-kit push`. No `drizzle-kit migrate`. No `psql -f` from a script.

Apply in numeric order:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_core_schema.sql
```

Each file is idempotent (`IF NOT EXISTS` / guarded `DO` blocks) and wrapped in a
transaction.

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

## What `drizzle-kit generate` is for

`npm run db:generate` emits SQL from `src/db/schema.ts` for **review**. Treat its
output as a draft: rename it into the numbered scheme, make it idempotent, add the
comments explaining any deliberate divergence, and commit the hand-edited file.
