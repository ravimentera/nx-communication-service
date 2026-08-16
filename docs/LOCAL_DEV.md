# Local development environment

Postgres and Redis for this service run in Docker, defined in
[`docker-compose.yml`](../docker-compose.yml). Ports are deliberately shifted so
nothing here can collide with a local Mentera Postgres or Redis.

| | Host | Inside the compose network | Credentials |
|---|---|---|---|
| Postgres 16 | `localhost:5433` | `postgres:5432` | `outreach` / `outreach`, db `outreach` |
| Redis 7 | `localhost:6380` | `redis:6379` | none |

`DATABASE_URL=postgres://outreach:outreach@localhost:5433/outreach`

## First-time setup

```bash
cp .env.example .env
npm ci
npm run db:up
```

`db:up` starts both containers and blocks until their healthchecks pass, then
prints the database state. On a fresh volume that state is **0 tables** — the
schema does not exist until you apply the migrations yourself.

## Applying migrations

**Nothing in this repo applies a migration for you.** Not `drizzle-kit`, not
`db-local.sh`, not an agent (hard rule 1 of `EXTRACTION_PLAN.md`,
`migrations/README.md`). The tooling only ever prints commands:

```bash
npm run migrate:print
```

The host has no `psql` client, so use the one inside the Postgres container.
`./migrations` is mounted read-only at `/migrations` there, so these are the
same files, applied by the same `psql`, in the order the README specifies:

```bash
docker compose exec -T postgres psql -U outreach -d outreach -v ON_ERROR_STOP=1 -f /migrations/0001_core_schema.sql
```

```bash
docker compose exec -T postgres psql -U outreach -d outreach -v ON_ERROR_STOP=1 -f /migrations/0002_approvals.sql
```

```bash
docker compose exec -T postgres psql -U outreach -d outreach -v ON_ERROR_STOP=1 -f /migrations/0003_playbooks.sql
```

Order matters: `0002` and `0003` add foreign keys whose other side is created
earlier. Every file is idempotent and wrapped in a transaction, so re-running
the whole set after a later phase adds a `0004` is safe and is the intended
workflow — apply all of them, every time.

If you would rather use a host `psql` (`brew install libpq`, then add
`$(brew --prefix libpq)/bin` to `PATH`), the commands from `npm run
migrate:print` work as-is against `$DATABASE_URL`.

The `9xxx` series are one-shot data migrations out of the mentera-core
database. They are not part of local setup — read `docs/MIGRATION_RUNBOOK.md`
before running any of them.

## Day-to-day

```bash
npm run db:status     # health, table list with row counts, migrations on disk
npm run db:psql       # interactive psql inside the container
npm run db:down       # stop the containers, keep the data
npm run db:up         # start them again, data intact
npm run db:nuke       # destroy containers AND volume (asks for confirmation)
```

`scripts/db-local.sh` never reads `DATABASE_URL`. It execs into the compose
service by name, so it cannot reach a remote database even when your shell
environment points at one.

After `db:nuke` the volume is gone and the migrations must be re-applied.

## Running the service

```bash
npm run dev
```

Then, in another shell:

```bash
curl -s localhost:5007/health | jq
```

```bash
curl -s localhost:5007/health/detailed | jq
```

`/health` is liveness only — it returns 200 whenever the process is up.
`/health/detailed` pings the real dependencies. Only the database gates
readiness: with Redis stopped it reports `degraded`, still returns 200, and the
platform falls back to the in-memory store (P1 handoff).

Every other path requires the gateway header, exactly as in production:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:5007/anything
```

That is a `403`. To call a real route, send what the gateway sends:

```bash
curl -s localhost:5007/v1/whatever -H 'x-gateway-request: true' -H 'x-tenant-id: demo-tenant' -H 'x-user-id: dev' -H 'x-user-role: ADMIN'
```

`x-tenant-id` and `x-sub-tenant-id` are the only tenancy headers this service
reads. `x-medspa-id` and `x-location-id` were accepted as synonyms through the
extraction and were **dropped in P12** — a request carrying only the medspa
spelling has no tenant and fails, rather than being served against an empty
string. The gateway sends both, so only a direct caller notices.

`x-provider-id` is still accepted as a synonym for `x-sender-id`. That one is a
sender identity rather than the tenancy boundary, and it was left alone.

`CHANNEL_DRY_RUN=true` is set in `.env.example`, so channel adapters log instead
of sending once P3 lands. Leave it on locally.

## Tests

```bash
npm test
```

Integration tests do **not** use the database above. `tests/integration/schema.test.ts`
starts its own throwaway Postgres via testcontainers, applies the migrations to
it, asserts the Drizzle model and the SQL agree, and destroys it. That container
has no route to any database holding data — which is why it is not a violation
of the never-run-a-migration rule, and why the local `outreach` database is
untouched by a test run. Docker must be running for it.

## Seed data

There is none yet, by design: nothing before P5 owns the shape of a `recipients`
row, and a seed written now would be rewritten twice. When a phase needs
fixtures, they belong in `tests/` (throwaway container) or in a `packs/` seed
applied through the pack loader (P7) — not in an ad-hoc SQL file that drifts
from the schema the way the §0.5 Seam D ghost tables did.
