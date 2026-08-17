# Decision record

Why this codebase looks the way it does — particularly where it **diverges from
`EXTRACTION_PLAN.md`**, and what evidence drove each choice.

`EXTRACTION_PLAN.md` says what to build. This says why the build differs from the
plan, and what we learned that the plan could not have known. When the two
disagree, the plan has been amended and this record explains the amendment.

Entries are stable-numbered (`D1`, `D2`, …) so they can be cited from code
comments, commits and the plan. Never renumber; supersede instead.

---

## 1. Working agreements

**These carry across sessions. Read this section first.**

### 1.1 Maintain this record

Add an entry whenever a choice:

- diverges from `EXTRACTION_PLAN.md`, or
- resolves a question the plan left open, or
- rests on evidence that contradicts an assumption in the plan, or
- would make a future reader ask "why on earth is it done this way?"

Do it **in the same session as the work**, not retroactively. An entry needs
context, the decision, the reasoning, and the evidence. "It seemed cleaner" is
not reasoning; "the source retried an unsubscribed number five times" is.

Routine implementation choices do not belong here. If it would not surprise a
careful reviewer, leave it out.

### 1.2 Amend `EXTRACTION_PLAN.md` in place — but ask first

When a finding invalidates something in the plan, fix the plan **at the point
where the next session will read it**, not as a footnote at the end. Later
phases are still unwritten; correcting them is cheap now and expensive after
they are built.

**Ask before applying a correction.** State the finding, the evidence, and the
proposed edit; wait for a yes. Amendments are recorded in the plan's own
"Amendments log" near the top, and the substantive ones also get an entry here.

### 1.3 Never commit a doc unless explicitly told to

**Documentation is not committed by default.** This file included.

Docs live in the working tree as **untracked** files and are **not** added to
`.gitignore` — seeing them as `??` in `git status` is the correct state, not
something to tidy up. That covers `EXTRACTION_PLAN.md`, `EXTRACTION_PLAN.html`,
`COMMIT_PLAN.md`, this record, and any `.md` written in the course of the work.

Committing one requires an explicit instruction for that file. "It seems useful
to have in the repo" is not one, and neither is "the directory already has a
tracked file in it" — `docs/LOCAL_DEV.md` and `migrations/README.md` are tracked
because they were explicitly asked for, and they set no precedent.

Practical consequence: **never `git add -A` in this repo.** Stage explicit paths,
or read the staged list before committing. Docs have been committed by accident
three times and removed from history each time.

**One boundary this rule does not cover, added P8b.** The test is not "does it
live in `docs/`" but **"does committed code read it at runtime or at test time"**.

`docs/api/openapi.yaml` is tracked. It is a machine-readable contract rather than
prose — consumers generate clients from it — and, decisively,
`tests/contract/openapi.test.ts` reads it from disk. That test was committed
while the file it reads was not, so `npm test` failed on a fresh clone and CI
with it. Verified by cloning the repo into a scratch directory: the test was
there, the file was not.

The same test applies to `packs/*.json` and `migrations/*.sql`, which are
tracked for the same reason and never counted as docs.

Everything that is only read by a human stays untracked: `EXTRACTION_PLAN.md`,
`EXTRACTION_PLAN.html`, `COMMIT_PLAN.md`, `docs/PACKS.md`,
`docs/api/BREAKING.md`, and this record. Seeing them as `??` remains correct.

### 1.4 Never run a migration

Hard rule 1 of the plan. No `drizzle-kit push`, no `drizzle-kit migrate`, no
`psql -f` from a script or an agent. Write the numbered SQL file, print the
operator command, stop.

The one thing that is **not** a violation: `tests/integration/*.test.ts` applying
migrations to a throwaway testcontainer. That container is created empty,
destroyed at the end, and never has a route to a database holding data.
Verifying a migration before an operator runs it is the point.

### 1.5 Report faithfully

If a check fails, say so with the output. If something was skipped, say that. A
phase is complete when its exit criteria pass, not when the code is written.

---

## 2. Decisions

Index:

| # | Decision | Phase |
|---|---|---|
| [D1](#d1) | Omit `@aws-sdk/client-rds-data` | P0 |
| [D2](#d2) | Separate `tsconfig.test.json` | P0 |
| [D3](#d3) | Split `app.ts` from `index.ts` | P0 |
| [D4](#d4) | Accept the `npm audit` noise from mjml | P0 |
| [D5](#d5) | Metric names are unchanged — there is no `tera_` prefix | P1 |
| [D6](#d6) | `batchQuery` runs its queries inside the transaction | P1 |
| [D7](#d7) | `ioredis` needs a named import under NodeNext | P1 |
| [D8](#d8) | Logger takes options; file transport defaults off | P1 |
| [D9](#d9) | Auth failures go through the error handler | P1 |
| [D10](#d10) | Redis down is `degraded`, not `down` | P1 |
| [D11](#d11) | Ghost tables hold no data — Seam D is closed | P2 |
| [D12](#d12) | The engine ships no vertical-specific tables | P2 |
| [D13](#d13) | Campaign tables land in `0001`, not P11's `0008` | P2 |
| [D14](#d14) | `drizzle-kit generate` does not work — `db:draft` replaces it | P2 |
| [D15](#d15) | The conformance test is bidirectional | P2 |
| [D16](#d16) | Cross-file foreign keys are declared in SQL only | P2 |
| [D17](#d17) | `timestamptz` everywhere | P2 |
| [D18](#d18) | Identity columns and `sent_at` are nullable | P2 |
| [D19](#d19) | Two tables have no `tenant_id`; two allow it to be NULL | P2 |
| [D20](#d20) | Credential mapping lives per channel, not in a switch | P3 |
| [D21](#d21) | Non-retryable failures stop after one attempt | P3 |
| [D22](#d22) | Every adapter returns `providerMessageId` | P3 |
| [D23](#d23) | Dry-run is explicit config, not an `NODE_ENV` read | P3 |
| [D24](#d24) | Endpoint and device-token registries are not ported | P3 |
| [D25](#d25) | Slack's medspa helpers are not channel methods | P3 |
| [D26](#d26) | SMTP retryability is inverted from HTTP | P3 |
| [D27](#d27) | Channel config caching moved to Redis | P3 |
| [D28](#d28) | One `SendJob` replaces six payload unions | P3 |
| [D29](#d29) | The disabled queue implements the real interface | P3 |
| [D30](#d30) | The LLM timeout no longer leaks a timer | P4 |
| [D31](#d31) | Token counts come from the provider, not a word count | P4 |
| [D32](#d32) | Prompts are not logged at info level | P4 |
| [D33](#d33) | The renderer gets an isolated Handlebars environment | P4 |
| [D34](#d34) | `formatDate` uses tenant locale and timezone | P4 |
| [D35](#d35) | `aiConfidence` ignores the model's self-assessment | P4 |
| [D36](#d36) | Migration `0004` is empty and not written | P4 |
| [D37](#d37) | Context providers are gated by installed pack | P5 |
| [D38](#d38) | Quiet hours use `hourCycle: 'h23'`, not `hour12: false` | P5 |
| [D39](#d39) | The quiet-hours end time is probed, not offset-arithmetic | P5 |
| [D40](#d40) | Quiet hours and rate limits defer; everything else blocks | P5 |
| [D41](#d41) | The gate ships in shadow mode by default | P5 |
| [D42](#d42) | `upsertByExternalRef` is insert-or-nothing, then update | P5 |
| [D43](#d43) | The unsubscribe route is unauthenticated by design | P5 |
| [D44](#d44) | Approving a message sends nothing today | P6 |
| [D45](#d45) | Every approval mutation is unscoped and unauthorized in the source | P6 |
| [D46](#d46) | The two approval implementations use different *storage*, not just different words | P6 |
| [D47](#d47) | Submit writes the message row; the dispatcher adopts it | P6 |
| [D48](#d48) | `SENT` is written by delivery, not by the approver | P6 |
| [D49](#d49) | `record-result` was destroying `metadata.playbookKey` on every send | P6 |
| [D50](#d50) | The escalation notice goes through the engine, so P6 ships a hook | P6 |
| [D51](#d51) | Bulk needs the permission **and** the policy right | P6 |
| [D52](#d52) | The P5 lint ruleset was never wired, so `lintWarnings` was always empty | P6 |
| [D53](#d53) | Approval is decided by content source — none of the 17 event playbooks needs one today | P7 |
| [D54](#d54) | Channels come from the trigger, intersected with the playbook's plan | P7 |
| [D55](#d55) | Four hardcoded destinations in the switch, not the one the plan flagged | P7 |
| [D56](#d56) | The `EventType` enum and the switch disagree — aliases are required, not convenience | P7 |
| [D57](#d57) | Pack content is validated at load, strictly | P7 |
| [D58](#d58) | A `none` policy writes no approval row at all | P7 |
| [D59](#d59) | AI playbooks ship inactive — they are new capability, not a port | P7 |
| [D60](#d60) | The legacy surface is 110 endpoints, not 77 | P8 |
| [D61](#d61) | The provider inbox is invalid SQL and has never returned a 200 | P8 |
| [D62](#d62) | Three more unscoped reads in the communications controller | P8 |
| [D63](#d63) | The analytics endpoint 500s unless both dates are supplied | P8 |
| [D64](#d64) | `/messages/webhook/*` is not a provider webhook, and never received one | P8b |
| [D65](#d65) | MCP discovery is pre-auth; execution is authenticated inside the router | P8b |
| [D66](#d66) | The template engine has no tenant scoping whatsoever | P8b |
| [D67](#d67) | Eight `/ai` endpoints are one endpoint and seven prompt packs | P8b |
| [D68](#d68) | The EHR mapper refuses to guess, and one of its targets never had a handler | P8b |
| [D69](#d69) | One analytics row per message, and an index the receipt lookup can use | P8b |
| [D70](#d70) | The 9xxx files are renumbered so numeric order is dependency order | P9 |
| [D71](#d71) | Naive source timestamps are converted at a declared zone | P9 |
| [D72](#d72) | Recipient ids are UUID v5 over (tenant, patient) | P9 |
| [D73](#d73) | Both of the plan's approval predicates miss rows | P9 |
| [D74](#d74) | `sent_at IS NULL` is never true, so the backlog is defined by status alone | P9 |
| [D75](#d75) | A migrated message must look like one the engine wrote | P9 |
| [D76](#d76) | Unattributable rows are quarantined, never guessed | P9 |
| [D77](#d77) | Operator knobs live in a settings table, not psql variables | P9 |
| [D78](#d78) | Watermarks lag `now()`, and the delta re-reads a trailing window | P9 |
| [D79](#d79) | The event switch's templates are files on disk, not table rows | P9 |
| [D80](#d80) | One stored spelling for a channel, and it is lower case | P9 |
| [D81](#d81) | P11 runs before P10, and the plan's order would have destroyed its sources | P11 |
| [D82](#d82) | A campaign targets its playbook through the matcher's predicate | P11 |
| [D83](#d83) | `cancel` cannot recall a queued message | P11 |
| [D84](#d84) | P12 cannot run before P10 | P10 |
| [D85](#d85) | The five preference opt-ins are carried across, not retired | P10 |
| [D86](#d86) | Step 5 runs before Step 2 | P10 |
| [D87](#d87) | Seam A is two code paths | P10 |
| [D88](#d88) | Importing a module opened a database connection | P10 |
| [D89](#d89) | scheduling-service has been posting to a 404 | P10 |
| [D90](#d90) | `retryAt` could not stay in JSONB | P10 |
| [D91](#d91) | `cancel` recalls, and reports three numbers | P10 |
| [D92](#d92) | Six of the seven 501s were never blocked on an image model | P12 |
| [D93](#d93) | `POST /templates/generate` defaulted to a prompt pack nothing shipped | P12 |
| [D94](#d94) | API keys are hashed with SHA-256, not bcrypt | P12 |
| [D95](#d95) | Pack config was replaced where the comment promised a merge | P12 |
| [D96](#d96) | What credential encryption does and does not cover | P12 |
| [D97](#d97) | `0013` is a decommissioning step, not baseline schema | P12 |
| [D98](#d98) | Role approvals were authorized by permission, not membership | P12 |
| [D99](#d99) | There is no parallel run, and most of P10 was built for one | P12 |
| [D100](#d100) | The compat shim is trimmed by inspection, not by measurement | P12 |

---

### P0 — scaffold

<a id="d1"></a>
#### D1 · Omit `@aws-sdk/client-rds-data`

**Plan said:** include it in the P0 dependency list.

**We did:** left it out.

**Why:** P1 drops the RDS Data API path entirely and Appendix C lists every
`RDS_*` variable as dropped. Including it would ship a package into the
production image that nothing imports, forever. One line to add back if a Data
API adapter is ever needed.

**Plan amended:** yes — P0 dependency table.

---

<a id="d2"></a>
#### D2 · Separate `tsconfig.test.json`

**Plan said:** nothing; it specified only `tsconfig.json` and `jest.config.cjs`.

**We did:** added a second tsconfig for ts-jest.

**Why:** the root config sets `rootDir: src` and excludes `tests/`, so ts-jest
cannot compile a test file against it. The plan's jest setup does not work
without this. Not a preference — a missing piece.

**Related gotcha:** the `jest` global is **not** injected in ESM mode.
`jest.fn()` throws `ReferenceError`. Either `import { jest } from '@jest/globals'`
or hand-roll the spy. Later phases will hit this the first time they mock an
adapter.

---

<a id="d3"></a>
#### D3 · Split `app.ts` from `index.ts`

**Plan said:** `src/index.ts` is the composition root.

**We did:** `createApp(deps)` builds the Express app in `app.ts`; `index.ts`
constructs dependencies and calls `listen()`.

**Why:** supertest can exercise the real app without binding a port, which is
what makes the boot and auth tests possible at all. `index.ts` is still the
composition root in the sense the plan means — nothing else constructs I/O.

---

<a id="d4"></a>
#### D4 · Accept the `npm audit` noise

A clean install reports ~41 advisories (7 moderate, 34 high), the bulk transitive
through `mjml`'s dependency tree. Unavoidable while P4 needs MJML rendering.

**Not a blocker; not resolved.** Triage before the first real deploy. Recorded so
nobody mistakes it for something that appeared later.

---

### P1 — platform layer

<a id="d5"></a>
#### D5 · Metric names are unchanged — there is no `tera_` prefix

**Plan said:** rename the metric prefix `tera_*` → `outreach_*`, and update
`observability/prometheus/prometheus.yml` in P10.

**We found:** there is no `tera_` prefix. `shared-libs/observability/metrics.ts`
declares the OpenMetrics-standard `http_request_duration_seconds`,
`http_requests_total` and `http_requests_in_flight`, with service identity
carried by an explicit `service` label.

**We did:** kept the standard names, set the `service` label to
`outreach-server`. Delivery-plane instruments added in P3 *are* prefixed
`outreach_*` because they are genuinely new.

**Why:** renaming standard metric names breaks every shared dashboard and
recording rule for no gain.

**Consequence for P10:** it needs a **new scrape job** in `prometheus.yml`, not a
metric rename. That is a different edit and would have been missed.

**Plan amended:** yes — P1 observability bullet and both handoffs.

---

<a id="d6"></a>
#### D6 · `batchQuery` runs its queries inside the transaction

**Found:** `shared-libs/utils/db-client.ts:514-540` checks a client out of the
pool, issues `BEGIN` on it, then invokes query functions that each take their
**own** connection from that same pool. Those queries are never part of the
transaction. A mid-batch failure rolls back an empty transaction and every prior
write stays committed. `useTransaction: true` bought nothing.

**We did:** the port passes the transaction handle to each query function:

```ts
batchQuery(db, queries: ((tx: Db) => Promise<T>)[], opts): Promise<T[]>
```

**Why:** a transaction that silently does not transact is worse than no
transaction — it invites callers to rely on atomicity they do not have. Safe to
change the signature because P1 is the first consumer.

**Still open:** `mentera_core` ships the broken version. Out of scope for this
repo; worth a separate issue.

---

<a id="d7"></a>
#### D7 · `ioredis` needs a named import under NodeNext

`import Redis from 'ioredis'` resolves the default export to a *namespace* —
neither constructable nor usable as a type (`TS2709` / `TS2351`). Use
`import { Redis, type RedisOptions } from 'ioredis'`.

Recorded because it is non-obvious, it cost time once, and P3 hit it again
wiring BullMQ.

---

<a id="d8"></a>
#### D8 · Logger takes options; file transport defaults off

**Plan said:** port `createServiceLogger` as-is.

**We did:** it takes `{ level, logDir, fileTransport }` instead of reading
`LOG_LEVEL` / `LOG_DIR` / `LOG_TO_FILE` from the environment, and the file
transport defaults **off** (the source defaults it on).

**Why:** `src/config/` is the only module permitted to read `process.env`, and
that is enforced by an eslint rule — the source's version cannot pass it.
Containers log to stdout; a file transport in a container writes to a layer
nobody reads.

---

<a id="d9"></a>
#### D9 · Auth failures go through the error handler

The source writes rejections straight to the response
(`res.status(403).json(...)`). The port calls `next(new ForbiddenError(...))` so
every failure gets one shape, one log line, and request-id correlation.

Status codes and semantics are unchanged. Also added `requireTenant(req)`, which
reads the tenant off the resolved identity and throws if absent — route handlers
use it instead of touching headers or the body.

---

<a id="d10"></a>
#### D10 · Redis down is `degraded`, not `down`

Only the **database** gates readiness. `/health/detailed` reports Redis as
`degraded` and still returns 200 when it is unreachable, because the platform
falls back to an in-memory store and HTTP keeps serving.

**Why:** returning 503 there would have Kubernetes pull a pod that is
functionally fine. Verified live: with the Redis container stopped, the service
boots, serves, and reports `redis: degraded, mode: in-memory`.

The source had two overlapping degradation strategies (`redis-client.ts` swapped
in a hand-rolled mock object; `redis-cache.ts` returned null from every call) and
both auto-connected at module import. The port has one `KeyValueStore` interface
with two backends, and connection is started by the composition root.

---

### P2 — schema

<a id="d11"></a>
#### D11 · Ghost tables hold no data — Seam D is closed

> **Raised by you:** *"You can't always trust the migrations. What's the impact
> of ghost tables being tenant-blind?"*

**Plan said:** §0.5 Seam D lists six tables written by raw SQL that exist in no
migration, assumes they have the columns their INSERT statements imply, and
schedules `9009_pack_medspa.sql` to migrate them.

**We found**, in three steps:

1. **Code:** `grep -c medspa_id` over all five writing services returns **0**.
   Not one of these tables has a tenant column; not one INSERT supplies a tenant.
2. **Database** (your query): `tenant_cols = 0` for all seven, confirming it at
   the schema level rather than by inference. `patient_feedback` included — it is
   declared in `schema/db.ts:248` but absent from migration `0000`, so the source
   model and the source database already disagreed about it.
3. **Row counts** (your query): **0 rows in all seven.**

**Impact, had they held data:** reads like
`SELECT * FROM promotions WHERE id = $1` carry no tenant predicate, so with two
tenants one could read the other's rows by id — and gift cards carry `amount`
and `balance`, so that is money. With one tenant nothing leaked. It was latent,
not active.

**Impact, given they are empty:** nothing. No data to migrate, no attribution to
decide, no rollback to plan.

**Why they are empty:** the code is demo scaffolding, not unfinished production
code. `promotion.service.ts:169` returns a hardcoded `Jane Smith` / `John Doe`
from `findEligiblePatients()` — commented *"For demo purposes, we'll return stub
data"* — and `createTargetedCampaign()`, the entire reason promotions live in
this service, is built on it. `feedback-analysis.service.ts:229,251` return a
hardcoded patient and provider. Five stub sites across two files. Nothing outside
`communication-service` imports any of it.

**We did:** deleted `9009_pack_medspa.sql` from the plan. P9 Step 1 keeps the
recon query as a **zero-count guard** at cutover, not a discovery step — if a
count comes back non-zero, stop and re-open Seam D rather than improvise a
target table.

**Plan amended:** yes — §0.5 rewritten, P9 migration table, Appendix B,
Appendix F risk retired.

---

<a id="d12"></a>
#### D12 · The engine ships no vertical-specific tables

> **Raised by you:** *"Why do we have packs-related code in the repo? I was under
> the impression that packs will be configurations that the consumer of the
> package will provide. We can't have tenant-specific tables in the
> communication service because that loses the purpose of it being an
> industry-agnostic standalone service. And when we put the table in medspa
> services, then it seems like we are asking the consumer to create tables before
> they can use the communication service?"*

**Plan said:** the ghost tables become namespaced `pack_<packid>_*` tables, and
P7 creates them. P2 built `pack_medspa_feedback`, `pack_medspa_promotions` and
`pack_medspa_gift_cards`.

**We did:** deleted all three. Kept `packs`, `tenant_packs` and the `pack_id`
provenance columns.

**Your first point was right,** with one vocabulary correction: these are
*vertical*-specific, not *tenant*-specific. `pack_medspa_promotions` would be
shared by every medspa tenant. The leak is not per-customer, it is per-industry —
a law firm adopting the engine would get three empty medspa tables in its core
migration.

**Your second point is where the answer lies.** No, a consumer does not have to
create tables first. The rule:

> **The engine needs a table only if the engine reads it.**

Ask it literally of each:

- **promotions** — does the engine read this to send a message? No. It needs the
  promotion's *fields at render time* (name, discount, expiry), and those arrive
  with the event.
- **gift_cards** — no. Code and amount at render time.
- **patient_feedback** — partly. The inbound reply *is* a message, and the engine
  already owns messages.

So a consumer creates a table only for data **they** own and **they** query —
which they would need whether or not this engine existed. A medspa has a
promotions table because it runs promotions. A gym adopting the engine for class
reminders creates nothing at all.

The mechanism for feeding vertical data into a generic engine was already in the
design: `playbooks.data_contract` is "JSON Schema for caller-supplied context".
The caller sends `{promotion: {...}}` with the event, the playbook validates it
against its contract, the template renders from it. No engine table, still
type-checked.

**The four tiers** (now §0.10 of the plan):

| Tier | Lives in | For | Consumer DDL? |
|---|---|---|---|
| 1. Event payload + `data_contract` | nowhere — transient | data the engine needs only at render time | none |
| 2. Generic extension columns — `recipients.attributes`, `recipient_context.payload`, `message_analytics.metadata`, `tenant_packs.config` | engine DB, schemaless | data the engine must query or filter on | none |
| 3. The vertical's own service | consumer's own DB | data the vertical owns; engine never reads it | it already has them |
| 4. Pack-owned migration | engine DB, opt-in | rare: relational storage that must sit beside engine data | opt-in, ships with the pack |

Applied: promotions and gift cards → tier 3 + tier 1. `gift_cards` is the
clearest case — `amount`, `balance`, `is_redeemed` is a **ledger**, and ledgers
belong with commerce, not outreach. Feedback splits: the inbound reply → tier 2
(`messages`, `direction='inbound'`), the clinical judgments (sentiment,
`is_adverse`, escalation) → `message_analytics.metadata` or the vertical's table.

**Three things wear the word "pack"**, and only two belong here:

- **the mechanism** — `packs`, `tenant_packs`, `pack_id` columns. Generic: a pack
  id is a string and no table is shaped by what any pack contains. **Stays.**
- **the content** — playbooks, templates, prompts, policies as JSON/YAML under
  `packs/`. Exactly what you described. **Stays, as data.**
- **pack-owned tables** — **gone.**

**The test:** `grep -ri medspa src/db/ migrations/` must return no table or
column name. Run it after any phase that adds tables.

**Why it was free to change:** the tables were empty, nothing read them, no data
had been migrated (D11). After P9 it would not have been.

**Plan amended:** yes — new §0.10, plus §0.5, §0.7, P2, P7, P9, Appendix B and
Appendix F.

---

<a id="d13"></a>
#### D13 · Campaign tables land in `0001`, not P11's `0008`

**Plan said:** P2 declares `campaigns.ts` in the Drizzle schema; P11 creates the
tables in migration `0008`.

**We did:** created them in `0001`. P11 still owns the runtime; only the DDL
moved.

**Why:** a declared Drizzle model with no backing table for nine phases is
exactly the drift that produced the Seam D ghost tables. Also leaves P4's claim
on `0004` intact.

---

<a id="d14"></a>
#### D14 · `drizzle-kit generate` does not work — `db:draft` replaces it

> **Raised by you:** *"What's the impact of `drizzle-kit generate` missing? Will
> we lose something, and if so, why are we not using an alternative?"*

**Found:** drizzle-kit 0.30.6 bundles the schema through esbuild in CJS mode and
resolves relative imports literally, so the `.js` extensions NodeNext ESM
requires resolve to files that do not exist:

```
Error: Cannot find module './schema/tenancy.js'
```

A schema glob does not help — the failure moves to the cross-file imports inside
each schema file. Upgrading does not help either: drizzle-kit 0.31.10 refuses to
run against `drizzle-orm@0.39.3` and demands a matching upgrade, and 0.39.3 is
pinned deliberately to match the source service.

**What we lose:** a drafting convenience — a first-pass SQL skeleton. Nothing
else. Type-safe queries are `drizzle-orm` and unaffected; migration correctness
is covered by D15.

**What we did:** `npm run db:draft` copies the schema to a gitignored
`.drizzle-draft/`, strips the extensions **in the copy**, and generates from
that. About 15 lines. Verified: all 27 tables.

**Why the copy makes this acceptable:** the source repo's `fix-imports.cjs` hack
rewrote *emitted build output* on every build and had to stay correct forever or
production broke — the plan explicitly refuses to carry it over. This touches a
disposable copy, runs only when drafting, and its worst failure is "no draft
today". The output goes to a gitignored directory and is never committed as a
migration.

**Correction on the record:** the first report said there was no alternative. That
was wrong — the workaround exists and is cheap.

---

<a id="d15"></a>
#### D15 · The conformance test is bidirectional

`tests/integration/schema.test.ts` asserts in **both** directions: every Drizzle
table and column exists in the applied database, and every database table and
column exists in the model.

**Why it matters more than usual here:** with no working generator (D14), this is
the *only* thing keeping the hand-written SQL and the Drizzle model in sync.
Adding a column to one without the other fails the build. Later phases must
extend it, never weaken it.

**Not covered by it:** expression and partial indexes, which cannot be expressed
in the Drizzle model —`recipients_tenant_external_ref_unique` (on
`external_ref->>'system'`/`->>'id'`) and `templates_tenant_key_unique`
(`WHERE key IS NOT NULL`) exist only in SQL and need human eyes.

---

<a id="d16"></a>
#### D16 · Cross-file foreign keys are declared in SQL only

Within one schema file, relationships use Drizzle's `.references()`. Across
files they are plain `uuid` columns and the FK is added in the migration.

**Why:** `.references()` needs a real import, and the natural graph has cycles —
playbooks → approvals → messages → playbooks. The hand-written migration is the
source of truth for constraints regardless, since `drizzle-kit push` is never
run.

**Consequence:** migration order is load-bearing. `0002` and `0003` add foreign
keys whose other side was created earlier, inside guarded `DO` blocks. Applying
`0003` before `0002` fails on a missing `approval_policies`.

---

<a id="d17"></a>
#### D17 · `timestamptz` everywhere

The source uses naked `timestamp` (no zone) on every column. That is a latent
bug, not a style choice: quiet-hours checks and scheduled sends compare
wall-clock values whose zone is implied by whichever server wrote them, so the
same stored value means different instants for a Los Angeles tenant and a New
York one.

Asserted by the conformance test: not one `timestamp without time zone` column
exists.

---

<a id="d18"></a>
#### D18 · Identity columns and `sent_at` are nullable

`message_history.patient_id` and `.provider_id` are `NOT NULL` in the source, as
are `message_analytics.patient_id`, `communication_memories.patient_id`,
`campaigns.provider_id` and `campaign_recipients.patient_id`. Those constraints
are what make a system-to-staff message impossible to record and what block a
tenant with no per-agent concept.

`messages.sent_at` is also nullable, which the plan did not call out. The source
has it `NOT NULL`, which is only coherent if every row is already sent — a
message in `DRAFT` or `PENDING_APPROVAL` has no send time, and P6 must be able to
store exactly that.

---

<a id="d19"></a>
#### D19 · Two tables have no `tenant_id`; two allow it to be NULL

Rule 4 says every table gets `tenant_id`. Four documented exceptions:

- **`tenants`** — its primary key *is* the tenant id.
- **`packs`** — a global catalogue. A pack is not owned by a tenant;
  `tenant_packs` records who installed it.
- **`approval_policies`**, **`prompt_packs`** — `tenant_id` is nullable, where
  NULL means "pack-provided default, shared by every tenant that installed the
  pack". A non-null row overrides it.

All four are asserted explicitly in the conformance test, so a fifth cannot
appear by accident.

---

### P3 — delivery plane

<a id="d20"></a>
#### D20 · Credential mapping lives per channel, not in a switch

**Plan said:** `resolveCredentials(channel, scope)` with the fallback chain
implemented inside the resolver — which reads as a switch on channel type.

**We did:** each channel owns a `CredentialMapper` (`fromAgent` / `fromTenant` /
`fromEnv`) in `src/adapters/channels/credentials.ts`; the resolver walks the
three levels generically.

**Why:** P3's exit criterion is *"no `switch` on channel type anywhere in
`src/`"*, and the first draft violated it three times. That was not just
letter-of-the-law — a switch in the resolver reproduces exactly the coupling the
phase removes: adding a `voice` channel later would mean editing a central file
rather than adding one.

**What the chain preserves:** the level-1 case at `twilio.ts:44-56`, where the
agent supplies the `from` and the **tenant** supplies the secrets. An agent has a
phone number, not a Twilio account. A mapper returns `null` rather than half a
credential, so an incomplete level falls through instead of failing at send time
far from the cause.

**Level 4 throws.** The source returns `false` from `sendSMS` when config is
missing (`twilio.ts:116-122`), which is indistinguishable from a send failure and
produces no alert. `ChannelNotConfiguredError` is a 503 naming the channel and
tenant.

---

<a id="d21"></a>
#### D21 · Non-retryable failures stop after one attempt

**Found:** the source throws a plain `Error` on every failure, so BullMQ retries
five times regardless of cause. An SMS to a number that replied STOP is retried
five times — five more messages to someone who opted out.

**We did:** adapters classify errors with `retryable: boolean`, and the worker
raises BullMQ v5's `UnrecoverableError` for permanent ones. Permanent: Twilio
21610 (unsubscribed), 21211/21212/21214/21614 (bad number), 30006 (landline);
FCM `NotRegistered` / `InvalidRegistration`; any HTTP 4xx except 429. Retryable:
5xx, 429, network failures with no response.

Asserted end to end in `tests/integration/queue.test.ts` — exactly one adapter
call for a non-retryable failure.

---

<a id="d22"></a>
#### D22 · Every adapter returns `providerMessageId`

The source discards SendGrid's response entirely (`sendgrid.ts:99`) and only logs
Twilio's `message.sid` (`twilio.ts:161`). Without those ids, delivery webhooks
have nothing to join receipts against — which is why `messages.provider_message_id`
and `idx_messages_provider_message_id` were added in P2.

Plan called this out for SendGrid; we did it for every adapter.

---

<a id="d23"></a>
#### D23 · Dry-run is explicit config, not an `NODE_ENV` read

The source decides this in three places as
`process.env.NODE_ENV !== 'production'` (`twilio.ts:25`, `sendgrid.ts:27`,
`slack.service.ts:17`). A staging deploy therefore sends nothing silently, and a
misconfigured `NODE_ENV` sends everything silently.

One injected flag, `config.channels.dryRun`, **defaulting to on**. A
misconfigured deploy cannot send.

`in_app` honours it too — it must not write rows either.

---

<a id="d24"></a>
#### D24 · Endpoint and device-token registries are not ported

`webhook-notification.ts` carried an endpoint registry (`registerEndpoint`,
`getEndpointsForEvent`, …) and `push-notification.ts` a device-token registry,
both over in-process `Map`s.

**Not ported.** In-memory subscription state is lost on restart and invisible to
other replicas, which makes both channels quietly unreliable. Device tokens are
contact points — they live on `recipients.contact_points` with `type: 'push'`,
and the dispatcher passes one in like any other address. Webhook subscriptions
are table-shaped state that P8 owns.

The adapters do one thing: deliver one payload to one destination.

**Also dropped:** the webhook adapter's own retry loop, which multiplied with the
queue's retries. Retries are BullMQ's job.

---

<a id="d25"></a>
#### D25 · Slack's medspa helpers are not channel methods

`sendAppointmentNotification` and `sendUrgentAlert` (`slack.service.ts:58,109`)
hardcode "Patient", "Treatment" and "Provider" block fields and a default
`urgent-alerts` channel.

A channel sends; it does not know what a treatment is. These become pack-authored
block templates in P7 — §0.10 tier 1, arriving in `msg.metadata.blocks`. The
adapter passes blocks through untouched.

---

<a id="d26"></a>
#### D26 · SMTP retryability is inverted from HTTP

SMTP 5xx is **permanent**; 4xx is **transient** (greylisting, quota). That is the
opposite of the HTTP rule used by every other adapter, and an easy thing to get
backwards. Called out in the adapter itself.

---

<a id="d27"></a>
#### D27 · Channel config caching moved to Redis

The source keeps two in-process `Map` caches with a 5-minute TTL
(`medspa-config.service.ts:135-137`). N replicas therefore hold N divergent
views, and a config write only invalidates the replica that served it.

Caching moved to Redis with explicit invalidation — `invalidate(tenantId,
senderId?)` clears the config entries **and** the derived credential entries, and
must be called after any write to either config table.

---

<a id="d28"></a>
#### D28 · One `SendJob` replaces six payload unions

The source has six payload interfaces (`EmailNotificationPayload`,
`SMSNotificationPayload`, …) and a switch that casts to each. `SendJob` carries
an already-rendered, channel-agnostic message.

Rendering happens **before** the queue (P4), not inside it. That is what lets the
worker be one line: `registry.get(job.data.channel).send(...)`.

---

<a id="d29"></a>
#### D29 · The disabled queue implements the real interface

The source's mock (`notification-queue.ts:727-739`) exposes
`addEmailToQueue`/`addSMSToQueue`/… — methods the real service does **not** have.
Any caller written against the mock's API breaks the moment the queue is enabled.

`DisabledNotificationQueue` implements `NotificationQueue`, the same interface as
`BullNotificationQueue`. It logs and reports `{ queued: false, reason }` so a
dropped message is visible rather than silently successful.

---

### P4 — content plane

<a id="d30"></a>
#### D30 · The LLM timeout no longer leaks a timer

**Found:** `ai-service.ts:258-260` races the Bedrock call against
`new Promise((_, reject) => setTimeout(reject, this.requestTimeout))` and never
clears that timer. Every call — including one that returns in 200ms — keeps a
pending timer for the full timeout, 30 seconds by default.

**Consequences:** the process cannot exit promptly, graceful shutdown is delayed
by up to 30s per recent call, and a Jest suite that touches the AI service hangs
until the timers drain.

**We did:** an `AbortController` cancels the in-flight request and the timer is
cleared in `finally`, whichever way the call ends.

A test asserts a fast call returns in under a second with a 30s timeout
configured — if the old pattern came back, it would still pass functionally but
Jest would refuse to exit, so the guard is the suite's exit behaviour as much as
the assertion.

---

<a id="d31"></a>
#### D31 · Token counts come from the provider, not a word count

**Found:** `ai-service.ts:334` records
`this.metrics.totalTokensGenerated += content.split(/\s+/).length`.

That is a **word count of the output only**. It ignores the prompt entirely, and
words are not tokens. Cost cannot be derived from it, which is presumably why
the source never tried.

**We did:** each model codec reads the real usage Bedrock returns — Nova's
`usage.inputTokens`/`outputTokens`, Claude's `input_tokens`/`output_tokens`,
Titan's `inputTextTokenCount` and `results[0].tokenCount` — and `cost_usd` is
computed from a per-model rate table that config can override.

That is what makes `ai_interactions.cost_usd` (added in P2) meaningful and a
tenant's AI spend answerable without a vendor bill.

---

<a id="d32"></a>
#### D32 · Prompts are not logged at info level

**Found:** `ai-service.ts:214-217` logs the entire request body —
`body: JSON.stringify(body, null, 2)` — at `info`, and `:280-285` logs the first
500 characters of every response, also at `info`.

For this service those prompts carry recipient names, provider names and
treatment context, and the P1 logger ships stdout to Loki. That is PHI in log
aggregation, at the default log level, on every AI call.

**We did:** `info` carries lengths, ids, model, token counts and latency.
Content goes to `debug` only. Stored prompts still exist for reproducibility —
truncated, on the `ai_interactions` row, inside the database rather than in the
log pipeline.

**Not fixed here:** the same pattern may exist elsewhere in the source. Worth a
sweep before P10 cutover.

---

<a id="d33"></a>
#### D33 · The renderer gets an isolated Handlebars environment

`template-engine.ts:163-253` calls `Handlebars.registerHelper(...)` on the
imported singleton, mutating global state shared by every consumer in the
process. Two engines with different helpers silently overwrite each other, and
test order starts to matter.

`Handlebars.create()` gives this renderer its own environment. A test asserts
the global registry stays clean.

---

<a id="d34"></a>
#### D34 · `formatDate` uses tenant locale and timezone

**Found:** `template-engine.ts:174-189` calls `d.toLocaleDateString()` and
`toLocaleTimeString()` with **no locale and no timezone**, so every date in every
message renders in whatever locale and zone the server process happens to have.

A 9am appointment reminder for a New York clinic reads as 2pm if the pod runs in
UTC. This is the same class of defect as D17 (naked `timestamp` columns), and the
schema already carries `tenants.timezone` / `.locale` and `recipients.timezone` /
`.locale` to fix it.

**We did:** the helper reads the zone and locale off the render context —
recipient first, then tenant — and passes them to `Intl`.

---

<a id="d35"></a>
#### D35 · `aiConfidence` ignores the model's self-assessment

The source takes whatever confidence the model volunteers in its JSON, defaulting
to `0.5` (`ai-message-generator.ts:244`). P6's `threshold` approval mode is meant
to auto-approve above a confidence bar.

**Letting the model set the number that decides whether a human reviews its
output is the wrong incentive**, and LLMs are not calibrated about their own
work. Our score is a deterministic composite of things we can observe:

```
completeness (fraction of contract fields supplied) − 0.15 per lint warning
```

A test asserts a model claiming `confidence: 0.99` gets the same score as one
claiming nothing.

**It is still a heuristic, not a probability.** Documented as such, and P6 must
ship `threshold` mode **off** by default because of it.

---

<a id="d36"></a>
#### D36 · Migration `0004` is empty and not written

The plan schedules `migrations/0004_content.sql` for "`prompt_packs`, `assets`,
and the `templates.key`/`pack_id` columns **if not already in `0001`**".

All four are already in `0001` (P2 built the whole schema up front, D13). The
conditional resolves to nothing, so **P4 ships no migration**.

`0004` is left unused rather than reassigned, so the numbering keeps matching the
plan's phase map.

---

### P5 — context and compliance

<a id="d37"></a>
#### D37 · Context providers are gated by installed pack

The plan called this out and it is worth restating, because it is a **security
boundary rather than a lookup table**.

`mentera.provider.ts` can reach patient-service using the engine's own gateway
credentials. If the registry resolved by `kind` alone, any tenant could craft
`{ kind: 'mentera-patient', id: '…' }` and have the engine fetch another
vertical's records on its behalf. Providers are therefore registered *against a
pack id*, and resolution takes the tenant's installed packs.

`inline` is registered under `CORE_PACK` and available to everyone — the caller
supplying their own data needs no permission. Everything else is opt-in.

An unauthorised kind is **403, not 404**: the caller asked for something real
that they are not entitled to, and pretending it does not exist helps nobody who
can read the source. An unknown kind is a `ValidationError` — never a silent
fallback to Mentera.

The test asserts both the throw *and* that no HTTP call was made.

---

<a id="d38"></a>
#### D38 · Quiet hours use `hourCycle: 'h23'`, not `hour12: false`

`preference.service.ts:341-346` formats the current time with
`new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, … })`.

On some ICU builds that combination renders midnight as **`24:00`**, not
`00:00`. The code then computes `24 * 60 = 1440` minutes, which compares as
*after* every quiet-hours window — so a message sent at midnight escapes a
22:00–06:00 window entirely, on exactly the platforms where it does that.

`hourCycle: 'h23'` pins the output to `00`–`23`. A test asserts midnight reads as
0 minutes in two zones.

---

<a id="d39"></a>
#### D39 · The quiet-hours end time is probed, not offset-arithmetic

P5 defers into quiet hours rather than dropping, so it needs to say *when* the
window ends. The obvious implementation — take the local offset and add the
remaining minutes — is wrong on a DST night, because the offset changes **inside
the window**.

`nextOccurrenceOf` walks forward a minute at a time until local wall-clock time
matches the target, up to 25 hours so a DST-lengthened day still terminates. At
this call rate the cost is irrelevant and the answer is exact.

The test pins the spring-forward night in New York: offset arithmetic would
produce `11:00Z`, the correct answer is `10:00Z`.

---

<a id="d40"></a>
#### D40 · Quiet hours and rate limits defer; everything else blocks

A **block** means never send this. A **defer** means not yet, with a `retryAt`.

The source does not distinguish: `checkPreferences` returns
`{ allowed: false, blockedReason: 'QUIET_HOURS' }` exactly like it returns
`'UNSUBSCRIBED'`, and the caller drops the message either way. A reminder that
arrives during someone's quiet hours is therefore **lost**, not delayed.

Deferrable: `QUIET_HOURS`, `RATE_LIMITED` — both are statements about *timing*.
Blocking: everything else — statements about *permission*.

Getting it wrong in either direction is expensive. Blocking a deferrable message
loses it; deferring a blockable one keeps retrying something the recipient asked
us to stop.

---

<a id="d41"></a>
#### D41 · The gate ships in shadow mode by default

`COMPLIANCE_SHADOW_MODE=true` evaluates every check, records what it *would* have
done in `outreach_would_suppress_total`, and **still sends**.

This is not timidity. Today's preference engine is an in-memory `Map` that is
empty after every restart (see the P5 preference service header), so the
effective gate in production passes everything. Turning on a durable, DB-backed
gate is the single change most likely to silently stop messages that currently
ship — and `tenant_channel_configs.require_opt_in` defaults to **true** while
`consent_records` is empty until P9 backfills it, so enforcing on day one would
block every message for every tenant on check 3 alone.

Watch the shadow counter per tenant for a week, then flip, and record the flip
date in `tenant_packs.config`.

---

<a id="d42"></a>
#### D42 · `upsertByExternalRef` is insert-or-nothing, then update

`recipients_tenant_external_ref_unique` is an **expression** index — on
`external_ref->>'system'` and `->>'id'` — and drizzle's `onConflictDoUpdate`
accepts only columns as a conflict target, so the natural single-statement
upsert does not compile.

The shape used instead: `onConflictDoNothing()` (atomic — the index decides the
race), and if the insert lost, update the existing row. Two concurrent callers
converge on one row, which is what idempotent means here. A test runs five
concurrent upserts and asserts one id.

The update `COALESCE`s every field, so a partial refresh — resolving just a
display name, say — never blanks a timezone we already knew.

---

<a id="d43"></a>
#### D43 · The unsubscribe route is unauthenticated by design

`POST /unsubscribe/:token` is mounted **before** the auth middleware.

A recipient clicking a link in an email has no gateway headers and no session.
CAN-SPAM requires that link to work for anyone who received the message, so the
24-byte token *is* the credential. The route is rate-limited (30 per 15 minutes)
because it is an open, database-writing endpoint, and it is not tenant-scoped
because the caller has no tenant context — which is precisely why the token is
random rather than derived.

`GET` on the same path deliberately does **not** mutate: mail clients and
browsers prefetch links, and a GET that unsubscribes would fire on preview. GET
reports the token is accepted; POST does the work.

---

### P6 — approvals

<a id="d44"></a>
#### D44 · Approving a message sends nothing today

**Plan said:** the medspa pack's `{always, agent}` policy is "byte-compatible
with today", and P6 should preserve behaviour (hard rule 3).

**We found:** approving a message today is a **dead end**. `approveMessage`
(`approvals.controller.ts:351-377`) sets `message_history.status = 'APPROVED'`
and `communication_events.status = 'APPROVED'` with a `scheduled_for`, and
**nothing reads either back**:

```
$ grep -rn "APPROVED" src --include=*.ts \
    | grep -v approvals.controller | grep -v ai-enhanced | grep -v PENDING_APPROVAL
src/events/event-subscriber.ts:34:  SHIFT_SWAP_APPROVED: ...      # unrelated enum value
src/controllers/communications.controller.ts:1514: isApproved: ... # read-only display flag
```

The event-processing queue takes jobs pushed to BullMQ; it does not scan
`communication_events` for approved rows. `scheduleMessage` (`:1003-1025`) writes
a `scheduledFor` string that no scheduler consumes either.

**We did:** `approve()` hands the message to `dispatcher.dispatch()`, exactly as
the plan specifies.

**Why this is worth an entry:** "preserve behaviour" cannot mean preserving
this. But it does mean P6 is **not** byte-compatible in outcome — it is
byte-compatible in *UX* (every AI message waits for its provider) and a
behaviour **change** in effect (an approved message now actually sends). That
distinction matters at cutover: whoever repoints `COMMUNICATION_SERVICE_URL`
needs to know messages that have been silently accumulating as `APPROVED` will
start going out.

`CHANNEL_DRY_RUN` defaults to on (D23) and the compliance gate defaults to
shadow (D41), so nothing ships by accident before P10.

**Plan amended:** proposed — P6 handoff, P9 (the backfill must decide what to do
with historic `APPROVED` rows that were never sent) and P10 cutover.

---

<a id="d45"></a>
#### D45 · Every approval mutation is unscoped and unauthorized in the source

**Plan said:** *"Access control: `req.user.providerId` must equal the path
`:providerId` (`approvals.controller.ts:66–73`) — **preserve this**, generalized
to `senderId`."*

**We found** that check exists on `getPendingApprovals` and **nowhere else**.
Every mutation looks its row up as:

```ts
.where(eq(messageHistory.id, messageId))
```

— no tenant predicate, no provider check. Six call sites: approve `:325`,
decline `:426`, edit-approve `:534`, edit `:687`, bulk `:792`, schedule `:981`.
`getApprovalHistory` `:921` reads across tenants for the same reason.

**Two consequences, both live:**

1. **Cross-provider.** Provider A cannot *see* provider B's queue but can
   approve, edit, decline or schedule anything in it, given an id.
2. **Cross-tenant.** A user authenticated to tenant A holding a message UUID
   from tenant B can approve it — and approval is where clinical content is
   released. This is a direct violation of hard rule 4.

The `ai-enhanced` controller is better here: its read carries `tenantWhere`
(`:286-290`). It still has no provider check.

**We did:** every read and every write in `approval.service.ts` carries
`eq(approvals.tenantId, scope.tenantId)`, and `authorize()` runs per row on
every action, not just on the list.

**This is a tightening, not a port.** A caller relying on cross-provider
approval will now get a 403. That is the intended outcome, but P8's compat shim
should expect it and P10 should watch for 403s in the parallel run.

**Plan amended:** proposed — the P6 access-control paragraph says "preserve
this", which reads as though the source already enforces it on mutations.

---

<a id="d46"></a>
#### D46 · The two approval implementations use different *storage*, not just different words

**Plan said:** *"State lives in `message_history.queued_message` JSONB, with
`message_history.status = 'QUEUED'` as the outer marker."* — and that the
`ai-enhanced` controller's divergence is one of **vocabulary**
(`REJECTED` vs `DECLINED`).

**We found** the divergence is deeper than vocabulary. The two write to
different places entirely:

| | outer marker | state lives in | values |
|---|---|---|---|
| `approvals.controller.ts` | `status='QUEUED'` | `queued_message->>'approvalStatus'` | `PENDING_APPROVAL`/`APPROVED`/`DECLINED` |
| `ai-enhanced-...controller.ts` | — | `status` **column** | `PENDING_APPROVAL`/`APPROVED`/`SCHEDULED`/`REJECTED` |

`ai-enhanced` writes no `queued_message` at all (`:108-130`) and filters on
`eq(messageHistory.status, 'PENDING_APPROVAL')` (`:222`).

**So the two inboxes show disjoint sets.** A message created by
`/ai-enhanced/generate-communication` never appears in `/approvals/pending/:id`
— its `status` is `PENDING_APPROVAL`, not `QUEUED`. A message created by
`ai-message-generator.storeForApproval()` never appears in
`/ai-enhanced/pending-approvals` — its status is `QUEUED`. Neither list is the
whole queue, and nothing anywhere shows both.

The plan's claim that only three `approvalStatus` values are ever written **is**
correct — verified across all writers, including the third one
(`automated-message-generator.service.ts:186,216,566`, all `PENDING_APPROVAL`).
The claim about where state lives covers one of the two implementations.

**Consequence for P9:** the backfill must read **both** shapes, or it will
silently migrate half the pending approvals. Its source query cannot be a single
`WHERE status='QUEUED' AND queued_message->>...`.

**Plan amended:** proposed — P6 "What exists today (verified)" and the P9
backfill.

---

<a id="d47"></a>
#### D47 · Submit writes the message row; the dispatcher adopts it

`approvals.message_id` is `NOT NULL` and references `messages`, so a message row
must exist before an approval can. `Dispatcher.dispatch()` as written in P3
always INSERTs.

Left alone, one logical message would end up as **two rows** — one written at
submit, one at approve — and every count that reads `messages` would
double-count it: the gate's rate-limit window, the per-recipient throttle, the
retention sweep, and the analytics join.

**We did:** `OutboundMessage` gains an optional `messageId`. When present,
`persist()` UPDATEs that row instead of inserting. One row carries the whole
lifecycle:

```
PENDING_APPROVAL ──▶ QUEUED ──▶ SENT | FAILED
                 ├─▶ SUPPRESSED   (compliance said no, after approval)
                 └─▶ CANCELLED    (declined)
```

This is what D18 anticipated when it made `messages.sent_at` nullable: *"a
message in DRAFT or PENDING_APPROVAL has no send time, and P6 must be able to
store exactly that."*

**The metadata is merged, not replaced** (`||`), because the submit-time
delivery envelope — the `ContactPoint`, priority, playbook key, throttle — lives
there and `approve()` reads it back days later. Reconstructing the address from
`recipients.contact_points` at approve time was the alternative, and it silently
retargets a message whose recipient changed their address in between.

---

<a id="d48"></a>
#### D48 · `SENT` is written by delivery, not by the approver

The tempting implementation is: `approve()` dispatches, dispatch succeeds,
transition to `SENT`. It is wrong for scheduled messages — a message held in a
delayed BullMQ job for three days would show `SENT` in the approver's history
while nothing had been sent.

`record-result.ts` calls `ApprovalService.markSent()` after a successful
delivery instead, so the approval says `SENT` exactly when the message was sent.
Until then it rests at `APPROVED` / `EDITED_APPROVED` / `AUTO_APPROVED` /
`SCHEDULED`.

**A failed delivery does not close the approval** — it stays approved so a retry
or a human can still act. And `markSent` never throws: a bookkeeping failure
must not fail a delivery that succeeded.

The mirror case: a **permanent** compliance suppression moves the approval to
`CANCELLED` with the reason on the audit trail, rather than leaving it looking
approved-and-pending forever. A **deferrable** one leaves it approved, because
`retryAt` means later, not never — and nothing consumes `retryAt` yet (P7).

---

<a id="d49"></a>
#### D49 · `record-result` was destroying `metadata.playbookKey` on every send

**Found while wiring P6**, not by looking for it.

`record-result.ts` did `.set({ metadata: {...} })`, which **replaces** the whole
JSONB document rather than merging into it. It wrote back only
`{correlationId, to, attempt, dispatched}`.

The P5 compliance gate's per-playbook cooldown counts recent sends with:

```sql
WHERE metadata->>'playbookKey' = $1
```

(`gate.ts`, `throttleExceeded`). The dispatcher writes `playbookKey` when the
row goes to `QUEUED`; the recorder then deleted it the moment the message
succeeded. So the cooldown could only ever match messages that had **not** been
sent — `throttle.cooldownHours` never fired for a delivered message, which is
the only kind that matters.

**Fixed:** the update merges with `||`. Called out in the file so it does not get
"simplified" back.

**Not covered by a test before now** because the P3 queue tests assert on the
recorder's calls, not on the row afterwards. The P6 integration suite asserts
`metadata.playbookKey` survives the round trip.

---

<a id="d50"></a>
#### D50 · The escalation notice goes through the engine, so P6 ships a hook

The plan wants SLA escalation to notify the fallback approver **through a
`system.approval_escalation` playbook** — the engine using itself. That is the
right design and it is a good proof the abstraction holds.

P7 owns playbooks, so P6 cannot build it. `SlaSweeper` takes an injected
`notify` callback; unwired, an escalation still reassigns the approval and logs
at `warn`, it just sends no mail. P7 wires the playbook.

**Two sweeper behaviours worth stating, because both are deliberate refusals to
act:**

- **`EXPIRED` is written first, always**, as its own transition, before any
  expiry policy runs. Otherwise the audit trail implies a human declined at 3am.
- **No `fallbackApproverRef` means the approval stays `EXPIRED`.** Reopening it
  for the same person who already ignored it would restart the clock and hide
  the problem; `EXPIRED` is visible in the dashboard's `overdue` count.

Escalation is the **default** when a policy names no `onExpiry`, because it is
the only one of the three that does not decide on a human's behalf.

**A bug this found in itself:** the first version appended the escalation entry
to the trail as read at *scan* time, silently overwriting the `EXPIRED` entry
written moments earlier — an append-only log that was not. Caught by the
integration test; a unit test now pins it directly.

---

<a id="d51"></a>
#### D51 · Bulk needs the permission **and** the policy right

`outreach:approve:bulk` says *this user* may act in bulk. `policy.rights.bulk`
says *this policy* tolerates it. Both are required.

They are not redundant: a permission is granted per user, usually broadly, while
the right is authored per policy by the tenant. A clinic that decides messages
under `medspa.provider-always` must be read one at a time is not overridden by
an admin having been handed a broad permission somewhere else.

The source's `/bulk-action` has neither — no permission check, no tenant
predicate, and no `PENDING_APPROVAL` guard on the rows it updates
(`approvals.controller.ts:798-881`, contrast the guard the single-message paths
do have at `:342`). It also dereferences `currentMessage[0].providerId` before
checking `currentMessage.length > 0` (`:794` vs `:801`), so a missing id reports
`"Cannot read properties of undefined"` as its per-row error.

Per-row outcomes without aborting the batch is the one thing that path gets
right, and it is preserved.

---

<a id="d52"></a>
#### D52 · The P5 lint ruleset was never wired, so `lintWarnings` was always empty

**Open item said:** *"The lint ruleset is not yet wired into `ContentGenerator`
— the hook is still unpassed at the composition root | P6 or P7."*

**Why it had to be P6.** `engine/compliance/lint.ts` and
`packs/medspa/compliance.json` both shipped in P5, and nothing loaded either:
`loadPacks` read `aliases.json` and `prompts/*.json` only, and `index.ts`
constructed `ContentGenerator` with the `lint` hook unset. So
`generator.lintWarnings` was `[]` for every draft ever generated.

That is quiet in P4 — `aiConfidence` (D35) is `completeness − 0.15 × warnings`,
which degrades to pure completeness. It stops being quiet in P6, because
`threshold` mode's second condition is *"and lint passes with zero errors"*, and
an always-empty warning list makes that condition **vacuously true**. A tenant
opting into auto-approval would have got a lint check that could never fire.

**We did:** the loader reads `packs/<id>/compliance.json` with the same
`$comment`-stripping convention as `aliases.json`, exposes `compliance(packId?)`,
and the composition root merges every installed pack's rules over the engine
defaults and passes the linter.

Merging **all** packs rather than the draft's own is deliberate: the composition
root builds one generator and does not know which pack a given draft belongs to.
A false warning from another vertical's rules costs one human glance; the wiring
to thread a pack id through generation belongs with the playbook runtime in P7.

**Test:** `tests/unit/packs/loader.test.ts` pins the whole path — a pack
prohibited phrase warns, a pack PHI pattern warns where the engine defaults are
silent, and the engine's own length ceilings survive the merge.

---

### P7 — playbook runtime and the medspa pack

<a id="d53"></a>
#### D53 · Approval is decided by content source — none of the 17 event playbooks needs one today

> **Decided by you** after reviewing the evidence, 2026-08-04.

**Plan said:** *"Every one of these gets `approval_policy: medspa.provider-always`
unless it is staff-directed or system-directed."* — framing the staff/system
exception as the phase's one user-visible change.

**We found** the framing was inverted. **None** of the 17 event-driven cases
requires approval today. `enhanced-event-handler.ts` calls
`notificationQueueService.addNotification` directly in every case, and:

```
$ grep -rn "approval" src/events/ src/services/queue/
(nothing)
```

Approval exists only on the AI-draft path — `ai-message-generator.storeForApproval`
and the `ai-enhanced` controller. A provider has never approved an appointment
reminder and there is no screen where they could.

**Impact had we shipped the plan's text:** every appointment reminder,
confirmation, cancellation and birthday email would have stopped at cutover and
queued for a human. Worse in combination with D44 — approval now actually sends
— so the backlog would then have gone out all at once, days late.

**The rule instead:**

> `content_source.kind === 'ai'` → `medspa.provider-always`
> `content_source.kind === 'template'` → `system.transactional`

**Why a rule rather than a list.** It reproduces today's behaviour exactly, since
every switch-derived playbook is template-rendered and every approval-requiring
path today is AI-generated. And it answers the question for the 8 playbooks
seeded from the service modules without a second judgement call: seed by what
*generates* the content, not by who receives it.

The pack schema enforces the reasoning rather than the outcome — a playbook with
a non-template `content_source` and no `approvalPolicyKey` **fails validation at
load**, naming the file. An AI-written message that silently needs no review is
the one mistake this phase must not allow.

**Plan amended:** yes — the P7 approval paragraph is rewritten, with the evidence.

---

<a id="d54"></a>
#### D54 · Channels come from the trigger, intersected with the playbook's plan

**Plan said:** the playbook table lists channels per case — "SMS + EMAIL",
"EMAIL", "SLACK + EMAIL".

**We found** those are the *supported* set, not the effective one. Every case
guards each dispatch with `if (event.channels.includes(NotificationChannel.X))`
— 24 such checks across the 17 handlers. **The caller has always chosen the
channels**; the case only decides which choices it can honour.

An `APPOINTMENT_REMINDER` arriving with `channels: ['EMAIL']` sends one email
today, not an email and an SMS. Treating the plan's table as authoritative would
have doubled the message volume on every two-channel playbook.

**We did:** `channel_plan` is the supported set and `trigger.channels`
intersects it. A trigger naming no channels takes the whole plan, which is what
a scheduled or manual invocation wants.

**One exception, preserved:** `handleEmergencyNotification` pushes its Slack
notification **unconditionally** (`:533`), outside any `channels` check, and
hardcodes `priority: 'URGENT'` for both dispatches regardless of
`event.priority`. An emergency alert that a caller could silence by omitting a
channel would be a bad design; the pack expresses this as a Slack entry that
does not participate in the intersection.

---

<a id="d55"></a>
#### D55 · Four hardcoded destinations in the switch, not the one the plan flagged

**Plan said:** `to: 'emergency-team@medspa.com'` at `:549` must become
`tenant_packs.config.emergencyContacts[]`, "no literal survives".

**We found three more**, all Slack channel names, none mentioned:

| Line | Literal | Case |
|---|---|---|
| `:448` | `channel: 'staff-alerts'` | `handleStaffAlert` |
| `:536` | `channel: 'emergency-alerts'` | `handleEmergencyNotification` |
| `:711` | `channel: 'system-alerts'` | `handleSystemAlert` |
| `:549` | `to: 'emergency-team@medspa.com'` | `handleEmergencyNotification` |

A second medspa tenant would have had its staff alerts posted into the first
tenant's Slack channel. That is a cross-tenant leak of clinical operations
content, and it is live today for any tenant beyond the first — the same shape
as the D11 ghost-table finding, latent only because there is one tenant.

**We did:** `ChannelPlanEntry.fixedTarget` carries a destination that is not a
recipient's, and a `$config.` prefix resolves it from `tenant_packs.config` at
install. The exit-criteria grep (`grep -rn "medspa.com\|emergency-team" src/`)
covers the email; the three Slack names need the same treatment and are covered
by the pack's config requirements in `manifest.requiredConfig`.

---

<a id="d56"></a>
#### D56 · The `EventType` enum and the switch disagree — aliases are required, not convenience

The plan flagged two mismatches. Checking all 17 case labels against the
44-value enum in `models/communication.model.ts`, the switch matches strings
that **are not enum members at all**:

| Switch matches | Enum declares |
|---|---|
| `APPOINTMENT_RESCHEDULING` | `APPOINTMENT_RESCHEDULED` |
| `TREATMENT_COMPLETION` | `TREATMENT_COMPLETED` |
| `TREATMENT_FOLLOWUP` | `TREATMENT_FEEDBACK_REQUEST`, `APPOINTMENT_FOLLOW_UP` |
| `PATIENT_REGISTRATION` | `PATIENT_WELCOME` |
| `TREATMENT_PREPARATION` | *(absent entirely)* |
| `TREATMENT_INSTRUCTIONS` | *(absent entirely)* |
| `STAFF_ALERT`, `SHIFT_REMINDER` | *(absent entirely)* |
| `PATIENT_FEEDBACK_REQUEST` | *(absent entirely)* |

So a caller using the exported enum for a rescheduling gets
`APPOINTMENT_RESCHEDULED`, hits `default:`, and the message is silently dropped
with a `logger.warn`. Conversely eight handled event types are unreachable
through the enum and only work if the caller passes a raw string.

**Both spellings are in production callers**, so both must keep working.
`playbook_triggers.match_rules.eventTypeAliases` carries the alternates, and
`packs/medspa/event-types.json` is the catalogue. The engine's own trigger type
is `string` — it does not enumerate what events exist, which is the entire
reason the enum could drift from the switch in the first place.

**Consequence for P9/P10:** the 27 enum values with no handler are not a
migration gap — they never did anything. Do not seed playbooks for them.

---

<a id="d57"></a>
#### D57 · Pack content is validated at load, strictly

Every pack file is parsed through Zod with `.strict()` at boot, and a failure
names the file and the field path.

**Why strict matters more than it looks:** a `templateKey` misspelled
`template_key` would be silently ignored by a permissive parser, and the
playbook would render the wrong channel's body forever. `.strict()` turns that
into a startup error a person fixes in seconds.

**Why a bad file does not stop the process:** one malformed playbook costs that
playbook, not the pack, and one broken pack does not stop a tenant that never
installed it from being served. Errors are collected on `LoadedPack.errors`,
logged at `error` with the paths, and exposed through `registry.errors()` so a
health check can surface them. The alternative — refusing to boot — turns a
typo in an unused vertical's pack into an outage.

This is the direct answer to `default: logger.warn('Unknown event type')`, which
is how 27 of the source's 44 enum values came to have no handler with nobody
noticing.

---

<a id="d58"></a>
#### D58 · A `none` policy writes no approval row at all

**Found by a failing test I had written wrong.** The first version routed every
playbook naming a policy through `approvals.submit()`. For `mode: 'none'` that
produced an `approvals` row per message — `status = AUTO_APPROVED`,
`approver_ref = NULL`, decided by nobody, actionable by nobody.

An appointment-reminder-heavy tenant would grow `approvals` at exactly the rate
it grows `messages`, entirely with rows that exist to record that no decision
was needed. The migration comment I had already written claimed *"a `none`
policy never produces an approval row to act on"* — which was the intent, and
the code did not match it.

**We did:** the runtime loads the policy and skips `submit()` entirely when the
mode is `none`, dispatching directly.

**`sample` and `threshold` still go through submit**, and that is not
inconsistent: there the auto-approval is a real decision about a *specific*
message — this one was in the 90% the sample skipped, that one cleared the
confidence bar — and recording it is the entire point of having the mode. With
`none` there is no decision to record, only a policy that says there never is.

The playbook still names `system.transactional` explicitly rather than leaving
`approval_policy_id` NULL, so "no approval needed" is an authored, auditable
choice rather than an omission.

---

<a id="d59"></a>
#### D59 · AI playbooks ship inactive — they are new capability, not a port

`medspa.treatment-followup-ai`, `medspa.feedback-acknowledgement` and the other
model-written playbooks ship with `isActive: false`.

**Why:** nothing in the source sends them. `treatment-follow-up.service.ts` and
`feedback-analysis.service.ts` describe the *shape* of these messages, and the
plan lists them for seeding — but their persistence is stubbed demo code whose
tables are empty (D11), and no production code path fires them.

Shipping them active would mean deploying the pack silently starts sending a
class of message the tenant has never sent, written by a model. That is a
tenant's decision. Installing a pack should never be the moment it gets made.

The template-rendered playbooks — every one of the 17 — ship **active**, because
those are ports: they reproduce something the tenant is already sending.

A tenant switches one on with `POST /v1/playbooks/:key/activate`, which is one
call and no deploy.

---

### P8 — API surface

<a id="d60"></a>
#### D60 · The legacy surface is 110 endpoints, not 77

**Plan said:** *"24 routers, 77 HTTP endpoints"* (§0.2), and P8's exit criterion
is *"all 77 legacy endpoints have a passing contract test"*.

**We found** 110. The 77 is exactly what the session brief's own command
returns:

```
$ grep -cE "router\.(get|post|put|patch|delete)\(" src/routes/*.ts   # 77
```

That command only matches route files whose router variable is literally named
`router`. Five registration sites use a different name or live in a controller,
and none of them is small:

| Where | Variable / mechanism | Endpoints |
|---|---|---|
| `controllers/template-controller.ts:79-100` | `createTemplateRoutes(router, …)` | 14 |
| `controllers/ai-content-controller.ts:32-43` | `createAIContentRoutes(router, …)` | 8 |
| `routes/ehr-webhook.routes.ts` | `ehrWebhookRouter` | 3 |
| `routes/automated-messages.routes.ts` | `automatedMessagesRouter` | 4 |
| `mcp/index.ts:42-212` | `createMCPRouter()` | 4 |

Appendix A of the plan already **lists** all of them — its own per-group counts
sum to 109 — so the 77 in §0.2 and in the exit criterion contradicts the
appendix that enumerates the work. (109 rather than 110 because Appendix A's
`/mcp` row omits `POST /mcp/bedrock`.)

**Why it matters beyond arithmetic:** the two undercounted groups are the two
biggest single controllers in the phase. Sizing P8 off 77 hides 33 endpoints —
30% of the surface — and all 14 template endpoints are Seam A, which P10 depends
on.

**We did:** built the inventory from every registration site rather than the one
grep, and split the phase (see the P8a/P8b note in the handoff).

**Plan amended:** proposed — §0.2, the P8 exit criterion, and Appendix A's
`/mcp` row.

---

<a id="d61"></a>
#### D61 · The provider inbox is invalid SQL and has never returned a 200

**Plan said:** the inbox is *"the piece with the most behavioral risk"* and
*"the highest-risk single handler in the project"*; P8 should reimplement it
*"with the same output shape"* and pin that shape with a golden-file contract
test.

**We found** the handler cannot run. `getProviderInbox`
(`communications.controller.ts:1211-1230`) builds a `SELECT DISTINCT … GROUP BY
patient_id` whose select list contains a correlated subquery referencing two
**ungrouped** columns:

```sql
(SELECT metadata->>'patientName' FROM message_history m2
  WHERE m2.patient_id = message_history.patient_id
    AND m2.provider_id = message_history.provider_id   -- not in GROUP BY
    AND m2.medspa_id  = message_history.medspa_id)     -- not in GROUP BY
GROUP BY message_history.patient_id
```

Postgres rejects it before execution:

```
ERROR:  subquery uses ungrouped column "message_history.provider_id" from outer query
```

Verified by running the exact statement — reproduced from the drizzle builder
call, against a throwaway `postgres:16-alpine` container. It is a planner error,
not a data-dependent one: it fails on an empty table, so no fixture makes it
pass. Every request therefore falls into the catch at `:1378` and returns the
500 at `:1385`, `{success: false, message: 'Failed to get provider inbox'}`.

**Consequences for this phase:**

1. **There is no golden response to capture.** The plan's contract test would
   have pinned a 500. The response shape in P8 is derived by reading the
   unreachable code at `:1321-1377` — which is the right source, but it is a
   *specification*, not an observation, and it has never been exercised against
   the FE.
2. **The risk is inverted.** The plan treats this handler as the thing most
   likely to break at cutover. Nothing that currently 500s can regress. The real
   risk is that the FE screen starts working for the first time and renders
   fields nobody has seen populated.
3. `alerts.hasAdverse` / `requiresFollowup` were doubly dead: sourced from
   `patient_feedback`, a ghost table that is empty and tenant-blind (D11).

**We did:** built the shape from the code, and kept the two structurally-zero
fields (`queuedCount`, `pendingApprovalCount` in the thread summary — excluded by
their own query's `status <> 'QUEUED'` two lines earlier) rather than dropping
them, so a compat consumer sees the documented envelope.

**For P10:** whoever repoints `COMMUNICATION_SERVICE_URL` should know the inbox
goes from *always 500* to *working*. That is the same class of change as D44 —
not a regression, but not a no-op either, and the FE's error-path handling for
this screen has never been exercised against a success.

**Plan amended:** proposed — the P8 inbox section and Appendix F.

---

<a id="d62"></a>
#### D62 · Three more unscoped reads in the communications controller

D45 found every approval mutation missing its tenant predicate. The same
pattern is in the read paths, and it is not the same three call sites:

| Site | Query | Effect |
|---|---|---|
| `:242` `getCommunicationsByProvider` | `where(eq(providerId), metadata filter)` — **no `tenantWhere` at all** | a provider id from another tenant returns that tenant's messages; the route's `validateMedspaAccess` only compares the caller's own medspa to the header |
| `:1745` `markMessageAsRead` | `select().where(eq(id))` before deciding the response | the update is scoped, but the *existence* check is not — an already-read message from another tenant is returned in the 200 body at `:1780-1788` |
| `:1439` `getConversationThread` | `SELECT … FROM patients WHERE patient_id = $1` | Seam C, and no tenant predicate — a name from any tenant |

**We did:** every read in `MessageService` and `ConversationService` carries
`tenantWhere`, including the existence check behind `markRead`. Asserted in
`tests/integration/inbox.test.ts` — an id belonging to another tenant is a 404,
and the inbox never returns another tenant's conversations.

**Same caveat as D45:** this is a tightening. A caller relying on cross-tenant
reads gets a 404 rather than a row, and the P10 parallel run should watch for
them.

---

<a id="d63"></a>
#### D63 · The analytics endpoint 500s unless both dates are supplied

`getCommunicationAnalytics` formats its bounds **before** testing them
(`:551-552`):

```ts
dateFrom = `${dateFrom} 00:00:00`;
dateTo   = `${dateTo} 23:59:59.999`;
if (dateFrom) whereConditions.push(gte(sentAt, sql`CAST(${dateFrom} AS timestamptz)`));
```

With no query string, `dateFrom` is the string `"undefined 00:00:00"` — truthy —
so the predicate is added and the cast throws. `GET
/communications/analytics/medspa/:medspaId` with no date range 500s.

**We did:** apply each bound only when it was supplied. A bare date still means
the whole of that day, which is what `:552` was reaching for.

**Also fixed here:** `addFilterConditions` (`:1893-1895`) has an `if
(filters.eventType)` branch with an empty body and a comment saying the join
handles it — it does not. `?eventType=X` silently returns everything. The filter
now filters, against the joined `outreach_events.type`. A filter that does not
filter is not behaviour worth preserving, but it *is* a visible change for any
caller that passes the parameter today: they will get fewer rows.

Both are listed in `docs/api/BREAKING.md`.

---

<a id="d64"></a>
#### D64 · `/messages/webhook/*` is not a provider webhook, and never received one

**Plan said:** *"Port `webhooks-controller.ts`. It handles inbound SMS/email…
**Verify signatures.** Twilio `X-Twilio-Signature`, SendGrid event webhook
ECDSA, Slack `X-Slack-Signature`. Check whether the source does this; if it does
not, add it — an unauthenticated inbound webhook that writes to
`message_history` is a data-integrity hole."*

**We found** the source verifies nothing — and the endpoint is not
unauthenticated either. It is not a provider endpoint at all:

- It reads `{fromNumber, messageContent, patientId, providerId, medspaId}` from
  a **JSON** body (`webhooks-controller.ts:113-123`). Twilio posts
  `application/x-www-form-urlencoded` with `From`/`To`/`Body`/`MessageSid`/
  `AccountSid`; SendGrid posts a JSON **array** of events keyed by
  `sg_message_id`. Neither would parse into this shape.
- It is mounted inside `setupRoutes`, **behind** the global gateway auth. A real
  callback carries no `x-gateway-request` header and would get a 403 before
  reaching the handler.

So the hole is not the one the plan describes. The source has an internal
reply-ingestion API that nothing external can reach, and **no delivery-receipt
handling anywhere** — nothing ever joins a provider's message id back to a row.
That is why `provider_message_id` had to be added in P2 and populated in P3
(D22); P8b is its first reader.

**We did:** ship two different things.

| | Path | Auth | Body |
|---|---|---|---|
| real provider callbacks | `/v1/webhooks/{twilio,sendgrid,slack}` | signature, pre-auth, pre-body-parser | the provider's own |
| the source's endpoint | `/messages/webhook/{sms,email}` | gateway, unchanged | the internal envelope |

**Three further changes on the legacy path**, all recorded in
`docs/api/BREAKING.md`:

- **A first-contact reply is no longer dropped.** The source requires an
  existing OUTBOUND message on the same channel before it stores anything
  (`:128`), so the first thing a recipient ever sends 404s.
- **The AI reply is not generated inline.** `:173` calls
  `generateConversationReply` inside the request, so a webhook blocks on a
  Bedrock round trip and a model timeout looks like a failed webhook — which the
  caller then retries, generating again. It becomes a `PATIENT_REPLY` trigger on
  the playbook runtime.
- The `generate-reply` lookup is tenant-scoped (`:368` is a bare `eq(id)`, the
  same shape as D62).

**Signature verification fails closed.** A deployment with no verification
secret configured rejects the callback rather than accepting it, because an
unverified endpoint that writes to `messages` lets anyone mark a message
delivered or inject a reply into a clinical conversation.
`WEBHOOK_REQUIRE_SIGNATURE=false` exists for local development and logs a
warning on every request.

**The Twilio URL is the production trap.** Twilio signs the **full URL it
requested**; behind a gateway that strips `/api/communication` and a load
balancer that terminates TLS, a reconstructed URL is a different string and
every signature fails. `WEBHOOK_PUBLIC_URL` states the real one, and a test
pins that a mismatched URL is rejected.

---

<a id="d65"></a>
#### D65 · MCP discovery is pre-auth; execution is authenticated inside the router

**Plan said:** preserve two behaviours — `GET /mcp/tools` reachable without
gateway headers, and the header-wins-over-body tenant guard at
`mcp/index.ts:70-80`.

**The tension the plan does not mention:** those two requirements pull opposite
ways. Mounting the router before the auth middleware is what makes discovery
work, and it also means `req.identity` is never resolved — so a tool call
arriving at the same router has no tenant to scope by. The source resolves this
by mounting the router **twice** (once pre-auth in `index.ts`, once inside
`setupRoutes`) and having the tool executor read `req.headers['x-medspa-id']`
directly, which is why its tenant guard is a header read rather than an identity
read.

**We did:** mount once, pre-auth, and apply the auth middleware to the two
executing routes *inside* the router. The split is then one file and readable:
`/tools` and `/health` are open, `/tools/:name` and `/bedrock` are not.

**We went further than the guard.** The source strips a body-supplied
`medspaId`; here no tool schema declares one at all. Advertising a parameter
that is silently overridden invites a caller to rely on it — and the comment at
`:70-80` exists because someone did.

**`clearFailedJobs` reports the truth.** The source's queue service has no such
method; the HTTP endpoint probes for one, misses, swallows the miss and reports
success. BullMQ's `removeOnFail` retention already does the work, so the tool
says so rather than pretending.

---

<a id="d66"></a>
#### D66 · The template engine has no tenant scoping whatsoever

**Found while porting the 14 `/templates` endpoints:**

```
$ grep -c "medspaId\|tenantId" services/templates/template-engine.ts
0
```

`listTemplates(filter)`, `getTemplate(id)`, `updateTemplate(id, …)` and
`deleteTemplate(id)` take no tenant and apply no predicate. Every one of the
fourteen endpoints reads and writes across tenants: any authenticated caller can
list another clinic's templates, read the body of one, edit it, or delete it.

This is broader than D45 (six approval mutations) and D62 (three controller
reads) — it is the entire router, including the destructive verbs.

**Why it matters more than the others:** this is **Seam A**. providers-service
proxies the router *and* holds the real foreign keys
(`template_versions.template_id`, `notification_rules.email_template_id`/
`sms_template_id`). A cross-tenant `DELETE` cascades into another tenant's
template versions.

Latent with one tenant, exactly like the ghost tables (D11). Not latent after
P10, which is when a second tenant becomes possible.

**We did:** every path goes through `DrizzleTemplateStore`, which takes a
tenantId on every call. Asserted in `tests/contract/legacy/content-endpoints.test.ts`
— a second tenant gets 404 on read, an empty list, and `success: false` on
delete.

**Response shapes are preserved as-is**, inconsistent as they are —
`{templates}`, `{templateId}`, `{success}`, `{metadata, content}`, and no
`success` envelope anywhere. providers-service reads `templateId` off a create
and `templates` off a list.

---

<a id="d67"></a>
#### D67 · Eight `/ai` endpoints are one endpoint and seven prompt packs

`ai-content-controller.ts` has eight handlers — generate, enhance, personalize,
analyze, multimodal, follow-up, promotional, educational — and each builds a
slightly different prompt **string in TypeScript** before calling the same
`aiService.generateContent`. Adding a ninth mode, or changing the wording of an
existing one, means editing a controller and shipping a release.

**We did:** one handler, seven prompt pack keys, resolved from the path. The
prompts ship as `packs/core/prompts/*.json` — a **core** pack rather than the
medspa one, because "rewrite this more clearly" is not vertical vocabulary and a
gym would use it unchanged.

**A mode whose pack is not installed answers 404 naming the key**, rather than
falling back to a generic prompt. The source cannot fail this way, which sounds
like a virtue until you notice it is the same property that makes its prompts
unchangeable without a deploy.

**`temperature` and `maxTokens` are no longer per-request.** The source accepts
both from the body (`:96-98`), so two callers of the same mode can get
differently-sampled output and blame the pack. The pack owns sampling; `model`
stays overridable because it is an editorial choice, not a sampling one.

**`/ai/multimodal` answers 501.** `LlmProvider` is text-only by design
(`generate` / `generateJson`), so this needs a port change rather than a router
change. Same for `/templates/generate-with-images` and
`/templates/assets/generate-image`; `/templates/assets/upload` needs a storage
adapter that `config.storage` declares and nothing implements yet.

---

<a id="d68"></a>
#### D68 · The EHR mapper refuses to guess, and one of its targets never had a handler

**Plan said:** `event-mapper.service.ts` becomes
`packs/medspa/ehr-mapping.json` + a generic mapper in
`src/engine/playbooks/ehr-mapper.ts`.

**Done**, and the source's three layers collapse to two rule kinds: `event`
(exact) and `contains` (every term must appear). Exact beats pattern; within a
tier, **first declared wins**. The source's precedence is the same in effect but
emergent from the order of `if` statements across three methods.

**The third layer is not ported.** `getContextualMapping` returns a mapping for
an event it does not recognise — so an unknown vendor event still produces a
message, chosen by a heuristic nobody reviewed, sent to a patient. An unmapped
event is `null` here, reported as `{mapped: false}` with a 200. Guessing what a
clinic meant is not a safe default when the output is a message to their
patient.

**A test found something the port would otherwise have carried over silently.**
`tests/unit/playbooks/ehr-mapper.test.ts` asserts every rule targets an event
the pack declares. `APPOINTMENT_MISSED` failed: it is in the source's
`EventType` enum, its EHR mapper maps both `appointment_missed` and
`appointment_no_show` onto it — and the 17-case switch **has no case for it**,
so it hits `default: logger.warn` and is dropped (D56).

**The EHR path for a missed appointment has therefore never sent anything.**

It is declared in `event-types.json` now, with a comment saying why, so the drop
becomes a `SKIPPED` `playbook_runs` row instead of silence. Authoring the
playbook is new capability rather than a port, so it is a tenant's call (D59).

---

<a id="d69"></a>
#### D69 · One analytics row per message, and an index the receipt lookup can use

**Found by re-reading the P8b webhook path after a question about the inbox's
query count.** Two defects, both mine, both invisible until receipts actually
flow — which is why nothing caught them: `message_analytics` had only ever held
rows written one at a time by hand, because nothing in the source consumes a
delivery receipt at all.

**1. `onConflictDoNothing()` with nothing to conflict on.**

`idx_message_analytics_message` is a plain index, not unique. `ON CONFLICT DO
NOTHING` without a target only skips on an actual unique violation, so with no
constraint there is never one and **every receipt inserted a new row**.

That is not untidy, it is incoherent. `MessageService.list`, `.getById` and
`ConversationService.thread` all LEFT JOIN this table:

```
ANALYTICS ROWS: 2      # one open, one click
LIST ROWS: 2  TOTAL: 1 # the same message, twice
```

`data.length !== total`. A page of 50 could return 80 rows, and the legacy
`PaginatedResponse` envelope the FE reads stops meaning anything. Reproduced
before the fix was written.

**2. The receipt lookup could not use its index.**

`idx_messages_provider_message_id` is on `(tenant_id, provider_message_id)` —
right for a tenant-scoped query, useless for the one that actually runs. A
provider callback carries no tenant, so `ReceiptService.apply` looks the row up
by `provider_message_id` alone and reads the tenant off it (D64). A btree cannot
serve a predicate that skips its leading column, so **every receipt sequentially
scanned the largest table in the service**.

Harmless on an empty table; on a production `messages` with SendGrid batching
event callbacks, it is the kind of thing that presents as a database problem
rather than a missing index.

**We did:** `migrations/0008_receipt_integrity.sql` — a partial unique index on
`message_analytics (message_id)`, and a partial index on `messages
(provider_message_id)`. The migration deduplicates first, folding each
duplicate's non-null engagement fields into the earliest row, so no observed
open or click is lost; on a database that has never taken a receipt it is a
no-op. `upsertAnalytics` replaces both insert sites.

**First event wins on each timestamp.** `opened_at` is when the message was
*first* opened, which is the number "time to open" needs. A provider sends one
callback per open, so last-write-wins would quietly redefine the column as "most
recently opened". Metadata is merged with `||`, not replaced — the same mistake
as D49, in a second place.

**Neither index is expressible in the Drizzle model** (both are partial), so
they are two more of the constraints D15 flags as needing human eyes. The
conformance test asserts both exist and checks their predicates, and
`tests/integration/webhooks.test.ts` asserts the row count and the first-open
semantics end to end.

**This is the first migration since P7**, and the plan's phase map said P8 ships
none. It ships one, because the alternative is a defect that corrupts every
message list the moment webhooks are wired up.

---

### P9 — data migration

<a id="d70"></a>
#### D70 · The 9xxx files are renumbered so numeric order is dependency order

**Plan said:** 9001 tenants, 9002 channel configs, 9003 recipients, 9004
templates, 9005 preferences, **9006 messages, 9007 approvals, 9008 events and
the rest**, 9009 deleted, 9010 verify.

**We did:** 9000 prelude, 9001 source link, 9002 tenants, 9003 channel configs,
9004 recipients, 9005 templates, 9006 preferences, **9007 events, 9008
messages, 9009 approvals**, 9010 verify.

**Why:** the plan's order cannot run. `messages.event_id` and
`messages.notification_id` are real foreign keys (0001), so loading messages
before events and notifications fails on every row that has one. The
alternatives were worse: load messages with those columns NULL and fill them in
with a second pass over the largest table in the database, or keep the numbers
and tell the operator to run the files out of numeric order — a footgun aimed at
the one person who cannot afford one.

Two files are new. `9000_prelude.sql` holds machinery the plan assumed into
existence (the watermark table, the helper functions); `9001_source_link.sql`
is the FDW setup the plan called `9000_fdw_setup.sql` and had to move down one
to make room. `9010_verify.sql` keeps its number.

**There is no pack migration at any number.** The plan struck through `9009
pack_medspa.sql` when P2 closed §0.5 Seam D (D11, D12), and 9009 is now the
approvals backfill. The runbook and `migrations/README.md` both say so, because
"9009" plus "pack" in the same sentence is exactly the kind of thing a future
reader half-remembers.

**Plan amended:** not yet — proposed, awaiting a yes (agreement 1.2).

---

<a id="d71"></a>
#### D71 · Naive source timestamps are converted at a declared zone

**Plan said:** nothing. It treats the columns as if they carried the same
meaning on both sides.

**We did:** every timestamp crosses through `mig.to_tz()`, which reads
`mig.settings.source_timezone` (default `UTC`), and the chunk windows cross back
through `mig.to_src()`.

**Why:** the source is `timestamp without time zone` everywhere and the target
is `timestamptz` everywhere (0001's header, divergence 1). An implicit cast
between them uses the **session's** `TimeZone`, so the same script run by an
operator in New York and by one on a UTC pod produces instants five hours apart
— silently, and visibly wrong only months later inside a quiet-hours check.
Stating the zone once, in a settings row, makes it a decision instead of an
accident, and `scripts/inspect-source.sql` §0 is the check that the default is
right.

`mig.to_src()` is the inverse, and it exists for a performance reason rather
than a correctness one: postgres_fdw can only push a predicate to the remote
server when it compares a bare column to a value of the same type, so
`mig.to_tz(created_at) >= $1` would drag the whole table across the link on
every chunk. Converting the window bounds instead keeps the predicate pushable.

---

<a id="d72"></a>
#### D72 · Recipient ids are UUID v5 over (tenant, patient)

**Plan said:** deterministic `uuid_generate_v5` on `(tenant_id, patient_id)`.
Adopted, with one substitution.

**We did:** `mig.uuid_v5()`, implemented on pgcrypto's `digest()` rather than on
uuid-ossp's `uuid_generate_v5`, under a fixed namespace constant.

**Why the substitution:** 0001 already requires pgcrypto, and adding a second
extension to a production RDS instance for one function is a change-control
conversation nobody needs. The implementation is RFC 4122 §4.3 and the prelude
carries the standard test vector so it can be checked against any other
implementation in one query.

**Why derived ids at all:** re-running any loader lands on the same rows, so
`ON CONFLICT DO NOTHING` is a real no-op; 9007–9009 compute a message's
recipient without joining a crosswalk table; and the delta sync, run days later,
resolves to the same recipients as the bulk load. **The namespace constant is
permanent** — changing it re-keys every recipient and orphans every message,
preference and approval pointing at one.

---

<a id="d73"></a>
#### D73 · Both of the plan's approval predicates miss rows

**Plan said (§P9, 9007):** shape A is `status='QUEUED' AND
queued_message->>'approvalStatus' IS NOT NULL`; shape B is
`status IN (…) AND queued_message IS NULL`.

**We did:** shape A is `queued_message->>'approvalStatus' IS NOT NULL`, with no
predicate on the status column. Shape B is its exact complement.

**Why:** each of the plan's predicates loses rows, and each loses a different
kind.

- **Shape A rows do not stay `QUEUED`.** `approvals.controller.ts:360` writes
  `status: 'APPROVED'` to the column at the same time as it writes the blob, so
  every already-decided shape A row has `status = 'APPROVED'` and the plan's
  predicate skips it. Those are precisely the rows the D44 backlog decision is
  about.
- **`queued_message` is not reliably NULL on shape B rows.** The column was
  added with no default (`0003_fix_queued_message.sql`) but the Drizzle model
  declares `.default('{}'::jsonb)` (`schema/db.ts:152`), so whether a row holds
  NULL or `{}` depends on whether anyone ever ran `drizzle push`. A row holding
  `{}` matches neither of the plan's two predicates and would have been lost by
  both passes at once.

Defining shape A on the presence of the key and shape B as its complement makes
the two provably disjoint and provably exhaustive. `tests/integration/migration.test.ts`
seeds a row of each kind, including one with `queued_message = '{}'`, and 9010
checks coverage in the direction that matters: no approval-shaped source row may
end up without an approval.

The recon script counts the same two shapes the same way, so its numbers and the
migration's agree by construction rather than by luck.

---

<a id="d74"></a>
#### D74 · `sent_at IS NULL` is never true, so the backlog is defined by status alone

**Plan said (§P9 step 1):**
```sql
SELECT count(*) FROM message_history
WHERE (status = 'APPROVED' OR queued_message->>'approvalStatus' = 'APPROVED')
  AND sent_at IS NULL;
```
— presented as "how many approved messages were never sent", the number that
drives the 9007b decision.

**We did:** dropped the `sent_at` predicate, and print both numbers so the
difference is visible.

**Why:** `message_history.sent_at` is `NOT NULL` — in the source's own migration
(`0000_spicy_valeria_richards.sql`) and in `schema/db.ts:149` — and it is written
at INSERT time, not at send time. The plan's query therefore returns **0 on any
data**, and it returns it for the most dangerous possible reason: it looks like
the reassuring answer. An operator reading "0 messages were approved but never
sent" would conclude there is no backlog and pick the `APPROVED` disposition.

Since approving has never dispatched anything at all (D44), "approved" and
"sent" are simply unrelated in this data: every approved row is unsent. The
count that matters is `approved_any`.

This is also why 9008 copies `sent_at` verbatim onto messages that were never
sent. It is the row's timestamp, the target's inbox and conversation queries
order by it (`idx_messages_conversation`), and NULLs sort first in a `DESC`
ordering — nulling it out would float every draft to the top of every
conversation.

---

<a id="d75"></a>
#### D75 · A migrated message must look like one the engine wrote

**Plan said:** copy `status` across.

**We did:** `mig.map_message_status()`, and 9009 additionally rewrites a
message to `PENDING_APPROVAL` when its approval is open.

**Why:** the source keeps delivery state and approval state in one column, so
`'APPROVED'` means both "a human said yes" and "this is where the message got
to". The engine separates them, and the words on each side differ:

| source | target | because |
|---|---|---|
| `PENDING_APPROVAL` | `PENDING_APPROVAL` | what `approval.service.ts:316` writes |
| `QUEUED` + an open approval | `PENDING_APPROVAL` | ditto — the source calls the same row QUEUED |
| `APPROVED` | `PENDING`, then `CANCELLED` under the default disposition | nothing was ever sent (D44) |
| `DECLINED` / `REJECTED` | `CANCELLED` | what `approval.service.ts:585` writes on a decline |
| anything unrecognised | quarantined | inventing a state is worse than reporting one |

The rule behind the table: a migrated row has to be indistinguishable from one
the engine wrote, or it is invisible to the screens built for it. A message left
`QUEUED` with an open approval never appears in `MessageService.list({status:
'PENDING_APPROVAL'})`, which is the query behind the approval inbox.

`suppression_reason` stays NULL throughout: its CHECK (0005) enumerates the
compliance gate's reasons and "a human said no" is not one of them.

---

<a id="d76"></a>
#### D76 · Unattributable rows are quarantined, never guessed

**Plan said:** rows with a NULL `patient_id` "are dropped with a logged count".

**We did:** every row that cannot be migrated is written whole into
`mig.rejects` with its reason, and 9010 reports the total as a WARN.

**Why:** "dropped with a logged count" answers *how many* and never *which*, and
the log line is gone by the time anyone asks. Five source tables
(`communication_batches`, `notifications`, `scheduled_communications`,
`ai_interactions`, `campaign_recipients`) carry no tenant column at all, so their
tenant is derived from a parent — and a missing parent is not rare enough to
handle by shrugging.

The alternative to quarantining is guessing a tenant, and `tenant_id` is the
isolation boundary (hard rule 4). A guessed tenant is a cross-tenant leak that
nobody would ever find, because the row looks exactly like a legitimate one.

Almost every rejection reason is a data problem an operator can fix in the
source and re-run, which is the other half of the argument: the row is kept so
that fixing it is possible.

---

<a id="d77"></a>
#### D77 · Operator knobs live in a settings table, not psql variables

**Plan said:** nothing; it assumed `psql -v`.

**We did:** `mig.settings`, a table of key/value/note rows the operator UPDATEs.

**Why:** the same files have to behave identically under `psql` and under
node-postgres, because `tests/integration/migration.test.ts` runs every one of
them and it does not implement psql's meta-commands. `\if` and `:'var'` would
make the series untestable, and an untested migration is the thing this phase
exists to avoid.

A table also leaves a record of what a run was actually configured with, which a
command-line flag does not — six months from now "what did we set
`historic_approved_disposition` to?" has an answer in the database rather than
in someone's shell history.

The same reasoning produced the `-- @@ SPLIT @@` marker: the chunked loaders
COMMIT between windows, node-postgres wraps a multi-statement string in an
implicit transaction, and a procedure cannot COMMIT inside one. The marker is a
comment psql ignores and the test splits on.

---

<a id="d78"></a>
#### D78 · Watermarks lag `now()`, and the delta re-reads a trailing window

**Plan said (§P9 step 4):** re-run the loaders `WHERE created_at > watermark`.

**We did:** that, plus two things it needs to actually work.

**A watermark never advances past `now() - watermark_lag_minutes` (default 5).**
Without the lag there is a silent hole: a loader computes its ceiling, scans
under one MVCC snapshot, and marks the window done — while a transaction that
started before that snapshot commits after it, inserting rows whose `created_at`
falls inside the window just completed. No later run looks there again. On a
busy source that is a handful of messages lost per pass, invisibly. Re-reading
the overlap costs nothing because every INSERT is `ON CONFLICT DO NOTHING`. The
runbook has the operator set the lag to 0 for the final delta, once the old
service is stopped and nothing can still be in flight.

**`message_history` has no `updated_at`.** A row migrated on Tuesday that is
delivered on Wednesday and approved on Thursday still carries Tuesday's
`created_at`, so no watermark on `created_at` can ever see the change — and the
plan's delta is watermark-only. `mig.refresh_recent()` re-reads a trailing
window (`delta_refresh_days`, default 7) and refreshes delivery state, content
and approval state. **Rows older than the window that change are still not
picked up**, which is a real limit stated in the runbook rather than papered
over.

The refresh treats mentera-core as the source of truth for every row it touches,
which is correct only while the old service is the only writer — so the runbook
puts the final delta inside the cutover window, before the new service starts
serving. It also refuses to touch an approval whose audit trail is no longer the
single entry the migration wrote: anything a human has decided in the new system
is theirs.

---

<a id="d79"></a>
#### D79 · The event switch's templates are files on disk, not table rows

**Open item said:** "the medspa pack's template bodies are engine-authored
defaults; P9 must map the real `communication_templates` rows onto the pack's
keys."

**We did:** nothing, because there is nothing to map.

**Why:** the 21 hardcoded `templateId` literals in
`events/enhanced-event-handler.ts` are slugs — `'appointment-reminder'`,
`'treatment-followup'` — and they are not `communication_templates` ids. Follow
either path they take:

- **SMS** → `sendTemplatedSMS` → `templateEngine.renderTemplate(templateId, …)`
  → `getTemplate()`, which is
  `path.join(this.storage.templatesPath, templateId)` plus
  `fs.existsSync` (`template-engine.ts:442-457`). A **directory on disk**, read
  with `fs`, with its own `metadata.json`.
- **Email** → `sendgrid.ts:86`, `msg.templateId = params.templateId` — that is
  **SendGrid's** dynamic-template id, which lives in SendGrid, not here.

Neither reaches the `communication_templates` table, and neither slug is a UUID,
so neither could. The table is what the `/templates` CRUD router and
providers-service's `notification_rules` use, and those are migrated by id
(9005), which is what §0.5 Seam A actually requires.

So the medspa pack's template bodies replace **filesystem templates**, not
database rows, and the migrated rows keep `key = NULL` and stay reachable
exactly as they are today. A tenant that wants a playbook to render its own
wording edits pack content or PUTs the template — a content change, not a data
migration. The open item is closed.

---

<a id="d80"></a>
#### D80 · One stored spelling for a channel, and it is lower case

**We found:** `messages.channel` had no convention at all. `dispatcher.ts:142`
and `approval.service.ts:313` wrote the lowercase `ChannelType`;
`receipt.service.ts:232` wrote `input.channel.toUpperCase()`; every row migrated
from mentera-core carried the source's upper case; and `message.service.ts:96`
searched with `f.channel.toUpperCase()`. So a channel filter could never match a
message the engine itself had sent.

**We did:** lower case is the stored spelling, everywhere. `normalizeChannel()`
(`ports/channel.ts`) is the one place that says so; the inbound writer, both
filter paths and the P9 loaders use it. Upper case survives only at the legacy
boundary, where `toLegacyChannel` already put it back — so **no legacy response
changes**.

**Why lower case rather than upper**, given that upper is what the source stores
and what the legacy API emits: three consumers inside the engine read the column
back and require `ChannelType`.

- `ApprovalService.release` casts `row.channel as ChannelType` and hands it to
  `dispatcher.dispatch()` → `registry.get(channel)`, which has no fallback.
  Approving a **migrated** message would have looked for an adapter registered
  as `'EMAIL'` and thrown. That is a cutover-blocking bug, not a cosmetic one:
  the first thing P10 does is let providers work their pending queue.
- `ComplianceGate.countSent` counts with `eq(messages.channel, channel)` for a
  `ChannelType`. Rows in the other spelling are invisible, so a per-channel rate
  limit under-counts — silently, in the direction of sending more.
- `AnalyticsService` groups by the raw column, so two spellings become two
  buckets for one channel.

Storing upper case would have meant changing all three plus the port's type. One
column, one spelling, converted at the edge.

**Consequences for P9:** `9008_messages.sql` and `9007_events.sql` lower-case
`channel` on the way across. An earlier draft of this entry said they preserved
the source's upper case, on the theory that the read path uppercased its filter —
which was the bug, not the contract.

**Regression cover**, because the defect survived P3 through P8b by never being
exercised: `tests/integration/inbox.test.ts` filters a dispatched message by
`sms`/`SMS`/`Sms`, `tests/integration/approvals.test.ts` releases an approval
whose row was forced back to `'EMAIL'`, and `tests/integration/migration.test.ts`
asserts the migrated spelling.

`templates.channel` was already lower case and is untouched — `content/store.ts`
matches it exactly and every pack ships lower case.

---

### P10 — cutover

<a id="d84"></a>
#### D84 · P12 cannot run before P10, and two of its workstreams would break the cutover

**Asked:** do P12 instead of P10, if P12 is independent of it and doing it first
costs P10 nothing.

**Answer: no, on both counts.** Checked against the code rather than the phase
map, because the phase map's `Depends on` column is sometimes risk sequencing
rather than mechanism — that is exactly what D81 found for P11.

Here it is mechanism. Three of the five workstreams are hard-blocked:

**Workstream 2 deletes the thing the cutover runs on.** All fourteen files under
`src/api/compat/` open with `// DELETE IN P12`, and the directory's own header
says they exist "so P10's cutover is an env-var change and nothing else". Worse
is *how* P12 decides what to delete: it reads 30 days of
`outreach_compat_hits_total` and drops every path with no hits. That counter
only records anything once P10 routes traffic through the shim. Today every
label is zero, so the measurement that is supposed to make the deletion safe
would instead authorise deleting all of it.

**The header aliases are load-bearing until the gateway changes.** P12 drops the
`x-medspa-id` / `x-location-id` fallbacks in `auth.middleware.ts:171-172`. The
gateway does not send `x-tenant-id` anywhere — `packages/gateway/src/index.ts`
mentions only `x-medspa-id`, at :77, :155, :199 and :247, and *requires* it at
:77. Remove the fallback first and every proxied request arrives with an empty
tenant id. §0.7 already says the aliases stay "for the whole parallel-run
window"; the point here is that the window has not opened yet.

**Workstream 5 edits `mentera_core`**, which hard rule 2 forbids before P10, and
would point Tera's MCP tools at a service not yet serving traffic.

Two more are softer but real: encrypting channel credentials nulls the plaintext
columns that `9003_channel_configs.sql` is still inserting into during the
parallel run, and the package split rebuilds the deploy artifact at the moment
P10 Step 2 most wants a stable one.

**What is genuinely independent:** workstream 3b — the storage adapter and the
image-capable `LlmProvider` behind the five `501`s. It touches no compat path,
no header, no credential and no other repo. If P10 stalls on operator
availability, that is the piece that can proceed.

---

<a id="d85"></a>
#### D85 · P9 dropped five preference columns; they are carried across rather than retired

**Found:** resolving §0.5 Seam B. `9006_preferences.sql` migrated eighteen
columns off `communication_preferences` and none of `email_opt_in`,
`sms_opt_in`, `push_opt_in`, `voice_opt_in`, `direct_mail_opt_in`.

**Why it was invisible at P9:** nothing reads them. A grep for `email_opt_in`
over the whole of `services/communication-service/src/` returns zero, and the
engine gates per-channel consent on `preferred_channels` and global consent on
`allow_communications` — both of which 9006 does carry. **This is not a
compliance gap**, which was the first thing checked, given that 9006's own
comments call preference staleness a compliance failure.

**Why it matters anyway:** patient-service LEFT JOINs the source table onto
every patient lookup (`patient.repository.ts:151-158`) and hands the row to the
FE as `communicationPreference`. The FE reads exactly these five booleans, in
six places across web and mobile (`types/patient.ts:46`,
`utils/patient.utils.ts:127`, `utils/approvals.utils.ts:54`,
`PatientOverview.tsx:61`, `demographicsProvider.ts:38`, mobile
`PatientDetailsScreen.tsx:259`). Seam B drops that JOIN. Without these columns
the engine cannot replace what the JOIN supplied.

**What the flags actually are, established before deciding:** inert, in all four
directions. Nothing in mentera_core writes them — the only occurrence anywhere
is the column declaration at `patient-service/src/db/schema.ts:156`. The source
service never read them. The FE's toggles call `setPreferences` and nothing
else, so they do not persist. No send has ever been gated on them. Every row
holds the column default and always has.

**Decision (the user's, asked explicitly): carry them across verbatim, and keep
them as an unfinished feature rather than dead weight.**

Three reasons, in order of weight:

1. **The option is only recoverable now.** Once the source database is
   decommissioned these values exist in a backup and nowhere else. Carrying five
   nullable booleans is close to free; recovering them later is not.
2. **The feature is half-built, not abandoned.** The UI exists and users can see
   it. The storage exists, and is now tenant-scoped and migrated. What is
   missing is a write path and enforcement — that is a feature to finish, and
   the shape of the finished thing is legible from what is already here.
3. **Deriving them from `preferred_channels` would have been worse.** It would
   make five toggles start meaning something they have never meant, silently,
   during a cutover.

**What finishing it requires**, recorded so it is not re-derived: a write path
(they are deliberately absent from `PreferencePatch` and the `PUT` schema —
nothing wrote them before and P10 was not the place to add a mutation),
enforcement in `ComplianceGate`, and an FE mutation behind the existing toggles.

**The real debt is not the columns.** It is that `preferred_channels` already
expresses per-channel consent in a different shape, so the engine now carries
two overlapping representations of the same idea. Reconciling them is the design
question; keeping the columns just preserves the ability to answer it.

Written on the columns themselves via `COMMENT ON COLUMN`, on all five, so
`\d recipient_preferences` says "RESERVED — not yet enforced" to anyone who
looks before building on them.

**Shipped as:** `0010_recipient_optins.sql` (nullable, `DEFAULT true`, matching
the source's `.default(true)` without `.notNull()`), the five columns on
`recipientPreferences`, and 9006 carrying them in its INSERT *and* its
`DO UPDATE` — the latter so a re-run repairs rows loaded before `0010` existed,
which took the ADD COLUMN default instead of the source's value.

**Two things this nearly broke.** `scripts/csv-staging.sql` declares
`src.communication_preferences` column by column, unlike the FDW path where
`IMPORT FOREIGN SCHEMA … LIMIT TO` restricts tables and not columns — so the
transport of last resort would have failed on `column l.email_opt_in does not
exist`. And the migration test builds its fixture from that same file, which is
why the fixture now sets a `false` and a `NULL` among the flags: a load that let
the column default stand would otherwise pass.

---

<a id="d86"></a>
#### D86 · Step 5 runs before Step 2, because the callers are already broken

**Plan said:** repoint staging (Step 2), watch for 4xx, and treat any of them as
a P8 bug in the shim. Clean up the five inbound callers three steps later.

**We did:** moved the caller fix to Step 0, before anything is repointed.

**Why:** the callers do not survive the repoint. Checked one by one against the
engine's auth rather than assumed:

| Caller | Sends | After the repoint |
|---|---|---|
| `settings.service.ts`, 8 template methods | `Content-Type`, tenant as a `medspaId` query param | 401 |
| `integration-settings.service.ts`, config read + write | no headers at all | 401 |
| `email.service.ts`, verification / invite / reset | `x-gateway-request`, `x-user-id`, `x-user-role`, no tenant | 401 |

The source has no authorization worth the name — `template-engine.ts` does not
contain the string `medspaId` anywhere — so the query parameter has always been
decorative and every one of these calls has run unscoped. The engine resolves
the tenant from headers and `requireTenant` throws without one
(`auth.middleware.ts:213`). These bypass the gateway (`COMMUNICATION_SERVICE_URL`
points at the service), so nothing supplies the headers for them.

Step 2's rule — "any 4xx on a compat path is a P8 bug, fix the engine" — would
have sent someone looking for the fault in the shim. It is not there.

The fix is inert against the old service, which is what makes it safe to land
first: extra headers on a service that reads none change nothing.

**Two consequences worth their own note.**

*Platform mail has no tenant to send under.* `VerificationEmailParams` and
`PasswordResetEmailParams` carry no medspa id, and that is correct — signup
happens before a medspa exists and password reset is identity recovery. The
engine still needs a tenant. Rather than exempt transactional mail — a `messages`
row with no tenant is exactly what hard rule 4 exists to prevent, and the mail
would appear in no tenant's analytics — `0011_platform_tenant.sql` seeds one
reserved `platform` tenant. Provider invitations do *not* use it: both call sites
have the real medspa in scope, so an invite bills and renders against the medspa
doing the inviting, and can use its credentials.

*`9010_verify.sql` had to learn about it.* The verifier compares the target's
tenant count against the distinct medspa ids in the source, so a reserved tenant
with no source counterpart made it report FAIL — telling an operator not to cut
over, on a migration that was correct. Engine-reserved tenants are now excluded
from that count. Caught by `migration.test.ts`, which is the reason that test
applies the whole series rather than spot-checking it.

---

<a id="d87"></a>
#### D87 · Seam A is two code paths, and the engine's delete is not this one's

**Plan said:** point `template.service.ts` at the engine over HTTP and keep the
method signatures.

**We did:** that, plus eight more methods the plan does not mention, and kept
one operation deliberately different from the engine's.

**The second path.** `settings.service.ts:1272-1620` holds `getCommunicationTemplates`,
`getCommunicationTemplateById`, `create`, `update`, `delete`, `preview`,
`duplicate` and `setDefault` — already HTTP, already talking to the
communication service, and invisible to a grep for `communicationTemplates`
because they never touch the table. Converting only the path the plan names
would have left half the surface failing after cutover with no obvious cause.

They are written against the legacy `/templates` envelope (`metadata` +
`content`), so they stay pointed at the compat shim and only gained identity
headers. Rewriting them onto v1 is P12 work, when the shim goes.

**`deleteTemplate` stays soft.** The engine's `DELETE /v1/templates/:id` is a
hard delete that cascades into `template_versions`. This method has always set
`isActive = false`, and `settings.service.ts:1813` writes an audit entry saying
`{ isActive: false }`. Mapping it to the engine's DELETE would destroy the row
while the audit trail claimed it survived. It maps to `PUT { isActive: false }`.

**Two translations.** The engine returns `tenantId` where consumers read
`medspaId`, and stores channels lower-cased while everything on this side speaks
`EMAIL`/`SMS` (D80). Both are restored at the seam. Without the second, a filter
for `SMS` silently matches nothing — the failure mode is an empty list, not an
error.

**A cycle, found by the test suite.** Importing `templateService` at module
scope into `notification-rule.service.ts` left the drizzle schema namespace
empty by the time `db/client.ts` passed it to `initializeDatabase`, which threw
"Invalid schema: must be a non-empty object". Deferred to a dynamic import,
which is what `settings.service.ts` already does five times over for the same
reason. Confirmed against the base run rather than assumed.

---

<a id="d88"></a>
#### D88 · Importing a module opened a database connection

**Symptom:** after `services/communication-service/` was removed, every
`vitest run` in providers-service ended with an unhandled rejection —
`Invalid schema: must be a non-empty object with table definitions`, thrown from
`db-client.ts:237`.

**The error named the wrong thing.** "Invalid schema" reads like a schema
problem. It is not. Instrumenting `initDb` gave the real stack:

```
initDb                        db/client.ts:33
Module.getDrizzle             db/client.ts:51
VisitChartLifecycleService.<instance_members_initializer>
                              visit-chart-lifecycle.service.ts:83
new VisitChartLifecycleService
                              visit-chart-lifecycle.service.ts:1039   ← module scope
chart-tools.ts:3                                                      ← imported by mcp/index
```

Two lines, forty-one hundred apart, in the same file:

```ts
export class VisitChartLifecycleService {
  private db = getDrizzle();                                    // :83
}
export const visitChartLifecycleService = new VisitChartLifecycleService(); // :1039
```

A field initializer runs on construction, and the singleton is constructed at
module scope. **So importing the module opened a database connection**, before
any caller asked for one. `Object.keys(schema).length` was 0 at that moment,
because the walk had not yet finished evaluating `db/client.ts`'s own
`import * as schema`.

**Not one service — four.** `image`, `visit-chart-lifecycle`, `chart-template`
and `chart-generation` all carried `private db = getDrizzle()`; three export an
eagerly-constructed singleton. This was never specific to charts.

**Not a P10 regression.** Verified by stashing everything and running the suite
on `develop` with the same `node_modules`: identical rejection. The deleted
service shipped its own `node_modules/drizzle-orm`, and providers-service
resolved through it — a second module instance whose separate evaluation order
happened to hide the defect. Removing the workspace collapsed the tree onto one
copy and exposed it.

**Fixed** by making the connection lazy: the field becomes a memoised getter, so
construction does nothing and the first `await this.db` opens it. Every call
site is unchanged. Three consecutive runs, zero unhandled rejections.

**Why it mattered beyond the noise.** The promise was created and never awaited
at construction, so any failure surfaced as an unhandled rejection at import
rather than at a call site that could handle it — in production that is a
connection error attributed to whichever module happened to be imported first.
And `getDrizzleInstance` caches per `(schema, serviceName)`: had the empty-schema
call succeeded rather than thrown, it would have cached a drizzle instance with
no tables for the whole process.

---

<a id="d89"></a>
#### D89 · scheduling-service has been posting to a 404 for its entire life

**Plan said (P10 Step 5):** "verify the endpoints it posts to exist in the
compat shim."

**They do not, and they never did.**

`scheduling-service/src/services/notification.service.ts` posts to
`${COMMUNICATION_SERVICE_URL}/notifications/email` and `/notifications/sms`, in
ten call sites — appointment booked, rescheduled, reminder, cancelled, no-show.

The old service's route table, recovered from git history at the commit before
its deletion, mounts twenty-three paths and **`/notifications` is not one of
them**: `/email`, `/sms`, `/slack`, `/events`, `/preferences`, `/config`,
`/leads`, `/treatments`, `/providers`, `/patients`, `/communications`, `/queue`,
`/mcp`, `/ai`, `/ai-enhanced`, `/approvals`, `/automated-messages`,
`/ehr-webhook`, `/templates`, `/promotions`, `/gift-cards`, `/messages`, `/`.

So every appointment notification this service has ever sent has 404'd. It is
invisible because `sendWithRetry` retries three times and then logs a warning —
the failure is well-handled and completely silent to anyone not reading logs.

**Resolved: it posts events now.** Of the two candidates, `/email/send` was
rejected on three counts, any one of which is decisive:

1. **This service has no address to send to.** The appointment model carries
   `patientId` and `medspaId` and no email or phone — the old code sent
   `to: appointment.patientId` with a comment admitting the id should have been
   an email. Using `/email/send` would mean calling patient-service to resolve
   contact details on every notification: new cross-service coupling and an
   extra hop per message, which is the exact pattern §0.5 Seam C removed. The
   `/events` path takes `patientId` and the engine resolves the recipient from
   its own `recipients` table.
2. **The playbooks already exist**, shipped in P7 and never called:
   `medspa.appointment-{confirmation,reminder,cancellation,rescheduling}`.
3. **`/email/send` is marked transactional**, so quiet hours and marketing
   opt-outs do not apply to it — correct for password resets, wrong for
   appointment reminders, which would have bypassed the compliance gate.

**What now sends that did not before:** confirmation, reminder, cancellation and
rescheduling. That is the D44-class change, and it is deliberate.

**What deliberately still sends nothing:** requested, approved and denied. They
are emitted as `APPOINTMENT_REQUESTED` / `_APPROVED` / `_DENIED`, which no
playbook matches, so the engine records them UNMATCHED and answers 200 — as
silent as the 404s were, but now visible in `outreach_events`, and lightable
from a JSON file. `_APPROVED` was specifically NOT folded into
`APPOINTMENT_CONFIRMATION`: that playbook exists, so reusing it would have
started sending approval mail as a side effect of choosing a name.

**Two details that would have bitten later.** The retry loop needed an
idempotency key that is stable across attempts but distinct between sends —
`appointment.id` alone collides across event types and across repeat reminders,
so it is `{id}:{type}:{timestamp}`, generated once per call. And the log lines
said "Sent appointment confirmation" on a request that had 404'd; they say
"Reported" now, because a confidently-worded log is what kept this hidden.

---

<a id="d90"></a>
#### D90 · The deferral sweeper, and why `retryAt` could not stay in JSONB

**The gap:** P5 made the compliance gate **defer** rather than block — the
source dropped a reminder that arrived during someone's quiet hours (D40), and
the gate computes a `retryAt` instead. Nothing ever read it back. Every deferred
message since P5 has been dropped exactly as the source dropped it, while its
row claimed a retry was coming, which is worse than an honest drop.

**Shipped:** `engine/delivery/deferral.worker.ts`, on a BullMQ repeatable job for
the same reason `SlaSweeper` is — with N replicas the queue guarantees one tick,
where a `setInterval` would have every replica dispatching the same rows.

**It re-dispatches; it does not re-send.** Due messages go back through
`dispatcher.dispatch()`, so the gate runs again against the state of the world
now. A recipient who unsubscribed during their own quiet hours must not receive
what was waiting for them, and re-enqueueing directly would send it. A message
still blocked simply defers again — `dispatch` writes the new deadline, so there
is no second re-deferral path to keep in step.

`messageId` is carried through so the retry adopts the existing row (the
mechanism P6 added for approvals). One logical message stays one row, or every
count, rate-limit window and retention sweep reads a retry as a second send.

**It gives up, on attempts or on age.** The age bound is the important one: an
appointment reminder delivered two days late is worse than none — the same
argument `SlaSweeper` makes for its `decline` policy — and without it a tenant
with a permanently saturated rate limit accumulates a backlog that eventually
fires at once. An exhausted message keeps its status and its original
suppression reason, and records why it stopped being retried.

---

**The part worth reading: `retryAt` had to leave the JSONB.**

It was already being written to `messages.metadata`, so the first cut simply
indexed it there:

```sql
CREATE INDEX ... ON messages (((metadata->>'retryAt')::timestamptz)) WHERE ...
```

Postgres refuses: **`functions in index expression must be marked IMMUTABLE`**.
`text::timestamptz` is STABLE, not IMMUTABLE, because parsing a timestamp
without an offset depends on the session's TimeZone. It cannot be indexed at
all.

That matters more than it sounds. The alternative to an index is a sequential
scan of `messages` — the largest table in the service, and `SUPPRESSED` is not a
rare status there since every opt-out and every quiet-hours hold lands in it and
stays forever — once a minute, for the lifetime of the deployment.

The tempting workaround is to index and compare the raw text: ISO-8601 UTC sorts
lexicographically, and the only writer uses `toISOString()`. Rejected. It is
correct only while that invariant holds and silently wrong the first time a
writer emits an offset, and "silently wrong" here means messages that are never
retried — the exact bug being fixed.

So `0012` adds a real `messages.deferred_until timestamptz` with a partial index
matching the sweeper's predicate. Nullable with no default, so it is a
catalogue-only change on a large table. `metadata.retryAt` is still written
beside it, because that is what the API returns and what `BREAKING.md`
documents: the column is the queryable copy, the JSON is the reported one.

Both exits maintain the index without a second pass — a sent message flips
`status` and drops out, an exhausted one has `deferred_until` nulled.

**Found by the test, not by review.** `tests/integration/deferral.test.ts`
applies every migration to a throwaway container, so the IMMUTABLE rejection
surfaced as a failing suite the first time it ran rather than as a production
sequential scan.

---

<a id="d91"></a>
#### D91 · `cancel` recalls, and the three numbers it now reports

**Closes D83.** `NotificationQueue` exposed `enqueue`, `enqueueMany`, `stats`
and `close` — no removal — so cancelling a campaign stopped generation and left
anything already queued to send. The exposure was bounded (a recipient is
enqueued only after it is generated) but not zero, and "cancel" is a word an
operator trusts.

**The job id had to be recorded, not derived.** The obvious shortcut is to pass
`jobId: messageId` on enqueue and remove by message id, storing nothing. It is
wrong here: `jobOptions` sets `removeOnComplete: { age: 24h, count: 1000 }`, so a
completed job lingers, and BullMQ treats a duplicate `jobId` as an
already-present job and silently declines to add it. The deferral sweeper (D90)
retries the same message hours later — well inside that window — so the shortcut
would have turned a quiet-hours retry into a message that never sends. The
dispatcher writes the generated id onto the row instead: one update per send,
against the alternative of scanning the queue by payload at exactly the moment
somebody is cancelling a large campaign.

**Three numbers, not one.** `{ cancelled, recalled, alreadySending }`. A single
count cannot distinguish a recipient that was never generated from a message
pulled off the queue from one a worker already holds — and the third is the one
that matters, because those may well have gone out. Once a worker has the lock
the provider call may be in progress, and no distributed queue can promise
otherwise. Reporting them as cancelled would tell somebody their message did not
send when it did.

An in-flight message is deliberately left `QUEUED` rather than marked
`CANCELLED`: the worker owns the outcome and will record what actually happened.

**Found while testing: a COMPLETED campaign could not be cancelled at all.**
`cancel` threw `ConflictError` on `status === 'COMPLETED'`, which was reasonable
when it only stopped generation. But COMPLETED means generation finished, not
that the queue drained — a large campaign finishes generating long before its
messages send. Refusing there would have made the recall useless in precisely
the window it was built for. Cancel now recalls on a completed campaign, and
leaves the campaign's own status COMPLETED: it did complete, and rewriting that
would misreport the generation run. The `ConflictError` survives for the case
where there is genuinely nothing left to stop.

---

### P11 — campaigns and the second pack

<a id="d81"></a>
#### D81 · P11 runs before P10, and the plan's order would have destroyed its sources

**Plan said:** P11 depends on P10.

**We did:** ran P11 first, with P10 still gated on operator action (the P9
migration has never been run and nothing is deployed).

**Why the dependency was not real:** P11 touches only this repo, every table it
needs except `import_errors` already exists in `0001`, and everything it builds
on shipped in P4–P8. The phase map's `Depends on: P10` is risk sequencing — cut
over carrying only parity-proven code, then add capability.

**Why the order is arguably wrong the other way:** P10 Step 6 deletes
`services/communication-service/` **entirely**, and P11's own session brief
requires reading six files from inside it — `lead-message.service.ts`,
`lead.model.ts`, `lead.routes.ts`, `campaign-template-generator.ts`,
`automated-message-generator.service.ts` and `batchGenerate`, 1,683 lines of the
lead and campaign logic this phase re-expresses. Run P10 first and P11's
reference material exists only in git history.

**What the reordering costs:** the P10 deploy carries the orchestrator and a
second pack, so the parallel run validates a bigger binary. The blast radius is
small — `/v1/campaigns` is new surface no legacy caller touches, and the
lead-generation pack is inert until a tenant installs it.

**Also corrected:** P11's migration is **`0009`**, not the plan's `0008` (P8b
took that, D69), and P12's credential-encryption migration moves to `0010`.

---

<a id="d82"></a>
#### D82 · A campaign targets its playbook through the matcher's predicate

**The problem:** `OutreachTrigger` has no "run this playbook" field. The matcher
selects on trigger type, event type and a `where` predicate over the payload, so
a campaign launching `lead.followup` would have matched **every** playbook with
a `campaign` trigger.

**The obvious fix — add `playbookKey` to the trigger and filter on it — is
exactly what P11's exit criterion forbids**: no file under
`src/engine/{playbooks,content,approvals,compliance,delivery}` may change, and
that constraint exists to catch shortcuts like it.

**We did:** the orchestrator puts `campaignPlaybookKey` in the payload, and a
campaign-capable playbook declares
`{"type":"campaign","where":{"campaignPlaybookKey":{"eq":"lead.followup"}}}`.
The existing bounded predicate does the selection.

The engine did not have to learn what a campaign is, and the targeting rule is
readable in the pack file rather than inferred from code. `campaigns.test.ts`
carries a decoy playbook that must never fire, because the failure mode is
silent fan-out rather than an error.

**The gap:** nothing enforces the convention. A pack author who omits the
predicate gets a playbook that fires on every campaign the tenant runs. Recorded
in `docs/PACKS.md`.

---

<a id="d83"></a>
#### D83 · `cancel` cannot recall a queued message

**Plan said:** "cancel must stop generation *and* drain queued-but-unsent jobs."

**We did:** the first half only, and said so in the file that does it.

**Why:** `NotificationQueue` exposes `enqueue`, `enqueueMany`, `stats` and
`close`. There is no removal, and adding one is a change to the delivery plane —
the thing P11's exit criterion forbids. Draining is not a campaign feature; it
is a queue feature that campaigns happen to be the first caller to want.

Cancel therefore stops generation immediately and cancels every recipient not
yet generated. The exposure is bounded by the fact that a recipient is enqueued
only after it has been generated: cancelling a 10,000-recipient campaign 200 in
leaves 9,800 ungenerated and at most a handful in flight.

Documented in the orchestrator's header, in `docs/PACKS.md` under known gaps,
and here — three places, because "cancel" is a word an operator will trust
without reading the source.

---

### P12 — productization

<a id="d92"></a>
#### D92 · Six of the seven `501`s were never blocked on an image model

**Plan said:** seven legacy endpoints answer 501 and every one is blocked on
"a storage adapter and an image-capable `LlmProvider`" (§P12 workstream 3b,
`docs/api/BREAKING.md`, and D84, which singled workstream 3b out as the one
piece independent of the cutover).

**Found:** only **one** of the seven needs an image model, and the source could
not serve that one either.

`AIService.generateImage` (`ai-service.ts:562-570`) is a method whose entire
body is a throw:

```ts
async generateImage(prompt, options = {}): Promise<{url: string; filename?: string}> {
  throw new Error('Image generation not supported with current Bedrock models. Please implement with a compatible image generation model.');
}
```

Every caller either swallows it or never reaches it:

| Endpoint | What the source does | Blocked? |
|---|---|---|
| `POST /ai/multimodal` | builds a **text** prompt asking for copy plus N image *descriptions* and calls `generateJsonContent` (`ai-content-controller.ts:379-407`). No image model is involved at any point | no |
| `POST /templates/generate-with-images` | generates the body, then loops `imageSuggestions` through a `try/catch` that logs and continues (`template-controller.ts:368-374`). Always 201, `imageAssets` always undefined | no |
| `POST /templates/campaigns` ×4 | campaign **copy** via Bedrock text, then `Promise.all` over image prompts each in a `try/catch` returning `null` (`campaign-template-generator.ts:232-238`), filtered out. Always 201 | no |
| `POST /templates/assets/upload` | `fs.writeFileSync` under a path built in the constructor | yes — storage |
| `POST /templates/assets/generate-image` | calls the throwing method with nothing catching it | yes — and it has answered **500** since it was written |

**We did:** ported the six, and declared the image port with no adapter.

The six go through `ContentGenerator` on the existing text-only `LlmProvider`,
reproducing the source's behaviour exactly — including the best-effort image
pass, which now returns nothing because no provider is registered rather than
because every attempt throws. A caller sees the same 201 and the same absent
`imageAssets`.

`src/ports/image.ts` exists and the engine registers no implementation, so
`assets/generate-image` answers 501 naming the reason. That is strictly more
capability than the source had (a 500) and strictly more information. A
deployment with an image model writes one adapter and the endpoint starts
working; nothing else moves.

**Why the port is separate from `LlmProvider` rather than a third method on it:**
every existing implementation would have to grow a method it cannot honour, and
`RecordingLlmProvider` would have to decide what an image costs in
`ai_interactions` before anyone has generated one.

**How the plan came to be wrong:** the endpoints are named for images, and
nobody read the method they bottom out in. `BREAKING.md` assigned them to P11,
P11 moved them to P12 on the same premise, and D84 repeated it. Three documents
agreeing is not evidence; the method body is.

---

<a id="d93"></a>
#### D93 · `POST /templates/generate` defaulted to a prompt pack nothing shipped

**Found while porting the campaign endpoints.** `compat/templates.ts:226` reads

```ts
const packKey = body.promptPackKey ?? 'core.template-author';
```

and `grep -rh '"key"' packs/*/prompts/*.json` did not contain
`core.template-author`. No pack has ever shipped it. So the endpoint 404s unless
the caller names a pack of their own — and providers-service proxies this router
(`settings.service.ts:1266`, Seam A).

Latent because the only test that exercises the path passes
`promptPackKey: 'core.content-generate'` explicitly, so the default was never
taken.

**We did:** shipped `core.template-author` in the core pack, plus
`core.campaign-author` for the four campaign endpoints and
`core.content-multimodal` for `/ai/multimodal`. All three are generic —
authoring a message template is not vertical vocabulary — and a contract test
now calls `/templates/generate` with no `promptPackKey`.

**The campaign prompt moved from code to pack content.**
`campaign-template-generator.ts:362-430` builds its prompt in TypeScript with
the vertical's nouns hardcoded: *"new patients who have recently joined the
practice"*, *"aligns with healthcare best practices"*. Under §0.10 that is pack
content. The engine passes `campaignType`, `audience`, `tone` and `purpose`
through as context and `core.campaign-author` does the wording, so a vertical
that wants its own vocabulary overrides the key in its own pack.

---

<a id="d94"></a>
#### D94 · API keys are hashed with SHA-256, not bcrypt

**Schema said:** `tenancy.ts:55` describes `tenant_api_keys.key_hash` as an
"Argon2/bcrypt digest".

**We did:** SHA-256, and the schema comment is the thing that was wrong.

Argon2 and bcrypt are password hashes: deliberately slow, and **individually
salted**. A salted digest cannot be computed from a presented secret and looked
up, so verification would have to load every key in the table and test the
candidate against each — O(keys in the entire installation) slow-hash operations
on **every authenticated request** — and
`tenant_api_keys_hash_unique`, declared in the same file, would be unusable.

Slow hashing exists to make brute-forcing a low-entropy human-chosen secret
expensive. A key here is `randomBytes(32)`: 256 bits, no dictionary, nothing to
slow down. The property bcrypt buys does not apply; the cost it imposes does.

SHA-256 against a unique-indexed column is one indexed lookup and gives up
nothing. The comparison is still `timingSafeEqual` — the lookup already matched
on the full digest so it is equal by construction, but the equality that decides
authentication should be the constant-time one on principle.

**Three things are deliberately not read from headers in `apikey` mode:** the
tenant (it comes from the key's row, or the key is not a boundary), the
permissions (they are the key's `scopes`), and the role (fixed at `system`, so a
key cannot take `requirePermissions`' admin short-circuit by asserting
`x-user-role: admin`). Sub-tenant and sender **are** read from headers: both are
scoped inside the tenant the key already fixes.

---

<a id="d95"></a>
#### D95 · Pack config was replaced where the comment promised a merge

**Found while adding `requiredConfig` validation.** `registry.ts` upserts
`tenant_packs` with:

```ts
// Merge, do not replace: `config` holds operator-set values like
// emergencyContacts and the compliance-enforcement flip date (D41).
...(options.config ? { config: options.config } : {}),
```

The comment says merge. The code assigns the object wholesale. So an operator
re-installing a pack to change one Slack channel silently dropped
`emergencyContacts` and the other two channels — and a playbook whose `$config.`
reference is unset produces a `SKIPPED` run, which means the symptom is a staff
alert that quietly stops arriving, at the next deploy rather than at the edit.

**We did:** made it a real deep merge, and pinned it with a test. Deep rather
than shallow because the config nests — `slackChannels` holds three keys, and a
shallow merge of `{slackChannels: {staffAlerts: '#new'}}` reproduces the same
bug one level down. Arrays replace: `emergencyContacts` is a list of who to wake
up, and a shorter list means shorten it.

**Also closed here: `requiredConfig` had no reader.** It has been in the pack
schema and in `packs/medspa/manifest.json` since P7, and `grep -rn requiredConfig
src/` returned only the schema line. Installing the medspa pack with no
`emergencyContacts` succeeded, and the first sign of trouble was an emergency
notification producing a `SKIPPED` run — the exact failure `docs/PACKS.md` says
the mechanism exists to prevent, discovered at 3am. Install now refuses and names
every missing key.

Validated against the config the tenant **ends up with**, not against the
request body, so adding one setting later does not mean resending all of them.

---

<a id="d96"></a>
#### D96 · What credential encryption does and does not cover

`credentials_encrypted` and `encryption_key_id` were reserved in P2 for "P12 to
flip to envelope encryption". Two divergences from the plan's suggested
approach, and two limits worth stating.

**Not `shared-libs/utils/encryption.ts`, on two counts.** That service defaults
its secret to the literal `'default-encryption-key-change-in-production'` and
only refuses it when `NODE_ENV === 'production'`, so every other environment
encrypts with a key that is in the repository — worse than plaintext, because
the column now *looks* protected. And it runs scrypt on every encrypt **and
every decrypt** with a fresh salt, which is right for a password and wrong for a
key: scrypt is deliberately expensive and credential resolution sits on the send
path. Here a key must be supplied, must be 32 bytes, and is used directly.

**Reads resolve ciphertext first and plaintext second, on purpose.**
`9003_channel_configs.sql` keeps inserting plaintext for the length of the
parallel run and the delta sync re-runs it. A build that read only the sealed
column would find nothing for every row that arrived after the backfill. Once
`0013` nulls the plaintext the fallback finds nothing and stops mattering — with
no second code change.

**Writes null the flat column in the same statement.** The first cut left it,
reasoning that a replica without the key would still need it. A test caught what
that actually meant: a credential set through the API *after* encryption was
turned on still landed in cleartext, and then in the config cache. The value is
recoverable from the bundle in the same row, so nothing is lost by clearing it.

**Two limits, stated rather than papered over:**

- `twilio_account_sid` is **not** sealed. It is an account identifier, it arrives
  in Twilio's own webhook payloads, and `getTenantConfigByTwilioAccount` looks a
  row up by it to find the auth token that verifies an inbound signature.
  Sealing it would break every callback.
- **`CredentialResolver` caches resolved credentials in Redis** (D27), so a
  decrypted credential lives there for the cache TTL. Encryption at rest in
  Postgres does not change that. The config cache was fixed — it stores the row
  as stored, and decryption happens after — but the resolver's cache is a
  different decision, and treating Redis as a secret store is its own piece of
  work.

---

<a id="d97"></a>
#### D97 · `0013` is a decommissioning step, not baseline schema

Ten test harnesses each carried their own copy of `/^0\d{3}_.*\.sql$/` to decide
what to apply to a throwaway container. Until P12 that was right: every `0*` file
was schema every environment gets.

`0013_encrypt_credentials.sql` is the first that is not. It nulls the plaintext
credential columns and adds a CHECK forbidding them, which is correct only once
credentials are sealed — and applying it in a harness made every fixture that
writes a credential fail, which is the constraint working rather than a broken
test.

**We did:** one shared `tests/helpers/migrations.ts` defining the baseline, with
`0013` named in a `NON_BASELINE_MIGRATIONS` set and the reasoning in one place.
It is applied deliberately by `tests/integration/credential-encryption.test.ts`,
which proves the guard refuses while anything is unsealed before running it for
real — closer in kind to the 9xxx one-shots than to `0001`.

Adding to that set is a decision worth arguing for. The default for a schema
migration is that everyone gets it.

---

<a id="d98"></a>
#### D98 · Role approvals were authorized by permission, not membership

**Found while closing the record's own open item** ("`AuthorizationProvider` is
a stub: `role`/`group` approvals check the `outreach:approve` permission, not
actual membership").

`group` was fine — its `approverRef` carries the member ids inline and
`approval.service.ts` splits and checks them. `role` was not. It fell through to
a bare permission test, so **anyone in the tenant holding `outreach:approve`
could act on any role's approvals**, whether or not they held the role.

What makes it worth an entry rather than a fix: `policy.service.ts:339` says, in
a comment, that the ref stays the role because "members are resolved at
authorization time instead". They were not resolved anywhere. A clinic routing
messages to a `nurse-practitioner` role got no separation from it at all, and the
only sign was that nothing ever complained.

Not the same defect as D45 — the tenant boundary held — but the same shape: an
authorization decision that reads as enforced and is not.

**We did:** `TenantConfigAuthorizationProvider`, reading
`tenant_packs.config.roleMembers`. §0.10 tier 2, deliberately not a table: the
engine does not own identity, and modelling users here would mean every tenant
syncing its directory into this service to send a message. A deployment with a
real directory implements the interface — which already existed — against it.

**Fails closed in both directions.** A role with no configured members admits
nobody, and a service constructed with no provider refuses role approvals
outright rather than falling back to the permission. Treating "no configuration"
as "everyone" is how the check was decorative to begin with. The permission is
still required; it is necessary, not sufficient.

**The acceptance test was passing because of the gap.** It approved a
`sales-manager` role approval with an actor holding only `outreach:approve`. It
now configures `roleMembers` at install, which is what a real deployment does.

---

<a id="d99"></a>
#### D99 · There is no parallel run, and a good deal of P10 was built for one

**The assumption, never stated and never checked:** that the cutover moves a
service with live users, so it must be staged — deploy alongside, repoint
staging, soak for a business day, measure, freeze, repoint production, keep a
delta sync running throughout.

**The fact, supplied by the project owner after P12 shipped:** the product is in
**demo phase**. There is a production environment with data in it, but no real
client and no meaningful traffic. There is no staging environment. The plan is
to confirm the new service works and repoint.

Nobody was wrong to build for safety, but the plan was carrying a lot of
machinery whose only job is to manage risk that does not exist here.

**What that invalidates:**

| Built for | Verdict |
|---|---|
| Parallel run + hourly delta sync | Not used. Its premise is that mentera-core stays the source of truth for migrated rows while both systems are live. The old service is stopped before the load and never restarts |
| 30 days of `outreach_compat_hits_total` to decide what to delete | **Could never have worked here.** A counter records what was called; nothing is calling. Every label is zero, so the measurement meant to make deletion safe would have authorised deleting the entire shim |
| Shadow mode on the compliance gate | The reason was "do not silently stop messages that currently ship". Nothing ships. Enforcing from day one is strictly safer |
| `CHANNEL_DRY_RUN` + the historic-approval backlog decision | The backlog is cancelled at migration, so there is nothing waiting to escape. Dry-run still matters for the first *new* send |
| `0013` blocked until the parallel run ends | Unblocked. `9003` runs once, in the window, and nothing re-inserts plaintext after it |
| Staged repoint + business-day soak | One window |

**What it does not invalidate:** the migration's correctness machinery —
watermarks, quarantine, `mig.verify()`, the read-only source guarantee. Those
answer "did the data arrive intact", which is a question regardless of traffic.

**Was the compat shim built in vain?** Partly, and the honest accounting is
worth writing down. A grep of the consumers gives the reachable set:

```
web + mobile (8):  /approvals/{pending,approve,decline,edit,edit-approve}
                   /communications/provider/:id/inbox
                   /communications/conversation/:p/:pt[/read-all]
providers-service: /email/send, /config/medspa/*, /api/events, the template proxy
scheduling:        posts events (D89)
tera:              /mcp/*        health-monitor: /health
```

Roughly **20 of the 110**. The other ~90 were ported so that unknown callers on
live traffic would not break — and there are no unknown callers and no live
traffic. With this information at planning time the right call would have been
to port the reachable set and stub the rest.

What is *not* wasted: those 20 are load-bearing. Without them the repoint means
changing the web app, the mobile app and four backend services in the same
change as the cutover, instead of one environment variable. And porting the rest
is how three real defects surfaced — the inbox handler had never returned a 200
(D61), analytics 500'd without date params (D63), and approving had never sent
anything (D44). Those were found by writing the port, not by reading the code.

**What changed as a result:**

- Runbook §7 rewritten as a single window; the parallel-run material moved to
  §7b, clearly marked as not this path. The delta sync is kept and still tested,
  because a future onboarding with live traffic would want it.
- `watermark_lag_minutes` set to 0 *before* the load rather than for a final
  delta — the race it guards needs a writing source.
- `0013` moved into the window.
- Pre-flight now says a maintenance window **is** required. It said "not
  required", which was true of the migration and false of the cutover once the
  two stopped being separated by a parallel run.
- P12 workstreams 1, 2 and 5 are unblocked; D84's analysis of them rested on the
  premise this entry corrects.
- Workstream 2 retires the shim **by inspection** rather than measurement, which
  is a complete answer rather than a sampled one — and is the right method
  permanently for this product, not a stopgap.

**And one thing the owner asked for directly:** nothing migrated should look
actionable. `mig.finalize_cutover()` is that, and the choice of `CANCELLED` over
`SENT` is argued in the header of `9009_approvals.sql` — both are mechanically
safe, because nothing in the engine re-sends a message whatever its status, and
only one of them is true.

---

<a id="d100"></a>
#### D100 · The compat shim is trimmed by inspection, not by measurement

**Plan said** (§P12 workstream 2): read 30 days of `outreach_compat_hits_total`,
delete every legacy path with zero hits, send a dated deprecation notice for the
rest.

**That method cannot work here, and never could have.** A counter records what
*was called*. Nothing is calling — no real client, no meaningful traffic (D99) —
so every label is zero and the procedure would have authorised deleting all 110
endpoints, including the ones the cutover runs on.

**We did:** established the reachable set by grepping the six consumers, and
deleted what nothing reaches.

**Inspection is not the fallback here, it is the better instrument.** A counter
reports what happened to be exercised during a window; a grep reports what *can*
reach the surface at all. In a demo-phase product the first is a sample of
almost nothing, and even after a real client arrives it would only ever cover the
paths that client's usage happened to touch. This is the right method for this
product permanently, not a stopgap.

**The consumers, and what each one calls** — the whole basis of the deletion:

| Consumer | Calls |
|---|---|
| mentera_app web (`lib/store/api/communicationsApi.ts`) | `/approvals/{approve,decline,edit,edit-approve}`, `/communications/{create-communication,generate-message,message,conversation/:p/:pt/read-all}`, `/automated-messages/generate` |
| mentera_app mobile (`redux/api/{communicationsApi,approvalsApi}.ts`) | `/approvals/{pending,approve,decline,edit-approve}`, `/communications/{provider/:id/inbox,conversation/:p/:pt,conversation/:p/:pt/read-all,message,generate-message}`, `/automated-messages/generate` |
| providers-service (`outreach.client.ts`, `communication-service-client.ts`) | `/email/send`, `/config/medspa[/:id]`, `/templates[/:id][/render]`, `POST /api/events` |
| scheduling-service (`outreach.client.ts`) | `POST /events` |
| patient-service | `/v1/recipients/by-external-ref/…` — already v1 |
| tera-orchestrator | `/mcp/*` — its own mount, never part of the shim |

**28 endpoints survive of 110.** The shim went from 4,106 lines to 2,075.

**Three routers were deleted outright** — `ai.ts`, `preferences.ts`, `queue.ts` —
along with an `aiEnhanced` router inside `generation.ts` that was still being
*constructed* after P12 stopped mounting it. Nothing would have caught that: it
compiled, it was covered by tests, and it served no traffic because it was not
reachable from the app.

**Retired paths answer `410 Gone`, not `404`.** Each names its successor. The
difference matters: 404 says "this never existed", 410 says "this existed, it is
gone, here is where it went" — and a caller the inspection missed gets a sentence
instead of something indistinguishable from a typo. `createRetiredMounts()` in
`api/compat/index.ts`, covered by `tests/contract/legacy/endpoints.test.ts`.

**THE LIMIT OF THE METHOD, STATED RATHER THAN GLOSSED.** Two mounts are kept with
no proof of use at all:

- `/messages/webhook/sms` and `/messages/webhook/email`
- `/ehr-webhook/*`

Their URLs are configured in Twilio's and SendGrid's dashboards, and in an EHR
vendor's own settings. No grep over this repository or `mentera_core` can see
them, so "nothing calls it" is unprovable rather than false. Deleting them would
be a guess whose failure mode is silently losing every delivery receipt and
inbound reply. They stay until someone opens those consoles and repoints them at
`/v1/webhooks/*`.

**What this deleted that P12 had just built.** `/ai/multimodal`, the four
`/templates/campaigns*` endpoints and `/templates/assets/*` were ported earlier
in this same phase (D92) and are now gone from the legacy surface. That is not
churn undone: the engine work behind them — the storage port, the asset service,
the image port, the three core prompt packs — is untouched, and the functionality
lives at `/v1/assets` and `/v1/content/generate`. What went is the *legacy alias*
nothing calls. `POST /templates/generate` went with them, which retires the
D93 defect rather than fixing it twice; `core.template-author` still ships and is
reachable through `POST /v1/content/generate`.

**`outreach_compat_hits_total` survives with a changed purpose.** It no longer
decides deletions. It now confirms the trim was right: a mount still mounted and
sitting at zero after the cutover is one this should have caught.

---

<a id="d101"></a>
#### D101 · The successor named on two 410s did not exist

**Found by starting workstream 5.** The plan specifies `generateDraft` as an MCP
tool "backed by v1: → `/v1/outreach/generate`". There is no such route, and
there never was.

Worse, two things already point at it. `createRetiredMounts()` answers
`/ai-enhanced` and `/automated-messages` with a **410 naming
`POST /v1/outreach/generate` as the successor** (`api/compat/index.ts:123`,
`generation.ts:187`), and D100's write-up repeats the claim. A 410 exists to say
"this moved, here is where"; pointing it at a 404 is worse than a plain 404,
because it costs the reader a round trip to find out the answer is nothing.

**Why it was missed:** the capability is real, it was just in the wrong place.
Two v1 routes each do half of it — `POST /v1/content/generate` writes copy and
stores nothing, `/v1/approvals` reviews a draft that already exists — and the
half nobody had built is *both at once*, which is the only half anyone actually
calls. That lived in the compat shim as `draftFor`, a local function inside
`api/compat/generation.ts`, reachable only at two legacy URLs. Writing the
retirement notice, somebody reasonably assumed the v1 equivalent of a legacy
route existed, because for the other 27 it did.

**What shipped:**

- `engine/outreach/draft.service.ts` — `DraftService`, the logic in engine
  vocabulary: resolve the recipient, generate, find the contact point, submit
  for approval.
- `POST /v1/outreach/generate` (`api/v1/outreach.ts`), documented in
  `openapi.yaml`, covered by `tests/contract/outreach-generate.test.ts`.
- `draftFor` keeps its name and its legacy envelope and **delegates**. What is
  left in it is the vocabulary bridge the compat layer exists to be:
  `patientId` → external ref, `providerId` → sender, `DECLINED` → `REJECTED`.
  One test asserts the two paths produce the same content and the same status,
  which is now true by construction.
- The `generateDraft` MCP tool, on the same service.

**Three decisions inside it worth stating:**

**The approval policy is left unnamed.** `submit` with no policy ref resolves to
`FALLBACK_POLICY` — `always`, review everything (`policy.service.ts:433`). An
earlier draft of this service named `system.provider-always` explicitly, which
would have been wrong twice over: no policy by that key exists, so `submit`
would have thrown for every caller, and naming a key at all invites naming a
`none`-mode one, which dispatches without writing an approval row (D58) — on
this path, that is Tera sending unreviewed model output to a patient. `policyKey`
is an explicit opt-in for a caller that means it, and the response always reports
the status actually reached.

**It resolves a recipient but will not invent one.** `getOrResolve` goes through
the installed context provider and stores what comes back; if nothing can resolve
the reference, the answer is 404. Creating an empty recipient instead would only
move the failure one line down to "no contact point", after the model call has
been paid for. The compat path still calls `identity.ensure` first, so its
behaviour is unchanged — an unknown `patientId` there becomes a recipient, as it
always did.

**It refuses a channel the recipient has no contact point for, before
generating.** A draft nobody can send is an approval a reviewer approves and then
watches fail.

---

<a id="d102"></a>
#### D102 · The MCP mutation gate named a tool that does not exist

**The orchestrator confirms a tool with a user before running it when the tool is
listed in `mutationTools`** — a hand-kept array in
`mentera_core/packages/tera-orchestrator/.../service-mcp-tools.ts`, listing tool
names that are defined in *this* repository.

It read:

```ts
mutationTools: ['sendEmail', 'sendSMS', 'sendSlack'],
```

**There has never been a tool called `sendSlack`.** The names are
`sendSlackMessage` and `sendUrgentSlackAlert`. So for the life of the service,
both Slack sends — including the urgent-alert one — ran with no confirmation, as
did `addNotificationToQueue`, which was never listed at all.

**A gate entry that matches nothing fails open, and looks exactly like one that
works.** `config.mutationTools?.includes(name)` returns false for a stale name
and false for a tool that genuinely does not mutate; nothing distinguishes them,
and nothing logged.

**This repository asserted the opposite.** `src/mcp/tools.ts` carried a header
saying the seven names were a contract and that renaming one "silently removes
that gate" — accurate about the mechanism, wrong about the state. Nobody had
opened the other repository to check the names actually matched. Corrected in
place; the comment now says what is true.

**The fix is not a corrected list.** A list maintained in one repository against
names defined in another drifts, and this one drifted for years without a
symptom. So:

- each tool declares `mutation` **next to itself**, and `GET /mcp/tools`
  publishes `mutationTools` alongside the schemas;
- the orchestrator prefers the published list, falls back to the inline flag,
  and only then to its own array;
- **a fallback name matching no discovered tool now logs a warning** naming it
  and the tools that do exist. That is the check that would have caught this.

The local array is corrected and kept as the rollback path for a build that does
not publish. Its comment says which it is.

`tests/integration/mcp.test.ts` asserts every name in the published set is a real
tool, and `packages/tera-orchestrator/tests/service-mcp-tools.test.ts` asserts
the precedence and the stale-name case.

**Also found here:** `packages/shared-libs/utils/tool-permissions.ts` holds a
`TOOL_CATALOG` that classifies each tool for the FGA gate, and a tool with no
entry **fails closed** — safe, but silently, so Tera would simply never offer the
new tools and nothing would say why. Entries added for all five.
`comm_approveMessage` is classified exactly as `comm_sendEmail` is, because
approving *is* sending: the engine dispatches on approval (D44).
`comm_createCampaign` is narrower than the rest — it creates a `DRAFT` that sends
nothing, but it addresses a whole audience, and who may message everyone is an
owner's decision. `launch` is deliberately not a tool at all.

---

<a id="d103"></a>
#### D103 · `messages.queued_message` leaves the baseline rather than being dropped later

**Plan said** (§P12 workstream 2): drop `messages.queued_message`, retained since
P9. The open item called it "a migration, not a route deletion".

**It is both, and the front end is the reason.** The column fed four fields on
the legacy conversation envelope, and `mentera_app/utils/inbox.utils.ts:301` and
`components/organisms/approvals/ApprovalCard.tsx:128` render
`queuedMessage.content` — as does the mobile app
(`ApprovalsScreen.tsx:133`). This was never an internal column.

**Dropping it is safe anyway, for a reason worth checking rather than assuming:**
nothing in this engine has ever *written* it. `grep` finds three readers and no
writer. Approval state has lived in the `approvals` table since P6, so every
message the new service creates has answered `null` here since P9 — the field is
already permanently null for anything not migrated, and the migrated rows that
carry a value were all cancelled by `mig.finalize_cutover()` (D99), so the
content behind them belongs to messages nobody will act on.

**The key stays in the envelope, at `null`.** Both apps guard on the object being
present, so `null` is a path they already take and a missing key is not.

**The interesting part is where the DDL went.** The obvious shape was `0014` with
a `DROP COLUMN`, and that is what was first written. It does not work:

1. the 9xxx load **writes** the column (`9008_messages.sql:107`, and
   `mig.refresh_recent()` updates it), so `0014` could only be applied *after*
   the load — making it non-baseline, like `0013` (D97);
2. baseline `0001` would therefore keep the column, so `db/schema/messaging.ts`
   has to keep it too, or the bidirectional Drizzle↔SQL conformance test fails;
3. but `ApprovalService.release()` does `db.select().from(messages)`, which emits
   **every column in the model** — so the first operator to apply `0014` would
   break approvals, on a column nobody remembered.

Keeping the two definitions in sync would have meant adding an exception to the
one test that keeps them in sync, which P2's amendment says to extend and never
weaken.

**So the column came out of `0001` instead** — and out of the model, and out of
`9008`/`9009`, which no longer write it. That is only available because **no
environment has applied `0001`**: the target database is new and empty (runbook
§0), P10 Steps 1–3 are still pending, and even `0008_receipt_integrity.sql` is
logged as written-and-not-applied. There was nothing to preserve, and a column
that ships only to be dropped is worse than one that never shipped.

`0014_drop_queued_message.sql` survives as a **no-op cleanup** for a local
development database built from the older file — every statement is
`IF EXISTS`. `tests/integration/schema.test.ts` asserts the baseline has no such
column and that applying `0014` to a current schema succeeds and changes nothing.

**One thing deliberately not changed.** `thread()`'s `pendingApprovalCount` used
to read `queued_message->>'approvalStatus'`; it reads `approvals.status` now, but
**keeps its `m.status = 'QUEUED'` term**, which is what makes it structurally
zero — the same query excludes `QUEUED` two lines earlier, and the docblock has
said so since P8. Dropping that term would start returning a real number to a
field the front end renders, inside a commit whose job was removing a dead
column. If that count should become real, it is its own change with its own
`BREAKING.md` entry.

---

<a id="d104"></a>
#### D104 · The package split is deferred, and the plan's boundary does not survive contact

**Plan said** (§P12 workstream 1): split into `packages/outreach-engine` —
"playbook runtime, approval policy engine, content plane, delivery plane,
compliance gate, ports. No industry nouns, no Express. Published as a library" —
plus `outreach-server` and `outreach-packs`.

**Not done, by decision.** But the more useful finding is that the boundary as
described is not the one the code has.

**`outreach-engine` cannot be "ports plus the four services".** The engine reads
the database directly — Drizzle, not a repository port. `grep` of the imports
crossing out of `src/engine/` returns `db/`, `platform/`, `ports/`, `domain/` and
`packs/`. So the library package would have to carry `db/` and `platform/` with
it, which means `pg`, `drizzle-orm`, `ioredis` and `winston` are dependencies of
the "no industry nouns" core. That is defensible — persistence is not incidental
to a playbook runtime — but it is not what the plan describes, and anyone sizing
the work off that paragraph would be surprised.

Two more the paragraph does not mention: `packs/` and `engine/playbooks/` import
each other (the loader validates against the matcher; the registry loads packs),
so they cannot be split without breaking a cycle. And `adapters/` — SendGrid,
Twilio, Bedrock, S3 — belongs to neither named package cleanly: putting it in the
engine makes the library depend on every vendor SDK, putting it in the server
means a second consumer must rewrite them.

**Why deferred rather than done:** there is no second consumer, nothing is
published, and the service is not deployed — P10 Step 1 is still pending. The
split's whole value is letting someone else depend on the engine, and until
someone does, it buys a restructure of 25k LOC plus jest, tsconfig, Dockerfile
and CI, for no behaviour. D99 unblocked it; unblocked is not the same as
worthwhile yet.

**What would make it worth doing:** a second consumer, or a second deployable
built from the same engine. At that point the boundary above is the starting
point, not the plan's.

---

<a id="d105"></a>
#### D105 · A queue outage was cancelling approvals

**Found while writing the P12 MCP tests**, in a harness running `SKIP_QUEUE=true`:
every approval came back `CANCELLED`, with the audit trail blaming
`compliance.gate` for a decision compliance never made.

`ApprovalService.release()` cancelled on this condition:

```ts
if (!dispatch.queued && dispatch.skipped && !dispatch.deferrable) { …CANCELLED… }
```

Three different outcomes reach it, and `DispatchResult` could not tell them
apart — `skipped` is free text and `deferrable` only ever means "the compliance
gate says try later":

| Path | What happened | Cancel? |
|---|---|---|
| `dispatcher.ts:185` | the channel rejected the content or the destination | yes — it will not become valid on its own |
| `dispatcher.ts:262` | the compliance gate refused | yes, unless deferrable |
| `dispatcher.ts:307` | **the queue would not accept the job** | **no** |

The third is an infrastructure failure. Nothing decided anything, and the fix is
to wait — but the approval was moved to a terminal state, so **a human's decision
was destroyed because Redis was briefly unavailable**, and the audit trail
recorded a compliance refusal that never happened.

**Three things were wrong, not one**, and fixing only the visible one would have
left the message stranded:

**1. `DispatchResult` gained `transient`**, set only on the queue-refusal path.
`release()` returns early on it: the approval keeps its status, and the failure
is logged at `error` rather than written to the row as somebody's decision.

**2. The message row is `FAILED`, not `QUEUED`.** It used to stay `QUEUED` under
a comment reading *"The row stays QUEUED but nothing will pick it up. Say so
plainly"* — which said it in the log and not in the data. `QUEUED` is precisely
the state meaning something *will* pick it up, so the row was indistinguishable
from one waiting its turn. `suppressionReason` is deliberately left NULL: that
column means the compliance gate stopped this, and nothing stopped this. The
reason goes to `metadata.dispatchFailure`.

**3. `approve()` no longer reports itself idempotent on a stranded approval.**
This is the part that makes the rest useful. The guard short-circuits on any
approved state, so with the approval left at `APPROVED` and no job on the queue,
pressing approve again answered "already done" forever. It now re-releases when
the message is `FAILED` *and* carries `dispatchFailure` — so a queue outage is
recoverable by doing the obvious thing.

**Why the marker rather than a missing job id.** The tempting check is
`metadata.jobId === undefined`, and it is wrong: `EnqueueResult.jobId` is
optional, so a queue that enqueues successfully without returning one would make
every such message look un-queued and re-approving would send it twice. The
marker is written in one place, by the dispatcher, only when the enqueue actually
refused — and **cleared on the success path**, which matters for a specific
sequence: queue refuses, retry succeeds, the worker later marks the row `FAILED`
for a delivery reason, and a re-approval finds a `FAILED` row still carrying the
old marker. Six tests in `tests/integration/approvals.test.ts` cover it,
including that one and the "compliance still cancels" case the fix must not
weaken.

**What this does not do.** It does not retry automatically. The deferral sweeper
was the obvious candidate — it already re-dispatches on a schedule — but it
sweeps `deferred_until`, and reusing that would have written a compliance
`suppression_reason` of "queue disabled" and, on exhaustion, a status of
`SUPPRESSED` for a message nothing suppressed. Conflating an infrastructure
failure with a compliance decision is the exact defect this entry is about, so
the recovery is explicit for now. An automatic retry belongs on its own path.

---

<a id="d106"></a>
#### D106 · The medspa header aliases are dropped, gateway first

**The last place the word "medspa" appeared in something every caller has to
speak.** §0.7 promised the engine would accept both `x-tenant-id` and
`x-medspa-id` (and `x-sub-tenant-id` / `x-location-id`) "for the whole
parallel-run window", removed in P12. D100 left it as the one part of workstream
2 still outstanding, on the grounds that the gateway sends only `x-medspa-id` and
*requires* it (`packages/gateway/src/index.ts:77`).

**That framing was half right.** The gateway does require `x-medspa-id` — from
the web and mobile apps — but that is the gateway's contract with its *clients*,
and it is untouched here. What had to change is what the gateway **forwards**,
which is a different line of code and purely additive.

**The order that makes this safe:** every caller sends the new name before the
engine stops reading the old one. Checked rather than assumed — the senders are a
closed set, and most were already correct:

| Caller | Before | Change |
|---|---|---|
| gateway proxy (`index.ts:154`) | `x-medspa-id`, `x-location-id` | **forwards both spellings** |
| providers-service `outreach.client.ts` | both | none |
| patient-service `outreach.client.ts` | both | none |
| scheduling-service `outreach.client.ts` | both | none |
| tera-orchestrator `createHttpExecutor` | `x-medspa-id` | **sends both** |
| health-monitor | `/health`, no tenant | none |

The three P10 service clients already sent both, each carrying a comment saying
the alias would be dropped in P12. This is the phase doing what they said.

**The gateway keeps sending `x-medspa-id` too, permanently.** Every other Mentera
service reads it through shared-libs' auth middleware. This is not a rename of a
Mentera-wide header; it is one service no longer speaking a vertical noun, with
the gateway translating at the boundary — which is what a gateway is for.

**The alias is removed, not deprecated.** A request carrying only `x-medspa-id`
now resolves to no tenant and fails at `requireTenant` rather than being
tolerated with a warning. Tolerating is how an alias survives forever — and the
failure mode of the alternative is worse than a 4xx: an empty-string tenant run
through a tenant predicate is a query for nobody's data that *looks* like it
worked. `tests/contract/legacy/endpoints.test.ts` asserts the rejection directly,
and `tests/unit/platform/auth.middleware.test.ts` **inverts** the tests that used
to assert the alias worked, because "the fallback is gone" is the property worth
pinning against someone helpfully restoring it.

**`x-provider-id` is deliberately NOT dropped**, though it is an alias of the
same kind. It is a *sender* identity rather than the tenancy boundary, the plan
only ever named the two tenancy headers, and nothing in this phase established
that its callers had moved. Dropping it because it looks similar is the kind of
change that gets discovered in production.

**One outbound site keeps the old names and must.**
`adapters/context/mentera.provider.ts` sends `x-medspa-id` and `x-location-id`
*to* patient-service and providers-service, whose auth middleware reads only
those. It sends the generic names alongside, so it needs no change the day those
services generalize — but removing the medspa ones to match this service's
inbound protocol would break every context lookup. Commented in place, because it
now looks exactly like the thing this entry removed.

**Not covered by a test: the gateway's two added `setHeader` lines.** The proxy
is constructed inline in `setupGateway`, and testing it would mean restructuring
another repository's module. Acceptable because the failure is immediate and
total rather than silent — a gateway that does not forward `x-tenant-id` breaks
every FE request to outreach on the first call. It is also covered from the other
side: the engine asserts that a legacy-only caller is rejected, which is exactly
the state this change prevents.

---

#### D107 · P13: the review response, and the four defects that shared one shape

**Question.** An external review of `main` at `29a1f5a` raised 37 findings.
Which are still valid, which were closed by the twelve commits that landed
after that hash, and which are wrong?

**Answer.** Thirty-two were valid and are fixed. Three were already closed:
`#16` (the deferral sweeper) shipped in `15dced1`, and `#26`/`#31` were half
closed by `b3212ad` and `5324ef1`. Three were wrong or mis-diagnosed, and each
was more interesting than the finding.

**The three the review got wrong, and what was actually there.**

- **`#24` named the wrong wire shape, and understated the defect.** It read the
  pack's own `description` fields — which describe the deleted source — and
  concluded the contracts should accept `appointmentDetails.date`. The *live*
  caller is `scheduling-service`, repointed in P10, and it sends `startTime` /
  `oldStartTime` (`notification.service.ts:86,112,148,175`). So three spellings
  are in circulation and the contract matched none of them: every appointment
  event would have produced a `FAILED` run and no message at cutover. Renaming
  the contract would have fixed one caller and broken two, which is why
  `context_mapping` (`0016`) is data rather than a rename.
- **`#12`'s Twilio replay window cannot exist.** Twilio's callback carries no
  timestamp — it is not part of the protocol — so there is nothing to compare a
  clock against, unlike SendGrid and Slack which both sign one. Adding a check
  against `Date.now()` would have rejected nothing while implying a protection
  that does not exist. Idempotency at the other end is the real defence:
  `0017`'s partial unique index, an upsert, and a terminal-status guard.
- **`#24`'s lead-generation claim is false.** `system.transactional` is seeded
  by `0006` with `tenant_id NULL, pack_id 'system'` — baseline schema, which
  every environment has. The pack is genuinely standalone and nothing needed
  changing.

**Four findings were one defect wearing four hats.** `#2` (approve then
schedule), `#3` (playbook idempotency), `#4` (campaign launch) and `#7`
(mid-fan-out failure) were each a guard and the write it protects in two
statements, with the whole unit of work in the gap. They are fixed with one
idiom — `UPDATE`/`INSERT … WHERE`/`ON CONFLICT … RETURNING` — so the database
decides the race rather than the code hoping to win it. The tests now deliver
concurrently, which is what none of them did: every "does not send twice" case
in the suite delivered twice *in sequence*, which the old check-then-act guard
handled perfectly well.

**The root cause worth naming.** Most of the rest is phase-boundary loss:
something built in phase N whose consumer or enforcement arrived in phase N+2,
with no mechanism carrying the requirement across.

| Finding | Built in | Consumer expected in | What actually happened |
|---|---|---|---|
| `#15` consent writer | P5 (the gate's read) | "P9 backfills it" — a comment | No writer ever existed, so `require_opt_in` could not be satisfied and enforcement could not be switched on |
| `#9` permissions | P8a (the convention) | every later router | P11 wrote two routers and nobody restated it |
| `#20` retention job | P12 | a cron nobody wrote | Shipped, never instantiated |
| `#22` schema indexes | `0006`, `0007` | the Drizzle model | Load-bearing partial indexes present in SQL and absent from the model |
| `#5` render identity | P4 (`emptyContext`) | five call sites | A shape guarantee read as a populated one, so `{{tenant.name}}` was blank in every message this engine has ever sent |

The fix for that class is not more care. Three mechanisms now fail the build
instead: `tests/contract/permissions.test.ts` walks the live router stack and
rejects an ungated mutating route; `tests/unit/platform/migrations.test.ts`
holds the four places that decide "which migrations are baseline" to one
answer; and `tests/integration/schema.test.ts` already compared the model to
the database, which is what makes a missing index findable at all.

**On the tests.** `#1` is the clearest argument in the review: the SLA
auto-approve path had a passing unit test asserting `approve.calls` had
length 1 — against a mock, so it was blind to the fact that `approve()`
returned immediately without dispatching. One of three documented SLA outcomes
sent nothing while the audit trail said it had. Every headline test now runs
the thing it claims to test: the medspa parity table is executed per event
family rather than only transcribed, and the acceptance suite asserts its own
"no engine file names a vertical" criterion, which had been prose in a header
since P11.

**What was deliberately not done.** `AUTH_MODE=jwt` stays a `501` — `apikey`
landed in P12 and covers the vendor case, and a second unused auth mode is a
second thing to keep correct. Per-tenant queue fairness (`#29`) is a BullMQ
limiter, which bounds total throughput and does not partition by tenant; real
fairness needs a queue per tenant or a group key, and that is a larger change
than the starvation warrants today. DNS rebinding against the webhook guard
(`#11`) is open, and the per-tenant allow-list is the answer for a tenant that
needs the guarantee — both are said in the files rather than left implied.

**Migrations added:** `0015` consent uniqueness, `0016` playbook context
mapping and priority rules, `0017` receipt idempotency, `0018` playbook run
reservation, `0019` campaign recipient uniqueness, `0020` webhook credentials,
and `9011` seeding consent from legacy preference data. All of `0015`–`0020`
are baseline; `9011` runs after `9006` and its unconsented count is what an
operator reads before leaving shadow mode.

---

## 3. Open items

Things deliberately deferred. Not bugs; not forgotten.

| Item | Where it lands |
|---|---|
| `npm audit` triage (mjml tree, ~41 advisories) | before first deploy |
| `mentera_core`'s `batchQuery` is still broken (D6) | separate issue, other repo |
| Expression/partial indexes are unverified by tests (D15) | review by eye on change |
| ~~`/internal/dispatch-test` is temporary~~ | **done in P8a** — deleted with the v1 surface |
| ~~`default-event-processor` is a log-and-drop stub~~ | **done in P7** — `createPlaybookEventProcessor` is the queue's consumer |
| `COMPLIANCE GATE (P5)` hook in `dispatcher.ts` | fill in P5 |
| ~~`AUTH_MODE=apikey` returns 501; `tenant_api_keys` exists but is unread~~ | **done in P12** — real lookup, scopes, rotation with an overlap window, per-key rate limits (D94) |
| ~~Content lint hook has no ruleset~~ | **done in P5** — `engine/compliance/lint.ts` + `packs/medspa/compliance.json` |
| ~~`aiConfidence` is heuristic — ship P6 `threshold` mode off by default~~ | **done in P6** — `threshold` refuses to fire without `tenant_packs.config.allowAutoApprove` (D35) |
| Compliance gate is in **shadow mode**; needs a week of clean telemetry per tenant before enforcing (D41) | operator, post-deploy |
| `consent_records` is empty, so check 3 would block everything if enforced today | **still open after P9 — nothing to backfill.** The source has no consent record of any kind: no table, no column, no proof. The gate stays in shadow (D41) until a tenant supplies consent through the API |
| Retention job exists but is dry-run; deletion needs operator sign-off | operator |
| ~~The lint ruleset is not yet wired into `ContentGenerator`~~ | **done in P6** — the loader reads `packs/*/compliance.json` and `index.ts` passes the merged rules (D52) |
| ~~Nothing re-enqueues a deferred message yet; `retryAt` is returned but no scheduler consumes it~~ | **done** — `engine/delivery/deferral.worker.ts` sweeps `messages.deferred_until` and re-dispatches through the gate (D90) |
| ~~SLA escalation reassigns and logs but sends nothing~~ | **done in P7** — the sweeper's `notify` hook runs the `system.approval-escalation` playbook, so the engine notifies through itself |
| ~~`docs/PACKS.md` still unwritten~~ | **done in P8b** |
| ~~The medspa pack's template bodies are engine-authored defaults; P9 must map the real `communication_templates` rows onto the pack's keys~~ | **closed in P9** — there is nothing to map. The switch's template ids are filesystem directories and SendGrid template ids, not table rows (D79) |
| ~~`ehr-mapper.ts` + `packs/medspa/ehr-mapping.json` not built~~ | **done in P8b** (D68) |
| `marketing-campaign`'s recipients[] fan-out is not ported; the playbook covers the single-recipient path only | P11 |
| ~~`AuthorizationProvider` is a stub~~ | **done in P12** — `group` was already checked; `role` was not, and anyone with `outreach:approve` could act on any role's queue (D98) |
| `group` with `all_of` semantics is stored and returned but only one decision is required to close the approval | P7 or P8 |
| ~~Historic `message_history` rows sitting at `status='APPROVED'` were never sent (D44) — decide whether the backfill sends, cancels or ignores them~~ | **decided in P9** — cancelled by default, with the count in front of the operator and one setting to override (D74) |
| A migrated message has no `provider_message_id`, because the source never recorded one — a delivery receipt for a pre-cutover message will not match | operator, runbook §7; decays within the provider's retry window |
| `9003_channel_configs.sql` and `9005_templates.sql` are insert-only: a credential rotated or a template edited in the old system during the parallel run is not carried across by a re-run | operator, runbook §7. Only `9006_preferences.sql` upserts, because a lost opt-out is a compliance failure rather than staleness |
| ~~`dispatcher.ts:142` writes `messages.channel` lowercase while `message.service.ts:96` uppercases the caller's filter~~ | **fixed after P9, before P10** — one stored spelling, normalised at the edge, with regression cover in three suites (D80) |
| `mig` and `src` schemas, and the `mentera_source` foreign server, survive the migration and must be dropped after cutover is signed off | P10, runbook §9 |
| ~~Nothing enforces the `campaignPlaybookKey` predicate (D82)~~ | **done in P12** — the playbook schema rejects a campaign trigger without it, naming the fix |
| ~~`cancel` cannot recall an enqueued message~~ | **done** — `NotificationQueue.remove()`, and cancel reports recalled vs already-sending (D91) |
| ~~The `/v1/campaigns` and `/v1/audiences` routes are not written~~ | **done** — 17 operations, documented in `openapi.yaml`, covered by `tests/contract/campaigns-api.test.ts` |
| Audience import is bounded by the JSON body limit; the streaming path has no HTTP route. The storage adapter exists now (P12), so this is a route away | a future phase |
| ~~Asset upload, image generation and `/ai/multimodal` moved from P11 to P12~~ | **done in P12** — six of the seven needed neither; only `assets/generate-image` did, and the source threw on it too (D92) |
| The P9 backfill must read **both** approval storage shapes, not just the JSONB (D46) | P9 |
| Sweep the source for other info-level prompt/PHI logging (D32) | before P10 |
| ~~asset upload needs a storage adapter~~ | **done in P12** — the storage port with local and S3 adapters |
| ~~Image generation and `/ai/multimodal` need an image-capable `LlmProvider`~~ | **`/ai/multimodal` never did** (D92). Image generation does: `ports/image.ts` is declared, no adapter ships, and the endpoint 501s |
| ~~`/templates/campaigns*` (4) answer 501~~ | **done in P12** — they generate campaign copy; the image step has always produced nothing (D92) |
| `APPOINTMENT_MISSED` is declared but no playbook handles it; the EHR path for a missed appointment has never sent anything (D68) | tenant decision |
| ~~`docs/PACKS.md` documenting the pack format and the confidence heuristic~~ | **done in P8b** |
| ~~`credentials_encrypted` / `encryption_key_id` reserved but unused~~ | **done in P12** — envelope encryption, backfill script, migration `0013`. **Not to be applied until the parallel run ends** (D96) |
| P9 Step 1 must re-confirm the Seam D zero counts at cutover (D11) | P9 |
| ~~P8 complete~~ | all 110 legacy endpoints answer, `/v1` is documented and validated, `docs/PACKS.md` written. **Next: P9 data migration.** |
| `migrations/0008_receipt_integrity.sql` is written and **not applied** — hand it to the operator with the rest (D69) | operator, before receipts flow |
| Four `/communications/*` endpoints answer 501 pending the content plane's API — `/response`, `/generate-message`, `/patient/:id/conversation/summary`, `/patient/:id/info` | P8b |
| ~~`docs/api/openapi.yaml` is unwritten~~ | **done** — validates with 0 errors, and `tests/contract/openapi.test.ts` fails if it drifts from the registered routes |
| `docs/api/BREAKING.md` must be kept current as later phases change legacy behaviour | P9, P10 |
| A tenant bringing its own SendGrid account needs its own webhook verification key; today there is one env-level key. `credentials_encrypted` can now hold it | a future phase |
| `WEBHOOK_PUBLIC_URL` must be set in every deployed environment, or Twilio signature verification fails on every callback (D64) | operator, before first deploy |
| The FE has never rendered a successful provider inbox (D61) — verify the success path against real data before the P10 repoint | P10 |

| `0010_recipient_optins.sql` must be applied **before** `9006_preferences.sql`, which loads its columns | operator, runbook §1 |
| `0011_platform_tenant.sql` must be applied and `OUTREACH_PLATFORM_TENANT_ID` set in providers-service before the repoint, or verification and password-reset mail 401s (D86) | operator, P10 Step 0 |
| P10 Steps 1–3 are operator actions — deploy, repoint staging, freeze and repoint production. The code for Steps 0/4/6 is on `p10-cutover-seams` in mentera_core | operator |
| P10 Step 6 is **done** — `services/communication-service` deleted, 210 files, on `p10-cutover-seams`. Commit message says LAND LAST: it removes the cutover's rollback surface | operator, merge after the 48h soak |
| `services/communication-service/.env` was **not** deleted — untracked, gitignored, 126 lines including `POSTGRES_PASSWORD` and `RDS_SECRET_ARN`, and the only copy. It is also the reference for what to configure in the outreach repo. Move it somewhere deliberate once the new service's environment is populated | operator |
| ~~providers-service's vitest run ends with a pre-existing unhandled rejection~~ | **fixed** — four services opened a DB connection from a field initializer at import time (D88) |
| ~~scheduling-service's appointment notifications post to `/notifications/*`~~ | **done** — they post events; confirmation/reminder/cancellation/rescheduling now send for the first time (D89) |
| `APPOINTMENT_REQUESTED`, `_APPROVED` and `_DENIED` are emitted but no playbook matches them, so they send nothing. Writing those three playbooks is pack work, no code change (D89) | pack author |
| ~~P12 workstream 2 (retire the compat layer)~~ | **done** — trimmed by inspection to the 28 endpoints six consumers reach; the rest answer 410 naming their successor (D100) |
| ~~The `x-medspa-id` / `x-location-id` header aliases are **not** dropped~~ | **done in P12** — the gateway now forwards both spellings and the engine reads only the generic ones. It keeps *requiring* `x-medspa-id` from the apps, which is its own contract and unchanged (D106) |
| `x-provider-id` is still an accepted alias for `x-sender-id`. Left deliberately: a sender identity is not the tenancy boundary, and its callers were not surveyed (D106) | a future pass |
| The gateway's header forwarding has no test — the proxy is built inline in `setupGateway`. The failure is immediate rather than silent, and the engine covers the other side (D106) | mentera_core, whenever the proxy is refactored |
| `providers-service/src/services/communication-service-client.ts` posts `/api/events` **through the gateway with no Authorization and no tenant header**, so it is rejected before it reaches the engine. Pre-existing and unrelated to the alias drop; `outreach.client.ts` is the working path | a future pass |
| `/messages/webhook/*` and `/ehr-webhook/*` are kept **without proof of use** — their URLs live in Twilio, SendGrid and EHR dashboards, where no grep reaches. Check those consoles, repoint them at `/v1/webhooks/*`, then retire (D100) | operator |
| ~~`messages.queued_message` is still retained from P9~~ | **done in P12** — out of `0001`, out of the model, out of `9008`/`9009`. The legacy envelope keeps `queuedMessage`/`isPendingApproval`/`isApproved`/`isDeclined` as constants, because the web and mobile apps read them (D103) |
| The web and mobile apps still read `queuedMessage.content` for an AI draft (`inbox.utils.ts:301`, `ApprovalCard.tsx:128`, `ApprovalsScreen.tsx:133`). Harmless — it is null for every message this engine writes — but the code path is dead and should come out | FE, whenever convenient |
| `thread()`'s `pendingApprovalCount` is still structurally zero, now for a documented reason rather than an inherited one. Making it real is an FE-visible change and needs its own BREAKING.md entry (D103) | a future pass |
| **P12 workstream 1 (package split) is not done** — deferred by decision, not blocked. The plan's three-way boundary does not match the code: the engine reads the database directly, so the library package carries `db/` and `platform/`; `packs/` and `engine/playbooks/` import each other; `adapters/` fits neither named package (D104) | when a second consumer exists |
| ~~**P12 workstream 5 (Tera MCP tools) is not done**~~ | **done in P12** — five tools (`generateDraft`, `listPendingApprovals`, `approveMessage`, `listConversations`, `createCampaign`) on the v1 services, registered in tera-orchestrator with FGA catalog entries. Still needs the service deployed to be reachable (P10 Step 1) |
| **The MCP mutation gate named `sendSlack`, which is not a tool** — so both Slack sends and `addNotificationToQueue` ran unconfirmed for the life of the service. Fixed: tools declare `mutation` inline, discovery publishes the set, and a fallback name matching nothing now warns (D102) | done in P12 |
| `POST /v1/outreach/generate` did not exist, while two retired mounts answered `410` naming it as their successor. Written, documented and shared with the compat path (D101) | done in P12 |
| ~~`ApprovalService.release()` treats "the queue would not take it" the same as "compliance refused permanently"~~ | **done in P12** — `DispatchResult.transient`, the message row goes `FAILED` rather than staying `QUEUED` with no job, and `approve()` re-releases a stranded approval instead of reporting itself idempotent (D105) |
| A message stranded by a queue outage is recovered by **calling approve again**, not automatically. The deferral sweeper was not reused because its vocabulary is compliance suppression, and a queue failure is not one (D105) | a future pass |
| `0013_encrypt_credentials.sql` is applied **inside the cutover window**, after the load and finalize (D99 — there is no parallel run re-inserting plaintext). Runbook §8b has the three ordered steps | operator, in the window |
| Credential encryption is **off by default**; `CREDENTIAL_ENCRYPTION_KEYS` turns it on. A key that is lost cannot be recovered and every tenant re-enters its credentials | operator |
| ~~`CredentialResolver` caches decrypted credentials in Redis (D27), so encryption at rest in Postgres is not the whole story (D96)~~ | **done in P13** — the resolver does not cache at all; `ChannelConfigService` caches the rows as stored, still sealed, and decrypts after (D107) |
| ~~The compliance gate is a no-op when `recipientId` is absent~~ | **done in P13** — the dispatcher resolves a recipient from a bare address, so all eight paths that passed none now face consent, preferences and throttles (D107) |
| ~~`RetentionJob` is never instantiated~~ | **done in P13** — on a daily repeatable job, iterating `tenants` rather than `tenant_channel_configs`, still dry-run by default (D107) |
| The webhook URL guard does not close **DNS rebinding** — a name resolving public here and private when the HTTP client resolves again. Closing it means pinning the resolved address into the connection, an agent-level change to the HTTP stack. The per-tenant allow-list is the answer for a tenant that needs the guarantee (D107) | a future pass |
| Queue fairness is a BullMQ **limiter**, which caps total throughput and does not partition by tenant. Real per-tenant fairness needs a queue per tenant or a group key (D107) | when a second high-volume tenant exists |
| `AUTH_MODE=jwt` is still a `501`. `apikey` covers the vendor case; a second unused auth mode is a second thing to keep correct (D107) | when something needs it |
| The `push` adapter targets the FCM legacy API, decommissioned in 2024, and `fcmApiKey` has no config entry, no mapper and no caller. It answers `PUSH_NOT_IMPLEMENTED` rather than asking for a key nobody can supply. `voice` and `letter` have never had an adapter (D107) | implement FCM v1, or drop the channel |
| The compliance gate defaults to **shadow mode**. Its reason — do not silently stop messages that currently ship — does not apply while nothing ships, so this can be enforced from day one (D99) | operator, at cutover |
| `tenants.compliance_profile` is `{}` for every tenant today, so `hipaa` and `gdpr` are off everywhere and the GDPR endpoints 403. Setting it is a tenant decision | tenant/operator |
| The five per-channel opt-in flags are a **reserved, unenforced feature**: storage migrated, no write path, no enforcement, FE toggles that do not persist. Finishing it means a `PreferencePatch` field, a `ComplianceGate` rule, an FE mutation — and deciding how they relate to `preferred_channels`, which expresses the same idea differently (D85) | a future phase |
