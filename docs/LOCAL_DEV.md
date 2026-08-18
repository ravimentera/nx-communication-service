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
for f in $(docker compose exec -T postgres sh -c 'ls /migrations/0*.sql' | tr -d '\r'); do
  case "$f" in *0013_*|*0014_*) continue;; esac
  docker compose exec -T postgres psql -U outreach -d outreach -v ON_ERROR_STOP=1 -f "$f"
done
```

A loop rather than a list, deliberately. This section used to name `0001`,
`0002` and `0003` by hand; there are twenty now, and a hand-written list is
wrong from the moment the next phase adds a file — silently, because a database
missing a migration fails much later and somewhere else.

`0013` and `0014` are skipped by the loop because neither is baseline schema —
but they are skipped for **opposite reasons**, and the difference matters.

`0013` retires the plaintext credential columns. It must not be applied until
after a data load, and it needs `CREDENTIAL_ENCRYPTION_KEYS` set. Leave it alone
locally; `docs/MIGRATION_RUNBOOK.md` §8b has the ordered steps.

`0014` is the opposite: every statement is `IF EXISTS`, so it is safe at any
time — and it is **required** if your database was created before P12.

> **Idempotent is not the same as an upgrade path.** `0001` is
> `CREATE TABLE IF NOT EXISTS`, so re-running the baseline does **not** apply a
> change made by *editing* an earlier file. P12 removed
> `messages.queued_message` from `0001`; a database created before that keeps
> the column forever, while a fresh deploy has never had it. `0014` is the only
> thing that removes it, and this page used to tell you to skip it.

Check whether yours needs it:

```bash
docker compose exec -T postgres psql -U outreach -d outreach -tAc \
  "SELECT 1 FROM information_schema.columns
    WHERE table_name='messages' AND column_name='queued_message'"
```

A row back means apply it, once:

```bash
docker compose exec -T postgres psql -U outreach -d outreach \
  -v ON_ERROR_STOP=1 -f /migrations/0014_drop_queued_message.sql
```

No rows means you are already clean and there is nothing to do.

**The general check, which does not depend on knowing about `0014`:** build a
throwaway database beside yours, apply the baseline to it, and diff the two
schemas. That catches this class of drift whatever causes it — see
`testing/TEST_PLAN.md` §0.4 for the commands.

`npm run migrate:print` prints the same split with the same reasoning, and
`tests/helpers/migrations.ts` is what the test harnesses use.
`tests/unit/platform/migrations.test.ts` fails if the three disagree, and now
also fails if a non-baseline file is added without saying why it is excluded.

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

`testing/` holds it. There is no create-a-tenant endpoint — tenants arrive
through the `9xxx` load or an insert — so without this a local service boots
against an empty database with no way to exercise anything.

```bash
docker compose exec -T postgres psql -U outreach -d outreach \
  -v ON_ERROR_STOP=1 -f /testing/seed-local.sql
./testing/seed-packs.sh          # installs packs through the API, not by insert
node testing/bootstrap.mjs        # drafts, a campaign, an API key
```

Three tenants: `t-alpha` for the happy path, `t-beta` as the other side of every
isolation test, and `t-gdpr` carrying a compliance profile so the data-rights
endpoints are reachable at all. Recipients cover the branches the compliance
gate takes — email-only, unsubscribed, and one in Asia/Tokyo so quiet hours are
observable from a US-hours laptop. Re-running the seed is the intended way to
reset fixture state; it restores every seeded column.

> **This section used to say there was no seed, "by design"** — because nothing
> before P5 owned the shape of a `recipients` row, and the concern was an
> ad-hoc SQL file drifting from the schema the way the §0.5 Seam D ghost tables
> did. The first half expired when the phases finished. **The second half was
> right**, and is why `tests/integration/seed.test.ts` exists: it applies this
> file to a throwaway container and asserts the fixtures still mean what the
> engine reads — that contact points use `phone` rather than the channel name
> `sms`, and that `external_ref.system` matches what the compat shim resolves.
> The fixture shipped wrong on both counts, and both inserted perfectly happily.

**Two files in `testing/` are generated and gitignored** — the Postman
collection and its environment. A fresh clone builds them:

```bash
node testing/build-postman.mjs    # from docs/api/openapi.yaml
node testing/bootstrap.mjs        # writes the environment, incl. an API key
```

The collection is ~300KB of generated output and the environment holds a
plaintext key the API returns once, so neither belongs in git. Regenerating is
cheap and `tests/contract/openapi.test.ts` already fails if the spec drifts from
the registered routes.

`node testing/smoke.mjs` replays all 150 requests against your running service
and reports anything 5xx. It is **not** a test suite — `npm test` is that. This
one knows only what a plausible answer looks like, and exists to answer "did I
break anything across the surface" in a few seconds against a real stack.
