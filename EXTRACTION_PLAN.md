# Outreach Engine — Extraction & Generalization Plan

**Source:** `mentera_core/services/communication-service` (123 `.ts` files, 30,631 LOC, 24 route files, 10 controllers, 21 service modules, 17 test files)
**Target:** `/Users/weevil/projects/elevano/nx-communication-service` — standalone repo, own database, own deploy
**Companion strategy docs:** `communication-service-decoupling-plan.html`, `future-state-diagrams.html`
**Status:** plan of record. Every claim in Part 0 was verified against the code on 2026-08-01.

---

## How to use this document

This plan is split into **13 phases (P0–P12)**. Each phase is scoped to fit in **one Claude Code session without context compression**. Each phase carries:

- **Session brief** — exactly which files to read, and which *not* to read. Follow it. The single biggest cause of a blown context window on this project is reading `communications.controller.ts` (2,571 LOC) or `template-engine.ts` (1,181 LOC) in full when you only need a signature.
- **Preconditions** — what must be true before you start.
- **Deliverables** — file-by-file, with paths.
- **Implementation detail** — code and SQL sketches, not prose.
- **Migrations** — written as numbered `.sql` files. **Never run them.** Hand them to the operator.
- **Verification** — commands that must pass.
- **Exit criteria** — the binary check for "phase done".
- **Handoff** — the one-paragraph note the next session needs.

### Hard rules for every session

1. **Never run a database migration.** Not `drizzle-kit push`, not `drizzle-kit migrate`, not `psql -f`. Write the `.sql` file, print the command the operator should run, stop.
2. **Never modify `mentera_core` before P10.** P0–P9 are additive work in the new repo only. The one exception is reading.
3. **Preserve behavior over elegance** where the two conflict and the phase does not explicitly say otherwise. The medspa tenant must keep working byte-for-byte through P10.
4. **Every table gets `tenant_id`.** No query without a tenant predicate. This is the isolation boundary and it is non-negotiable.
5. Commit at the end of each phase with a conventional message. Do not push unless asked.
6. The three planning docs at the repo root (`EXTRACTION_PLAN.md`, `EXTRACTION_PLAN.html`, `COMMIT_PLAN.md`) are **gitignored**. They live in the working tree and are never committed.

### Companion: `docs/DECISIONS.md`

**Read it before starting a phase.** It is the decision record — every divergence
from this plan, the evidence behind it, and the questions that drove it. Its §1
carries the standing working agreements (maintain the record, amend this plan in
place but ask first, never commit the planning docs, never run a migration).
Entries there are stable-numbered `D1`…`Dn` and are cited from this document.

### Amendments log

Corrections applied to this document after a phase verified a claim against the code. Each entry names the phase that found it.

| Found in | Section corrected | Correction |
|---|---|---|
| P0 | §P0 deps | `@aws-sdk/client-rds-data` removed from the dependency list — P1 drops the RDS Data API path entirely, so the package would ship unused. |
| P0 | §P0 jest | A second tsconfig (`tsconfig.test.json`) is required: the root config has `rootDir: src` and excludes `tests/`, so ts-jest cannot compile test files against it. |
| P0 | §P0 deliverables | `src/app.ts` is split out from `src/index.ts` so tests can build the app without binding a port. |
| P1 | §P1 observability | **The `tera_*` → `outreach_*` metric rename is not a real change.** No `tera_` prefix exists in shared-libs. See the corrected bullet for what P10 actually needs. |
| P1 | §P1 db client | `batchQuery` in shared-libs does not run its queries inside the transaction it opens. Signature changed to fix it. |
| P1 | §P1 redis | `ioredis` must be imported by name under NodeNext; the default export resolves to a namespace. |
| P1 | §P1 logger | `createServiceLogger` takes options instead of reading env, because `src/config/` is the only permitted `process.env` reader. File transport now defaults **off**. |
| P2 | §0.5 Seam D | **Seam D is closed.** All seven ghost tables are empty in production, none has a tenant column, and the code behind them is stubbed demo scaffolding. Nothing migrates; `9009_pack_medspa.sql` is deleted. |
| P2 | **new §0.10**, §0.7, §P2, §P7, §P9, Appendix B, Appendix F | **The engine ships no vertical-specific tables.** `pack_medspa_*` removed. New §0.10 gives the standing rule — *the engine needs a table only if the engine reads it* — and the four tiers that replace them. |
| P2 | §P2 migrations | Campaign tables moved from P11's `0008` into `0001`. Runtime still lands in P11; only the DDL moved, to stop the model and the database drifting for nine phases. |
| P2 | §P2 | `drizzle-kit generate` cannot read this schema at all. Replaced by `npm run db:draft`, which generates from a throwaway copy with the `.js` extensions stripped. |
| P2 | §P2 tests | The conformance test compares Drizzle and SQL **bidirectionally**. With no working generator, that is the only thing keeping them in sync — extend it, never weaken it. |
| P3 | §P3 credential resolution | Credential mapping is **per channel**, not a switch in the resolver. The drafted `resolveCredentials` violated P3's own "no switch on channel type" exit criterion three times (D20). |
| P3 | §P3 queues | BullMQ v5: `QueueScheduler` is gone, but the source never instantiated one — nothing to delete. The useful v5 addition is `UnrecoverableError` (D21). |
| P3 | §P3 adapters | The webhook endpoint registry and the push device-token registry are **not** ported — in-memory subscription state (D24). Slack's medspa helpers are pack content, not channel methods (D25). |
| P3 | §P3 config API | Config caching moves from per-instance `Map`s to Redis; the source's could not invalidate across replicas (D27). |
| P4 | §P4 LLM port | Three defects in `ai-service.ts` fixed, not ported: an uncleared timeout timer (D30), token counts estimated by word count (D31), and full prompts logged at info level (D32). |
| P4 | §P4 template engine | The renderer gets its own Handlebars environment rather than mutating the global singleton (D33), and `formatDate` resolves locale/timezone from the context instead of the server (D34). |
| P4 | §P4 generator | `aiConfidence` ignores any confidence the model reports (D35). |
| P4 | §P4 migration | **`0004_content.sql` is not written** — everything it would create is already in `0001` (D36). |
| P5 | §P5 quiet hours | Two real defects in the ported logic: `hour12: false` can render midnight as `24:00` (D38), and the deferral end time cannot be computed by offset arithmetic across DST (D39). |
| P5 | §P5 gate | Quiet hours and rate limits **defer**; the source blocks on quiet hours, so a reminder during someone's quiet window is lost rather than delayed (D40). |
| P5 | §P5 migration | `0005` is one column and three indexes — everything else it listed is already in `0001`. |
| P6 | §P6 what exists today, §P6 handoff, §P10 | **Approving a message sends nothing today.** It flips two status columns and nothing reads either back. P6's dispatch handoff is a fix, not a port: the medspa pack is byte-compatible in *UX*, not in outcome (D44). |
| P6 | §P6 access control | **The provider check guards only the pending list.** All six mutations look their row up by bare message id — no tenant predicate, no approver check. P6 *tightens* this rather than preserving it (D45). |
| P6 | §P6 what exists today, §P9 `9007` | **The two implementations use different storage, not different vocabularies.** `ai-enhanced` writes the `status` column; `approvals.controller` writes the JSONB. The two inboxes are disjoint sets, and the backfill must read both (D46). |
| P6 | §P6 exit criteria | The literal grep matches header comments that document what was replaced. Criterion restated as code-only (D46). |
| P5 | §P5 lint | The lint ruleset shipped in P5 but was never loaded or passed, so `lintWarnings` was always empty — which made P6's `threshold` lint condition vacuously true. Wired in P6 (D52). |
| P5 | §P3 record-result | `record-result` replaced `messages.metadata` instead of merging, destroying `metadata.playbookKey` on every send — so P5's per-playbook cooldown never fired for a delivered message (D49). |
| P7 | §P7 approval split | **None of the 17 event-driven playbooks requires approval today.** Seeding them all as `medspa.provider-always` would have stopped every appointment reminder at cutover. Approval is now decided by `content_source.kind` — AI waits, template sends (D53). |
| P7 | §P7 playbook table | Channels come from `event.channels` at runtime, not from the case. `channel_plan` is the *supported* set and the trigger's channels intersect it (D54). |
| P7 | §P7 emergency notification | Three more hardcoded literals beyond the flagged email: Slack channels `staff-alerts` (:448), `emergency-alerts` (:536) and `system-alerts` (:711). All become pack/tenant config (D55). |
| P8 | §0.2, §P8 exit criteria, Appendix A | **The legacy surface is 110 endpoints, not 77.** The 77 is what the session brief's own grep returns; it misses five registration sites that do not name their variable `router` — templates (14), ai-content (8), ehr-webhook (3), automated-messages (4), MCP (4). Appendix A already enumerates them (D60). |
| P8 | §P8 inbox, Appendix F | **The inbox handler is invalid SQL and has never returned a 200.** There is no current response shape to capture, so the golden-file instruction is replaced (D61). |
| P8 | §P8, phase map | P8 is split into **P8a** (v1 messaging surface + compat for the cutover-critical routers) and **P8b** (webhooks, MCP, the content-plane routers, OpenAPI). |
| P8b | phase map | **P8 ships a migration after all** — `0008_receipt_integrity.sql`. The phase map said none. Making a provider's callbacks write to `message_analytics` exposed a missing unique constraint that duplicated messages in every list, and an index the tenant-less receipt lookup could not use (D69). |
| P9 | §P9 step 2, phase map | **The 9xxx files are renumbered so numeric order is dependency order.** `messages.event_id` and `notification_id` are real foreign keys, so events and notifications must load before messages: events 9007, messages 9008, approvals 9009. Verify keeps 9010; two setup files (`9000_prelude`, `9001_source_link`) are new (D70). |
| P9 | §P9 step 2, 9007 | **Both approval predicates lose rows.** Shape A rows do not stay `QUEUED` — the controller flips the status column too — and `queued_message` is not reliably NULL on shape B, so a row holding `{}` was missed by both passes at once (D73). |
| P11 | phase map, §P11 | **P11 runs before P10, and its migration is `0009`.** The dependency was risk sequencing, not mechanism — and P10 Step 6 deletes the six source files P11's own session brief requires, so the plan's order would have destroyed its reference material (D81). |
| P11 | §P11 migration, §P12 | `0008_campaigns.sql` → **`0009_campaigns.sql`** (P8b took 0008), and P12's credential encryption moves to `0010`. Only `import_errors` is new; every other campaign table has existed since `0001`. |
| P11 | §P11, docs/api/BREAKING.md | **Asset upload, image generation, `/ai/multimodal` and the four `/templates/campaigns*` endpoints move to P12.** BREAKING.md assigned them to P11; the plan's P11 never mentioned them, and what they need is a storage adapter and an image-capable `LlmProvider` — neither of which is a campaign. New P12 workstream 3b. |
| P9 | §P9 step 1 | **The "approved but never sent" recon query always returns 0.** `message_history.sent_at` is `NOT NULL` and written at INSERT time, so `AND sent_at IS NULL` matches nothing — and returns the reassuring answer for the wrong reason (D74). |
| P10 | §P12, phase map | **P12 cannot run before P10, and two of its workstreams would break the cutover.** Workstream 2 deletes the compat shim the cutover runs on, and decides what to delete from a counter that only records once P10 routes traffic; dropping the header aliases breaks every gateway request, because the gateway sends only `x-medspa-id`. Workstream 3b (storage adapter + image model) is the one genuinely independent piece (D84). |
| P10 | §P9 `9006`, §P10 Seam B | **`9006_preferences.sql` dropped five columns.** The per-channel opt-in flags are not migrated. Not a compliance gap — nothing reads them in either system — but the FE renders them, so Seam B could not drop patient-service's JOIN without them. Carried across by `0010_recipient_optins.sql` (D85). |
| P10 | **§P10 Step 5 → before Step 2**, Step 4 | **The five callers are broken *now*, and Step 5 has to precede the repoint.** Every providers-service → communication-service call omits the tenant header, and the old service never asked for one. Step 2's rule that "any 4xx is a P8 bug" does not apply: these are caller bugs, and the plan scheduled their fix three steps after the repoint that breaks them (D86). |
| P10 | §P10 Seam A | **Seam A is twice the size the plan describes.** providers-service reaches templates two ways — the direct-DB `template.service.ts` the plan names, and eight already-HTTP proxy methods in `settings.service.ts` it does not. Also: the engine's `DELETE` is destructive where this method has always soft-deleted (D87). |
| P10 | §P12 workstream 3 | `0010_encrypt_credentials.sql` → **`0013_encrypt_credentials.sql`**. P10 took `0010` (recipient opt-ins), `0011` (the platform tenant) and `0012` (deferred messages). |
| P10 | §P10 Step 6 | **Step 6's reference list is incomplete.** It misses `jenkinsFile` (5 image build/push/pull lines), `docker/server.Dockerfile` (3), `package-lock.json`'s workspace entry, the root `drizzle.config.ts` (which addresses *only* the deleted schema, so it goes with `db:push`), and `terraform/README.md`. It also says the metric prefix changed — P1 already established that it did not; the instrument names are standard and only the `service` label moves. |
| P10 | §P10 Step 6 | **Deleting the service exposed a pre-existing defect** in providers-service: four services opened a database connection from a field initializer at import time, masked until now by a duplicate `drizzle-orm` under the deleted workspace. Present on `develop` too, verified. Fixed (D88). |
| P12 | §P12 workstream 3b, `docs/api/BREAKING.md`, D84 | **Six of the seven `501` endpoints were never blocked on an image model.** `AIService.generateImage` (`ai-service.ts:562-570`) is a body that throws unconditionally, and every caller either swallows it (`campaign-template-generator.ts:232`, `template-controller.ts:368`) or never reaches it — `/ai/multimodal` generates image *descriptions* as text. Only `assets/generate-image` needs one, and the source answered 500 there for its whole life (D92). |
| P12 | §P12 workstream 3b | **Workstream 3b is one storage adapter, not two pieces of machinery.** The `ImageProvider` port ships with no adapter, by decision — the endpoint that needs it has never worked anywhere. |
| P12 | §P12 workstream 3 | **`requiredConfig` had no reader**, and `tenant_packs.config` was replaced where the code's own comment promised a merge — so a partial re-install silently dropped an operator's other settings and the affected playbooks began producing `SKIPPED` runs (D95). |
| P12 | §P12 workstream 3 | **`key_hash` is SHA-256, not the "Argon2/bcrypt digest" the schema comment claims.** A salted password hash cannot be looked up, so verification would be O(all keys) on every request and the unique index would be unusable (D94). |
| P12 | §P12 workstream 3, migrations | **`0013_encrypt_credentials.sql` is not baseline schema.** It is a decommissioning step gated on the parallel run ending; harnesses apply `0001`–`0012` and it is exercised by its own suite (D97). |
| P12 | §P12 workstream 4 | **CAN-SPAM and TCPA are engine defaults that a tenant cannot switch off**, rather than flags read from `compliance_profile` — an unset field would otherwise opt a tenant out of the law. `hipaa` and `gdpr` stay opt-in add-ons. |
| P12 | phase map, §P12 | **Workstreams 1, 2 and 5 are not done and are still gated on the cutover** (D84). P12 delivered 3, 3b and 4, plus the D82 loader check and the `AuthorizationProvider` (D98). |
| P12 | **§P10 Steps 1–3**, `docs/MIGRATION_RUNBOOK.md` §§0, 1, 5.3, 5.5, 7, 8b | **There is no parallel run, no staging and no live traffic** — the product is in demo phase. The staged cutover, the delta sync, the business-day soak and the `outreach_compat_hits_total` measurement were all built for risk that does not exist here, and the counter method could never have worked: nothing is calling. Steps 1–3 are now one window (D99). |
| P12 | §P12 "what P12 delivered", D84 | **Workstreams 1, 2 and 5 are unblocked.** D84's analysis of them rested on the parallel-run premise D99 corrects. Compat retirement is by **inspection** — ~20 of the 110 endpoints are reachable — which is a complete answer rather than a sampled one. |
| P12 | §P9, runbook §5.3 | **Nothing migrated may land in a state that looks actionable.** `mig.finalize_cutover()` cancels approvals still open and never-sent messages with no approval, once, after the source has stopped. `CANCELLED` rather than `SENT`: both are mechanically safe, only one is true (D99). |
| P12 | §P12 workstream 5, §P12 "what P12 delivered" | **`POST /v1/outreach/generate` did not exist**, and two retired compat mounts had been answering `410` naming it as their successor since D100. Generate-then-review lived only inside the shim as a local function. Extracted to `engine/outreach/draft.service.ts` and given a real v1 route; the shim delegates to it (D101). |
| P12 | §P12 workstream 5 | **The MCP mutation gate named a tool that does not exist.** `mutationTools` listed `sendSlack`; the names are `sendSlackMessage` and `sendUrgentSlackAlert`, so both Slack sends and `addNotificationToQueue` ran unconfirmed for the life of the service. Tools now declare `mutation` beside themselves, discovery publishes the set, and a stale gate name warns instead of failing open (D102). |
| P12 | §P12 workstream 2, §P2 migrations | **`messages.queued_message` leaves `0001` rather than being dropped by a later migration.** A `DROP COLUMN` could only run after the 9xxx load, making it non-baseline — which forces the Drizzle model to keep a column that `ApprovalService.release()`'s `select()` would then emit against a table that no longer has it. No environment has applied `0001`, so the column came out of the baseline instead. `0014` survives as a no-op cleanup (D103). |
| P12 | §0.7 header compatibility, §P12 workstream 2 | **The medspa header aliases are dropped.** The blocker was misread: the gateway *requires* `x-medspa-id` from the apps, which is its contract with its clients and untouched — what had to change is what it **forwards**, which is additive. It now sends both spellings, tera-orchestrator does too, the three service clients already did, and the engine reads only `x-tenant-id` / `x-sub-tenant-id`. `x-provider-id` is deliberately kept (D106). |
| P12 | §P6 dispatch handoff, §P12 | **A queue outage was cancelling approvals.** `release()` could not tell an unreachable queue from a compliance refusal — `DispatchResult` carried only free text and a compliance-specific `deferrable` — so an infrastructure failure moved the approval to `CANCELLED` and blamed `compliance.gate` in the audit trail. Now `transient`, a `FAILED` message row rather than a `QUEUED` one nothing will collect, and an `approve()` that re-releases instead of reporting itself idempotent (D105). |
| P12 | §P12 workstream 1 | **The package split's boundary does not match the code.** The engine reads the database directly, so `outreach-engine` carries `db/` and `platform/` — it is not "ports plus the four services". `packs/` and `engine/playbooks/` import each other, and `adapters/` fits neither named package. Deferred by decision rather than blocked (D104). |

---

# PART 0 — GROUND TRUTH

## 0.1 Locked decisions

| Decision | Choice | Consequence |
|---|---|---|
| **Database** | **Own DB from day one** | New Postgres database `outreach`. Requires resolving 3 cross-ownership seams (§0.5) before cutover. Data migration is a first-class phase (P9). |
| **Scope** | **Extract *and* generalize together** | The rename to `recipient/sender/tenant`, the Channel + Context + LLM ports, the `approvals` table, and the playbook runtime all land inside this effort. No second pass. |
| **shared-libs** | **Vendor into the new repo** | ~1,300 LOC copied to `src/platform/`. Zero dependency on `mentera_core`. Accepted cost: future drift. |
| **Cutover** | **Env-var repoint + parallel run** | New service deploys alongside; `COMMUNICATION_SERVICE_URL` and 4 other call sites repoint. Old code deleted in P10 only after parity is proven. |

## 0.2 What the service actually is today

Express on port 5007, mounted behind the gateway which strips `/api/communication` and forwards identity headers. Auth trusts `x-gateway-request: true`. Two BullMQ queues on Redis (event ingestion + notification send). **24 routers, 110 HTTP endpoints** (full inventory: Appendix A).

> **Corrected (P8):** an earlier draft said 77. That is what `grep -cE "router\.(get|post|put|patch|delete)\(" src/routes/*.ts` returns, and it only matches route files whose router variable is literally named `router`. Five registration sites use a different name or live in a controller: `template-controller.ts:79-100` (14), `ai-content-controller.ts:32-43` (8), `ehr-webhook.routes.ts` (3), `automated-messages.routes.ts` (4), `mcp/index.ts:42-212` (4). Appendix A already enumerates all of them. Size the phase off 110 (D60).

**Verified generic (port as-is, rename only):**

| Component | File | Note |
|---|---|---|
| Notification queue | `services/queue/notification-queue.ts` (743L) | BullMQ, 5 attempts exponential backoff, 10× for URGENT, priority lanes, 24h/7d cleanup |
| Event processing queue | `services/queue/event-processing-queue.ts` (415L) | Separate queue, `createFromEnvironment()` factory |
| Bedrock AI client | `services/ai/ai-service.ts` (585L) | Multi-model (`AIModel` enum: Nova/Titan/Claude), `generateContent`, `generateJsonContent<T>`, metrics, timeout handling. **Zero domain knowledge.** |
| Template engine | `services/templates/template-engine.ts` (1,181L) | Handlebars + MJML, generic helpers, CRUD + render + AI generation + asset upload/generation |
| Preference engine | `services/preference/preference.service.ts` (631L) | Quiet hours w/ cross-midnight + timezone, per-channel/per-event opt-out, urgent override, unsubscribe tokens |
| Channel enum | `models/communication.model.ts` | `EMAIL SMS PUSH IN_APP VOICE WEBHOOK LETTER SLACK` |
| Per-tenant creds | `medspa_configurations`, `provider_configurations` | Already a white-label credential store; just named "medspa" |
| Twilio tenant fallback | `services/sms/twilio.ts` (231L) | 3-level chain: provider number → medspa config → env. Client cache keyed on `accountSid:authToken`. Good pattern — keep. |

**Verified coupled (must change):**

| Coupling | Evidence |
|---|---|
| **Medspa identity triple welded into schema** | `patientId`/`providerId`/`medspaId` on nearly every table. `NOT NULL` on: `message_history.patient_id`, `message_history.provider_id`, `message_analytics.patient_id`, `communication_memories.patient_id`, `patient_feedback.patient_id`, `campaigns.provider_id`, `campaign_recipients.patient_id` |
| **Event logic is enum + switch** | `EventType` enum has **44 values** (`models/communication.model.ts`, `LEAD_*` at :52–56). `events/enhanced-event-handler.ts` (725L) is one **17-case switch** with fixed variables + hardcoded `templateId` strings (21 literals) and `to: 'emergency-team@medspa.com'` at **:549** |
| **Channel dispatch is a switch** | `notification-queue.ts:271–294` — 6-case switch over `EMAIL/SMS/SLACK/PUSH/WEBHOOK/IN_APP`, bespoke payload type per case, **no `Channel` interface** |
| **AI prompts embed healthcare** | `ai-message-generator.ts` and `ai-enhanced-communication.controller.ts` inline "patient-provider", "treatment", "HIPAA" |
| **Context fetched from Mentera services** | `services/data/context-fetcher.service.ts:70–71` and `controllers/ai-enhanced-communication.controller.ts:32–33` build URLs from `PATIENT_SERVICE_URL`/`PROVIDER_SERVICE_URL`. 8 `axios.get` / `fetch` call sites total |
| **Approvals live in a JSONB blob** | No `approvals` table. State is `message_history.queued_message->>'approvalStatus'`, queried at `approvals.controller.ts:76,209,223,258,337`. Approver hardwired to `providerId`. **Two parallel implementations** — `approvals.controller.ts` (9 endpoints, states `APPROVED/DECLINED/SCHEDULED`) vs `ai-enhanced-communication.controller.ts` (3 approval endpoints, states `APPROVED/SCHEDULED/REJECTED`) |
| **Preference engine is in-memory** | `preference.service.ts:30` — `private userPreferences: Map<string, UserPreferences> = new Map()`. The `communication_preferences` table exists but the engine does not read it. State is lost on restart. |
| **Persona service is in-memory** | `persona-service.ts:94–95` — two `Map`s, no persistence |

## 0.3 Dependency on `@mentera/shared-libs` — the complete surface

Only **11 symbols across 3 subpaths, in 16 files**. This is the entire vendoring job.

| Subpath | Symbols | Backing file | LOC |
|---|---|---|---|
| `/utils` | `initializeDatabase`, `getDatabase`, `checkDatabaseConnection`, `closeDatabase`, `batchQuery` | `utils/db-client.ts` | 620 |
| `/utils` | `redisCache` | `utils/redis-cache.ts` (+ `redis-client.ts`) | 396 + 383 |
| `/utils` | `tenantWhere`, `locationValueForInsert` | `utils/tenant-scope.ts` | 35 |
| `/observability` | `createServiceLogger` | `observability/logger.ts` | 92 |
| `/observability` | `createObservabilityMiddleware`, `initMetrics`, `metricsHandler` | `observability/{middleware,metrics,context}.ts` | 137 + 75 + 51 |
| `/middleware` | `authenticate`, `authenticateRoutes` | `middleware/auth.middleware.ts` | 257 |

Consuming files: `index.ts`, `middleware/auth.middleware.ts`, `utils/logger.ts`, `utils/shared-db.ts`, `utils/queue-config.ts`, `db/client.ts`, `routes/health.routes.ts`, `controllers/{ai-enhanced-communication,webhooks-controller,communications,approvals}.controller.ts`, `services/ai/{automated-message-generator.service,ai-message-generator}.ts`, `services/queue/{event-processing-queue,notification-queue}.ts`, `services/data/context-fetcher.service.ts`.

Full vendoring manifest with per-file disposition: **Appendix D**.

## 0.4 Who depends on the communication service

**Inbound HTTP (5 callers):**

| Caller | File | Calls |
|---|---|---|
| **Gateway** | `packages/gateway/src/index.ts:26,356,399` | `createServiceProxy('/api/communication', COMMUNICATION_SERVICE_URL, ...)` — strips prefix, forwards `x-gateway-request`, `x-medspa-id`, `x-location-id`, `x-user-*`, `x-request-id`. Also health-checks `/health` at boot. |
| **providers-service** | `src/services/email.service.ts:53,60,98` | `POST /email/send` for `email-verification`, `provider-invitation`, `password-reset`. **Note:** default is `http://localhost:3002`, overridden to `http://127.0.0.1:5007` when `IN_DOCKER !== 'true'`. Dev mode logs instead of sending. |
| **providers-service** | `src/services/integration-settings.service.ts:56,60,74–75` | `GET/POST/PUT /config/medspa/:medspaId` |
| **providers-service** | `src/utils/event-service.ts:191–200` + `src/services/communication-service-client.ts` | `POST /api/events` via `CommunicationServiceClient`. **Bug to preserve/fix:** the default URL is `http://localhost:5001` (the gateway) and the path is `/api/events`, not the service's own `/events`. |
| **providers-service** | `src/services/settings.service.ts:1266` | Template proxy; default `http://localhost:3002` |
| **scheduling-service** | `src/services/notification.service.ts:52` | `POST ${COMMUNICATION_SERVICE_URL}/${endpoint}` |
| **health-monitor** | `services/health-monitor/index.ts:57` | `GET /health` |
| **tera-orchestrator** | `src/modules/bedrock/core/tools/service-mcp-tools.ts:111–112` | MCP discovery `GET /mcp/tools` + execution `POST /mcp/tools/:name` at `COMMUNICATION_SERVICE_MCP_URL` (default `http://localhost:5007/mcp`), tool prefix `comm`, mutation tools `sendEmail`/`sendSMS`/`sendSlack`. Also `action-executor.ts:190` maps domain `communication` → server `communication-service`. |

**Infra references:** `docker-compose.yml` (:113–149, :27, :62, :503, :606), `k8s/services/communication-service.yaml`, `terraform/main.tf:95,223`, `infra/lib/mentera-stack.ts:215,333`, `.github/workflows/deploy.yml:86,138`, `observability/prometheus/prometheus.yml:26–28`, `scripts/fix-imports.js:27,75`, root `drizzle.config.ts:3,6,7`, root `package.json:26`, `server/index.ts:56–57,236`, `server/routes.ts:48`.

## 0.5 The three cross-ownership seams (the reason "own DB" is expensive)

All services share **one physical database** — `DB_NAME=postgres` on `mentera-proxy.proxy-co3uio4ocru6.us-east-1.rds.amazonaws.com`, verified identical in `communication-service/.env`, `patient-service/.env`, `providers-service/.env`. Three tables are genuinely co-owned:

### Seam A — `communication_templates`

Declared in **both** `communication-service/src/schema/db.ts:104` **and** `providers-service/src/db/schema.ts:344` — with *different columns* (providers has `status`, comm has `templateType`/`previewText`/`description` differences, comm's `name`/`content`/`channel` are `NOT NULL`, providers' are nullable).

providers-service holds the **real foreign keys**:
- `template_versions.template_id → communication_templates.id ON DELETE CASCADE` (`schema.ts:4406–4407`)
- `notification_rules.email_template_id → communication_templates.id ON DELETE SET NULL` (`:4440`)
- `notification_rules.sms_template_id → communication_templates.id ON DELETE SET NULL` (`:4442`)

and the CRUD surface: `providers-service/src/services/template.service.ts` (list/get/create/update/delete/incrementUsage/setDefault) + `notification-rule.service.ts:146–147`.

**Resolution (P10):** the outreach engine owns `templates` — it must, because a non-medspa tenant has no providers-service. `template_versions` **moves** to the outreach DB. providers-service's `notification_rules` keeps `email_template_id`/`sms_template_id` as **soft references** (FK dropped, column kept, UUIDs preserved across the migration so values stay valid). `providers-service/src/services/template.service.ts` becomes a thin HTTP client against `POST/GET/PUT/DELETE /v1/templates`.

### Seam B — `communication_preferences`

Declared in **both** `communication-service/src/schema/db.ts:5` **and** `patient-service/src/db/schema.ts:137`. `patient-service/src/repositories/patient.repository.ts:151–158` **LEFT JOINs** it onto `patients` on `(patient_id, medspa_id)`.

**Resolution (P10):** outreach owns it, renamed `recipient_preferences`, keyed by `recipient_id`. patient-service drops the JOIN; the field becomes opt-in via a small HTTP client (`GET /v1/recipients/:externalRef/preferences`) or is dropped from the payload if unused by the FE. **Verify FE usage before choosing.**

### Seam C — raw `SELECT ... FROM patients`

`communications.controller.ts` reaches directly into the patient-service table at **:1240, :1441, :1671** — e.g. the inbox does
```sql
SELECT patient_id, first_name || ' ' || last_name AS "patientName"
FROM patients WHERE patient_id IN (...)
```
to resolve display names for conversations.

**Resolution (P5/P10):** replaced by the engine-owned `recipients` table (`display_name`, `contact_points`, `external_ref`), populated by the `MenteraContextProvider` on first contact and refreshed on demand. No cross-DB read survives.

### Seam D — ghost tables (schema drift, must not be missed)

These are written by raw SQL in the service but **exist in neither `schema/db.ts` nor the drizzle migrations**:

| Table | Written by | Ops |
|---|---|---|
| `promotions` | `services/promotion/promotion.service.ts:25` | INSERT |
| `gift_cards` | `services/promotion/promotion.service.ts:215` | INSERT |
| `lead_profiles` | `services/lead/lead-message.service.ts:92,130` | INSERT, UPDATE |
| `treatment_follow_up_rules` | `services/treatment/treatment-follow-up.service.ts:271` | INSERT, SELECT |
| `outreach_rules` | `services/onboarding/onboarding-service.ts:222,271` | INSERT ×2, SELECT ×4 |
| `farewell_messages` | `services/farewell/farewell-message.service.ts:238` | INSERT |
| `patient_feedback` | `services/feedback/feedback-analysis.service.ts:133,209` | In `schema/db.ts:248` but **absent from migration `0000`** |

`campaigns` is also written by raw SQL (`promotion.service.ts:291,359`) despite being in the drizzle schema.

#### Seam D is closed. Verified against production, 2026-08-04.

Three facts, checked rather than assumed, collapse this seam to nothing:

**1. Every one of these tables is empty.** `SELECT count(*)` returns **0** for all seven — `promotions`, `gift_cards`, `lead_profiles`, `treatment_follow_up_rules`, `outreach_rules`, `farewell_messages`, `patient_feedback`. There is no data to migrate, no attribution to decide, and no rollback to plan.

**2. None of them has a tenant column.** Not `medspa_id`, not `location_id`, not `tenant_id` — confirmed at the database level and in the code (`grep -c medspa_id` over all five writing services returns 0). Had they held data, that data would have been unattributable, and reads like `SELECT * FROM promotions WHERE id = $1` would have been cross-tenant by construction. With one tenant nothing leaked; with two it would have, and gift cards carry a balance.

**3. The code behind them is demo scaffolding.** Not incomplete — stubbed, and labelled as such:

| Location | What it returns |
|---|---|
| `promotion.service.ts:169` | `findEligiblePatients()` → hardcoded `PATIENT-1 Jane Smith` / `PATIENT-2 John Doe`, *"For demo purposes, we'll return stub data"* |
| `feedback-analysis.service.ts:229` | `getPatientDetails()` → hardcoded `Jane Smith / jane.smith@example.com` |
| `feedback-analysis.service.ts:251` | `getProviderForPatient()` → hardcoded `Dr. Rachel Garcia / rachel.garcia@medspa.com` |
| `promotion.service.ts:403,425` | two more stubs |

`createTargetedCampaign()` — the entire reason promotions live in this service — is built on the first of those. Nothing outside `communication-service` imports any of it; the only external mention of `patient_feedback` is a line in `integrations-service/src/db/seed.ts`.

**Resolution (P2): none of these becomes a table in the outreach engine.** Not folded, not namespaced — gone. Where their concepts survive, they survive as §0.10 tier-1 or tier-2 constructs:

| Ghost table | Becomes |
|---|---|
| `promotions`, `gift_cards` | the vertical's own service. A gift card balance is a ledger; it belongs with commerce. The engine receives the fields it must render in the event payload. |
| `patient_feedback` | inbound `messages` (`direction='inbound'`) + `message_analytics.metadata` for sentiment/adverse judgments |
| `lead_profiles` | `recipients.attributes` + `recipient_context` |
| `outreach_rules`, `treatment_follow_up_rules` | `playbooks` rows |
| `farewell_messages` | `messages` with `playbook_id = 'medspa.farewell'` |

**P9 consequence:** migration `9009_pack_medspa.sql` is deleted, not written. P9 Step 1 still runs the recon query — as a **guard**, to confirm the counts are still zero at cutover time rather than to discover a shape.

## 0.6 Existing migrations in the source service

`services/communication-service/drizzle/migrations/`:
- `0000_spicy_valeria_richards.sql` — creates 12 tables (`ai_interactions`, `campaign_recipients`, `campaigns`, `communication_batches`, `communication_events`, `communication_memories`, `communication_preferences`, `communication_templates`, `message_analytics`, `message_history`, `notifications`, `scheduled_communications`). Note: **no `patient_feedback`**, no `medspa_configurations`/`provider_configurations`.
- `0001_add_communication_configs.sql` — `medspa_configurations`, `provider_configurations` + 5 indexes
- `0003_fix_queued_message.sql` — drops typo columns `queedmessagr`/`queedmessage`, adds `queued_message JSONB`, adds `message_history_queued_approval_idx` + `message_history_provider_queued_idx`
- `0004_add_location_id.sql` — adds `location_id uuid` to 5 tables + composite `(medspa_id, location_id)` indexes
- `0005_backfill_location_id.sql` — backfill

There is no `0002`. The new repo restarts migration numbering from `0001`.

## 0.7 Vocabulary map — old → new

Applied consistently everywhere: columns, TypeScript types, API fields, headers, log keys.

| Today | Target | Medspa-pack meaning |
|---|---|---|
| `patientId` / `patient_id` | `recipientId` / `recipient_id` → FK to `recipients` | recipient = patient |
| `providerId` / `provider_id` | `senderId` / `sender_id` (agent on whose behalf we send) | sender = provider |
| `medspaId` / `medspa_id` / `x-medspa-id` | `tenantId` / `tenant_id` / `x-tenant-id` | tenant = medspa |
| `locationId` / `x-location-id` | `subTenantId` / `x-sub-tenant-id` (nullable = org-wide) | sub-tenant = location |
| `medspa_configurations` | `tenant_channel_configs` | same rows |
| `provider_configurations` | `agent_channel_configs` | same rows |
| `communication_preferences` | `recipient_preferences` | keyed by recipient |
| `message_history` | `messages` | |
| `communication_events` | `outreach_events` | |
| `communication_templates` | `templates` | |
| `communication_memories` | `recipient_memories` | |
| `EventType` enum + handler switch | `playbooks` + `playbook_triggers` rows | 17 seeded medspa playbooks |
| approval state in `queued_message` JSONB | `approvals` table + `approval_policies` | `{mode: always, approver: agent}` |
| `patient_feedback` | inbound `messages` + `message_analytics.metadata` | no table (§0.10) |
| `promotions`, `gift_cards` | **not in the engine** — the vertical's own service | fields arrive in the event payload |
| `lead_profiles` | folded into `recipients.attributes` + `recipient_context` | pack-owned context |
| `outreach_rules`, `treatment_follow_up_rules` | folded into `playbooks` | seeded rows |
| `farewell_messages` | folded into `messages` (playbook `medspa.farewell`) | — |

**Header compatibility:** the engine accepted **both** `x-tenant-id` and `x-medspa-id` (the latter mapped to the former) through the extraction, and the same for `x-sub-tenant-id` / `x-location-id`. **Removed in P12 (D106)** — the gateway forwards the generic names now, so the engine reads only those; a request carrying just the medspa spelling has no tenant and is rejected. The gateway still *requires* `x-medspa-id` from the web and mobile apps, which is its own contract and unchanged. `x-provider-id` survives as an alias for `x-sender-id`: a sender identity is not the tenancy boundary.

## 0.8 Target repo layout

```
nx-communication-service/
├── EXTRACTION_PLAN.md            ← this file
├── package.json                  ← name: @mentera/outreach-server
├── tsconfig.json
├── drizzle.config.ts
├── jest.config.cjs
├── .eslintrc.cjs
├── .env.example
├── Dockerfile
├── docker-compose.yml            ← postgres + redis + service, for local dev
├── .github/workflows/ci.yml
├── migrations/                   ← hand-written SQL. NEVER auto-run.
│   ├── 0001_core_schema.sql
│   ├── 0002_approvals.sql
│   ├── ...
│   └── README.md                 ← run order + operator instructions
├── docs/
│   ├── api/openapi.yaml
│   ├── PACKS.md
│   └── MIGRATION_RUNBOOK.md
├── packs/
│   ├── medspa/                   ← JSON/YAML: playbooks, prompts, policies, templates
│   └── lead-generation/
├── src/
│   ├── index.ts                  ← composition root
│   ├── config/
│   ├── platform/                 ← VENDORED from shared-libs (Appendix D)
│   │   ├── db/                   ← client.ts, tenant-scope.ts
│   │   ├── redis/                ← cache.ts, client.ts
│   │   ├── observability/        ← logger.ts, metrics.ts, middleware.ts, context.ts
│   │   └── http/                 ← auth.middleware.ts, error-handler.ts
│   ├── db/
│   │   ├── schema.ts             ← barrel
│   │   └── schema/               ← one file per domain group
│   ├── domain/                   ← types + enums, no I/O
│   ├── ports/                    ← Channel, ContextProvider, LLMProvider, TemplateStore
│   ├── adapters/
│   │   ├── channels/             ← sendgrid, twilio, slack, push, webhook, in-app
│   │   ├── llm/                  ← bedrock
│   │   └── context/              ← inline (default), mentera, csv
│   ├── engine/
│   │   ├── playbooks/            ← runtime, trigger matching, data contracts
│   │   ├── content/              ← template engine, prompt assembly, generation
│   │   ├── approvals/            ← state machine, policy engine
│   │   ├── compliance/           ← preferences, quiet hours, consent, lint
│   │   ├── delivery/             ← queues, dispatch, retry
│   │   └── campaigns/            ← audiences, batch orchestrator
│   ├── api/
│   │   ├── v1/                   ← the new versioned surface
│   │   └── compat/               ← legacy 110-endpoint shim (deleted in P12)
│   ├── mcp/
│   └── packs/                    ← pack loader + registry
└── tests/
    ├── unit/
    ├── integration/
    └── contract/                 ← golden tests against recorded legacy responses
```

## 0.9 Conventions

- ESM (`"type": "module"`), `.js` extensions in relative imports, `NodeNext` resolution.
- **`strict: true`.** The source service runs `strict: false`; the new repo does not inherit that. Expect to add real types where the source used `any`.
- Drizzle for all DB access. Raw `sql` only where a query genuinely cannot be expressed — and never against a table this service does not own.
- Zod for request validation and for playbook data contracts (JSON Schema is generated from Zod, not hand-written).
- Winston structured JSON logging via `platform/observability`.
- Every route handler: `tenantId` resolved by middleware, never read from the body.
- No singletons exported at module scope for anything that touches I/O — use the composition root in `src/index.ts`. (The source service exports `export const twilioSMSService = new TwilioSMSService()` etc.; that pattern does not survive the port, because adapters need per-tenant credentials injected.)

---
## 0.10 Where a vertical's data lives — the extension model

> The standing rule for every phase: when a pack, a vertical or a tenant needs to store something, this decides where it goes. It is the difference between an industry-agnostic engine and a medspa service with the word "medspa" filed off.


### The rule

> **The engine needs a table only if the engine reads it.**

Apply it literally. Ask "does the engine itself read this row to do its job?" If the answer is no, the engine does not get a table, no matter how naturally the data seems to belong to messaging.

Worked example — a promotion. Does the engine read `promotions` to send a message? No. It needs the promotion's *fields at render time* (name, discount, expiry), and those arrive with the event. The promotion's lifecycle — who created it, when it expires, which treatments it covers — is the vertical's problem, and the vertical has that table whether or not this engine exists.

### The four tiers

| Tier | Lives in | Use for | Consumer must create tables? |
|---|---|---|---|
| **1. Event payload** | nowhere — transient | Data the engine needs only at render time. Validated against the playbook's `data_contract` (JSON Schema, generated from Zod). | no |
| **2. Generic extension columns** | engine DB, schemaless — `recipients.attributes`, `recipient_context.payload`, `message_analytics.metadata`, `tenant_packs.config` | Data the engine must query, filter or segment on, per recipient or per message | no |
| **3. The vertical's own service** | consumer's own database | Data the vertical owns and queries; the engine never reads it | it already has them |
| **4. Pack-owned migration** | engine DB, opt-in | Rare escape hatch: relational storage that genuinely must sit beside engine data | opt-in, and it ships with the pack — not with the engine |

Tiers 1 and 2 cover almost everything. Reach for 4 only when 1–3 have each been ruled out in writing, and when it lands, it lands as a migration shipped **with the pack**, applied only by tenants that install it — never in the engine's `migrations/0*.sql`.

### What this answers

*"Doesn't tier 3 mean I have to create tables before I can use the outreach engine?"* — No. A consumer creates tables only for data **they** own and **they** query, which they would need regardless. A gym adopting the engine for class reminders creates nothing at all; it sends events and the engine sends messages. The medspa has a promotions table because it runs promotions, not because of anything the engine requires.

### The mechanism is generic; the content is not

Three things wear the word "pack" and only the first two belong in this repo:

- **the mechanism** — `packs`, `tenant_packs`, and the `pack_id` provenance column on `playbooks`/`templates`/`prompt_packs`/`approval_policies`. A pack id is a string. No table is shaped by what any pack contains. This is the engine's plugin registry and it stays.
- **the content** — playbooks, templates, prompts and policies as JSON/YAML under `packs/`, loaded into rows. Supplied by whoever adopts the engine. Stays as data.
- **~~pack-owned tables~~** — dropped. See §0.5 Seam D.

### The test

```bash
grep -ri medspa src/db/ migrations/
```

Must return no table name and no column name. Hits in comments and in example key strings (`'medspa.appointment_reminder'`) are fine — those are data, not schema. Run it whenever a phase adds tables.


---
# PART I — PHASES

## Phase map

| # | Phase | Touches mentera_core? | Migrations | Depends on |
|---|---|---|---|---|
| P0 | Repo scaffold & toolchain | no | — | — |
| P1 | Vendored platform layer + boot | no | — | P0 |
| P2 | Domain schema + core migrations | no | `0001`–`0003` | P1 |
| P3 | Delivery plane: Channel port, adapters, queues | no | — | P2 |
| P4 | Content plane: templates + LLM port | no | `0004` | P2 |
| P5 | Context port, recipients, compliance plane | no | `0005` | P2, P4 |
| P6 | Approvals: table, state machine, policy engine | no | `0006` | P2 |
| P7 | Playbook runtime + medspa pack | no | `0007` | P4, P5, P6 |
| P8a | v1 messaging surface + compat for the cutover-critical routers | no | — | P3–P7 |
| P8b | Webhooks, MCP, content-plane routers, EHR mapper, OpenAPI | no | `0008` | P8a |
| P9 | Data migration from mentera-core DB | read-only | `9000`–`9010` | P8 |
| P10 | mentera_core cutover + seam resolution | **YES** | mentera-core `M1`–`M3` | P9 |
| P11 | Campaigns, audiences, lead-gen pack | no | tables already in `0001` | P10 |
| P12 | Productization: package split, packs, Tera tools | yes (light) | `0014` | P11 |

---

# P0 — Repo scaffold & toolchain

### Session brief
Read: this file §0.8, §0.9. `mentera_core/services/communication-service/package.json`, `tsconfig.json`, `jest.config.cjs`, `Dockerfile`, `.env.example`. **Do not read any `src/**` file this phase.**
Budget: small. This phase is config only.

### Goal
`npm install && npm run build && npm test` succeeds in the new repo on an empty `src/` with one placeholder. Docker builds. Nothing business-logical exists yet.

### Preconditions
`/Users/weevil/projects/elevano/nx-communication-service` exists with `.git` and nothing else.

### Deliverables

**`package.json`**
```jsonc
{
  "name": "@mentera/outreach-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "rimraf dist && tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "NODE_OPTIONS=--experimental-vm-modules jest",
    "test:unit": "npm test -- tests/unit",
    "test:contract": "npm test -- tests/contract",
    "lint": "eslint 'src/**/*.ts'",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "migrate:print": "node scripts/print-migrations.mjs"
  }
}
```

Dependencies — pinned to the versions the source service actually runs, **except** where the monorepo root had a newer major that the service picked up through hoisting. Resolve each explicitly:

| Package | Source service declares | Root declares | **Use** |
|---|---|---|---|
| `twilio` | `^4.19.0` | `^5.5.1` | **`^5.5.1`** — the code uses only `client.messages.create`, compatible |
| `@sendgrid/mail` | `^7.7.0` | `^8.1.4` | **`^8.1.4`** |
| `@slack/web-api` | `^6.8.1` | `^7.9.0` | **`^7.9.0`** |
| `bullmq` | `^4.8.0` | `^5.44.3` | **`^5.44.3`** — note v5 changed `QueueScheduler` removal; verify in P3 |
| `uuid` | `^9.0.1` | `^11.1.0` | **`^11.1.0`** |
| `multer` | `^2.0.0` | `^1.4.5-lts.2` | **`^2.0.0`** |
| `drizzle-orm` | `^0.39.3` | `^0.39.3` | `^0.39.3` |
| `express` | `^4.18.2` | `^4.21.2` | `^4.21.2` (stay on 4; v5 changes routing) |

Plus: `ioredis ^5.6.0`, `pg ^8.14.1`, `winston ^3.17.0`, `handlebars ^4.7.8`, `mjml ^4.15.3`, `zod ^3.24.2`, `helmet ^8.1.0`, `cors ^2.8.5`, `axios ^1.8.4`, `dotenv ^16.4.7`, `prom-client ^15.1.3`, `@aws-sdk/client-bedrock-runtime ^3.775.0`, `@aws-sdk/client-bedrock-agent-runtime ^3.775.0`, `@aws-sdk/client-s3 ^3.777.0`, `@modelcontextprotocol/sdk ^1.22.0`, `express-rate-limit ^7.1.0`, `nodemailer ^8.0.1`, `jsonwebtoken ^9.0.2`.

> **Corrected (P0):** `@aws-sdk/client-rds-data` is deliberately **not** declared. An earlier draft of this list carried it over from the source service, but P1 drops the RDS Data API path entirely and Appendix C lists the `RDS_*` vars as dropped — so the package would ship in the production image and never be imported. If a Data API adapter is ever needed it comes back as one line.

> **`npm audit` (P0):** a clean install reports ~41 advisories (7 moderate, 34 high), the bulk of them transitive through `mjml`'s dependency tree, which is unavoidable while P4 needs MJML rendering. Not a P0 blocker; revisit before the first real deploy (Appendix F).

Dev: `typescript ^5.8.2`, `tsx`, `jest ^29`, `ts-jest ^29`, `@types/*`, `eslint ^8.57` + `@typescript-eslint/*`, `drizzle-kit ^0.30.6`, `rimraf`, `supertest`, `testcontainers` (for P2+ integration tests against a throwaway Postgres).

> **`mjml` note:** the source service does not declare `mjml` — it resolves through the monorepo root. The template engine imports it. Declare it explicitly here or the build breaks at P4.

**`tsconfig.json`** — extends nothing (no monorepo base). `target: ES2022`, `module/moduleResolution: NodeNext`, **`strict: true`**, `declaration: true`, `sourceMap: true`, `outDir: dist`, `rootDir: src`, `resolveJsonModule: true`, `esModuleInterop: true`, `skipLibCheck: true`. Paths: `"@/*": ["src/*"]` — but **prefer relative imports**; path aliases + ESM + NodeNext is the exact combination that forced the source repo's `fix-imports.cjs` hack. We are not carrying that hack over.

**`drizzle.config.ts`** — schema `./src/db/schema.ts`, out `./migrations`, dialect `postgresql`, creds from `DATABASE_URL`. Generation is allowed; **`drizzle-kit push`/`migrate` are not** — add a comment saying so.

**`jest.config.cjs`** — ts-jest ESM preset (`ts-jest/presets/default-esm`), `testMatch: ['**/tests/**/*.test.ts']`, `moduleNameMapper: {'^(\\.{1,2}/.*)\\.js$': '$1'}`, `extensionsToTreatAsEsm: ['.ts']`.

**`tsconfig.test.json`** — **required (P0 correction).** The root `tsconfig.json` sets `rootDir: src` and excludes `tests/`, so ts-jest cannot compile a test file against it. This config extends the root one with `rootDir: "."`, `noEmit: true`, `types: ["node","jest"]` and an include covering both `src/` and `tests/`. Point ts-jest at it from `jest.config.cjs`.

> **ESM gotcha:** the `jest` global is **not** injected in ESM mode. `jest.fn()` throws `ReferenceError: jest is not defined`. Either `import { jest } from '@jest/globals'` or hand-roll the spy. Later phases will hit this the first time they mock a channel adapter.

**`.eslintrc.cjs`** — `@typescript-eslint/recommended`, plus a custom rule note: ban `process.env` reads outside `src/config/`.

**`.env.example`** — see Appendix C for the full variable list. At minimum for P0: `PORT=5007`, `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`.

**`Dockerfile`** — multi-stage, single-repo (much simpler than the source's monorepo-aware one):
```dockerfile
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS production
RUN apk add --no-cache curl
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY packs ./packs
COPY migrations ./migrations
RUN mkdir -p logs uploads && chown -R app:app /app
USER app
ENV NODE_ENV=production PORT=5007
EXPOSE 5007
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:5007/health || exit 1
CMD ["node", "dist/index.js"]
```

**`docker-compose.yml`** — `postgres:16` (db `outreach`, exposed 5433 to avoid clashing with any local Mentera Postgres), `redis:7`, and the service. Include a `migrate` profile service that *prints* the psql command rather than running it.

**`.github/workflows/ci.yml`** — on push/PR: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `docker build`. No deploy yet.

**`migrations/README.md`** — the operator contract:
```
Migrations in this directory are NEVER run by tooling or by an agent.
Apply in numeric order:
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_core_schema.sql
Each file is idempotent (IF NOT EXISTS / guarded DO blocks) and wrapped in a transaction.
The 9xxx series are one-shot data migrations from the mentera-core database — read
docs/MIGRATION_RUNBOOK.md before running any of them.
```

**`src/index.ts`** — placeholder: express app, `GET /health` → `{status:'ok'}`, listen on `PORT`.

**`src/app.ts`** — **added in P0.** `createApp(deps): Express` builds the app; `src/index.ts` only constructs dependencies and calls `listen()`. The split exists so supertest can exercise the real app without binding a port, and it is what makes P1's composition root testable. Keep the split for every later phase.

**`.gitignore`**, **`.dockerignore`**, **`.npmrc`** (`engine-strict=true`).

### Verification
```bash
npm ci && npm run typecheck && npm run lint && npm test && npm run build && node dist/index.js &
curl -sf localhost:5007/health && docker build -t outreach:dev .
```

### Exit criteria
All of the above pass. `git log` shows one commit: `chore: scaffold outreach-server repo`.

### Handoff
"Repo scaffolded with strict TS + ESM, no path aliases, no fix-imports hack. Dep versions resolved to the newer monorepo-root majors for twilio/sendgrid/slack/bullmq/uuid — P3 must verify BullMQ v5 API differences (v5 removed `QueueScheduler`; the source runs v4). `mjml` declared explicitly (source service relied on hoisting); `@aws-sdk/client-rds-data` deliberately omitted. A second tsconfig (`tsconfig.test.json`) exists for ts-jest — the root one excludes `tests/`. `src/app.ts` is split from `src/index.ts` so tests can build the app without binding a port. `npm audit` is noisy (~41 advisories, mostly transitive via mjml) — triage before first deploy, not now. Next: P1 vendors the platform layer."

---

# P1 — Vendored platform layer + service boot

### Session brief
Read, in full (they are small and you are copying them):
- `mentera_core/packages/shared-libs/utils/tenant-scope.ts` (35L)
- `mentera_core/packages/shared-libs/middleware/auth.middleware.ts` (257L)
- `mentera_core/packages/shared-libs/observability/{index,logger,metrics,middleware,context}.ts` (389L total)
- `mentera_core/packages/shared-libs/utils/redis-cache.ts` (396L) and `redis-client.ts` (383L)
- `mentera_core/packages/shared-libs/utils/db-client.ts` (620L)
- `mentera_core/services/communication-service/src/config/index.ts`, `src/utils/logger.ts`, `src/db/client.ts`, `src/utils/queue-config.ts`, `src/index.ts`

Do **not** read: anything under `services/communication-service/src/{controllers,routes,services,events,models}`.
Budget: medium. ~2,100 LOC in, ~1,400 LOC out.

### Goal
`src/platform/` provides db, redis, logging, metrics, auth, and tenant scoping with zero reference to `@mentera/shared-libs`. The service boots, serves `/health` + `/metrics`, connects to its own Postgres and Redis.

### Deliverables

**`src/platform/db/client.ts`** — port of `shared-libs/utils/db-client.ts` with these deliberate changes:
- **Drop the RDS Data API path entirely.** The source supports dual-mode via `USE_LOCAL_DB`; the new service is plain `pg` + `node-postgres` drizzle against `DATABASE_URL`. RDS Data API adds 600 LOC of branching for no benefit when the service owns its DB. If prod later needs Data API, it comes back as a second adapter behind the same interface.
- Keep: the pool config knobs (`PG_POOL_MAX`/`MIN`, `PG_IDLE_TIMEOUT`, `PG_CONNECTION_TIMEOUT`), pool error listeners, graceful shutdown.
- **Drop the `global.__dbConnectionPool` global.** That existed to share a pool across services co-located in one Node process. Irrelevant here; use a module-scoped singleton created by the composition root.
- Export: `createDb(config)`, `checkConnection(pool)`, `getPoolStats(pool)`, `closeDb(pool)`, `batchQuery(db, queries, opts)`.

```ts
export interface DbConfig { url: string; poolMax?: number; poolMin?: number;
  idleTimeoutMs?: number; connectionTimeoutMs?: number; ssl?: boolean }

// Generic until P2 exists. P2 narrows it: `export type Db = PlatformDb<typeof schema>`.
export type Db<TSchema extends Record<string, unknown> = Record<string, never>> =
  NodePgDatabase<TSchema>;

export function createDb<TSchema>(
  cfg: DbConfig, options?: { schema?: TSchema; logger?: Logger },
): { db: Db<TSchema>; pool: pg.Pool };
```

> **Corrected (P1) — `batchQuery` has a transaction bug in shared-libs and it is not ported.** The source (`db-client.ts:514–540`) checks a client out of the pool, issues `BEGIN` on it, then invokes query functions that each take their **own** connection from that same pool. Those queries are never part of the transaction: a mid-batch failure rolls back an empty transaction and every prior write stays committed. `useTransaction: true` bought nothing.
>
> The port fixes it by handing the transaction to each query function:
> ```ts
> batchQuery(db, queries: ((tx: Db) => Promise<T>)[], opts): Promise<T[]>
> ```
> Safe to change the signature because P1 is the first consumer. **`mentera_core` still ships the broken version** — out of scope here, but worth a separate issue.

**`src/platform/db/tenant-scope.ts`** — direct port of `tenant-scope.ts`, renamed:
```ts
export interface TenantScope { tenantId: string; subTenantId?: string }

/** medspaId→tenantId, locationId→subTenantId. `includeShared` lets a sub-tenant
 *  also see org-wide (NULL) rows — use for catalog/config/templates. */
export function tenantWhere(
  table: { tenantId: any; subTenantId?: any },
  scope: TenantScope,
  opts: { includeShared?: boolean } = {},
): SQL

export function subTenantValueForInsert(scope: TenantScope): string | null
```
Semantics must match the original exactly: no `subTenantId` on the scope **or** no `subTenantId` column on the table ⇒ tenant-only predicate.

**`src/platform/redis/`** — port `redis-cache.ts` + `redis-client.ts`. Keep the graceful-degradation behavior (service must boot and serve when Redis is down; queue features degrade, HTTP does not 500). Keep `isConnected()`. Drop any Mentera-specific key prefixes; introduce a configurable `REDIS_KEY_PREFIX` (default `outreach:`).

> **Note (P1):** the source has **two** overlapping implementations with different degradation strategies — `redis-client.ts` swaps in a hand-rolled mock object, `redis-cache.ts` returns null from every call. Both auto-connect at module import. The port collapses them into one `KeyValueStore` interface with two backends (`RedisStore`, `MemoryStore`), and connection is started by the composition root, never at import.
>
> **`ioredis` import gotcha:** under `moduleResolution: NodeNext`, `import Redis from 'ioredis'` resolves the default export to a *namespace* — not constructable and not usable as a type (`TS2709`/`TS2351`). Use `import { Redis, type RedisOptions } from 'ioredis'`. **P3 will hit this again wiring BullMQ.**
>
> Expose the raw ioredis instance as `handle.connection` (null when degraded) — BullMQ needs it in P3, and a null connection is exactly the feature-level degradation we want.

**`src/platform/observability/`** — port `logger.ts`, `metrics.ts`, `middleware.ts`, `context.ts`. Service name becomes `outreach-server`. Keep: request-id minting/propagation (`x-request-id`), RED metrics, structured `http_request` access log line on finish, `metricsHandler`.

> **Corrected (P1) — there is no `tera_*` metric prefix.** An earlier draft said to rename `tera_*` → `outreach_*`. Verified against `shared-libs/observability/metrics.ts`: the instruments are the OpenMetrics-standard `http_request_duration_seconds`, `http_requests_total`, `http_requests_in_flight`, and service identity is carried by an explicit `service` label. Renaming standard names would break every shared dashboard and recording rule for no gain. **Keep the names; set the `service` label to `outreach-server`.** What P10 actually needs in `observability/prometheus/prometheus.yml` is a **new scrape job** for the new service, not a metric rename.

> **Corrected (P1) — `createServiceLogger` takes options, not env.** The source reads `LOG_LEVEL`/`LOG_DIR`/`LOG_TO_FILE` from `process.env` directly, which the new repo's eslint rule forbids outside `src/config/`. Pass `{ level, logDir, fileTransport }` in from the composition root. The file transport now defaults **off** (containers log to stdout); the source defaulted it on.

> **Note (P1):** `initMetrics()` takes no argument. The source signature is `initMetrics(_serviceName?)` and the parameter is unused.

**`src/platform/http/auth.middleware.ts`** — port of `shared-libs/middleware/auth.middleware.ts` with the tenancy generalization:

```ts
export interface RequestIdentity {
  userId: string;
  role: string;
  email?: string;
  tenantId: string;
  subTenantId?: string;
  senderId?: string;        // was providerId
  permissions: string[];
}
```

Header resolution, in order, **accepting both old and new names for the parallel-run window**:

| Field | Headers (first match wins) |
|---|---|
| `tenantId` | `x-tenant-id`, `x-medspa-id` |
| `subTenantId` | `x-sub-tenant-id`, `x-location-id` |
| `senderId` | `x-sender-id`, `x-provider-id` |
| `userId` | `x-user-id` |
| `role` | `x-user-role` |
| `email` | `x-user-email` |
| `permissions` | `x-user-permissions` (JSON array; parse failure ⇒ `[]` + warn) |

Keep the gateway-only gate (`x-gateway-request: true` **or** `x-internal-request: gateway`) and the skip paths (`/health`, `/docs`, `/public`, `OPTIONS`, root). Keep `requirePermissions`.

> **Note (P1):** the source writes its rejections straight to the response (`res.status(403).json(...)`). The port instead calls `next(new ForbiddenError(...))` / `next(new AuthError(...))` so every failure goes through the one terminal error handler and gets consistent shape, logging and request-id correlation. Status codes and semantics are unchanged.
>
> Also add `requireTenant(req)`, which reads the tenant off the resolved identity and throws if absent. Route handlers use it instead of touching headers or the body (§0.9).

**Add** an alternative trust mode for the standalone/multi-vendor future: `AUTH_MODE=gateway | apikey | jwt`. Implement `gateway` fully now; stub `apikey` (validate `x-api-key` against `tenant_api_keys` — table lands in P2, wiring in P12) and `jwt` as `501 Not Implemented`. This is the seam that lets a non-Mentera vendor use the service without a Mentera gateway in front.

Keep `UserRole` but **drop the Mentera `Permission` enum** (it enumerates provider/medspa/expertise permissions that mean nothing here). Replace with outreach-scoped permissions: `outreach:send`, `outreach:approve`, `outreach:approve:bulk`, `outreach:templates:write`, `outreach:playbooks:write`, `outreach:config:write`, `outreach:admin`.

**`src/config/index.ts`** — the *only* place `process.env` is read. Zod-validated, fail-fast at boot on missing required vars. Shape:
```ts
export const config = {
  server: { port, host, env },
  db: { url, poolMax, poolMin, ssl },
  redis: { url, host, port, password, username, keyPrefix, skip },
  queue: { skip, concurrency, defaultAttempts, urgentAttempts },
  auth: { mode, gatewayOnly },
  llm: { provider, region, defaultModel, agentId, agentAliasId, timeoutMs },
  channels: {
    sendgrid: { apiKey, fromEmail, fromName },
    twilio: { accountSid, authToken, phoneNumber },
    slack: { botToken, defaultChannel },
    smtp: { host, port, user, pass },
  },
  storage: { s3Bucket, useLocal, localPath },
  compliance: { defaultTimezone, enforceQuietHours, unsubscribeBaseUrl },
  observability: { logLevel, serviceName },
} as const;
```
Note: env-level channel credentials are the **last-resort fallback** only. Per-tenant credentials come from the DB (P3).

**`src/index.ts`** — real composition root:
```ts
const cfg = loadConfig();
const logger = createServiceLogger(cfg.observability.serviceName, {
  level: cfg.observability.logLevel,
  logDir: cfg.observability.logDir,
  fileTransport: cfg.observability.logToFile,
});
initMetrics();
const app = express();
app.use(createObservabilityMiddleware({ serviceName, logger }));
app.get('/metrics', metricsHandler);           // BEFORE auth — Prometheus has no gateway headers
app.use(helmet(), cors(), express.json({ limit: '5mb' }),
        express.urlencoded({ extended: true, limit: '5mb' }));
app.get('/', serviceInfo);
app.use('/mcp', mcpRouter);                    // BEFORE auth — discovery is schema-only  (P8)
app.use(createAuthMiddleware(cfg.auth));
// routers mounted from P3 onward
app.use(errorHandler);
```
Preserve the source's two ordering subtleties, both load-bearing: `/metrics` before auth, and `/mcp` before auth.

**`src/api/health.ts`** — `GET /health` (liveness, no dependencies, always 200 if the process is up) and `GET /health/detailed` (db ping, redis ping, queue depth, pack registry status). **Do not port** the source's `health.routes.ts` dependency on `HEALTH_MONITOR_URL` (`:128`) — that is a Mentera-internal service. Detailed health checks its own dependencies directly.

> **Readiness semantics (P1):** only the **database** gates readiness. Redis being down is reported as `degraded`, not `down`, and `/health/detailed` still returns 200 — the platform falls back to the in-memory store and HTTP keeps serving. Returning 503 there would have Kubernetes pull a pod that is functionally fine. `queues` and `packs` are stubs until P3 and P7.

**`src/platform/http/error-handler.ts`** — typed error hierarchy (`AppError` → `ValidationError` 400, `AuthError` 401, `ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409, `UpstreamError` 502, `RateLimitError` 429) and one terminal handler that logs with `requestId` and never leaks stack traces when `NODE_ENV=production`. The source service's handler (`index.ts:118–126`) is a bare 500; improve on it.

### Tests
`tests/unit/platform/`:
- `tenant-scope.test.ts` — port `shared-libs/tests/tenant-scope.test.ts`, renamed. All 4 branches (scope w/ and w/o subTenant × table w/ and w/o column) + `includeShared`.
- `auth.middleware.test.ts` — non-gateway request ⇒ 403; missing `x-user-id` ⇒ 401; `x-medspa-id` alone populates `tenantId`; `x-tenant-id` wins over `x-medspa-id` when both present; malformed permissions JSON ⇒ `[]` + no throw; skip paths bypass.
- `config.test.ts` — missing `DATABASE_URL` ⇒ boot throws with a readable message.

`tests/integration/boot.test.ts` — supertest: `/health` 200 without headers; `/metrics` 200 without headers; any other path without `x-gateway-request` ⇒ 403.

### Verification
```bash
docker compose up -d postgres redis
npm run typecheck && npm test && npm run dev
curl -sf localhost:5007/health | jq
curl -sf localhost:5007/health/detailed | jq   # db + redis both "up"
curl -s localhost:5007/metrics | head -20
curl -s -o /dev/null -w '%{http_code}' localhost:5007/anything   # 403
```

### Exit criteria
Service boots against its own Postgres and Redis, all four checks above pass, and `grep -r "@mentera/shared-libs" src/` returns nothing.

### Handoff
"Platform layer vendored: db (pg-only, RDS Data API dropped), redis, observability, auth. Tenancy generalized to `tenantId`/`subTenantId` with dual-header acceptance for the parallel run. `AUTH_MODE` seam added (`gateway` implemented, `apikey`/`jwt` return 501). Config is the sole `process.env` reader, zod-validated, fail-fast. `/metrics` and `/mcp` are mounted pre-auth — keep it that way. 52 tests green; boot verified against docker postgres+redis, and verified again with Redis stopped (serves 200, reports `degraded`).

Four things later phases need to know: (1) metric names are the standard `http_*` — no rename happened, P10 needs a new **scrape job**, not a metric rename; (2) `batchQuery` now passes the transaction handle to each query fn, because the shared-libs version never actually transacted; (3) `import { Redis } from 'ioredis'` — the default import breaks under NodeNext, which **P3 will hit wiring BullMQ**; (4) the `jest` global does not exist in ESM mode. Next: P2 defines the whole schema."

---

# P2 — Domain schema + core migrations

### Session brief
Read: `mentera_core/services/communication-service/src/schema/db.ts` (492L — read in full, it is the primary input), `drizzle/migrations/0000_spicy_valeria_richards.sql`, `0001_add_communication_configs.sql`, `0003_fix_queued_message.sql`, `0004_add_location_id.sql`. Read §0.5 and §0.7 of this file.
Skim only (for column shapes of the ghost tables) the INSERT statements at: `services/promotion/promotion.service.ts:25,215,291`, `services/lead/lead-message.service.ts:92`, `services/treatment/treatment-follow-up.service.ts:271`, `services/onboarding/onboarding-service.ts:222`, `services/farewell/farewell-message.service.ts:238`.
Budget: medium-large. This is the phase most worth getting right.

### Goal
The complete target schema as Drizzle definitions plus hand-written idempotent SQL migrations. **No application code uses it yet.** This phase is pure data modeling so that P3–P7 never have to renegotiate column names.

### Design rules
- Every table: `id uuid PK default gen_random_uuid()`, `tenant_id text NOT NULL`, `created_at timestamptz NOT NULL default now()`, `updated_at timestamptz NOT NULL default now()`.
- `sub_tenant_id uuid NULL` on every table that is operational/PHI-bearing (mirrors today's `location_id`; NULL = org-wide).
- `timestamptz`, not `timestamp`. The source uses naked `timestamp` throughout, which is a latent bug for quiet-hours and scheduling across timezones. **This is a deliberate divergence — call it out in the migration comments.**
- No `NOT NULL` on any identity column that the medspa vocabulary made mandatory: `recipient_id` and `sender_id` are nullable on `messages`/`message_analytics` (today `patient_id`/`provider_id` are `NOT NULL` — that is exactly what blocks a system-to-staff message or a tenant with no per-agent concept).
- Enum-ish columns stay `text` + a CHECK constraint, not Postgres enums (cheaper to evolve).
- Pack-owned tables are prefixed `pack_<packid>_`.

### Deliverables

**`src/db/schema/` — one file per group, re-exported from `src/db/schema.ts`:**

`tenancy.ts`
```
tenants                  id(text PK, = today's medspaId) · name · industry · timezone
                         · locale · compliance_profile jsonb · settings jsonb · is_active
sub_tenants              id uuid PK · tenant_id · name · timezone · external_ref jsonb
tenant_api_keys          id · tenant_id · name · key_hash · scopes text[] · last_used_at
                         · expires_at · revoked_at            (used by AUTH_MODE=apikey, P12)
tenant_channel_configs   ← medspa_configurations, renamed columns, credentials
                         moved into `credentials jsonb` (encrypted at rest, P12)
agent_channel_configs    ← provider_configurations; provider_id → sender_id
```

> **On `tenant_channel_configs`:** today's `medspa_configurations` stores `twilio_auth_token`, `sendgrid_api_key`, `slack_bot_token` as plaintext `text` with a `-- Should be encrypted in production` comment. Keep the same columns for the P9 migration to land into, **and** add `credentials_encrypted jsonb` + `encryption_key_id text` now so P12 can flip without another migration. Do not silently change storage in this phase.

`recipients.ts`
```
recipients          id uuid PK · tenant_id · sub_tenant_id · display_name · first_name
                    · last_name · timezone · locale
                    · contact_points jsonb   -- [{type:'email'|'phone'|'slack'|'push',
                                             --   value, verified, primary}]
                    · external_ref jsonb     -- {system:'mentera-patient', id:'...'}
                    · status text            -- active | unsubscribed | bounced | deleted
                    · attributes jsonb       -- pack-specific, schemaless
                    UNIQUE (tenant_id, (external_ref->>'system'), (external_ref->>'id'))
consent_records     id · tenant_id · recipient_id · channel · granted bool · source
                    · proof jsonb · granted_at · revoked_at
recipient_preferences  ← communication_preferences, keyed by recipient_id
                    allow_communications · preferred_channels text[] · preferred_language
                    · preferred_frequency · preferred_time_of_day
                    · quiet_hours_start · quiet_hours_end · quiet_hours_timezone
                    · event_opt_outs text[]      -- NEW: per-playbook opt-out
                    · unsubscribe_token text UNIQUE
                    UNIQUE (tenant_id, recipient_id)
recipient_memories  ← communication_memories; patient_id → recipient_id
recipient_context   id · tenant_id · recipient_id · source · payload jsonb · fetched_at
                    · expires_at      -- cache for ContextProvider results (P5)
```

> `quiet_hours_timezone` is new. Today quiet hours are stored as bare `HH:MM` strings and the timezone is resolved at check time from a config lookup — see `preference.service.ts:331`. Storing it alongside removes an entire class of ambiguity.

`content.ts`
```
templates           ← communication_templates (union of BOTH the comm-service and
                    providers-service column sets — see §0.5 Seam A):
                    id · tenant_id · sub_tenant_id · pack_id · key text
                    · name · description · channel · subject · content · html_version
                    · preview_text · variables jsonb · format · category · template_type
                    · tags text[] · attachments jsonb · status text · is_active
                    · is_default · version int · usage_count · last_used_at
                    UNIQUE (tenant_id, key) WHERE key IS NOT NULL
template_versions   ← moved from providers-service, FK to templates(id) ON DELETE CASCADE
                    UNIQUE (template_id, version)
prompt_packs        id · tenant_id NULL · pack_id · key · version · persona text
                    · goal text · constraints text · channel_rules jsonb · model_hints jsonb
assets              id · tenant_id · kind · url · mime_type · size · metadata jsonb
```

> `templates.id` values **must be preserved** from the existing `communication_templates` rows during P9 — providers-service's `notification_rules.email_template_id`/`sms_template_id` become soft references to them.

`playbooks.ts`
```
packs               id text PK · name · version · description · manifest jsonb
tenant_packs        tenant_id · pack_id · installed_at · config jsonb   PK(tenant_id,pack_id)
playbooks           id uuid PK · tenant_id · pack_id · key text · name · description
                    · is_active · priority int
                    · data_contract jsonb    -- JSON Schema for caller-supplied context
                    · content_source jsonb   -- {kind:'template',templateKey} |
                                             -- {kind:'ai',promptPackKey} | {kind:'hybrid'}
                    · channel_plan jsonb     -- [{channel, priority, fallbackAfterMs}]
                    · approval_policy_id uuid FK
                    · throttle jsonb         -- {maxPerRecipientPerDay, cooldownHours}
                    · metadata jsonb
                    UNIQUE (tenant_id, key)
playbook_triggers   id · tenant_id · playbook_id · trigger_type text
                    -- 'event' | 'schedule' | 'manual' | 'campaign' | 'webhook'
                    · match_rules jsonb      -- {eventType:'APPOINTMENT_REMINDER', where:{...}}
                    · schedule_cron text · is_active
```

`approvals.ts`
```
approval_policies   id · tenant_id NULL · pack_id · key · name
                    · mode text CHECK IN ('always','threshold','sample','none')
                    · confidence_threshold numeric(4,3)
                    · sample_rate numeric(4,3)
                    · approver_resolution jsonb
                      -- {kind:'agent'} | {kind:'role',role} | {kind:'group',ids,semantics}
                      -- | {kind:'round_robin',ids}
                    · rights jsonb          -- {approve,edit,decline,reschedule,bulk}
                    · sla jsonb             -- {deadlineMs, onExpiry:'escalate'|'decline'|'approve',
                                            --  fallbackApproverRef}
approvals           id · tenant_id · sub_tenant_id · playbook_id · message_id FK messages
                    · status text CHECK IN ('DRAFT','PENDING_APPROVAL','APPROVED',
                        'EDITED_APPROVED','AUTO_APPROVED','DECLINED','EXPIRED',
                        'SCHEDULED','SENT','CANCELLED')
                    · approver_type text · approver_ref text
                    · requested_at · decided_at · decided_by · sla_deadline
                    · original_content text · edited_content text · decline_reason text
                    · ai_confidence numeric(4,3) · policy_id FK · audit_trail jsonb default '[]'
                    UNIQUE (message_id)      -- idempotency
                    INDEX (tenant_id, status, sla_deadline)
                    INDEX (tenant_id, approver_ref, status, requested_at DESC)
```

`messaging.ts`
```
outreach_events     ← communication_events; patient_id→recipient_id, provider_id→sender_id,
                    medspa_id→tenant_id, location_id→sub_tenant_id
                    + playbook_id uuid NULL · trigger_type · correlation_id text
messages            ← message_history. recipient_id and sender_id NULLABLE.
                    + direction ('outbound'|'inbound')  -- was metadata->>'direction'
                    + playbook_id · template_id · approval_id · ai_generated bool
                    + provider_message_id text  -- SendGrid/Twilio id, for webhook joins
                    - queued_message jsonb      -- KEPT during P9 backfill, dropped in P12
                    INDEX (tenant_id, sender_id, recipient_id, sent_at DESC)
                    INDEX (tenant_id, sender_id, read_at) WHERE read_at IS NULL
                    INDEX (tenant_id, provider_message_id)
notifications       ← notifications (already generic; add tenant_id, channel_ref)
message_analytics   ← message_analytics; patient_id → recipient_id, NULLABLE
scheduled_messages  ← scheduled_communications
ai_interactions     ← ai_interactions + tenant_id, playbook_id, cost_usd numeric
```

`campaigns.ts`
```
campaigns           ← campaigns; provider_id → sender_id (NULLABLE — today NOT NULL)
                    + playbook_id · audience_id · schedule jsonb
audiences           id · tenant_id · name · kind ('static'|'query'|'accumulating')
                    · definition jsonb · member_count · last_materialized_at
audience_members    audience_id · recipient_id · added_at · source   PK(audience_id,recipient_id)
campaign_recipients ← campaign_recipients; patient_id → recipient_id
message_batches     ← communication_batches + tenant_id, campaign_id
```

**No pack-owned tables. No vertical-specific tables of any kind.**

An earlier draft of this plan specified a `packs_medspa.ts` declaring `pack_medspa_feedback`, `pack_medspa_promotions` and `pack_medspa_gift_cards`. Those were built in P2 and then removed. The reasoning is §0.10; the evidence that made it free is §0.5 Seam D (all seven tables empty, none tenant-scoped, the code behind them stubbed).

Deliberately **not** carried over as tables:

| Source | Becomes | Tier (§0.10) |
|---|---|---|
| `promotions`, `gift_cards` | the vertical's own service; fields arrive in the event payload | 1 + 3 |
| `patient_feedback` | inbound `messages` + `message_analytics.metadata` | 2 |
| `lead_profiles` | `recipients.attributes` + `recipient_context` | 2 |
| `outreach_rules`, `treatment_follow_up_rules` | `playbooks` rows | — |
| `farewell_messages` | `messages` with `playbook_id = 'medspa.farewell'` | — |

Before closing the phase, run the §0.10 test: `grep -ri medspa src/db/ migrations/` must return no table or column name.

**Migrations (write, do not run):**

- `migrations/0001_core_schema.sql` — tenancy, recipients, content, messaging **and campaigns**. `CREATE EXTENSION IF NOT EXISTS pgcrypto;` at the top for `gen_random_uuid()`. Every statement `IF NOT EXISTS`-guarded, whole file in `BEGIN/COMMIT`.
- `migrations/0002_approvals.sql` — `approval_policies`, `approvals`, plus the `messages` ↔ `approvals` foreign keys.
- `migrations/0003_playbooks.sql` — `packs`, `tenant_packs`, `playbooks`, `playbook_triggers`, plus every foreign key pointing at `playbooks`.

> **Corrected (P2) — campaign tables move into `0001`.** An earlier draft deferred `campaigns`/`audiences`/`audience_members`/`campaign_recipients`/`message_batches` to P11's migration `0008`. Their *runtime* still lands in P11; only the DDL moved. Leaving a declared Drizzle model with no backing table for nine phases is exactly the drift that produced the Seam D ghost tables. This also leaves P4's claim on `0004` intact.

> **Ordering is load-bearing.** `0002` and `0003` add foreign keys whose other side was created in an earlier file, via guarded `DO` blocks. Applying `0003` before `0002` fails on a missing `approval_policies`. Cross-file relationships in the Drizzle model are plain `uuid` columns — `.references()` needs a real import and the natural graph has cycles (playbooks → approvals → messages → playbooks), so the SQL is the sole definition of those constraints.

> **Expression and partial indexes live only in SQL.** `recipients_tenant_external_ref_unique` (on `external_ref->>'system'` / `->>'id'`) and `templates_tenant_key_unique` (`WHERE key IS NOT NULL`) cannot be expressed in the Drizzle model. The conformance test covers the tables and columns; these two need eyes.

Index checklist — carry these forward from the source (they were added for real production problems, see `schema/db.ts:403–421`), renamed:

```sql
CREATE INDEX IF NOT EXISTS idx_messages_tenant_sender          ON messages (tenant_id, sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation           ON messages (tenant_id, sender_id, recipient_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread                 ON messages (tenant_id, sender_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_sent_at                ON messages (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_status                 ON messages (status);
CREATE INDEX IF NOT EXISTS idx_messages_channel                ON messages (channel);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_subtenant       ON messages (tenant_id, sub_tenant_id);
CREATE INDEX IF NOT EXISTS idx_outreach_events_status          ON outreach_events (status);
CREATE INDEX IF NOT EXISTS idx_recipient_prefs_recipient       ON recipient_preferences (recipient_id);
```

The source also had `message_history_queued_approval_idx` on `(queued_message->>'approvalStatus')` — **not** carried forward; the `approvals` table replaces it.

### Tests
`tests/integration/schema.test.ts` using `testcontainers`: spin a throwaway Postgres, apply `migrations/000*.sql` **in the test container only** (this is not "running a migration" against any real DB — make that explicit in a comment), then assert via `information_schema`:
- every table has `tenant_id` — exempting only `tenants` (its PK *is* the tenant) and `packs` (global catalogue)
- `tenant_id` is `NOT NULL` everywhere except `approval_policies` and `prompt_packs`, where NULL means "pack-provided default, shared across tenants"
- no `timestamp without time zone` columns exist
- the `approvals.status` CHECK accepts exactly the 10 states, and does **not** accept `REJECTED`
- `UNIQUE (message_id)` on `approvals` exists
- the identity columns that had to stop being `NOT NULL` are nullable, and a message with neither recipient nor sender inserts cleanly
- the carried-forward indexes exist, `idx_messages_unread` is still partial, and no `queued_approval` index came across
- re-applying all migrations is a no-op (idempotency)

> **This test is what replaces the generator.** It compares the Drizzle model and the applied SQL **in both directions** — every model table and column must exist in the database, and every database table and column must exist in the model. Adding one without the other fails the build. Since `drizzle-kit generate` cannot read this schema (below), that bidirectional check is the only thing keeping the two honest. Later phases must extend it, not weaken it.

### `drizzle-kit generate` does not work here — use `npm run db:draft`

**Corrected (P2).** `drizzle-kit generate` cannot read this schema (verified on 0.30.6). It bundles through esbuild in CJS mode and resolves relative imports literally, so the `.js` extensions NodeNext ESM requires resolve to files that do not exist:

```
Error: Cannot find module './schema/tenancy.js'
```

Pointing `schema` at a glob does not help — the failure moves to the cross-file imports inside each schema file. Upgrading is not the answer either: drizzle-kit 0.31.10 refuses to run against `drizzle-orm@0.39.3` and demands a matching upgrade, and 0.39.3 is pinned deliberately to match the source service (§P0).

**The workaround, and why it is not the `fix-imports.cjs` hack.** `scripts/draft-migration.mjs` copies the schema to a gitignored `.drizzle-draft/`, strips the extensions **in the copy**, and generates from that. The source repo's hack rewrote *emitted build output* on every build and had to stay correct forever or production broke. This touches a disposable copy, runs only when someone is drafting, and its worst failure is "no draft today".

```bash
npm run db:draft     # -> .drizzle-draft/out/*.sql
```

**The output is a draft, never a migration.** Read it, take what is useful, hand-write the numbered idempotent file, and let the conformance test prove the two agree. Nothing in `.drizzle-draft/` is ever committed.

### Verification
```bash
npm run typecheck
npm test -- tests/integration/schema.test.ts
npm run migrate:print          # lists all three, with the operator command
grep -ri medspa src/db/ migrations/    # §0.10 test: no table or column names
# print the operator command, do not run it:
echo 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_core_schema.sql'
```

### Exit criteria
Drizzle schema compiles under `strict`, the testcontainer applies all three migrations cleanly and idempotently, and the assertions pass. `migrations/README.md` lists the three files with the operator command.

### Handoff
"Full target schema landed as Drizzle + three idempotent SQL migrations (unrun). 87 tests green; the conformance test applies all three to a throwaway container and checks the model against the SQL in both directions.

Deliberate divergences from the source: `timestamptz` everywhere; `recipient_id`/`sender_id`/`sent_at` nullable; approval state is a real table over 10 unified states with `REJECTED` mapped to `DECLINED`; quiet hours carry their own timezone; per-playbook `event_opt_outs`; credentials have `_encrypted` columns reserved for P12; campaign tables created in `0001` rather than deferred to P11.

**§0.5 Seam D is closed, not deferred.** All seven ghost tables are empty in production and none has a tenant column; the code behind them is stubbed demo scaffolding. Nothing migrates. **The engine ships zero vertical-specific tables** — see §0.10 for where a vertical's data goes instead, and run `grep -ri medspa src/db/ migrations/` after any phase that adds tables.

Two toolchain notes: `drizzle-kit generate` cannot read this schema, so use `npm run db:draft` for a skeleton and hand-write the migration; and expression/partial indexes exist only in SQL, so the conformance test cannot cover them.

Next: P3 builds the delivery plane on `tenant_channel_configs` — and must verify the BullMQ v5 API differences flagged in P0."

---
# P3 — Delivery plane: Channel port, adapters, queues

### Session brief
Read in full: `services/queue/notification-queue.ts` (743L), `services/sms/twilio.ts` (231L), `services/email/sendgrid.ts` (124L), `services/email/nodemailer.ts`, `services/slack/slack.service.ts` (136L), `services/config/medspa-config.service.ts` (414L), `services/config/provider-config.service.ts` (464L), `src/utils/queue-config.ts`.
Skim signatures only: `services/notification/{email,sms,slack,push,webhook,in-app}-notification.ts` (these are thin wrappers; `in-app-notification.ts` is 585L — read only its public methods).
Read: `services/queue/event-processing-queue.ts` (415L), `services/queue/default-event-processor.ts`.
Do **not** read: controllers, routes, events/, models other than `communication.model.ts` enums.
Budget: large. This is the biggest single port.

### Goal
`Channel` port + registry replaces the 6-case dispatch switch. All six channels are adapters resolving per-tenant credentials from `tenant_channel_configs`/`agent_channel_configs`. BullMQ queues ported to v5. A message can be enqueued and delivered end-to-end via a test endpoint.

### The port

**`src/ports/channel.ts`**
```ts
export type ChannelType = 'email' | 'sms' | 'slack' | 'push' | 'webhook' | 'in_app' | 'voice' | 'letter';

export interface ContactPoint { type: string; value: string; verified?: boolean; primary?: boolean }

export interface RenderedMessage {
  subject?: string;
  body: string;            // plain text / markdown
  html?: string;
  attachments?: Array<{ fileName: string; url?: string; content?: Buffer; mimeType: string }>;
  metadata?: Record<string, unknown>;
}

export interface ChannelCredentials {
  tenantId: string;
  senderId?: string;
  source: 'agent' | 'tenant' | 'env';   // which level of the fallback chain won
  values: Record<string, string>;        // adapter-specific; adapter validates
  from?: string;                         // resolved sender address/number/channel
}

export interface DeliveryResult {
  success: boolean;
  providerMessageId?: string;
  error?: { code: string; message: string; retryable: boolean };
  raw?: unknown;
}

export interface ChannelCapabilities {
  subject: boolean;
  html: boolean;
  attachments: boolean;
  maxLength?: number;
  supportsDeliveryReceipts: boolean;
}

export interface Channel {
  readonly type: ChannelType;
  readonly capabilities: ChannelCapabilities;
  validate(msg: RenderedMessage, to: ContactPoint): { ok: true } | { ok: false; reason: string };
  send(msg: RenderedMessage, to: ContactPoint, creds: ChannelCredentials): Promise<DeliveryResult>;
}

export interface ChannelRegistry {
  register(ch: Channel): void;
  get(type: ChannelType): Channel;          // throws NotFoundError
  has(type: ChannelType): boolean;
  list(): ChannelType[];
}
```

### Credential resolution — generalize Twilio's 3-level chain to all channels

`src/engine/delivery/credential-resolver.ts`. Today only Twilio has the fallback chain (`twilio.ts:36–86`); SendGrid and Slack read env directly. Generalize:

```ts
resolveCredentials(channel, { tenantId, senderId }): Promise<ChannelCredentials>
  1. agent_channel_configs WHERE tenant_id AND sender_id AND <channel>_enabled
     → sender-specific `from` (phone number / email address / slack user)
       + account-level secrets inherited from the tenant row
  2. tenant_channel_configs WHERE tenant_id AND <channel>_enabled → full credentials
  3. config.channels.<channel> from env → { source: 'env' }
  4. none → throw ConfigurationError (do NOT silently no-op)
```
Cache resolved credentials in Redis with a short TTL keyed `outreach:creds:{tenantId}:{senderId ?? '-'}:{channel}`, invalidated on any write to the config tables. Port the Twilio client cache keyed on `accountSid:authToken` — but move it **inside** the Twilio adapter, and make it bounded (the source's `Map` grows unbounded).

> **Corrected (P3) — do NOT implement the chain as a switch on channel type.** The sketch above reads as one, and the first draft was: three `switch (channel)` blocks inside the resolver. That violates this phase's own exit criterion, and for a real reason — a switch in a central resolver reproduces exactly the coupling P3 exists to remove, so adding a `voice` channel later means editing a shared file rather than adding one.
>
> Each channel owns a `CredentialMapper` (`fromAgent` / `fromTenant` / `fromEnv`) registered alongside its adapter in `src/adapters/channels/credentials.ts`; the resolver walks the three levels generically. A mapper returns `null` rather than a half-populated credential, so an incomplete level falls through instead of failing at send time far from the cause. See `docs/DECISIONS.md` D20.

> **Behavior to preserve exactly:** `twilio.ts:117–137` — when `NODE_ENV !== 'production'` the adapter logs and returns success without sending. Keep this, but drive it off an explicit `config.channels.dryRun` (default `NODE_ENV !== 'production'`) rather than reading `NODE_ENV` in the adapter. Same for the SendGrid dev-mode logging that `providers-service/src/services/email.service.ts:81–94` relies on.

### Adapters — `src/adapters/channels/`

| File | Ports from | Notes |
|---|---|---|
| `sendgrid.channel.ts` | `services/email/sendgrid.ts` | `capabilities: {subject:true, html:true, attachments:true, supportsDeliveryReceipts:true}`. Return the SendGrid `x-message-id` header as `providerMessageId` — the source discards it, and the webhook controller therefore cannot join receipts to messages. **Fix this.** |
| `smtp.channel.ts` | `services/email/nodemailer.ts` | fallback email; same capabilities, no receipts |
| `twilio.channel.ts` | `services/sms/twilio.ts` | `maxLength: 1600`, `supportsDeliveryReceipts: true`. Return `message.sid`. |
| `slack.channel.ts` | `services/slack/slack.service.ts` | block-kit support; `subject:false`. **Port `sendUrgentAlert` and `sendAppointmentNotification` as *pack helpers*, not channel methods** — they are medspa-shaped. The channel only does `send`. |
| `push.channel.ts` | `services/notification/push-notification.ts` | FCM via `axios.post(fcmEndpoint)` |
| `webhook.channel.ts` | `services/notification/webhook-notification.ts` | HMAC signing, retry semantics |
| `in-app.channel.ts` | `services/notification/in-app-notification.ts` | writes to `notifications` table |

Every adapter: no module-scope singleton export. Constructed by the registry factory in `src/adapters/channels/index.ts`.

> **Corrected (P3) — `providerMessageId` for EVERY adapter, not just SendGrid.** The table above flags it for SendGrid only. Twilio's `message.sid` is logged and dropped at `twilio.ts:161`, and the same applies to Slack's `ts` and the in-app row id. All of them are returned. This is what `messages.provider_message_id` and `idx_messages_provider_message_id` exist for.

> **Corrected (P3) — two in-memory registries are NOT ported.** `webhook-notification.ts` carries an endpoint registry (`registerEndpoint`, `getEndpointsForEvent`, …) and `push-notification.ts` a device-token registry, both over in-process `Map`s. Both are lost on restart and invisible to other replicas, which makes those channels quietly unreliable. Device tokens are **contact points** (`recipients.contact_points` with `type:'push'`); webhook subscriptions are table-shaped state that **P8** owns. The adapters deliver one payload to one destination and nothing else. Also drop the webhook adapter's own retry loop — it multiplied with the queue's. (D24)

> **Note (P3) — SMTP retryability is inverted from HTTP.** SMTP 5xx is permanent and 4xx is transient (greylisting, quota). Every other adapter uses the HTTP rule. Easy to get backwards. (D26)

### Queues — `src/engine/delivery/`

`notification-queue.ts` ported with these changes:
1. **The switch at `notification-queue.ts:271–294` becomes `registry.get(job.data.channel).send(...)`.** That is the whole point of the phase.
2. Preserve retry config exactly: 5 attempts exponential backoff, **10 attempts for `URGENT`**, priority lanes, `removeOnComplete` 24h / `removeOnFail` 7d, concurrency from config.
3. Preserve the mock/no-op fallback when Redis is unavailable — the service must not fail to boot without Redis.
4. **BullMQ v4→v5** — *verified on 5.81.3 (P3)*: `QueueScheduler` is indeed gone, but **the source never instantiated one**, so there is nothing to delete. `Queue`/`Worker`/`QueueEvents` import shapes are unchanged and `connection` still accepts a plain options object (an `ioredis` instance works too — pass `.duplicate()` to the Worker and QueueEvents so they do not share the command connection). The migration is far smaller than feared.
   The genuinely useful v5 addition is **`UnrecoverableError`**: throwing it from the worker fails a job immediately instead of consuming its remaining attempts. Use it for every non-retryable adapter error — the source throws a plain `Error` on all failures, so an SMS to a number that replied STOP is retried five times, meaning five more messages to someone who opted out. Adapters classify (`retryable: boolean`); the worker translates. (D21)
5. Job payload becomes uniform — no per-channel payload union:
```ts
interface SendJob {
  messageId: string; tenantId: string; subTenantId?: string;
  channel: ChannelType; recipientId?: string; senderId?: string;
  to: ContactPoint; rendered: RenderedMessage;
  priority: 'LOW'|'MEDIUM'|'HIGH'|'URGENT';
  playbookId?: string; correlationId: string; attempt: number;
}
```
6. On success/failure: update `messages.status`, `messages.provider_message_id`, `notifications`, and emit metrics `outreach_message_sent_total{channel,tenant,status}` + `outreach_message_latency_seconds`.

`event-processing-queue.ts` ported as-is (it is already generic). `default-event-processor.ts` becomes a thin shim that hands the event to the playbook runtime — **stub it in P3** to log-and-drop, wire it in P7.

`src/engine/delivery/dispatcher.ts` — the single entry point everything else uses:
```ts
dispatch(msg: OutboundMessage): Promise<{ queued: boolean; jobId?: string; skipped?: string }>
```
It resolves credentials, validates against channel capabilities (truncate/reject over `maxLength`), and enqueues. The **compliance gate is inserted here in P5** — leave a clearly-marked `// COMPLIANCE GATE (P5)` hook so it is not forgotten.

### Config API
Port `services/config/{medspa,provider}-config.service.ts` → `src/engine/delivery/channel-config.service.ts`, reading `tenant_channel_configs`/`agent_channel_configs`. Keep the read helpers the resolver needs (`getTwilioConfig`, `getSenderNumber`, `getSendersByTenant`) and the cache-invalidation-on-write behavior.

> **Corrected (P3) — caching moves to Redis.** The source keeps two in-process `Map` caches with a 5-minute TTL (`medspa-config.service.ts:135-137`), so N replicas hold N divergent views and a config write only invalidates the replica that served it. `invalidate(tenantId, senderId?)` must clear the config entries **and** the derived `outreach:creds:*` entries — a rotated API key that stays cached for two minutes is a support ticket. Only the read surface is ported here; the CRUD belongs with the config API in P8. (D27)

### Tests
`tests/unit/channels/*.test.ts` — one per adapter, provider SDK mocked. Assert: `providerMessageId` is returned; dry-run mode does not call the SDK; `validate()` rejects oversize SMS; error classification sets `retryable` correctly (Twilio 21610 = unsubscribed = **not** retryable; 5xx = retryable).
`tests/unit/delivery/credential-resolver.test.ts` — all four levels of the chain, including "agent number + tenant secrets" (the exact case at `twilio.ts:44–56`), and the throw at level 4.
`tests/unit/delivery/registry.test.ts` — unknown channel throws; `list()` returns all registered.
`tests/integration/queue.test.ts` — testcontainers Redis; enqueue → worker → adapter called once → `messages.status = SENT`; forced failure retries with backoff and lands in `failed` after N attempts; URGENT gets 10 attempts.

### Verification
```bash
npm test -- tests/unit/channels tests/unit/delivery tests/integration/queue
# manual smoke against the dev-mode adapters:
curl -X POST localhost:5007/internal/dispatch-test -H 'x-gateway-request: true' \
  -H 'x-user-id: dev' -H 'x-user-role: admin' -H 'x-tenant-id: t1' \
  -d '{"channel":"email","to":{"type":"email","value":"a@b.c"},"rendered":{"subject":"hi","body":"yo"}}'
```
(`/internal/dispatch-test` is a temporary route; delete it in P8.)

### Exit criteria
No `switch` on channel type anywhere in `src/`. All six adapters implement `Channel`. Queue integration test green. `grep -rn "process.env" src/adapters src/engine` returns nothing.

### Handoff
"Channel port + registry in place; the dispatch switch is gone and `grep -rn 'switch (' src/` returns nothing. 135 tests green across 10 suites; the queue integration test runs real Postgres + Redis containers and proves dispatch → queue → adapter → `messages.status = SENT`. Smoke-tested live in dry-run.

Credential resolution generalizes Twilio's 3-level chain to every channel, cached in Redis — but as **per-channel mappers**, not a switch (D20). Level 4 throws `ChannelNotConfiguredError` (503) rather than returning false. Every adapter returns `providerMessageId`. Non-retryable errors raise `UnrecoverableError` so an unsubscribed recipient is not retried five times (D21). Dry-run is explicit config defaulting **on**, so a misconfigured deploy cannot send (D23).

BullMQ v5 was a smaller migration than the plan feared — `QueueScheduler` was never used. Not ported, deliberately: the webhook endpoint registry, the push device-token registry (D24) and Slack's medspa helpers (D25).

`dispatcher.ts` has a marked `// COMPLIANCE GATE (P5)` hook — P5 must fill it **before** the messages row is written, not in the worker. `default-event-processor` is a log-and-drop stub until P7. `/internal/dispatch-test` is temporary; delete it in P8.

Next: P4 content plane."

---

# P4 — Content plane: templates, LLM port, generation

### Session brief
Read in full: `services/ai/ai-service.ts` (585L), `services/ai/ai-message-generator.ts` (380L), `services/templates/template-engine.ts` (1,181L — this one is unavoidable; read it once, take notes, do not re-read), `controllers/template-controller.ts` (609L, for the endpoint contract only).
Skim: `services/ai/bedrock-agent-client.ts` (438L), `services/ai/ai-summary.service.ts` (329L), `services/templates/generators/campaign-template-generator.ts` (669L — P11 owns this; note its interface only), `controllers/ai-content-controller.ts` (708L — endpoint list only).
Do **not** read: `ai-enhanced-communication.controller.ts` (P6/P8 owns it), any route file.
Budget: large.

### Goal
Templates and AI drafting sit behind ports. Healthcare prompts are extracted out of code into pack data. `POST /v1/content/render` and `POST /v1/content/generate` work.

### The LLM port

**`src/ports/llm.ts`**
```ts
export interface LlmRequest {
  system?: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  jsonSchema?: object;          // when set, provider must return valid JSON
  timeoutMs?: number;
}
export interface LlmResponse<T = string> {
  content: T;
  model: string;
  tokensIn: number; tokensOut: number;
  latencyMs: number;
  finishReason: string;
  raw?: unknown;
}
export interface LlmProvider {
  readonly name: string;
  generate(req: LlmRequest): Promise<LlmResponse<string>>;
  generateJson<T>(req: LlmRequest & { jsonSchema: object }): Promise<LlmResponse<T>>;
  listModels(): string[];
}
```

**`src/adapters/llm/bedrock.provider.ts`** — `ai-service.ts` becomes this adapter's internals. Keep: the `AIModel` enum (Nova/Titan/Claude ids), per-model request/response shaping, retry, and the metrics counters (`getMetrics()`). Drop: the hourly `setInterval` metrics logger (`:148`) — replace with Prometheus gauges, an unref'd interval in a library is a test-hang hazard.

> **Corrected (P4) — do NOT port the timeout as written.** `ai-service.ts:258-260` races the call against `new Promise((_, reject) => setTimeout(...))` and **never clears the timer**. Every call keeps a pending timer for the full timeout (30s default) even when it returns in 200ms — delaying process exit, stalling graceful shutdown, and hanging Jest. Use an `AbortController` and clear the timer in `finally`. (D30)

> **Corrected (P4) — token counts must come from the provider.** `:334` estimates with `content.split(/\s+/).length`, a word count of the output only. `cost_usd` cannot be derived from it. Each codec reads the real usage Bedrock returns. (D31)

> **Corrected (P4) — do NOT port the request/response logging.** `:214-217` logs the full request body and `:280-285` logs 500 chars of every response, both at **info**. Those prompts carry recipient names and treatment context, and P1's logger ships stdout to log aggregation. Log lengths, ids and token counts at info; content at `debug` only. The reproducible copy lives truncated on the `ai_interactions` row, in the database. **Worth sweeping the rest of the source for the same pattern before P10.** (D32)

> **Note (P4):** pair request shaping with response parsing per model family (a "codec"). The source keeps two parallel if/else chains — `:184-255` builds, `:289-330` parses — that must be kept in step by hand.

Every call logs a row to `ai_interactions` (tenant_id, playbook_id, model, tokens, latency, success, error). The source already does this and it is the right audit trail — keep it and add `cost_usd` computed from a per-model rate table in config.

**Default model:** the source's `.env.example` sets `AWS_BEDROCK_MODEL_ID=amazon.nova-pro-v1:0`. Keep Bedrock as the default provider and preserve the configured model ids; do not silently change which model drafts patient-facing messages.

### Template store & engine

**`src/ports/template-store.ts`** — `get(tenantId, idOrKey)`, `list(tenantId, filter)`, `create/update/delete`, `incrementUsage`, `setDefault`, `versions(templateId)`. Backed by the `templates` + `template_versions` tables.

> `setDefault` semantics from `providers-service/src/services/template.service.ts:281–299`: setting a template default clears `is_default` on other templates with the same `(tenant, channel, category)` — including the `category IS NULL` case. Port that exactly; it is a real invariant the FE relies on.

**`src/engine/content/template-engine.ts`** — port of `template-engine.ts`, split into four files (it is 1,181 LOC and violates the 500-line rule):
- `renderer.ts` — Handlebars compile + helper registration (`formatDate`, `addTracking`, `ifCond`, `json`, `substring`) + MJML → HTML for `format: 'MJML'`. Keep every helper; the medspa templates use them.

  > **Corrected (P4) — use `Handlebars.create()`.** The source registers helpers on the imported singleton (`template-engine.ts:163-253`), mutating process-global state. Two engines with different helpers overwrite each other and test order starts to matter. (D33)
  >
  > **Corrected (P4) — `formatDate` must take locale and timezone from the context.** `:174-189` calls `toLocaleDateString()` with neither, so every date renders in whatever zone the *server* has: a 9am reminder for a New York clinic reads as 2pm on a UTC pod. Same class of defect as the naked `timestamp` columns, and the schema already carries `tenants.timezone`/`.locale` and `recipients.timezone`/`.locale`. Read recipient first, then tenant. (D34)
- `store.ts` — the CRUD half, implementing `TemplateStore`.
- `ai-generation.ts` — `generateTemplateWithAI` / `generateCompleteEmailWithAI` / `enhancePromptForFormat` / `generateNameFromPrompt`, now going through `LlmProvider`.
- `assets.ts` — `saveAsset` / `generateImageAsset` (S3 or local per `config.storage`).

**Variable resolution is the generalization point.** Today templates interpolate `{{patientName}}`, `{{doctorName}}`, `{{appointmentDate}}` and the handler switch supplies them. In the target, the render context is:
```ts
{ recipient: {...}, sender: {...}, tenant: {...}, context: {...caller-supplied},
  message: { unsubscribeUrl, channel, playbookKey }, now: ISO }
```
Medspa templates keep working through a **pack-level alias map** in `packs/medspa/aliases.json`:
```json
{ "patientName": "recipient.displayName", "doctorName": "sender.displayName",
  "appointmentDate": "context.appointmentDate", "medspaName": "tenant.name" }
```
The renderer applies aliases before compiling. This is how existing templates survive the rename untouched — **and it means P9 does not have to rewrite template bodies.**

### Prompt packs — extracting the healthcare prompts

The prompts inlined in `ai-message-generator.ts` (~:112, :182) and `ai-enhanced-communication.controller.ts` (~:623, :677) move to `packs/medspa/prompts/*.json`:
```json
{
  "key": "medspa.followup",
  "version": 1,
  "persona": "You are writing on behalf of {{sender.displayName}}, a provider at {{tenant.name}}, a medical aesthetics clinic.",
  "goal": "Write a warm post-treatment follow-up checking on the recipient's recovery and inviting questions.",
  "constraints": [
    "HIPAA compliant: never restate clinical details the recipient did not already receive in writing.",
    "Do not give medical advice; direct clinical questions to the clinic.",
    "No pricing or promotional content."
  ],
  "channelRules": { "sms": "Max 320 characters, no subject line, no links except the booking link.",
                    "email": "Subject under 60 characters. Short paragraphs." }
}
```

**`src/engine/content/prompt-assembler.ts`** builds the final prompt as:
`pack persona → playbook goal → constraints (pack + compliance profile) → validated context (JSON) → channel formatting rules → tenant style profile`.
Deterministic ordering, and the assembled prompt is stored on the `ai_interactions` row (truncated) so every draft is reproducible.

**`src/engine/content/generator.ts`**
```ts
generate(input: {
  tenantId; subTenantId?; playbookKey; recipient; sender?; context: unknown;
  channel: ChannelType; overrides?: { tone?; language?; model? };
}): Promise<{
  draftId; content; subject?; channel; aiConfidence: number;
  promptPackKey; model; tokensIn; tokensOut;
}>
```
- Validates `context` against the playbook's `data_contract` (Zod compiled from the stored JSON Schema). Validation failure ⇒ `ValidationError` with the failing paths, never a silent best-effort draft.
- **`aiConfidence`**: the source has no real confidence score (it takes whatever the model volunteers, defaulting to `0.5` at `ai-message-generator.ts:244`), but the threshold approval mode depends on one. Implement v1 as a deterministic composite of **observable** signals: contract completeness (fraction of declared fields supplied) minus a per-lint-warning penalty.

  > **Corrected (P4) — drop the "normalized model-reported signal".** Letting a model influence the number that decides whether a human reviews its output is the wrong incentive, and LLMs are not calibrated about their own work. Observable signals only. (D35)

  Document it as heuristic in `docs/PACKS.md`; do not present it as calibrated.
- Runs content lint (P5 owns the rules; call the hook, stub the ruleset here).

### API (mounted under `/v1`)
`POST /v1/content/generate`, `POST /v1/content/render`, and template CRUD `GET|POST /v1/templates`, `GET|PUT|DELETE /v1/templates/:id`, `POST /v1/templates/:id/render`, `GET /v1/templates/:id/versions`, `POST /v1/templates/generate`, `POST /v1/assets/upload`, `POST /v1/assets/generate-image`.
(Legacy `/templates/*` and `/ai/*` paths are added by the compat shim in P8, not here.)

**Migration `migrations/0004_content.sql`** — ~~`prompt_packs`, `assets`, and the `templates.key`/`pack_id` columns if not already in `0001`~~.

> **Corrected (P4) — there is no `0004`.** All four are already in `0001`, because P2 built the whole schema up front rather than deferring tables to the phase that uses them (D13). The conditional resolves to nothing, so **P4 ships no migration**. `0004` is left unused rather than reassigned, so the numbering keeps matching the phase map. (D36)

### Tests
- `tests/unit/content/renderer.test.ts` — every Handlebars helper; MJML compiles; alias map resolves `{{patientName}}` → `recipient.displayName`; unknown variable renders empty, never `undefined`.
- `tests/unit/content/prompt-assembler.test.ts` — golden-file assertion on the assembled prompt for `medspa.followup` (this is the regression guard for prompt drift).
- `tests/unit/llm/bedrock.provider.test.ts` — SDK mocked; timeout rejects at `timeoutMs`; `generateJson` retries once on invalid JSON then throws; an `ai_interactions` row is written on both success and failure.
- `tests/unit/content/generator.test.ts` — contract violation throws before any LLM call is made (assert the provider mock was not called).
- `tests/contract/templates.test.ts` — `setDefault` clears siblings including the `category IS NULL` case.

### Exit criteria
`grep -rniE "patient|provider|medspa|HIPAA|treatment" src/engine/content src/adapters/llm` returns **only** comments and the alias-map loader. All healthcare strings live in `packs/medspa/`.

### Handoff
"Content plane behind `LlmProvider` + `TemplateStore`. 208 tests green across 15 suites. `template-engine.ts` split into renderer/store/prompt-assembler/generator. Healthcare prompts extracted to `packs/medspa/prompts/`; existing medspa templates render unchanged via `packs/medspa/aliases.json`, so **P9 does not rewrite template bodies**. Exit criterion met: no healthcare vocabulary in any executable string under `src/engine/content` or `src/adapters/llm`.

Four source defects fixed rather than ported — the uncleared timeout timer (D30), word-count 'tokens' (D31), full prompts logged at info level (D32), and the global Handlebars mutation (D33). `formatDate` now resolves locale and timezone from the render context, not the server (D34).

`aiConfidence` is a documented heuristic built from observable signals only, and deliberately ignores anything the model says about its own output (D35) — **P6 must ship threshold mode OFF by default because of it**.

**No migration was written**: everything `0004` would have created is already in `0001` (D36). Still open for later phases: the content lint hook in `generator.ts` is called but has no ruleset (P5 owns it); template AI generation and asset upload/generation are not ported (P8); `docs/PACKS.md` is unwritten (P7).

Next: P5 context port + compliance."

---

# P5 — Context port, recipients, compliance & preferences plane

### Session brief
Read in full: `services/data/context-fetcher.service.ts` (733L), `services/preference/preference.service.ts` (631L), `models/preferences.model.ts` (468L).
Read the 3 raw `patients` queries: `controllers/communications.controller.ts` lines 1236–1250, 1435–1450, 1665–1680 (**only those ranges** — the file is 2,571L).
Skim: `controllers/preference.controller.ts` (365L) for the endpoint contract.
Do **not** read: the rest of `communications.controller.ts`, any AI controller.
Budget: large.

### Goal
Nothing in the engine knows a Mentera service URL. Caller-supplied context is the first-class path. `recipients` is populated and owns display names, killing the cross-DB `SELECT ... FROM patients`. The preference engine is DB-backed and enforced as a mandatory gate.

### The context port

**`src/ports/context-provider.ts`**
```ts
export interface ContextRef {
  kind: string;                       // 'inline' | 'mentera-patient' | 'crm' | 'csv' | ...
  id?: string;
  params?: Record<string, unknown>;
}
export interface ContextObject { [k: string]: unknown }

export interface ContextProvider {
  readonly kind: string;
  fetch(ref: ContextRef, scope: TenantScope): Promise<ContextObject>;
  /** Resolve/refresh recipient identity — display name, contact points, timezone. */
  resolveRecipient?(ref: ContextRef, scope: TenantScope): Promise<Partial<Recipient>>;
}
```

**`src/adapters/context/inline.provider.ts`** — the default and the reuse path. The caller already supplied the object; `fetch` is identity. **This is the provider used when nothing else is registered**, and it must be the documented happy path in the API docs.

**`src/adapters/context/mentera.provider.ts`** — everything Mentera-specific from `context-fetcher.service.ts`, in one file, behind the port. It owns:
- `PATIENT_SERVICE_URL` / `PROVIDER_SERVICE_URL` (read from config, only here)
- the 8 HTTP calls: patient demographics (`/{id}`), visits (`/medical/patients/{id}/visits`), health insights (`/intelligence/patients/{id}/health-insights/latest`), provider profile (`/{id}`), provider comm preferences (`/{id}/preferences/communication`)
- header forwarding (`x-gateway-request`, tenant headers), 5s timeouts, `Promise.allSettled` partial-failure tolerance — the source uses `axios.get` triples; keep the partial-degradation behavior, a missing health-insight must not fail the draft
- `resolveRecipient` → maps a patient record to `{ displayName, contactPoints, timezone, externalRef }`

Results are cached in `recipient_context` with a TTL (`CONTEXT_CACHE_TTL_S`, default 900).

**`src/engine/context/registry.ts`** — `register(provider)`, `resolve(ref)`. Unknown `kind` ⇒ `ValidationError`, never a silent fallback to Mentera.

> **Critical:** `mentera.provider.ts` is registered by the *medspa pack*, not by the composition root. A tenant without the medspa pack installed cannot reach patient-service even by crafting a `ContextRef`. Enforce that in the registry: providers are registered per-pack and resolution is scoped by the tenant's installed packs.

### Recipients

**`src/engine/recipients/recipient.service.ts`**
```ts
upsertByExternalRef(scope, ref, patch): Promise<Recipient>   // idempotent on the UNIQUE index
getOrResolve(scope, ref): Promise<Recipient>                 // cache-miss → provider.resolveRecipient
listByIds(scope, ids[]): Promise<Recipient[]>                // batch — replaces the IN (...) SQL
search(scope, q, page): Promise<Page<Recipient>>
```
`listByIds` is the direct replacement for `communications.controller.ts:1236–1250`. It must handle the empty-array case — the source hit `IN ()` and 500'd the whole inbox for providers with no messages, and there is an explicit comment about that fix at `:1234`. Keep the guard.

**Backfill path (P9)**: every distinct `(medspa_id, patient_id)` in `message_history` becomes a `recipients` row with `external_ref = {system:'mentera-patient', id: patient_id}` and `display_name` taken from the latest `metadata->>'patientName'` — which is exactly what the inbox query already reaches for. Names missing from metadata are resolved lazily by `mentera.provider.ts` on first read.

### Compliance plane

**`src/engine/compliance/preference.service.ts`** — port of `preference.service.ts` with the single most important change in this phase: **`private userPreferences: Map<...>` (`:30`) is deleted.** All reads/writes go to `recipient_preferences`. Preserve exactly:
- quiet-hours evaluation including the cross-midnight window and timezone handling (`:331`)

> **Corrected (P5) — the time formatting is buggy; do not port it verbatim.** `:341-346` uses `new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false })`. On some ICU builds that renders midnight as **`24:00`**, which the arithmetic turns into 1440 minutes — *after* every quiet-hours window. A message at midnight escapes a 22:00–06:00 window on exactly those platforms. Use `hourCycle: 'h23'`. (D38)
>
> **The cross-midnight arithmetic itself is correct** (`start > end ⇒ now >= start || now <= end`) and is preserved unchanged.
>
> **Deferral needs an end time, and it cannot be offset arithmetic.** The local UTC offset can change *inside* the window on a DST night. Probe forward a minute at a time until local wall-clock matches. (D39)
- urgent-priority override of quiet hours
- per-channel and per-event enablement
- unsubscribe token generation and the unsubscribe URL (source builds it from `SERVICE_DOMAIN`, `:458` — replace with `config.compliance.unsubscribeBaseUrl`)

**`src/engine/compliance/gate.ts`** — the mandatory pre-delivery check, wired into the `// COMPLIANCE GATE (P5)` hook left in `dispatcher.ts`:
```ts
check(msg): Promise<{ allow: true; mutations?: Partial<RenderedMessage> }
                   | { allow: false; reason: SuppressionReason; retryAt?: Date }>
```
Order of checks (short-circuit on first block):
1. recipient status (`unsubscribed`/`bounced`/`deleted`) → block
2. `allow_communications = false` → block, unless priority `URGENT` **and** the playbook is marked transactional
3. per-channel opt-out / consent record required (`tenant.require_opt_in`) → block
4. per-playbook opt-out (`event_opt_outs`) → block
5. quiet hours → **defer** (return `retryAt`, re-enqueue with delay), not block

> **Note (P5):** the source does not have this distinction — `checkPreferences` returns `blockedReason: 'QUIET_HOURS'` exactly as it returns `'UNSUBSCRIBED'`, and the caller drops the message either way. A reminder that lands in someone's quiet hours is **lost today**, not delayed. Deferrable means the message is about *timing*; blocking means it is about *permission*. (D40)
6. tenant rate limits (from `tenant_channel_configs.sms_rate_limit`/`email_rate_limit`: `maxPerHour`, `maxPerDay`, `burstLimit`) → defer
7. per-playbook throttle (`maxPerRecipientPerDay`, `cooldownHours`) → block
8. mutations: inject unsubscribe footer (CAN-SPAM) for non-transactional email; inject sender identity; truncate to channel `maxLength`

Every block/defer writes a `messages` row with `status = SUPPRESSED` + `suppression_reason`, and increments `outreach_suppressed_total{reason,channel}`. Silent drops are not acceptable — today a preference failure is invisible.

> **Ship the gate in shadow mode.** `COMPLIANCE_SHADOW_MODE=true` (the default) evaluates every check, logs `outreach_would_suppress_total{reason,channel}`, and **still sends**. This matters because the source's preference engine is in-memory and effectively empty after every restart — turning on a real, DB-backed gate is the single change most likely to silently stop messages that ship today. Flip to enforcing per tenant only after a week of clean telemetry, and record the flip date per tenant in `tenant_packs.config`.

**`src/engine/compliance/lint.ts`** — the ruleset hook stubbed in P4. Rules are data, loaded per pack + per compliance profile:
```json
{ "prohibitedPhrases": [...], "requiredDisclaimers": [...],
  "maxLength": {"sms": 320}, "phiPatterns": ["\\bdiagnos", "\\bprescri"],
  "linkPolicy": "allowlist", "allowedDomains": ["mentera.com"] }
```
Engine-level defaults every pack inherits: CAN-SPAM footer + sender identity for bulk email, TCPA quiet-hours strictness for SMS. HIPAA rules ship in `packs/medspa/compliance.json`. Lint results feed `aiConfidence` and the threshold policy.

**Retention:** `tenant_channel_configs.retention_days` exists today and nothing reads it. Add `src/engine/compliance/retention.job.ts` — a scheduled purge of `messages`/`message_analytics`/`ai_interactions` older than the tenant's retention, dry-run by default (`RETENTION_DRY_RUN=true`), logging counts. **Do not enable deletion without operator sign-off.**

**Migration `migrations/0005_compliance.sql`** — ~~`consent_records`, `recipient_context`,~~ `messages.suppression_reason` ~~, `recipient_preferences.event_opt_outs`, `recipient_preferences.quiet_hours_timezone`, `recipients.status`~~.

> **Corrected (P5):** five of the six already exist — P2 built the schema up front (D13). What was genuinely missing is `messages.suppression_reason`, plus its CHECK and a partial index, and two composite indexes for the rate-limit and throttle windows (without them, every send sequential-scans `messages`).

### API
`GET|PUT /v1/recipients/:id/preferences`, `POST /v1/preferences/check`, `POST|GET /v1/preferences/unsubscribe` (token-based, **unauthenticated** — it is a link in an email; rate-limit it), `GET /v1/recipients/:id/unsubscribe-url`, `GET|PUT /v1/recipients/:id/consent`, `GET|POST /v1/recipients`, `GET /v1/recipients/:id`.

### Tests
- `tests/unit/compliance/quiet-hours.test.ts` — port the source's cases and add: window 22:00→06:00 across midnight; `America/New_York` vs `UTC`; DST boundary; URGENT override; missing timezone falls back to tenant default.
- `tests/unit/compliance/gate.test.ts` — all 8 checks, each in isolation and in precedence order; assert the `SUPPRESSED` row is written; assert quiet hours **defer** rather than block.
- `tests/unit/context/registry.test.ts` — a tenant without the medspa pack cannot resolve `kind: 'mentera-patient'` (assert it throws, and that no HTTP call was made).
- `tests/unit/recipients/recipient.service.test.ts` — `listByIds([])` returns `[]` without issuing SQL; `upsertByExternalRef` is idempotent under concurrency.
- `tests/integration/preferences.test.ts` — preferences survive a service restart (the whole point of killing the `Map`).

### Exit criteria
`grep -rn "PATIENT_SERVICE_URL\|PROVIDER_SERVICE_URL" src/` matches **only** `src/adapters/context/mentera.provider.ts` and `src/config/index.ts`. `grep -rn "FROM patients" src/` returns nothing. The preference `Map` is gone.

### Handoff
"Context is a port; caller-supplied inline data is the default path and Mentera access is pack-gated — a tenant without the medspa pack physically cannot reach patient-service, and the test asserts no HTTP call is even attempted (D37). `recipients` owns display names; the cross-DB `SELECT ... FROM patients` is dead. The preference `Map` is gone and preferences survive a restart. 280 tests green across 18 suites.

Two real defects found in the quiet-hours logic while porting it: `hour12: false` can render midnight as `24:00` on some ICU builds, letting a midnight message escape a 22:00–06:00 window (D38); and the deferral end time cannot be offset arithmetic, because the offset changes inside the window on a DST night (D39). The cross-midnight arithmetic itself was correct and is unchanged.

The gate has 8 ordered checks. **Quiet hours and rate limits DEFER with a `retryAt`; everything else blocks** — the source drops on quiet hours, so a reminder landing in someone's quiet window is lost today rather than delayed (D40). Every block and defer writes a `SUPPRESSED` row with a reason.

**The gate is in SHADOW MODE by default and must stay there for now** (D41). Today's gate is an empty in-memory Map after every restart, and `require_opt_in` defaults true while `consent_records` is empty until P9 — enforcing on day one would block every message for every tenant on check 3. Watch `outreach_would_suppress_total` per tenant for a week, then flip, and record the date in `tenant_packs.config`.

Still open for later phases: **nothing consumes `retryAt` yet** — a deferred message is recorded but not re-enqueued, which P7's scheduler must do; the lint ruleset is written but not yet passed into `ContentGenerator`; the retention job is dry-run and needs operator sign-off.

Next: P6 approvals."

---
# P6 — Approvals: table, unified state machine, policy engine

### Session brief
Read in full: `controllers/approvals.controller.ts` (1,055L), `routes/approvals.routes.ts`.
Read **only** the approval-related parts of `controllers/ai-enhanced-communication.controller.ts` (803L): the class header + constructor (:1–60), `getPendingApprovals`, `approveMessage`, and the two `fetch` calls to provider preferences at :609 and :786. Use `grep -n "async \|approvalStatus" ` to locate them rather than reading top-to-bottom.
Read: `services/ai/ai-message-generator.ts:230–300` (`storeForApproval()` — where drafts enter the flow).
Do **not** read: the rest of `ai-enhanced-communication.controller.ts`, `communications.controller.ts`.
Budget: large.

### Goal
One `approvals` table, one state machine, one API. Both legacy implementations collapse into it. Policy decides who approves what, with `{mode: always, approver: agent}` reproducing today's medspa UX exactly.

### What exists today (verified — corrected by P6)

**The two implementations differ in STORAGE, not just vocabulary** (D46). This was the single biggest wrong assumption in the original draft of this phase:

| | outer marker | state lives in | values written |
|---|---|---|---|
| `approvals.controller.ts` | `status='QUEUED'` | `queued_message->>'approvalStatus'` | `PENDING_APPROVAL` / `APPROVED` / `DECLINED` |
| `ai-enhanced-...controller.ts` | — | the `status` **column** | `PENDING_APPROVAL` / `APPROVED` / `SCHEDULED` / `REJECTED` |

`ai-enhanced` writes no `queued_message` at all (`:108–130`) and filters on `eq(messageHistory.status, 'PENDING_APPROVAL')` (`:222`). **So the two inboxes show disjoint sets** — a message created by one flow never appears in the other's pending list, and nothing anywhere shows both. `REJECTED` is resolved to `DECLINED`.

Only **three** `approvalStatus` values are ever written to the JSONB — verified across all three writers, including `automated-message-generator.service.ts:186,216,566`. That part of the original claim holds.

**Approving a message sends nothing** (D44). `approveMessage` (`:351–377`) sets `message_history.status='APPROVED'` and `communication_events.status='APPROVED'` with a `scheduled_for`, and nothing reads either back — the event queue takes jobs pushed to BullMQ, it does not scan for approved rows. `scheduleMessage` (`:1003–1025`) writes a `scheduledFor` string no scheduler consumes. **P6's dispatch handoff is therefore a fix, not a port**: byte-compatible in UX (every AI message waits for its provider), a behaviour change in outcome.

`approvals.controller.ts` — 9 endpoints:
`GET /pending/:providerId` · `GET /dashboard/:providerId` · `POST /approve/:messageId` · `POST /decline/:messageId` · `PUT /edit/:messageId` · `POST /edit-approve/:messageId` · `POST /bulk-action` · `GET /history/:providerId` · `POST /schedule/:messageId`

`ai-enhanced-communication.routes.ts` — 3 overlapping ones:
`GET /pending-approvals/:providerId` · `POST /approve/:messageId` · (+ `POST /generate-communication`, `POST /batch-generate` which create drafts)

Filters on the pending list: `priority` and `channel`, both read out of the JSONB (`queued_message->>'priority'`, `->>'channel'`), plus `sortBy`/`sortOrder`/`limit`/`offset`.

**Access control — this is a TIGHTENING, not a port** (D45). The `req.user.providerId !== providerId` rejection at `approvals.controller.ts:65–71` guards `getPendingApprovals` and **nothing else**. Every mutation looks its row up as `where(eq(messageHistory.id, messageId))` — no tenant predicate, no approver check: approve `:325`, decline `:426`, edit-approve `:534`, edit `:687`, bulk `:792`, schedule `:981`. `getApprovalHistory:921` reads across tenants for the same reason.

Two live consequences: provider A can approve anything in provider B's queue given an id, and a user authenticated to tenant A holding a message UUID from tenant B can approve it — a direct violation of hard rule 4, at the point where clinical content is released. (`ai-enhanced`'s read does carry `tenantWhere` at `:286–290`; it still has no approver check.)

Generalize the *rule* to `senderId` and apply it **per row on every action**. Expect new 403s in the parallel run for any caller that relied on cross-provider approval; P8's compat shim and P10's cutover watch should both anticipate that.

### The state machine

**`src/engine/approvals/state-machine.ts`** — a pure, table-driven transition function. No I/O.

```
                 ┌──────────────── policy: none / threshold met ─────────────┐
                 ▼                                                            │
[*] ──▶ DRAFT ──▶ AUTO_APPROVED ──┐                                          │
          │                        ├──▶ SCHEDULED ──▶ SENT ──▶ [*]           │
          └──▶ PENDING_APPROVAL ───┤                    ▲                     │
                 │  │  │  │        │                    │                     │
                 │  │  │  └─▶ APPROVED ─────────────────┘                     │
                 │  │  └────▶ EDITED_APPROVED ──────────┘                     │
                 │  └───────▶ DECLINED ──▶ [*]                                │
                 └──────────▶ EXPIRED ──┬─▶ PENDING_APPROVAL (escalated)      │
                                        ├─▶ DECLINED (policy: auto-decline)   │
                                        └─▶ AUTO_APPROVED (policy: auto-approve)
Any non-terminal ──▶ CANCELLED
```

```ts
export const TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  DRAFT:            ['PENDING_APPROVAL', 'AUTO_APPROVED', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'EDITED_APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'],
  APPROVED:         ['SCHEDULED', 'SENT', 'CANCELLED'],
  EDITED_APPROVED:  ['SCHEDULED', 'SENT', 'CANCELLED'],
  AUTO_APPROVED:    ['SCHEDULED', 'SENT', 'CANCELLED'],
  EXPIRED:          ['PENDING_APPROVAL', 'DECLINED', 'AUTO_APPROVED', 'CANCELLED'],
  SCHEDULED:        ['SENT', 'CANCELLED'],
  DECLINED: [], SENT: [], CANCELLED: [],
};
export function transition(from, to, actor): Result<ApprovalStatus, InvalidTransitionError>
```
Every accepted transition appends to `approvals.audit_trail` (append-only): `{at, from, to, actorType, actorRef, reason?, contentHash?}`.

### The policy engine

**`src/engine/approvals/policy.service.ts`**
```ts
decide(input: {
  policy: ApprovalPolicy; draft: Draft; playbook: Playbook;
  scope: TenantScope; senderId?: string;
}): Promise<ApprovalDecision>

type ApprovalDecision =
  | { kind: 'auto'; reason: 'mode_none' | 'threshold_met' | 'sample_skip' }
  | { kind: 'review'; approverType: 'agent'|'role'|'group'|'round_robin';
      approverRef: string; slaDeadline?: Date };
```
Modes:
- **`always`** — every message reviewed. **The medspa pack ships this.** Byte-compatible with today.
- **`threshold`** — auto-approve when `aiConfidence >= confidence_threshold` **and** lint passes with zero errors. **Ships disabled**; requires explicit per-tenant opt-in flag (`tenant_packs.config.allowAutoApprove`). Rationale: `aiConfidence` is a heuristic (P4).
- **`sample`** — review `sample_rate` of messages, chosen by a *deterministic* hash of `messageId` (not `Math.random()` — determinism matters for replay and for tests).
- **`none`** — transactional/system messages.

Approver resolution:
- `agent` → the message's `senderId` (today's provider). Falls back to the policy's `fallbackApproverRef` when `senderId` is null.
- `role` → resolved against `tenant_packs.config.roleMembers[role]`, or via an optional `AuthorizationProvider` port (stub now, wire in P12).
- `group` → `any_of` (first responder wins) or `all_of` (all must approve; the approval row holds an array of decisions in `audit_trail` and only transitions when complete).
- `round_robin` → stable rotation on `(tenantId, playbookId)` counter in Redis.

**SLA & escalation** — `src/engine/approvals/sla.worker.ts`, a BullMQ repeatable job scanning `approvals WHERE status='PENDING_APPROVAL' AND sla_deadline < now()`, applying `sla.onExpiry`. Escalation notifies the fallback approver **through the engine itself** (a `system.approval_escalation` playbook), which is a nice proof the engine is self-hosting.

### Service + API

**`src/engine/approvals/approval.service.ts`**
```ts
submit(draft, playbook, scope): Promise<Approval>        // idempotent on messageId
listPending(scope, { approverRef, priority?, channel?, playbookKey?, page, sort })
dashboard(scope, approverRef)                            // counts by status/priority/age
approve(scope, id, actor)
editThenApprove(scope, id, actor, newContent)
edit(scope, id, actor, newContent)                       // stays PENDING_APPROVAL
decline(scope, id, actor, reason)
schedule(scope, id, actor, sendAt)
bulk(scope, ids[], action, actor)                        // policy.rights.bulk must allow it
history(scope, approverRef, filters)
```

Rules that must hold:
- **Idempotency**: `approve` on an already-`APPROVED` row returns the existing row with `200`, not an error and not a second send. `UNIQUE(message_id)` on `approvals` backs this.
- **Authorization**: the caller's `senderId` must match `approver_ref` for `approverType='agent'`, or hold `outreach:approve` for role/group. Bulk additionally requires `outreach:approve:bulk` **and** `policy.rights.bulk === true`.
- On `APPROVED`/`EDITED_APPROVED`/`AUTO_APPROVED`, the service hands the message to `dispatcher.dispatch()` — which is where the P5 compliance gate runs. **Approval does not bypass compliance.**
- `edit` records both `original_content` and `edited_content`; the message body sent is always `edited_content ?? original_content`.

**v1 API** (`src/api/v1/approvals.router.ts`):
```
GET    /v1/approvals                 ?approverRef=&status=&priority=&channel=&playbook=&page=
GET    /v1/approvals/dashboard       ?approverRef=
GET    /v1/approvals/:id
POST   /v1/approvals/:id/approve
POST   /v1/approvals/:id/edit-approve
PUT    /v1/approvals/:id/content
POST   /v1/approvals/:id/decline
POST   /v1/approvals/:id/schedule
POST   /v1/approvals/bulk
GET    /v1/approvals/history
GET    /v1/approval-policies         POST /v1/approval-policies   PUT /v1/approval-policies/:id
```
Legacy `/approvals/*` and `/ai-enhanced/{pending-approvals,approve}` are mapped by the P8 compat shim. **`ai-enhanced`'s private approval endpoints are retired at P12, not before** — the FE may still call them.

**Migration `migrations/0006_approval_policies.sql`** — seed the two baseline policies:
```sql
INSERT INTO approval_policies (id, tenant_id, pack_id, key, name, mode, approver_resolution, rights, sla)
VALUES
 (gen_random_uuid(), NULL, 'medspa', 'medspa.provider-always', 'Provider approves everything',
  'always', '{"kind":"agent"}',
  '{"approve":true,"edit":true,"decline":true,"reschedule":true,"bulk":true}', NULL),
 (gen_random_uuid(), NULL, 'system', 'system.transactional', 'Transactional — no approval',
  'none', '{"kind":"agent"}', '{"approve":false,"edit":false,"decline":false,"reschedule":false,"bulk":false}', NULL)
ON CONFLICT DO NOTHING;
```

### Tests
- `tests/unit/approvals/state-machine.test.ts` — exhaustive: every (from,to) pair asserted legal/illegal; terminal states reject everything; audit trail append is ordered and never rewrites history.
- `tests/unit/approvals/policy.test.ts` — all four modes; `sample` is deterministic for a fixed messageId; `threshold` refuses to auto-approve when the tenant opt-in flag is absent even if confidence is 1.0; `agent` with null `senderId` falls back.
- `tests/unit/approvals/authz.test.ts` — provider A cannot approve provider B's message (the `:66–73` rule); bulk without `rights.bulk` ⇒ 403.
- `tests/integration/approvals.test.ts` — full lifecycle DRAFT→PENDING→EDITED_APPROVED→SENT; double-approve is idempotent; declining does not dispatch; approving a message whose recipient is unsubscribed produces `SUPPRESSED`, not `SENT` (proves compliance is downstream of approval).
- `tests/unit/approvals/sla.test.ts` — expiry escalates / auto-declines / auto-approves per policy.

### Exit criteria
No **code** in `src/engine` or `src/api/v1` reads or writes the legacy approval JSONB. The header comments in `src/engine/approvals/*` cite `queued_message` and `approvalStatus` deliberately, to document what was replaced, so the criterion is code-only:

```bash
grep -rn "queued_message\|approvalStatus" src/engine src/api/v1 \
  | grep -vE '^[^:]+:[0-9]+:\s*(\*|//)'
```

Returns nothing. The strings may still appear in `src/api/compat`, the P9 backfill script, and `src/db/schema/messaging.ts` (the retained `queuedMessage` column, dropped in P12). All approval state reads/writes go through `approval.service.ts`.

### Handoff
"One `approvals` table, one 10-state machine, one policy engine. `DECLINED` won over `REJECTED`. Medspa ships `{always, agent}` — identical UX to today. Threshold mode exists but is hard-disabled without a per-tenant opt-in because `aiConfidence` is heuristic. Approval hands off to `dispatcher.dispatch()`, so the compliance gate still runs after approval — do not shortcut that. `ai-enhanced`'s duplicate approval endpoints survive via the compat shim until P12.

**Three corrections to what this phase assumed, all verified against the code** (D44–D46): approving a message **sends nothing today**, so the dispatch handoff is a behaviour change and not a port; the provider access check guards only the pending list, so P6 *tightens* authorization rather than preserving it, and new 403s are expected; and the two source implementations use different **storage**, so their inboxes are disjoint and P9 must backfill from both.

Structural notes P7 inherits: `submit()` writes the `messages` row at status `PENDING_APPROVAL` and the dispatcher **adopts** it via `OutboundMessage.messageId` rather than inserting a second row (D47) — a playbook that has already persisted a message passes its id in. `SENT` is written by the delivery worker through `markSent()`, not by the approver (D48). SLA escalation reassigns and logs but **sends nothing**: `SlaSweeper` takes a `notify` hook that P7 must wire to a `system.approval_escalation` playbook (D50). Two P5 defects were found and fixed on the way through: `record-result` was destroying `metadata.playbookKey` on every send, breaking the per-playbook cooldown (D49), and the lint ruleset was never loaded, making `lintWarnings` permanently empty (D52). Next: P7 playbooks."

---

# P7 — Playbook runtime + the medspa pack

### Session brief
Read in full: `events/enhanced-event-handler.ts` (725L — this *is* the phase input), `services/event-mapper.service.ts` (351L), `events/event-handler.ts` (238L), `events/event-subscriber.ts` (247L), `models/communication.model.ts` (346L, for the 44-value `EventType` enum).
Skim for the pack's playbook definitions: `services/onboarding/onboarding-service.ts` (359L), `services/treatment/treatment-follow-up.service.ts` (321L), `services/farewell/farewell-message.service.ts` (292L), `services/promotion/promotion.service.ts` (555L), `services/feedback/feedback-analysis.service.ts` (455L).
Do **not** read: `services/lead/lead-message.service.ts` (P11 owns it), controllers, `campaign-template-generator.ts`.
Budget: large. Consider splitting into P7a (runtime) and P7b (pack authoring) if context pressure appears — the seam is clean.

### Goal
`enhanced-event-handler.ts`'s 17-case switch is deleted. Triggers match playbook rows. The medspa pack ships as data and reproduces today's behavior.

> **The medspa pack ships NO DDL (P2 amendment).** An earlier draft had this phase create `pack_medspa_feedback` / `pack_medspa_promotions` / `pack_medspa_gift_cards`. The engine has no vertical-specific tables — see §0.10 and §0.5 Seam D. The pack is playbooks, templates, prompts and policies **as data**, seeded into the generic tables. If authoring the pack seems to need a table, that is a signal to re-read §0.10, not to add one: the answer is almost always the event payload (tier 1) or a generic extension column (tier 2).
>
> `promotion.service.ts` and `feedback-analysis.service.ts` are on the skim list below for their *playbook shapes only* — what gets sent, on what trigger, to whom. Do not port their persistence. Both are stubbed demo code (§0.5 Seam D) and their tables are empty.
>
> Close the phase with `grep -ri medspa src/db/ migrations/` — no table or column names.

### Runtime

**`src/engine/playbooks/trigger.ts`**
```ts
export interface OutreachTrigger {
  type: 'event' | 'schedule' | 'manual' | 'campaign' | 'webhook';
  tenantId: string; subTenantId?: string;
  eventType?: string;                 // e.g. 'APPOINTMENT_REMINDER'
  payload: Record<string, unknown>;
  correlationId: string;
  idempotencyKey?: string;
}
```

**`src/engine/playbooks/matcher.ts`** — given a trigger, select playbooks:
1. tenant's installed packs → candidate playbooks (`is_active`)
2. `playbook_triggers.trigger_type` matches
3. `match_rules.eventType` equals `trigger.eventType` (exact; no regex, no DSL)
4. `match_rules.where` — a **bounded** predicate object, deliberately not a rules language: `{ "path.to.field": {eq|neq|in|nin|gt|lt|exists: value} }`, ANDed. Anything needing more becomes code behind a port. **Resist adding an expression evaluator here** — that is the documented failure mode for this design.
5. sort by `priority` desc; a trigger may fire multiple playbooks

**`src/engine/playbooks/runtime.ts`**
```ts
run(trigger): Promise<PlaybookRunResult[]>
```
Per matched playbook:
1. resolve recipient(s) — `payload.recipient` inline, or `recipientRef` via the context registry, or an audience (P11)
2. resolve context — inline `payload.context`, or `contextRef` through the registry
3. **validate context against `data_contract`** — failure ⇒ record a `FAILED` run with the schema errors; never proceed with a partial context
4. resolve channel — the first entry in `channel_plan` the recipient has a contact point for and has not opted out of
5. content: `content_source.kind === 'template'` ⇒ render; `'ai'` ⇒ `generator.generate()`; `'hybrid'` ⇒ AI drafts into a template slot
6. `approvalService.submit(...)` with the playbook's policy
7. auto-decided ⇒ straight to `dispatcher.dispatch()`
8. write `outreach_events` + `playbook_runs` rows; emit `outreach_playbook_runs_total{playbook,result}`

**Idempotency:** `(tenant_id, playbook_id, idempotency_key)` unique. `default-event-processor.ts` (stubbed in P3) now calls `runtime.run()` and is the queue's consumer. Redelivery of the same event must not double-send.

**`src/engine/playbooks/registry.ts`** — playbook CRUD + pack installation:
```ts
installPack(tenantId, packId, config): Promise<void>   // idempotent upsert of playbooks/policies/templates/prompts
uninstallPack(tenantId, packId)
listPlaybooks(scope) · upsertPlaybook(scope, def) · setActive(scope, key, bool)
```

### Pack format — `packs/medspa/`

```
packs/medspa/
├── manifest.json          { id, name, version, requires: {engine: '>=1.0'},
│                            contextProviders: ['mentera-patient'] }
├── aliases.json           template variable aliases (from P4)
├── compliance.json        HIPAA lint rules, PHI patterns, SMS clinical-detail ban
├── policies/
│   └── provider-always.json
├── prompts/               *.json  (from P4)
├── templates/             *.hbs + *.meta.json  (the 21 template ids below)
└── playbooks/             *.json
```

**`src/packs/loader.ts`** validates a pack against a Zod schema at load, then `registry.installPack`. Packs are loaded from `packs/` on disk (and later from `packs` DB rows for tenant-authored ones).

### The 17 medspa playbooks — direct transcription of the switch

Source: `enhanced-event-handler.ts` case labels (:29–69) and its 21 hardcoded `templateId` literals.

| Playbook key | Trigger `eventType` | Template id(s) | Channels | Notes |
|---|---|---|---|---|
| `medspa.appointment-reminder` | `APPOINTMENT_REMINDER` | `appointment-reminder` (:130, :149) | SMS + EMAIL | two dispatches in the source |
| `medspa.appointment-confirmation` | `APPOINTMENT_CONFIRMATION` | `appointment-confirmation` (:175) | EMAIL | |
| `medspa.appointment-cancellation` | `APPOINTMENT_CANCELLATION` | `appointment-cancellation` (:200, :218) | SMS + EMAIL | |
| `medspa.appointment-rescheduling` | `APPOINTMENT_RESCHEDULING` | `appointment-rescheduling` (:244, :267) | SMS + EMAIL | ⚠ enum has `APPOINTMENT_RESCHEDULED`, the switch matches `APPOINTMENT_RESCHEDULING` — **both must be accepted as trigger aliases** |
| `medspa.treatment-followup` | `TREATMENT_FOLLOWUP` | `treatment-followup` (:295) | EMAIL | ⚠ enum says `APPOINTMENT_FOLLOW_UP`/`TREATMENT_FEEDBACK_REQUEST`; alias both |
| `medspa.treatment-preparation` | `TREATMENT_PREPARATION` | `treatment-preparation` (:322, :342) | SMS + EMAIL | not in the enum at all |
| `medspa.treatment-completion` | `TREATMENT_COMPLETION` | `treatment-completion` (:371) | EMAIL | enum: `TREATMENT_COMPLETED` |
| `medspa.treatment-instructions` | `TREATMENT_INSTRUCTIONS` | `treatment-instructions` (:398, :421) | SMS + EMAIL | |
| `medspa.patient-registration` | `PATIENT_REGISTRATION` | `patient-registration` (:576) | EMAIL | enum: `PATIENT_WELCOME` |
| `medspa.patient-feedback-request` | `PATIENT_FEEDBACK_REQUEST` | `patient-feedback` (:602) | EMAIL | |
| `medspa.patient-birthday` | `PATIENT_BIRTHDAY` | `patient-birthday` (:630) | EMAIL | |
| `medspa.staff-alert` | `STAFF_ALERT` | `staff-alert` (:464) | SLACK + EMAIL | recipient is staff, **not** a patient — this is the case that proves `recipient_id` must be nullable |
| `medspa.shift-reminder` | `SHIFT_REMINDER` | `shift-reminder` (:490, :510) | SMS + EMAIL | |
| `medspa.emergency-notification` | `EMERGENCY_NOTIFICATION` | `emergency-alert` (:550) | EMAIL + SLACK | **contains `to: 'emergency-team@medspa.com'` at :549 — must become `tenant_packs.config.emergencyContacts[]`, no literal survives** |
| `medspa.general-notification` | `GENERAL_NOTIFICATION` | `general-notification` (:657) | EMAIL | |
| `medspa.marketing-campaign` | `MARKETING_CAMPAIGN` | (campaign path) | EMAIL | non-transactional ⇒ CAN-SPAM footer applies |
| `medspa.system-alert` | `SYSTEM_ALERT` | (slack) | SLACK | |

Additionally, seeded from the service modules rather than the switch:
`medspa.onboarding` (from `onboarding-service.ts`, replaces the `outreach_rules` table), `medspa.farewell` (from `farewell-message.service.ts`, replaces `farewell_messages`), `medspa.treatment-followup-rules` (from `treatment-follow-up.service.ts`, replaces `treatment_follow_up_rules`), `medspa.promotion-announcement` + `medspa.gift-card` (from `promotion.service.ts`), `medspa.feedback-acknowledgement` / `-resolution` / `-escalation` (from `feedback-analysis.service.ts`).

**Approval is decided by content source, not by playbook** (D53 — corrected; the operator confirmed this on 2026-08-04):

> `content_source.kind === 'ai'` → `medspa.provider-always`
> `content_source.kind === 'template'` → `system.transactional`

**The original text here said every playbook gets `medspa.provider-always` except four staff/system ones. That was wrong, and shipping it would have been a serious regression.** None of the 17 event-driven playbooks requires approval today: `enhanced-event-handler.ts` calls `notificationQueueService.addNotification` directly, and `grep -rn "approval" src/events/ src/services/queue/` returns nothing. Approval exists only on the AI-draft path (`ai-message-generator.storeForApproval`, the `ai-enhanced` controller). Seeding all 17 as `provider-always` would have stopped every appointment reminder at cutover until a human clicked approve — and, because P6 made approval actually send (D44), they would then all have gone out at once.

The rule above reproduces today's behaviour exactly, because every switch-derived playbook is template-rendered and every approval-requiring path today is AI-generated. It also answers the question for the 8 service-module playbooks without a second operator conversation: seed by what generates the content, not by who receives it.

A tenant that wants its reminders reviewed changes one row. This is playbook **data**, not code.

**Data contracts.** Each playbook's `data_contract` is derived from the fields the switch case actually reads (`appointmentDate`, `appointmentTime`, `doctorName`, `treatmentName`, `patientName`, …). Write them as Zod in `packs/medspa/playbooks/*.ts` → emit JSON Schema at build time into `*.json`. Fields the source read defensively (`data.x || 'there'`) become **optional with a default**, not required — otherwise events that work today start failing validation.

**`EventType` enum disposition.** The 44-value enum is not ported to the engine. It becomes `packs/medspa/event-types.json` — a list of accepted trigger aliases. The engine's trigger type is `string`.

**`event-mapper.service.ts`** (EHR event → internal event) becomes `packs/medspa/ehr-mapping.json` + a generic mapper in `src/engine/playbooks/ehr-mapper.ts` driven by that data.

**Migration `migrations/0007_playbook_runs.sql`** — `playbook_runs` (id, tenant_id, playbook_id, trigger jsonb, status, error, message_ids uuid[], started_at, finished_at) + the idempotency unique index.

### Tests
- `tests/unit/playbooks/matcher.test.ts` — eventType exact match; `where` operators; priority ordering; a tenant without the pack matches nothing.
- `tests/unit/playbooks/runtime.test.ts` — contract violation ⇒ FAILED run and zero LLM calls; `always` policy ⇒ nothing dispatched until approval; idempotency key blocks the second run.
- `tests/contract/medspa-parity.test.ts` — **the key regression test.** For each of the 17 events, feed the same payload the old handler took and assert: same templateId selected, same channel set, same recipient, same approval requirement. Build the expectation table by reading the switch, not by running the old service.
- `tests/unit/packs/loader.test.ts` — malformed pack rejected with a readable error; install is idempotent.

### Exit criteria

`enhanced-event-handler.ts` has **no** counterpart in `src/` — there is no switch on event type anywhere:

```bash
grep -rn "case 'APPOINTMENT_\|case 'TREATMENT_\|case 'PATIENT_\|case 'STAFF_" src/   # nothing
```

The other two are **code-only**, for the same reason as P6's: the engine's comments cite the literals and the vocabulary they replaced, deliberately, and a criterion that forbade naming them would forbid explaining them.

```bash
# no hardcoded destination survives in code
grep -rn "medspa\.com\|emergency-team" src/ | grep -vE "^[^:]+:[0-9]+:\s*(\*|//|/\*\*)"

# no vertical vocabulary in engine code
grep -rniE "\b(patient|treatment|medspa)\b" src/engine --include="*.ts" \
  | grep -vE "^[^:]+:[0-9]+:\s*(\*|//|/\*\*)"
```

Both return nothing. **`provider` is deliberately excluded from the second grep**: it survives as generic port vocabulary — `ContextProvider`, `LlmProvider`, and `providerMessageId` (SendGrid's and Twilio's id for a message). Those are English, not the medspa `providerId` concept, which is now `senderId` everywhere.

Also run the §0.10 test: `grep -ri medspa src/db/ migrations/` — no table or column names.

### Handoff
"Playbook runtime replaces the 17-case switch; the medspa pack ships as data with all 17 playbooks plus 9 more from the service modules and the engine's own escalation. Trigger aliases handle the enum/switch mismatches — check `packs/medspa/event-types.json` before assuming an event is unhandled, and note the mismatch is larger than the plan said: **eight** handled event types are not enum members at all (D56). Optional-with-default is the rule for any field the old code read defensively. `where` matching is a bounded predicate object; **do not turn it into an expression language** — the answer to a harder condition is a named predicate behind a port.

**The approval split is the opposite of what this phase originally said** (D53). None of the 17 requires approval today, so all 17 ship `system.transactional`. Approval is seeded by `content_source.kind`: AI waits, template sends. The pack schema *enforces* this — an AI playbook with no `approvalPolicyKey` fails validation at load. The AI playbooks additionally ship **inactive** (D59): nothing in the source sends them, and installing a pack must not be the moment a tenant starts sending model-written messages.

**Four hardcoded destinations were removed, not one** (D55): `emergency-team@medspa.com` plus the Slack channels `staff-alerts`, `emergency-alerts` and `system-alerts`. All four are `$config.` references resolved from `tenant_packs.config`, and `manifest.requiredConfig` lists them. A tenant that has not configured one gets a SKIPPED run and an error log, never a silent send to the wrong place.

Channels come from the **trigger**, intersected with the playbook's plan (D54) — the plan's per-case channel lists are the *supported* set, not the effective one. `medspa.emergency-notification` carries `metadata.alwaysSendChannels: ['slack']`, which exempts its Slack alert from that intersection because the source posts it unconditionally.

Structural notes: a `none` policy skips `submit()` entirely and writes no approval row (D58). Every run writes a `playbook_runs` row, so "why did nothing send?" is a query rather than log archaeology. `(tenant_id, playbook_id, idempotency_key)` is a **partial** unique index; the queue's event id is the key, so a BullMQ retry cannot double-send.

Still open for P8: `event-mapper.service.ts` → `ehr-mapper.ts` + `ehr-mapping.json` is not built; `docs/PACKS.md` is unwritten; nothing consumes a deferred message's `retryAt` yet. For P9: the pack's template bodies are engine-authored defaults, and the real `communication_templates` rows must be mapped onto the pack's keys. Next: P8 API surface."

---
# P8 — v1 API, legacy compat shim, inbox/conversations, MCP

### Session brief
Read: `routes/index.ts` (103L), then each route file's **endpoint list only** via
`grep -nE "router\.(get|post|put|patch|delete)\(" src/routes/*.ts`.
Read in full: `controllers/webhooks-controller.ts` (478L), `routes/webhooks.routes.ts`, `mcp/index.ts` (250L), `mcp/server.ts` (237L), `mcp/tools/*.ts`.
Read **selectively** from `controllers/communications.controller.ts` (2,571L) — only the handlers behind the 16 `/communications/*` endpoints; use `grep -n "async get\|async post\|async create\|async update"` to find them and read one at a time. **Do not read this file top-to-bottom; it will consume most of your window.**
Read: `controllers/preference.controller.ts`, `routes/config.routes.ts` (474L, endpoint contracts).
Budget: very large. **Split, and the split is now a decision rather than a contingency** — the surface is 110 endpoints, not 77 (D60).

| | Scope | Endpoints | Status |
|---|---|---|---|
| **P8a** | `src/engine/messaging/*`, the v1 messaging/channels/queue surface, and compat for `/email` `/sms` `/slack` `/events` (+`/api/events`) `/preferences` `/config` `/approvals` `/communications` `/queue` | 55 | **shipped** |
| **P8b** | Webhooks with signature verification, MCP, and compat for `/templates` `/ai` `/ai-enhanced` `/automated-messages` `/ehr-webhook` `/messages/webhook/*` `/leads` `/treatments` `/patients` `/providers` `/promotions`+`/gift-cards`; plus `ehr-mapper.ts`, `docs/api/openapi.yaml`, `docs/PACKS.md` | 55 | |

Four `/communications/*` endpoints answer **501 with a named successor** at the end of P8a — `/response`, `/generate-message`, `/patient/:id/conversation/summary`, `/patient/:id/info`. They need the content plane's generation surface, which lands with the rest of the AI routers in P8b.

### Goal
Every one of the 110 legacy endpoints answers correctly from the new service, and a clean `/v1` surface exists alongside. This is the phase that makes P10's env-var repoint a no-op for callers.

### Structure

`src/api/v1/` — the real surface, documented in `docs/api/openapi.yaml`.
`src/api/compat/` — thin routers that translate legacy paths/shapes to v1 services. **Every file in here carries `// DELETE IN P12` at the top.**

### v1 surface (grouping)

```
/v1/outreach/trigger          POST   — the OutreachTrigger entry point
/v1/outreach/generate         POST   — playbook + recipient + context → draft (§5 of the strategy doc)
/v1/messages                  GET POST
/v1/messages/:id              GET
/v1/messages/:id/read         PUT
/v1/conversations             GET    — inbox: grouped by recipient, latest + unread + alerts
/v1/conversations/:senderId/:recipientId          GET
/v1/conversations/:senderId/:recipientId/read-all PUT
/v1/recipients                GET POST ; /:id GET PUT ; /:id/preferences ; /:id/consent
/v1/approvals*                (P6)
/v1/templates*  /v1/content*  /v1/assets*         (P4)
/v1/playbooks   /v1/packs     /v1/tenant-packs    (P7)
/v1/channels/configs          GET POST PUT        — tenant + agent channel credentials
/v1/channels/test             POST                — send a test message on a channel
/v1/queue/stats               GET ; /v1/queue/maintenance POST
/v1/analytics/messages        GET                 — engagement rollups
/v1/webhooks/{sendgrid,twilio,slack}  POST        — provider receipts (unauthenticated, signature-verified)
/v1/preferences/unsubscribe   GET POST            — unauthenticated, token-based
```

### The inbox — the handler that has never worked

> **Corrected (P8).** This section previously called the inbox "the piece with the most behavioral risk" and asked for a golden-file test capturing its current response shape. **The handler cannot run.** See D61, and the rewritten instruction below.

`communications.controller.ts:getProviderInbox` (:1180–1390) is the FE's main screen. Reimplement in `src/engine/messaging/conversation.service.ts` with a **materially better query**. Today it does:

1. `selectDistinct` over `message_history` grouped by `patient_id` with a **correlated subquery per row** to pull the latest `metadata->>'patientName'`
2. a raw `SELECT ... FROM patients WHERE patient_id IN (...)`
3. a `COUNT(DISTINCT patient_id)` for pagination
4. **then `Promise.all` over every conversation, issuing 3 more queries each** — latest message (:1263), stats (:1288), and a `patient_feedback` lookup for the alerts (:1306)

That is `3 + 3N` **SQL statements per page** — statements, not rows — where N is the number of conversations on the page. A 50-conversation page therefore costs **153 round trips to the database to render one screen**, not the 103 an earlier draft claimed. Replace with **two statements**, independent of page size: a grouped CTE with a lateral for the latest message and a lateral for the alerts, plus one count. Step 2 disappears entirely, because after P5 `recipients.display_name` holds the name (Seam C).

#### Step 1 is not valid SQL

The query at :1211–1230 is `SELECT DISTINCT … GROUP BY patient_id` with a correlated subquery in the select list that references `provider_id` and `medspa_id` — neither grouped nor aggregated. Postgres rejects it at plan time:

```
ERROR:  subquery uses ungrouped column "message_history.provider_id" from outer query
```

It fails on an empty table, so no data state avoids it. **Every request falls into the catch at :1378 and returns the 500 at :1385.**

Three consequences for this phase:

- **Do not go looking for a baseline response to diff against.** There isn't one. The only thing a caller has ever received from this endpoint is `{success:false, message:'Failed to get provider inbox'}`.
- **Build the shape from the unreachable code at :1321–1377**, which is still the right source — it is what the author intended and what the FE was written against — but treat it as a **specification**, not an observation. Keep the fields that are structurally dead rather than dropping them, so a consumer written against the intended shape finds everything it expects.
- **The risk is inverted.** Nothing that always 500s can regress. The real risk is that the screen starts working and renders fields nobody has seen populated. Verify the FE's success path before P10 Step 3.

**Preserve exactly** (all of it read out of the unreachable code, and all of it still correct as a specification):
- the status filter `status NOT IN ('QUEUED','DECLINED')` (`:1198–1201`) — queued/declined drafts must not appear in the inbox
- the empty-`patIds` guard (`:1234`) — the `IN ()` 500 bug. In the two-query form this is structural: nothing is interpolated from a list, so the shape cannot occur.
- the search behavior: `metadata->>'patientName' ILIKE %q%` OR `content ILIKE %q%` (now: `recipients.display_name` OR `messages.content`)
- the response envelope: `{ success, data: [...], pagination: {...}, summary: { totalUnread, adverseAlerts, followupRequired } }`, with `summary` computed over **the current page**, as `:1373–1375` does
- the 100-character `latestMessage.content` preview with a trailing `...` (`:1327`)
- sort by latest `sent_at` desc

**One substitution, forced by §0.10:** the alerts came from `patient_feedback`, a ghost table that is empty, tenant-blind and absent from the source's own migrations (D11). Its concepts live on `message_analytics.metadata` now (§0.7). Empty metadata yields `false`/`0` — the same answer an empty table gives — so the visible result is unchanged and the field becomes meaningful once P8b's webhooks write sentiment.

The contract test asserts the chosen shape **plus** real database behaviour against a testcontainer: **≤ 2 SQL statements to serve one page**, whatever the page size, the QUEUED/DECLINED exclusion, the empty-inbox case, tenant isolation. That is a stronger guarantee than a field-for-field diff against a specification would have been. Any intentional difference from the specified shape gets an explicit entry in `docs/api/BREAKING.md`.

### Compat shim — mapping table

Full 110-endpoint mapping in **Appendix A**. Mechanics:

- **Path**: legacy paths are mounted exactly as `routes/index.ts` mounts them (`/email`, `/sms`, `/slack`, `/events`, `/preferences`, `/config`, `/leads`, `/treatments`, `/providers`, `/patients`, `/communications`, `/queue`, `/mcp`, `/ai`, `/ai-enhanced`, `/approvals`, `/automated-messages`, `/ehr-webhook`, `/templates`, `/promotions`, `/gift-cards`, `/messages`, `/`). The gateway strips `/api/communication`, so these are root-mounted. **Keep `/gift-cards` aliased to the promotions router** — `routes/index.ts:96` does this and something depends on it.
- **Request**: `patientId`→`recipientId` (resolving via `external_ref`), `providerId`→`senderId`, `medspaId`→`tenantId`. Body fields are translated, not passed through.
- **Response**: the reverse. Legacy consumers see `patientId`/`providerId`/`medspaId` **exactly as today**. This is what makes the FE and the 5 inbound callers work unchanged.
- **Deprecation**: every compat response carries `Deprecation: true` and `Link: </v1/...>; rel="successor-version"`. Log `outreach_compat_hits_total{path}` — that counter is how P12 knows what is safe to delete.

Priority order if the phase must be split — these five are load-bearing for the P10 cutover:
1. `POST /email/send` (providers-service auth emails)
2. `GET|POST|PUT /config/medspa/:medspaId` (providers-service integration settings)
3. `POST /events` + `POST /api/events` (providers-service event client — **note it posts to `/api/events`, so mount both**)
4. all 9 `/approvals/*` and the 16 `/communications/*` (the FE)
5. `GET /mcp/tools` + `POST /mcp/tools/:name` (tera-orchestrator)

### Webhooks

Port `webhooks-controller.ts`. It handles inbound SMS/email and generates replies. Changes:
- **Verify signatures.** Twilio `X-Twilio-Signature`, SendGrid event webhook ECDSA, Slack `X-Slack-Signature`. Check whether the source does this; if it does not, add it — an unauthenticated inbound webhook that writes to `message_history` is a data-integrity hole. Mount webhook routes **before** the body parser where raw bytes are needed for HMAC (the gateway has the same pattern at `packages/gateway/src/index.ts:264,282–291`).
- Join delivery receipts to `messages` via `provider_message_id` (now populated, per P3) instead of best-effort metadata matching.
- Inbound messages create `messages` rows with `direction='inbound'` and update `message_analytics.replied_at`.

### MCP

Port `mcp/` wholesale. Preserve the two behaviors tera-orchestrator depends on:
1. `GET /mcp/tools` reachable **without** gateway headers (mounted pre-auth in `src/index.ts` — established in P1)
2. the tenant-override guard at `mcp/index.ts:70–80`: the header `x-medspa-id`/`x-tenant-id` **overrides** any body-supplied tenant id. That comment documents a real cross-tenant send vulnerability that was fixed; do not regress it.

Tool names must stay `sendEmail`, `sendSMS`, `sendSlackMessage`, `sendUrgentSlackAlert`, `getQueueStatus`, `addNotificationToQueue`, `clearFailedJobs` — `service-mcp-tools.ts:116` lists `sendEmail`/`sendSMS`/`sendSlack` as mutation tools and prefixes them `comm_`. Add new tools (`generateDraft`, `listPendingApprovals`, `approveMessage`) in P12, not here.

### Tests
- `tests/contract/legacy/*.test.ts` — one file per legacy router, asserting status code + response envelope for every endpoint. This suite is the P10 gate.
- `tests/integration/inbox.test.ts` — seeded fixtures; assert query count ≤ 3 per page (use a pg statement counter), assert QUEUED/DECLINED excluded, assert empty result does not throw.
- `tests/unit/api/compat-translation.test.ts` — round-trip `patientId ↔ recipientId` through request and response.
- `tests/unit/webhooks/signature.test.ts` — bad signature ⇒ 401, no DB write.
- `tests/integration/mcp.test.ts` — `GET /mcp/tools` with no headers ⇒ 200 with the 7 tools; `POST /mcp/tools/sendEmail` with a body `medspaId` different from the header ⇒ header wins.

### Exit criteria
All **110** legacy endpoints have a passing contract test (D60 — an earlier draft said 77, which is what the session brief's own grep returns and not what the service registers). `curl` against a locally-running new service with the exact headers the gateway sends produces the same shapes as the source service's code paths. `openapi.yaml` validates.

**One exception, and it is the inbox.** `GET /communications/provider/:providerId/inbox` cannot be compared against the source's code path, because that path is invalid SQL and produces a 500 (D61). Its contract test asserts the shape specified by the unreachable code plus real database behaviour, and `docs/api/BREAKING.md` records that the endpoint changes from always-500 to working.

### Handoff
"Both surfaces live: `/v1` (real) and the legacy 110 (compat shim, every file marked `// DELETE IN P12`). Inbox rewritten from 3+3N SQL statements per page to a flat 2, independent of page size — and note it never worked at all before (D61), so its shape is a specification read out of unreachable code, not a captured baseline.

**Read `docs/api/BREAKING.md` before the cutover.** Three changes need eyes during the parallel run: the inbox goes from always-500 to working, approving a message now sends it (D44), and the two approval inboxes — which show disjoint sets today (D46) — start agreeing.

**Four security tightenings, each a live cross-tenant hole in the source.** The whole `/templates` router had no tenant predicate at all (D66, Seam A, including DELETE); three `/communications` reads had none (D62); every approval mutation had none (D45); and `getProviderInbox`'s `patient_feedback` lookup had none. Watch for 403s and 404s in the parallel run and identify the caller rather than loosening the check.

Webhooks are real now: `/v1/webhooks/{twilio,sendgrid,slack}` are signature-verified and mounted pre-auth **and pre-body-parser** — verification needs the raw bytes. `WEBHOOK_PUBLIC_URL` must be set in every deployed environment or Twilio verification fails on every callback, because Twilio signs the URL it requested (D64). The source's `/messages/webhook/*` was never a provider endpoint; it is ported as the authenticated reply-ingestion API it actually is.

MCP keeps the pre-auth discovery mount, and execution is authenticated **inside** the router rather than by mounting it twice (D65). No tool declares a tenant parameter.

`docs/api/openapi.yaml` covers `/v1` and validates with zero errors; `tests/contract/openapi.test.ts` fails if it drifts from the registered routes. `docs/PACKS.md` documents the pack format against the Zod schema.

Still open: nothing consumes a deferred message's `retryAt` — the runtime returns SUPPRESSED with it and no sweeper acts on it. Asset upload needs a storage adapter, image generation needs an image-capable `LlmProvider`, and the four `/templates/campaigns*` paths answer 501 until campaigns land in P11. Webhook signature verification added. MCP ported with the pre-auth mount and the header-wins-over-body tenant guard intact. Compat hits are counted in `outreach_compat_hits_total` — that metric decides what P12 can delete. Next: P9 data migration."

---

# P9 — Data migration from the mentera-core database

### Session brief
Read: §0.5, §0.6, §0.7 of this file. `services/communication-service/drizzle/migrations/*.sql`. The new repo's `migrations/0001`–`0007`.
**Do not** spend budget inferring ghost-table columns — §0.5 Seam D is closed; they are empty and nothing migrates from them.
Budget: medium. Mostly SQL authoring.

### Goal
A complete, resumable, verifiable migration from the shared `postgres` database to the new `outreach` database. **Written, not run.** Plus a runbook the operator follows.

### Step 1 — Reconnaissance (operator runs, agent writes)

Before anything else, the ghost tables must be confirmed. Write `scripts/inspect-source.sql`:
```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN (
  'communication_preferences','communication_batches','communication_events',
  'message_analytics','notifications','communication_templates','message_history',
  'scheduled_communications','ai_interactions','communication_memories',
  'campaigns','campaign_recipients','patient_feedback',
  'medspa_configurations','provider_configurations',
  -- ghosts:
  'promotions','gift_cards','lead_profiles','treatment_follow_up_rules',
  'outreach_rules','farewell_messages'
) ORDER BY table_name, ordinal_position;

SELECT relname, n_live_tup FROM pg_stat_user_tables
WHERE relname IN (/* same list */) ORDER BY n_live_tup DESC;

-- Approval state distribution — sizes the P9 approvals backfill.
-- BOTH shapes, counted separately (D46). The two implementations store state in
-- different places, so either query alone reports half the queue.
--
-- **Corrected (P9, D73).** Shape A is "has an approvalStatus key", NOT
-- "status = 'QUEUED'": approvals.controller.ts:360 flips the status column to
-- 'APPROVED' as well as the blob, so a QUEUED-only predicate misses every
-- already-decided row. Shape B is then the exact complement, which also catches
-- the rows where `queued_message` is `{}` rather than NULL — the Drizzle model
-- defaults it (schema/db.ts:152) while the migration that added the column does
-- not, so a `queued_message IS NULL` predicate loses them from both passes.
SELECT 'A' AS shape, queued_message->>'approvalStatus' AS s, count(*)
FROM message_history WHERE queued_message->>'approvalStatus' IS NOT NULL
GROUP BY 1, 2
UNION ALL
-- Shape B — ai-enhanced-communication.controller.ts, state in the column:
SELECT 'B', status, count(*)
FROM message_history
WHERE queued_message->>'approvalStatus' IS NULL
  AND status IN ('PENDING_APPROVAL','APPROVED','SCHEDULED','REJECTED','DECLINED')
GROUP BY 1, 2
ORDER BY 1, 2;

-- How many "approved" messages were never actually sent (D44). These are the
-- rows 9009 decides about; the operator needs this number before cutover.
--
-- **Corrected (P9, D74).** An earlier draft added `AND sent_at IS NULL`. That
-- column is NOT NULL in this schema and is written at INSERT time, so the
-- predicate matches nothing and reports 0 — the reassuring answer, for the
-- wrong reason. Approving has never dispatched anything at all, so "approved"
-- and "sent" are unrelated here: every approved row is unsent.
SELECT count(*) FROM message_history
WHERE status = 'APPROVED' OR queued_message->>'approvalStatus' = 'APPROVED';

-- Template overlap between the two owners (Seam A)
SELECT count(*) FROM communication_templates;
SELECT count(*) FROM template_versions;
SELECT count(*) FROM notification_rules
WHERE email_template_id IS NOT NULL OR sms_template_id IS NOT NULL;

-- Recipient cardinality
SELECT count(DISTINCT (medspa_id, patient_id)) FROM message_history;
```
**The plan's assumptions about the ghost tables are unverified. If Step 1 shows a ghost table does not exist, its migration file is skipped and the corresponding pack feature is marked unmigrated in the runbook.**

### Step 2 — Migration scripts (`migrations/9xxx_*.sql`)

Run order, each idempotent and resumable (`ON CONFLICT DO NOTHING`, watermark tables).

> **Renumbered (P9, D70). Numeric order is dependency order.** The order below
> cannot run as first drafted: `messages.event_id` and `messages.notification_id`
> are real foreign keys (0001), so events and notifications must be loaded before
> a single message row can be inserted. As built:
>
> | Built as | Was | Loads |
> |---|---|---|
> | `9000_prelude.sql` | *new* | the `mig` schema: settings, watermarks, quarantine, log, helper functions |
> | `9001_source_link.sql` | `9000_fdw_setup.sql` | FDW server + `src` schema, read-only, plus the source's baseline row counts |
> | `9002` … `9006` | `9001` … `9005` | tenants, channel configs, recipients, templates, preferences — unchanged in content, shifted by one |
> | `9007_events.sql` | 9008 | batches, events, notifications, schedules, ai interactions, memories, campaigns |
> | `9008_messages.sql` | 9006 | messages **and** message_analytics, which hangs off them |
> | `9009_approvals.sql` | 9007 + 9007b | both storage shapes, plus the backlog decision |
> | `9010_verify.sql` | 9010 | unchanged |
>
> **There is still no pack migration at any number.** 9009 is the approvals
> backfill; the struck-through row below stays as the record of why nothing
> migrates from the Seam D ghosts.

| # | File | Content |
|---|---|---|
| 9001 | `tenants.sql` | `INSERT INTO tenants(id,name,...) SELECT DISTINCT medspa_id, ... FROM medspa_configurations` + any `medspa_id` seen in `message_history` but absent from configs |
| 9002 | `channel_configs.sql` | `medspa_configurations` → `tenant_channel_configs`; `provider_configurations` → `agent_channel_configs` (`provider_id`→`sender_id`). **Secrets copy as-is** into the plaintext columns; encryption is P12. |
| 9003 | `recipients.sql` | `SELECT DISTINCT medspa_id, patient_id, latest metadata->>'patientName'` from `message_history` ∪ `communication_preferences` ∪ `campaign_recipients` ∪ `message_analytics` → `recipients` with `external_ref = jsonb_build_object('system','mentera-patient','id',patient_id)`. Deterministic `id` via `uuid_generate_v5` on `(tenant_id, patient_id)` so re-runs are stable and later scripts can compute the FK without a lookup table. |
| 9004 | `templates.sql` | `communication_templates` → `templates`, **preserving `id`**. Then `template_versions` → `template_versions` (also preserving ids). Column union handled: providers-service's `status` and comm-service's `template_type` both land. |
| 9005 | `preferences.sql` | `communication_preferences` → `recipient_preferences`, joined to `recipients` via `(medspa_id, patient_id)`. Rows with `patient_id IS NULL` (there are some — the column is nullable) are dropped with a logged count. `quiet_hours_timezone` defaults to the tenant's `timezone`. |
| 9006 | `messages.sql` | `message_history` → `messages`. **Largest table — batch by `created_at` month with a watermark table `migration_progress(table_name, watermark, rows_done)`.** `patient_id`→`recipient_id` via the v5 uuid, `provider_id`→`sender_id`, `medspa_id`→`tenant_id`, `location_id`→`sub_tenant_id`, `message_direction`→`direction` (lower-cased; **corrected in P9** — the plan pointed at `metadata->>'direction'`, but the source has a NOT NULL `message_direction` COLUMN written 'INBOUND'/'OUTBOUND' at eight call sites, and metadata is only the fallback), `metadata->>'aiGenerated'`→`ai_generated`. `queued_message` is copied verbatim into the retained column. |
| 9007 | `approvals.sql` | **Must read BOTH storage shapes** (D46) — a single `WHERE status='QUEUED' AND queued_message->>...` silently migrates half the pending approvals. **Corrected (P9, D73): both predicates below lose rows and were replaced by a complementary pair.** Shape A is `queued_message->>'approvalStatus' IS NOT NULL` with **no** predicate on the status column, because approvals.controller.ts:360 flips that column to 'APPROVED' too; shape B is its exact complement (`… IS NULL AND status IN (…)`), which also catches the rows holding `{}` rather than NULL. ~~**Shape A** (`approvals.controller.ts`): `status='QUEUED' AND queued_message->>'approvalStatus' IS NOT NULL`~~; `original_content = queued_message->>'content'`. ~~**Shape B** (`ai-enhanced-...controller.ts`): `status IN ('PENDING_APPROVAL','APPROVED','SCHEDULED','REJECTED') AND queued_message IS NULL`~~; `original_content = content`, edits at `metadata->>'originalContent'`. Both map `status` `PENDING_APPROVAL→PENDING_APPROVAL`, `APPROVED→APPROVED`, `DECLINED→DECLINED`, `REJECTED→DECLINED`, `SCHEDULED→SCHEDULED`; both set `approver_type='agent'`, `approver_ref = provider_id`, `policy_id` = the `medspa.provider-always` policy, and `audit_trail = jsonb_build_array(jsonb_build_object('at', created_at, 'from','DRAFT','to',<status>,'actorType','migration'))`. `UNIQUE(message_id)` makes the two passes safe to run in either order and safe to re-run. **Verify against the Step 1 distribution query, which must count both shapes separately** — if the totals do not add up, one shape was missed. |
| 9007b | *decision, not a script — implemented inside `9009_approvals.sql` as `mig.apply_backlog_disposition()`* | **Historic `APPROVED` rows were never sent** (D44). Approving has been a dead end, so the source holds `APPROVED` messages going back to launch that no recipient ever received. Backfilling them as `APPROVED` in the new engine means P6's release path could pick them up and send a year of stale appointment reminders at cutover. **Default: migrate them as `CANCELLED`** with an audit entry naming the reason, and hand the operator the count during Step 1 so the call is made with a number in front of them. Only rows still `PENDING_APPROVAL` are genuinely in flight. |
| 9008 | `events_and_rest.sql` | `communication_events`→`outreach_events`, `notifications`, `message_analytics`, `scheduled_communications`→`scheduled_messages`, `ai_interactions`, `communication_memories`→`recipient_memories`, `communication_batches`→`message_batches`, `campaigns`, `campaign_recipients` |
| ~~9009~~ | ~~`pack_medspa.sql`~~ | **Deleted, not written (P2).** All seven Seam D tables are empty in production and the engine no longer has `pack_medspa_*` tables to migrate into. Step 1's recon is now a guard confirming the counts are still zero, not a discovery step. If a count comes back non-zero at cutover, stop and re-open §0.5 Seam D — do not improvise a target table. |
| 9010 | `verify.sql` | Row-count parity per table, orphan checks (`messages.recipient_id` with no `recipients` row), approval-count parity vs the Step 1 distribution, `templates.id` set equality with the source. Prints a PASS/FAIL table. |

Cross-database mechanics: the source and target are different databases on the **same** RDS instance. Use `postgres_fdw` (preferred — the operator creates the server + user mapping once) or `\copy` to CSV + `\copy` in. Write both paths into the runbook; default to `postgres_fdw`. **As built (D70):** the setup SQL is `migrations/9001_source_link.sql`, the CSV alternative is `scripts/csv-staging.sql`, and both produce the same schema `src` so every later script is transport-agnostic.

### Step 3 — `docs/MIGRATION_RUNBOOK.md`

Must contain, in order: pre-flight checks (disk, connections, a fresh `pg_dump` of the source tables), the exact `psql` invocation for each file with expected duration and row counts from Step 1, the verification queries, the **rollback procedure** (the target DB is new — rollback is `DROP DATABASE outreach` and re-create; the source is untouched by every 9xxx script, and that must be asserted: **no 9xxx file may contain `UPDATE`, `DELETE`, or `INSERT` against the source database**), and the delta-sync procedure for the parallel-run window.

### Step 4 — Delta sync

Between the bulk migration and the P10 cutover, the old service keeps writing. Write `scripts/delta-sync.sql` — re-runs the events, messages and approvals loaders from their watermarks. **As built (D78):** each loader is a procedure taking `p_since`, so the delta calls the same code rather than restating it; a watermark never advances past `now() - watermark_lag_minutes` (a scan under one snapshot otherwise leaves a permanent hole where an in-flight transaction commits behind it); and because `message_history` has no `updated_at`, a trailing window is re-read for status changes an insert-only delta cannot see. The runbook schedules it: bulk load, then delta every hour, then a final delta inside the cutover window with the old service stopped.

### Tests
`tests/integration/migration.test.ts` — testcontainers spins **two** Postgres databases, seeds the source with a fixture resembling the real schema (including a `queued_message` row per approval state and a `patient_id IS NULL` preference row), runs 9000–9010, and asserts `mig.verify()` reports no FAIL. This is the only way to test migrations without touching a real database.

### Exit criteria
`tests/integration/migration.test.ts` green. The runbook is complete enough that the operator does not have to ask a question. **Nothing has been run against a real database.**

### Handoff
"Migration scripts 9000–9010 written and tested against two real databases in one throwaway container, over the same postgres_fdw link production will use. **Renumbered so numeric order is dependency order** (events 9007, messages 9008, approvals 9009) because `messages.event_id`/`notification_id` are real FKs; there is no pack migration at any number (D70). Recipients get deterministic v5 UUIDs from `(tenant_id, patient_id)`, built on pgcrypto rather than uuid-ossp (D72). `templates.id` is preserved — providers-service's `notification_rules` soft references depend on it, and 9010 checks every one of them. Approvals read both storage shapes with complementary predicates; **the plan's two predicates each lost rows** (D73). Naive source timestamps are converted at a declared zone, not the session's (D71). Unattributable rows are quarantined in `mig.rejects`, never guessed (D76). Every 9xxx script is read-only against the source — the foreign server is `updatable 'false'` and the test greps for writes — so rollback is dropping the target DB.

**Three things P10 inherits.** (1) The operator still has to run the Step 1 recon, fill in `mig.settings`, and read the WARNs; running the files is not the whole job — `docs/MIGRATION_RUNBOOK.md` is the sequence. (2) Installing the medspa pack is an API call, not a migration: without it a migrated tenant has messages and no playbooks. (3) `dispatcher.ts:142` writes `messages.channel` lowercase while `message.service.ts:96` uppercases the caller's filter, so `?channel=sms` never matches an engine-written row — a P8 defect surfaced by P9 and worth fixing before cutover (D80). Next: P10 cutover."

---

# P10 — mentera_core cutover & seam resolution

### Session brief
**This is the only phase that modifies `mentera_core`.** Work in `/Users/weevil/projects/elevano/mentera_core` on a fresh branch.
Read: §0.4 and §0.5 of this file. `packages/gateway/src/index.ts:20–40, 100–200, 390–410`. `services/providers-service/src/services/{email.service.ts,integration-settings.service.ts,template.service.ts,notification-rule.service.ts,settings.service.ts:1255–1290}`. `services/providers-service/src/utils/event-service.ts:180–210`. `services/patient-service/src/repositories/patient.repository.ts:140–170`. `services/scheduling-service/src/services/notification.service.ts`.
Budget: large.

### Goal
All traffic served by the new service. The three cross-ownership seams resolved. `services/communication-service` deleted from the monorepo.

### Order of operations — do not reorder

> **Step 5 was moved to the front (amended by P10).** It used to sit after the
> repoint, on the reasoning that the callers keep working through compat and can
> be tidied up later. They do not. Every providers-service → communication
> service call omits the tenant header — `settings.service.ts`'s eight template
> methods send `Content-Type` alone, `integration-settings.service.ts` sends
> nothing at all, and `email.service.ts` sends gateway identity but no tenant —
> and the old service never asked for one, so this has always worked by virtue
> of nothing checking. The engine refuses a request with no tenant. Repoint
> first and auth email, integration settings and the whole template surface
> answer 401 on the first request (D86).

**Step 0 — Fix the callers.** What was Step 5. Land it, deploy providers-service
and patient-service, and confirm they are still green against the *old* service
— the added headers are inert there, which is what makes this safe to do first.
The engine also needs `0010`–`0011` applied and `OUTREACH_PLATFORM_TENANT_ID`
set, because two of the three mail flows have no tenant of their own.

> **Steps 1–3 were rewritten (D99).** They described a staged cutover: deploy
> alongside, repoint staging, watch `outreach_compat_hits_total` for a business
> day, then freeze and repoint production. That shape exists to protect live
> traffic during a parallel run.
>
> **There is no live traffic, no staging environment and no parallel run.** The
> product is in demo phase with no real client. The old service is stopped before
> the migration and never restarts. Everything below is one sitting.
>
> What that removes: the delta sync, the trailing-window refresh, the staged
> repoint, the business-day soak, and the compat-hit measurement — which could
> never have worked here anyway, because a counter only records what was called
> and nothing is calling. Workstream 2 retires the shim **by inspection**
> instead, which is a complete answer rather than a sampled one.

**Step 1 — Deploy the new service, do not route to it.** Stand it up in the same VPC/namespace, health-checked, against an **empty** target database with `0001`–`0012` applied. No data yet: the load happens in the window, once. Verify with direct `curl` using gateway-shaped headers — that is the whole of the pre-repoint verification, and it is enough, because there is no traffic whose behaviour could differ.

**Step 2 — The cutover window.** Runbook §7 is the procedure; this is the shape of it:

1. Scale the old communication-service to 0. Note the time; keep the image.
2. `watermark_lag_minutes = 0`, then run `9002`–`9009` in order.
3. `CALL mig.finalize_cutover();` — cancels everything still in flight, so nothing migrated lands in a provider's inbox looking like outstanding work.
4. `SELECT * FROM mig.verify() WHERE status <> 'PASS';` — no FAIL, `source rows added since the link` must be 0.
5. Encrypt the credentials (runbook §8b). This used to be blocked until the parallel run ended; there isn't one, so it happens here, before anything serves.
6. Install the packs per tenant.

**Step 3 — Repoint and start.** Flip `COMMUNICATION_SERVICE_URL`: one line in each of `docker-compose.yml`, `terraform/main.tf:95`, `infra/lib/mentera-stack.ts:333`, the k8s configmap, and `.env`. Start the new service. Keep the old image available for 48h — with the source database untouched, rolling back is putting the variable back and starting it.

> **Two things to look at first, and the list is short because there are no users.**
>
> **Approvals now dispatch.** Approving flipped two status columns that nothing read back (D44) — the message never went out. `approve()` hands to `dispatcher.dispatch()` now. The historic backlog is cancelled by `finalize_cutover`, so nothing is queued to escape, but the first *new* approval sends for real. Decide `CHANNEL_DRY_RUN` before the window.
>
> **The provider inbox returns 200 for the first time.** Its SQL is invalid and it has answered 500 for its entire life (D61), so the frontend's success path for that screen has never run against data. Most likely place to find a surprise.
>
> **A 403 on an approval endpoint is not a compat bug.** The source has no tenant predicate and no approver check on any approval mutation (D45); the engine enforces both per row. A 403 means a caller was doing something it should never have been able to do — investigate the caller.

**Step 4 — Resolve the seams** (each is an independent PR).

**Seam A — templates.**
- `services/providers-service/src/services/template.service.ts` → HTTP client against `/v1/templates` (or the compat `/templates`). Keep the method signatures so `routes/`/`settings.service.ts` need no change.
- `services/providers-service/src/services/notification-rule.service.ts:146–147` — the `communicationTemplates` join goes away; validate the template id via the HTTP client instead.
- **Migration `mentera-core/M1_drop_template_fks.sql`** (write, do not run):
  ```sql
  ALTER TABLE template_versions   DROP CONSTRAINT IF EXISTS template_versions_template_id_communication_templates_id_fk;
  ALTER TABLE notification_rules  DROP CONSTRAINT IF EXISTS notification_rules_email_template_id_communication_templates_id_fk;
  ALTER TABLE notification_rules  DROP CONSTRAINT IF EXISTS notification_rules_sms_template_id_communication_templates_id_fk;
  -- columns and values retained as soft references; ids match the outreach DB (P9 step 9004)
  ```
  Then drop `communicationTemplates` and `templateVersions` from `providers-service/src/db/schema.ts`. **Do not drop the tables themselves** until 30 days after cutover — keep them as a rollback surface. Add `M3_drop_legacy_comm_tables.sql` as a *deferred, dated* script.

**Seam B — preferences.**
- `patient-service/src/repositories/patient.repository.ts:151–158` — drop the `communicationPreferences` LEFT JOIN. **First verify whether the FE consumes `communicationPreference` from the patient payload.** If yes: add an opt-in `?include=preferences` that calls `GET /v1/recipients/by-external-ref/mentera-patient/:id/preferences`, N+1-safe via a batch endpoint. If no: remove the field and note it in the API changelog.
- Drop `communicationPreferences` from `patient-service/src/db/schema.ts`.

**Seam C — the `patients` reads.** Nothing to do in mentera-core; P5 already removed them from the engine. Verify with `grep -rn "FROM patients" nx-communication-service/src/`.

**Step 5 — Callers.** ~~Each of the five inbound callers keeps working through compat, but clean them up now while the context is fresh~~ — **moved to Step 0**; three of the five do NOT keep working (D86). What remains here is the cleanup that is genuinely optional:
- `providers-service/src/services/email.service.ts:53` — default `http://localhost:3002` is wrong; make it `http://localhost:5007` and drop the `IN_DOCKER` special case (`:56–61`) in favor of a single env var.
- `providers-service/src/utils/event-service.ts:192` — default `http://localhost:5001` points at the **gateway**, and `communication-service-client.ts` posts to `/api/events`. Decide: either keep routing through the gateway (then the compat shim needs no `/api/events` mount) or point it at the service and change the path to `/events`. **Prefer the gateway route** — it is the only caller that gets auth headers for free.
- `providers-service/src/services/settings.service.ts:1266` — same wrong `3002` default.
- `scheduling-service/src/services/notification.service.ts` — verify the endpoints it posts to exist in the compat shim.
- `tera-orchestrator/.../service-mcp-tools.ts:112` — `COMMUNICATION_SERVICE_MCP_URL` repointed; no code change.

**Step 6 — Infra & repo cleanup.** **Land this last** — it deletes the rollback
surface. The `.env` inside the deleted directory is untracked, holds live
credentials, and is the only copy: it is deliberately left in place rather than
removed with the rest.
- Delete `services/communication-service/` entirely.
- Remove from: root `package.json:26` (`dev:communication`), root `drizzle.config.ts:3,6,7`, `scripts/fix-imports.js:27,75`, `docker-compose.yml:113–149` (and the `depends_on` at `:98`), `.github/workflows/deploy.yml:86,138`, `k8s/services/communication-service.yaml`, `terraform/main.tf:223` (**keep** `:95`, the URL other services need), `infra/lib/mentera-stack.ts:215`.
- `observability/prometheus/prometheus.yml:26–28` — repoint the scrape target; note the metric prefix changed `tera_*`/`http_*` → `outreach_*` (P1), so any Grafana panel referencing the old names needs updating.
- `server/index.ts:56–57,236` and `server/routes.ts:48` — update the dev-helper messages.
- `packages/gateway/src/index.ts` — no change beyond the env var; the proxy is already generic. **But** if the gateway is emitting `x-medspa-id` only, that is fine — the new service accepts it (P1). Adding `x-tenant-id` alongside is a P12 nicety.

### Tests
- Run the full `mentera_core` test suite. `packages/tera-orchestrator/tests/service-mcp-tools.test.ts:190` asserts `{name:'communication-service', registered: 0}` — update it if the service name changes in discovery output.
- Smoke the five caller paths end-to-end in staging: auth email send, integration settings read/write, provider event post, FE inbox + approvals, Tera `comm_sendEmail`.

### Exit criteria
`grep -rn "services/communication-service" mentera_core/ --exclude-dir=node_modules` returns nothing. All five callers green in staging. The old service has been scaled to 0 for 48h with no regressions.

### Handoff
"Cutover complete: traffic on the new service, `services/communication-service` deleted, seams A and B resolved (templates moved with ids preserved and FKs dropped to soft references; patient-service's preference JOIN removed). Legacy `communication_templates`/`template_versions`/`communication_preferences` tables **still exist** in the mentera-core DB as a rollback surface — `M3_drop_legacy_comm_tables.sql` is written but dated for +30 days. Prometheus metric prefix changed; Grafana panels need updating. Next: P11 campaigns + the lead-gen pack, which is where the reuse claim gets proven."

---
# P11 — Campaigns, audiences, and the lead-generation pack

### Session brief
Read: `services/lead/lead-message.service.ts` (277L), `models/lead.model.ts`, `routes/lead.routes.ts`, `services/templates/generators/campaign-template-generator.ts` (669L), `services/ai/automated-message-generator.service.ts` (629L), `routes/automated-messages.routes.ts` (305L).
Read the batch path only from `controllers/ai-enhanced-communication.controller.ts`: `batchGenerate` (grep for it).
Budget: large.

### Goal
A generic campaign orchestrator over audiences, and a second shipped pack that proves the engine is industry-blind.

### Audiences

**`src/engine/campaigns/audience.service.ts`**
```ts
create(scope, { name, kind, definition }): Promise<Audience>
materialize(scope, audienceId): Promise<{ count: number }>
addMembers(scope, audienceId, recipients[]): Promise<void>
importCsv(scope, audienceId, stream, mapping): Promise<{ imported, skipped, errors[] }>
```
Three kinds:
- **`static`** — uploaded/added explicitly. This is the lead-gen path: CSV or API, creating `recipients` rows as it goes (`upsertByExternalRef`, so re-import is idempotent).
- **`query`** — `definition` is a bounded predicate over `recipients` + `messages` (same operator vocabulary as `playbook_triggers.match_rules`; no DSL). Re-materialized on demand.
- **`accumulating`** — event-driven; a playbook trigger appends members (e.g. "everyone who fired `LEAD_INITIAL_CONTACT` this week").

CSV import: streamed, batched at 1,000, per-row validation, an `import_errors` report the caller can download. Never load the file into memory — lead lists are large.

### Campaign orchestrator

**`src/engine/campaigns/orchestrator.ts`** — `campaign = playbook + audience + schedule`.

Pipeline, each stage resumable via `message_batches.status` (`DRAFT→QUEUED→PROCESSING→COMPLETED|CANCELLED`, already the source's vocabulary):
1. **Expand** audience → `campaign_recipients` rows, `status='PENDING'`
2. **Generate** per recipient — **through the same `/v1/outreach/generate` path** so the approval policy applies uniformly. This is what replaces the per-patient `for` loop in `ai-enhanced-communication.controller.ts:batchGenerate`. Bounded concurrency (`CAMPAIGN_GENERATE_CONCURRENCY`, default 5) and a per-tenant LLM rate limit.
3. **Approve** — bulk review UI backed by P6's policies; `policy.rights.bulk` decides whether bulk approval is even offered.
4. **Enqueue** — into the existing notification queue with per-tenant rate limits; the compliance gate runs per message, so unsubscribed recipients are `SUPPRESSED` individually rather than failing the batch.
5. **Track** — per-recipient status on `campaign_recipients`, rolled up to `message_batches` counters (`event_count`/`success_count`/`failure_count` — the source's columns).

Controls: pause/resume/cancel; cancel must stop generation *and* drain queued-but-unsent jobs.

**API:** `POST|GET /v1/campaigns`, `GET|PUT /v1/campaigns/:id`, `POST /v1/campaigns/:id/{launch,pause,resume,cancel}`, `GET /v1/campaigns/:id/recipients`, `GET /v1/campaigns/:id/stats`, `POST|GET /v1/audiences`, `POST /v1/audiences/:id/{members,import,materialize}`.

### Analytics

`message_analytics` is already industry-neutral; with `recipient_id` nullable (P2) it just works. Build `GET /v1/analytics/campaigns/:id` — sends, deliveries, opens, clicks, replies, unsubscribes, suppressions by reason, engagement score. Delivery receipts arrive via the P8 webhooks and join on `provider_message_id`.

### The lead-generation pack — `packs/lead-generation/`

The exit criterion for the whole project lives here. Contents:
- **5 playbooks**, re-expressing today's `LEAD_*` event types (`communication.model.ts:52–56`): `lead.initial-contact`, `lead.followup`, `lead.educational`, `lead.promotional`, `lead.reengagement`
- **data contract** — the fields `lead-message.service.ts` reads off `lead_profiles`, now supplied by the caller (name, source, interest, budget band, last touch, …). No `lead_profiles` table; the data is `recipients.attributes` + caller context.
- **approval policy** — `{mode: threshold, confidence_threshold: 0.85, approver: {kind:'role', role:'sales-manager'}, sla: {deadlineMs: 4h, onExpiry: 'escalate'}}`. Ships with `allowAutoApprove` **off**; the tenant must opt in.
- **prompt pack** — sales/nurture persona, explicitly non-healthcare
- **compliance profile** — CAN-SPAM + TCPA only; no HIPAA rules
- **templates** — a 5-message email + SMS nurture sequence
- **no context provider** — inline caller-supplied data only. That is the proof.

**Migration `migrations/0009_campaigns.sql`** — ~~`audiences`, `audience_members`~~ (both created in `0001`; P2 built the whole schema up front, D13), `campaign_recipients.message_id`, `import_errors`. **Numbered 0009, not 0008** — P8b took that for `0008_receipt_integrity.sql` (D69).

**Generation goes through `POST /v1/outreach/trigger`**, not the `/v1/outreach/generate` this section named — that route does not exist. The orchestrator calls `PlaybookRuntime.run()` directly, which is what the route does.

**A campaign targets its playbook through the matcher's `where` predicate** (`campaignPlaybookKey`), not a new field on `OutreachTrigger` — adding one would breach this phase's own exit criterion (D82).

**`cancel` stops generation and cancels the ungenerated; it does NOT drain queued jobs.** The delivery port has no removal, and adding one is a delivery-plane change this phase may not make (D83). **Closed after P10** — `NotificationQueue.remove()` landed with the P12 port work, and cancel now reports `{cancelled, recalled, alreadySending}` (D91).

### The acceptance test

`tests/acceptance/non-medspa-tenant.test.ts` — the milestone, automated:

```
GIVEN a fresh tenant "acme-realty" with industry='real-estate'
  AND only the lead-generation pack installed (medspa pack NOT installed)
  AND its own SendGrid + Twilio credentials in tenant_channel_configs
WHEN  an audience CSV of 50 leads is imported
  AND a campaign on playbook lead.followup is launched
THEN  50 drafts are generated from caller-supplied JSON context only
  AND ZERO HTTP calls are made to any Mentera service   ← assert on a network spy
  AND drafts below confidence 0.85 land in PENDING_APPROVAL for role sales-manager
  AND a sales-manager approval dispatches through Acme's own credentials
       (assert the resolved ChannelCredentials.source and the account sid used)
  AND opens/clicks land in message_analytics
  AND resolving contextRef {kind:'mentera-patient'} THROWS (pack not installed)
  AND the medspa tenant's playbooks/messages are untouched throughout
  AND ZERO files under src/engine/** were modified to make this pass
```

The last assertion is the real one. If any engine file had to change, the abstraction is wrong and the finding goes in `docs/PACKS.md` as a gap.

### Exit criteria
The acceptance test passes, and `git log --stat` for this phase shows changes only under `packs/`, `src/engine/campaigns/`, `src/api/v1/campaigns*`, and tests. No edits to `src/engine/{playbooks,content,approvals,compliance,delivery}` core files.

### Handoff
"Campaign orchestrator built over the existing batch/queue tables; per-recipient generation goes through the same `/v1/outreach/generate` path so approvals apply uniformly. Audiences support static/query/accumulating with streamed CSV import. Lead-gen pack ships as pure data with no context provider. The non-medspa acceptance test passes with zero engine changes — that is the reuse claim, proven. Next: P12 productization."

---

# P12 — Productization

### Session brief
Read: §8 of `communication-service-decoupling-plan.html`. `docs/api/openapi.yaml`. The `outreach_compat_hits_total` metric output from production.
Budget: medium. Parallelizable — the five workstreams below are independent.

### Goal
Ship it as a product: package split, per-tenant pack installation, encrypted credentials, compliance profiles, Tera integration, and the removal of everything marked `// DELETE IN P12`.

### Workstream 1 — Package split — **DEFERRED (D104)**

```
packages/outreach-engine/   ← playbook runtime, approval policy engine, content plane,
                              delivery plane, compliance gate, ports. No industry nouns,
                              no Express. Published as a library.
packages/outreach-server/   ← the deployable service: Express, API, MCP, composition root
packages/outreach-packs/    ← medspa + lead-generation, versioned independently
```
Turborepo or npm workspaces. The engine's public API is its ports plus the four services (`playbooks`, `approvals`, `content`, `delivery`); everything else is internal.

> **Corrected (P12).** That boundary is not the one the code has, and anyone
> sizing this off the paragraph above will be surprised three times:
>
> - **`outreach-engine` is not "ports plus the four services".** The engine reads
>   the database directly — Drizzle, not a repository port — so the imports
>   crossing out of `src/engine/` are `db/`, `platform/`, `ports/`, `domain/` and
>   `packs/`. The library package carries `db/` and `platform/` with it, which
>   makes `pg`, `drizzle-orm`, `ioredis` and `winston` dependencies of the
>   industry-agnostic core. Defensible; just not what this says.
> - **`packs/` and `engine/playbooks/` import each other** — the loader validates
>   against the matcher, the registry loads packs — so there is a cycle to break
>   before either moves.
> - **`adapters/` belongs to neither named package.** In the engine, the library
>   depends on every vendor SDK; in the server, a second consumer rewrites them.
>   It probably wants a fourth package.
>
> **Deferred because nothing needs it yet.** The split's value is letting someone
> else depend on the engine; there is no second consumer, nothing is published,
> and the service is not deployed. D99 unblocked it, which is not the same as
> making it worthwhile. Revisit when a second consumer or a second deployable
> exists — starting from the boundary above, not the one in the box.

### Workstream 2 — Retire the compat layer — **DONE**
Read `outreach_compat_hits_total` for the trailing 30 days. Any legacy path with **zero** hits is deleted. Paths still in use get a dated deprecation notice to the consumer team. Specifically expected to survive longest: `/email/send` (providers-service), `/config/medspa/*`, `/approvals/*` and `/communications/*` (the FE). Retire `ai-enhanced`'s duplicate approval endpoints here — they were kept alive since P6 purely for the FE.
Also here: drop `messages.queued_message` (retained since P9), drop the `x-medspa-id`/`x-location-id` header aliases once the gateway sends `x-tenant-id`/`x-sub-tenant-id`.

> **Corrected (P12).** The counter method could never have worked here — nothing
> is calling, so every label is zero and the procedure would have authorised
> deleting the shim the cutover runs on. Retired by **inspection** instead: 28 of
> 110 endpoints survive, the rest answer `410` naming their successor (D100).
>
> **`messages.queued_message` is done**, and it did not go the way this
> paragraph implies. It is not a later `DROP COLUMN`: the 9xxx load writes the
> column, so a drop could only run after the load, which makes it non-baseline —
> and baseline keeping the column forces the Drizzle model to keep it, which
> `ApprovalService.release()`'s bare `select()` would then emit against a table
> that no longer has it. Since no environment has applied `0001`, the column came
> out of the baseline, the model and `9008`/`9009` instead;
> `0014_drop_queued_message.sql` survives as a no-op cleanup for an old
> development database. The legacy envelope keeps `queuedMessage` and its three
> derived booleans as constants, because the web and mobile apps read them (D103).
>
> **The header aliases are done too** (D106), and the stated blocker was a
> misreading. The gateway *requires* `x-medspa-id` from the apps — its contract
> with its clients, untouched — but what the engine needed was for it to
> **forward** `x-tenant-id`, which is a different line and purely additive. The
> three service clients had sent both spellings since P10; tera-orchestrator now
> does; the engine reads only the generic names. `x-provider-id` stays.

### Workstream 3 — Multi-tenant hardening
- **Encrypt channel credentials.** *(migration `0013`, not `0010` — see the amendments log.)* Populate `credentials_encrypted` (reserved in P2) via KMS or the `shared-libs/utils/encryption.ts` approach; migrate and null the plaintext columns. Migration **`0012_encrypt_credentials.sql`** (P11 took `0009` for `import_errors`; P10 took `0010` for the recipient opt-ins and `0011` for the platform tenant) + a one-shot script. **Not before P10:** `9003_channel_configs.sql` is still inserting plaintext credentials during the parallel run, so nulling those columns first would leave the delta-synced rows unreadable.
- **`AUTH_MODE=apikey`** — finish the stub from P1 against `tenant_api_keys`, with scopes, rotation, and per-key rate limits. This is what lets a vendor use the service without a Mentera gateway.
- **Per-tenant quotas & billing signals** — meter `ai_interactions` (tokens, cost) and delivery counts per tenant; expose `GET /v1/usage`. The pricing model is undecided (Open Question 5) — meter everything now so the decision is not blocked later.
- **Self-serve pack installation** — `POST /v1/tenant-packs` with config validation against the pack manifest.

### Workstream 3b — The rich-media plane (moved here from P11) — **DONE**

> **Corrected (P12).** This section, `docs/api/BREAKING.md` and D84 all held that
> seven endpoints were blocked on "a storage adapter **and** an image-capable
> `LlmProvider`". **Six of the seven were blocked on nothing.** See D92.
>
> `AIService.generateImage` (`ai-service.ts:562-570`) is a method whose entire
> body is `throw new Error('Image generation not supported with current Bedrock
> models')`. `campaign-template-generator.ts:232` and `template-controller.ts:368`
> each catch that throw, log it and continue — so those five endpoints have
> always returned 201 with `imageAssets` absent — and `/ai/multimodal` never
> calls it at all: it asks a **text** model for copy plus image *descriptions*
> (`ai-content-controller.ts:406`).
>
> Three documents agreeing was not evidence. The method body was.

What actually shipped:

- **A storage adapter.** `config.storage` was declared since P0 with no reader.
  `src/ports/storage.ts` with local-filesystem and S3 adapters behind it; keys
  are service-assigned (`<tenantId>/<kind>/<uuid>.<ext>`) and traversal is
  rejected at the port, because the source joined its root with a
  caller-supplied filename and wrote there. Unblocks
  `POST /templates/assets/upload`, and gives `assets` its first writer.
- **The six endpoints that were never image-blocked**, ported onto the existing
  text-only port: `/ai/multimodal`, `/templates/generate-with-images` and the
  four `/templates/campaigns*`. The best-effort image pass is reproduced and
  produces nothing, which is what the source produced.
- **`src/ports/image.ts`, with no adapter.** The one genuinely blocked endpoint
  answers 501 naming the reason — better information and identical capability to
  the source's 500. A deployment with an image model writes one adapter and
  registers it; nothing else moves. Kept separate from `LlmProvider` so every
  existing implementation is not forced to grow a method it cannot honour.
- **Three core prompt packs** — `template-author` (which
  `POST /templates/generate` had defaulted to since P8b without it existing,
  D93), `campaign-author` and `content-multimodal`. The campaign prompt's
  vertical vocabulary moved out of `campaign-template-generator.ts` and into
  pack content, per §0.10.

### Workstream 4 — Compliance profiles
Promote `tenants.compliance_profile` from a column to an enforced ruleset: `hipaa`, `tcpa`, `can-spam`, `gdpr`. Engine-level defaults (CAN-SPAM, TCPA) apply to all; `hipaa` and `gdpr` are add-ons. GDPR brings `POST /v1/recipients/:id/erase` (right to erasure across `messages`, `analytics`, `context`, `memories`) and `GET /v1/recipients/:id/export`. Enable the P5 retention job for real (`RETENTION_DRY_RUN=false`) once the operator signs off per tenant.

### Workstream 5 — Tera ↔ Outreach — **DONE**
Add MCP tools backed by v1: `generateDraft` (→ `/v1/outreach/generate`), `listPendingApprovals`, `approveMessage`, `listConversations`, `createCampaign`. Register them in `mentera_core/packages/tera-orchestrator/.../service-mcp-tools.ts` under the `comm` prefix, adding the mutating ones to `mutationTools`. Tera gains "draft and queue a follow-up for approval" as a first-class capability; Outreach gains Tera as an optional conversational review surface.

All five shipped, on the same `/v1` services the HTTP surface calls. Two things
the paragraph assumed turned out not to hold:

- **`POST /v1/outreach/generate` did not exist.** Generate-then-review lived only
  inside the compat shim, as `draftFor` in `api/compat/generation.ts` — and two
  mounts retired by D100 had been answering `410` naming this very route as their
  successor. A 410 pointing at a 404 is worse than a plain 404. The logic moved
  to `engine/outreach/draft.service.ts` with three callers: the new v1 route, the
  MCP tool, and the shim, which now only translates vocabulary (D101).
- **"Adding the mutating ones to `mutationTools`" was already broken.** The list
  named `sendSlack`, which is not a tool, so both Slack sends — and
  `addNotificationToQueue`, never listed at all — ran with no confirmation. A
  gate name that matches nothing fails open and looks identical to one that
  works. Tools now declare `mutation` beside themselves, `GET /mcp/tools`
  publishes the set, the orchestrator prefers it, and a stale fallback name warns
  (D102). Entries were also added to `shared-libs`' `TOOL_CATALOG`, where a
  missing tool fails closed *silently*.

**Still needs the service deployed to be reachable** — that is P10 Step 1, and it
is the only thing left between this and Tera using it.

### Exit criteria
Packages published (private registry). Compat layer reduced to the measured-in-use set. Credentials encrypted at rest. A second real tenant onboarded end-to-end without an engine code change.

### What P12 actually delivered, and what is still open

**Done:** workstreams 3 (API keys, usage metering, self-serve pack install with
`requiredConfig` validation, credential encryption), 3b (above), 4 (compliance
profiles enforced, GDPR erasure and export), **2** (D100, D103) and **5** (D101,
D102). Plus two items the decision record had left open: the
`campaignPlaybookKey` loader check (D82) and the `AuthorizationProvider`, which
turned out to be a real authorization gap rather than a stub (D98).

**One workstream is not done, and the reason changed twice.** D84 said three were
gated on the cutover; that rested on a premise D99 corrects — it assumed live
traffic and a parallel run, and there is neither. Two of the three then shipped.

| Workstream | Status |
|---|---|
| **1 — package split** | **Deferred by decision, not blocked** (D104). D99 removed the objection (it would rebuild the deploy artifact during a soak that does not exist), and the work still is not worth doing: there is no second consumer, nothing is published, and the service is not deployed. The plan's boundary also does not survive contact — the engine reads the database directly, so the library package carries `db/` and `platform/`; `packs/` and `engine/playbooks/` import each other; `adapters/` fits neither named package. Revisit when a second consumer exists |
| **2 — retire the compat layer** | **Done** (D100, D103, D106). The 30-day `outreach_compat_hits_total` read was never going to work here — a counter records what was called, and nothing is calling. Retired by **inspection** instead: grep the six consumers, keep the 28 endpoints they reach, answer `410` with the successor named everywhere else. Shim down from 4,106 to 2,075 lines. `messages.queued_message` is gone, and so are the `x-medspa-id` / `x-location-id` aliases — the gateway forwards the generic names now. Two exceptions kept without proof of use: the provider and EHR webhook mounts, whose URLs live in third-party dashboards |
| **5 — Tera ↔ Outreach** | **Done** (D101, D102). Five tools on the v1 services, registered under `comm` with FGA catalog entries. Two assumptions in the workstream text did not hold: the route it names as `generateDraft`'s backing did not exist, and the mutation gate it says to add to had been failing open on a tool name that matches nothing. Reachable once the service is deployed, which is P10 Step 1 |

**Every workstream except the package split is now done.** The header aliases
were the last item, and the constraint recorded against them turned out to be a
misreading — the gateway *requires* `x-medspa-id` from its clients, which is not
the same as being unable to *forward* `x-tenant-id`. See D106.

**Operator-gated within what shipped:** `compliance_profile` is `{}` everywhere,
so `hipaa` and `gdpr` are off until a tenant sets them. Two things that *were*
gated no longer are — `0013_encrypt_credentials.sql` moves into the cutover
window (runbook §8b), and the compliance gate's shadow mode was there so a live
system did not silently stop shipping messages, which is not a risk when nothing
ships yet.

---
# PART II — APPENDICES

## Appendix A — Legacy endpoint inventory (110) and v1 mapping

Legacy paths are shown as the **service** sees them (the gateway strips `/api/communication`). FE-facing URLs are `/api/communication` + the path below.

> **Trimmed in P12 (D100).** This inventory is the **source's** 110 endpoints and
> stays accurate as a record of what was ported. The shim now serves **28** of
> them — the set six consumers actually reach — and every other mount answers
> `410 Gone` naming its successor.
>
> **What survives, and who calls it:**
>
> | Mount | Kept | Caller |
> |---|---|---|
> | `/email` | `POST /send` | providers-service auth mail |
> | `/events`, `/api/events` | `POST /` on both | scheduling-service, providers-service |
> | `/config` | `GET|POST|PUT /medspa[/:id]` | providers-service integration settings |
> | `/approvals` | `pending`, `approve`, `decline`, `edit`, `edit-approve` | web + mobile |
> | `/communications` | `provider/:id/inbox`, `conversation/:p/:pt[/read-all]`, `message`, `create-communication`, `generate-message` | web + mobile |
> | `/templates` | `GET|POST /`, `GET|PUT|DELETE /:id`, `POST /:id/render` | providers-service proxy (Seam A) |
> | `/automated-messages` | `POST /generate` | web + mobile |
> | `/messages` | `webhook/sms`, `webhook/email` | **unproven** — Twilio/SendGrid dashboards |
> | `/ehr-webhook` | all 3 | **unproven** — an EHR vendor's own configuration |
>
> **Retired**, answering 410: `/sms`, `/slack`, `/preferences`, `/queue`, `/ai`,
> `/ai-enhanced`, `/leads`, `/treatments`, `/patients`, `/providers`,
> `/promotions`, `/gift-cards`, plus the unreached routes inside the mounts above.
>
> The last two rows are the method's limit, stated rather than glossed: a
> provider callback URL lives in a third party's dashboard, so no grep proves it
> unused. They are kept until someone checks the consoles.

### `/email` — 1
| Legacy | v1 | Caller |
|---|---|---|
| `POST /email/send` | `POST /v1/messages` `{channel:'email', templateKey, variables}` | **providers-service** auth emails |

### `/sms` — 2
`POST /sms/send`, `POST /sms/send-direct` → `POST /v1/messages` `{channel:'sms'}` (the `-direct` variant bypasses the queue → `?sync=true`)

### `/slack` — 2
`POST /slack/message`, `POST /slack/urgent` → `POST /v1/messages` `{channel:'slack', priority}`

### `/events` — 5
`POST /events/legacy`, `POST /events/process`, `POST /events/`, `POST /events/batch`, `GET /events/:eventId/status`
→ `POST /v1/outreach/trigger`, `POST /v1/outreach/trigger/batch`, `GET /v1/outreach/events/:id`
**Also mount `POST /api/events`** — `providers-service/src/services/communication-service-client.ts` posts there.

### `/preferences` — 9
`GET /preferences/:userId` · `POST /preferences/` · `PUT /preferences/:userId` · `POST /preferences/unsubscribe` · `GET /preferences/unsubscribe` · `GET /preferences/:userId/unsubscribe-url` · `GET /preferences/quiet-hours` · `PUT /preferences/quiet-hours` · `POST /preferences/check`
→ `/v1/recipients/:id/preferences`, `/v1/preferences/unsubscribe`, `/v1/preferences/check`

### `/config` — 9
`GET /config/medspa/:medspaId` · `POST /config/medspa` · `PUT /config/medspa/:medspaId` · `GET /config/provider/:providerId/medspa/:medspaId` · `POST /config/provider` · `PUT /config/provider/:providerId/medspa/:medspaId` · `GET /config/medspa/:medspaId/providers` · `GET /config/medspa/:medspaId/phone-numbers` · `POST /config/test-sms`
→ `/v1/channels/configs` (tenant + agent), `/v1/channels/test`
**Caller: providers-service `integration-settings.service.ts`.**

### `/approvals` — 9
`GET /approvals/pending/:providerId` · `GET /approvals/dashboard/:providerId` · `POST /approvals/approve/:messageId` · `POST /approvals/decline/:messageId` · `PUT /approvals/edit/:messageId` · `POST /approvals/edit-approve/:messageId` · `POST /approvals/bulk-action` · `GET /approvals/history/:providerId` · `POST /approvals/schedule/:messageId`
→ `/v1/approvals*` (P6). **FE-critical.**

### `/ai-enhanced` — 6
`POST /ai-enhanced/generate-communication` · `GET /ai-enhanced/pending-approvals/:providerId` · `POST /ai-enhanced/approve/:messageId` · `POST /ai-enhanced/batch-generate` · `GET /ai-enhanced/patient/:patientId/suggested-communications` · `POST /ai-enhanced/analyze-communication-style`
→ `/v1/outreach/generate`, `/v1/approvals`, `/v1/campaigns` (batch), `/v1/recipients/:id/suggestions`
**Overlaps `/approvals` — retired in P12, not before.**

### `/communications` — 16
`GET /communications/medspa/:medspaId` · `GET /communications/provider/:providerId` · `GET /communications/patient/:patientId` · `GET /communications/patient/:patientId/conversation` · `GET /communications/patient/:patientId/conversation/summary` · `GET /communications/:id` · `GET /communications/analytics/medspa/:medspaId` · `POST /communications/response` · `POST /communications/message` · `POST /communications/generate-message` · `GET /communications/provider/:providerId/inbox` · `GET /communications/conversation/:providerId/:patientId` · `GET /communications/patient/:patientId/info` · `PUT /communications/:messageId/read` · `PUT /communications/conversation/:providerId/:patientId/read-all` · `POST /communications/create-communication`
→ `/v1/messages`, `/v1/conversations*`, `/v1/analytics/messages`, `/v1/recipients/:id`
**FE-critical. The inbox endpoint is the highest-risk single handler in the project.**

### `/templates` — 14
`GET /` · `GET /:id` · `POST /` · `PUT /:id` · `DELETE /:id` · `POST /:id/render` · `POST /generate` · `POST /generate-with-images` · `POST /campaigns` · `POST /campaigns/follow-up` · `POST /campaigns/educational` · `POST /campaigns/promotional` · `POST /assets/upload` · `POST /assets/generate-image`
(defined in `controllers/template-controller.ts:79–100`) → `/v1/templates*`, `/v1/assets*`, `/v1/campaigns/generate*`
**Caller: providers-service `settings.service.ts` proxy + Seam A.**

### `/ai` — 8
`POST /ai/generate` · `/enhance` · `/personalize` · `/analyze` · `/multimodal` · `/follow-up` · `/promotional` · `/educational`
(defined in `controllers/ai-content-controller.ts:32–43`) → `/v1/content/generate` with a `mode` discriminator

### `/automated-messages` — 4
`POST /generate` · `POST /bulk-generate` · `POST /trigger-from-event` · `GET /test-context/:patientId/:providerId`
→ `/v1/outreach/generate`, `/v1/campaigns`, `/v1/outreach/trigger`, `/v1/context/preview`

### `/ehr-webhook` — 3
`POST /process-event` · `POST /bulk-process` · `GET /mapping-preview/:ehrEventType`
→ `/v1/outreach/trigger` (with the pack's EHR mapper), `/v1/packs/medspa/ehr-mapping/preview`

### `/messages` (webhooks) — 3
`POST /messages/webhook/sms` · `POST /messages/webhook/email` · `POST /messages/generate-reply`
→ `/v1/webhooks/twilio`, `/v1/webhooks/sendgrid`, `/v1/content/generate` (reply mode)

### `/leads` — 3 · `/treatments` — 1 · `/patients` — 2 · `/providers` — 1 · `/promotions` + `/gift-cards` — 4
`POST|GET /leads/:leadId/profile`, `POST /leads/:leadId/message` → lead-gen pack (P11)
`POST /treatments/:treatmentId/follow-up` → `POST /v1/outreach/trigger` playbook `medspa.treatment-followup`
`POST /patients/:patientId/onboarding`, `POST /patients/:patientId/farewell` → triggers `medspa.onboarding` / `medspa.farewell`
`GET /providers/:providerId/feedback/adverse` → `GET /v1/analytics/feedback?adverse=true`
`POST /promotions/`, `POST /promotions/:promotionId/campaign`, `POST /promotions/create`, `POST /promotions/patients/:patientId/feedback` → medspa pack + `/v1/campaigns`
**`/gift-cards` is mounted to the same router (`routes/index.ts:96`) — keep the alias.**

### `/queue` — 2 · `/health` — 2 · `/mcp` — 3
`GET /queue/stats`, `POST /queue/maintenance` → `/v1/queue/*`
`GET /health`, `GET /health/detailed` → unchanged paths
`GET /mcp/tools`, `POST /mcp/tools/:toolName`, `POST /mcp/bedrock`, `GET /mcp/health` → unchanged paths, **pre-auth mount preserved**. (`/mcp/bedrock` was missing from an earlier draft of this row — it is the fourth endpoint `mcp/index.ts` registers, at `:134`.)

---

## Appendix B — Table ownership after the split

| Table (source) | Target | Owner after P10 | Notes |
|---|---|---|---|
| `message_history` | `messages` (outreach DB) | outreach | largest table; batch-migrate |
| `communication_events` | `outreach_events` | outreach | |
| `notifications` | `notifications` | outreach | already generic |
| `message_analytics` | `message_analytics` | outreach | `patient_id` → nullable `recipient_id` |
| `communication_batches` | `message_batches` | outreach | |
| `scheduled_communications` | `scheduled_messages` | outreach | |
| `ai_interactions` | `ai_interactions` | outreach | + `cost_usd` |
| `communication_memories` | `recipient_memories` | outreach | |
| `campaigns`, `campaign_recipients` | same | outreach | `provider_id` → nullable `sender_id` |
| `medspa_configurations` | `tenant_channel_configs` | outreach | |
| `provider_configurations` | `agent_channel_configs` | outreach | |
| **`communication_templates`** | `templates` | **outreach** (was co-owned) | **Seam A** — ids preserved; providers-service FKs dropped to soft refs |
| **`template_versions`** | `template_versions` | **outreach** (was providers-service) | **Seam A** |
| **`communication_preferences`** | `recipient_preferences` | **outreach** (was co-owned) | **Seam B** — patient-service JOIN removed |
| `notification_rules` | — | **providers-service** (stays) | keeps soft `*_template_id` refs |
| `patients`, `providers`, … | — | patient/providers-service | **Seam C** — outreach must never read these again |
| `patient_feedback` | inbound `messages` + `message_analytics.metadata` | outreach (no table) | empty in production; §0.10 tier 2 |
| `promotions`, `gift_cards` | **not migrated** | the vertical's own service | empty in production; §0.10 tier 3 |
| `lead_profiles` | `recipients.attributes` + `recipient_context` | outreach | **ghost** — folded, not migrated as a table |
| `outreach_rules`, `treatment_follow_up_rules` | `playbooks` rows | outreach | **ghost** — folded |
| `farewell_messages` | `messages` (playbook `medspa.farewell`) | outreach | **ghost** — folded |
| — | `tenants`, `sub_tenants`, `tenant_api_keys` | outreach | new |
| — | `recipients`, `consent_records`, `recipient_context` | outreach | new |
| — | `approvals`, `approval_policies` | outreach | new |
| — | `packs`, `tenant_packs`, `playbooks`, `playbook_triggers`, `playbook_runs` | outreach | new |
| — | `audiences`, `audience_members`, `prompt_packs`, `assets` | outreach | new |

---

## Appendix C — Environment variables

Derived from the 79 distinct `process.env.*` reads in the source `src/` plus the service `.env`. Grouped as they appear in `src/config/index.ts`.

**Required (boot fails without them):** `DATABASE_URL`, `NODE_ENV`, `PORT`

| Group | Vars | Source equivalent |
|---|---|---|
| server | `PORT`(5007) `HOST` `NODE_ENV` `SERVICE_NAME`(outreach-server) | same |
| db | `DATABASE_URL` `PG_POOL_MAX` `PG_POOL_MIN` `PG_IDLE_TIMEOUT` `PG_CONNECTION_TIMEOUT` `DB_SSL` | replaces `DB_HOST/PORT/USER/PASSWORD/NAME` + `USE_LOCAL_DB` + `RDS_RESOURCE_ARN`/`RDS_SECRET_ARN`/`DB_RESOURCE_ARN`/`DB_SECRET_ARN` (**RDS Data API dropped, P1**) |
| redis | `REDIS_URL` `REDIS_HOST` `REDIS_PORT` `REDIS_USERNAME` `REDIS_PASSWORD` `REDIS_KEY_PREFIX`(outreach:) `SKIP_REDIS` | same + new prefix |
| queue | `SKIP_QUEUE` `DISABLE_NOTIFICATION_QUEUE` `EVENT_QUEUE_NAME` `EVENT_PROCESSING_CONCURRENCY` `NOTIFICATION_CONCURRENCY` `MAX_CONCURRENCY` `RETRY_LIMIT` | same |
| auth | `AUTH_MODE`(gateway) `GATEWAY_ONLY`(true) | **new** |
| llm | `LLM_PROVIDER`(bedrock) `AWS_REGION` `AWS_BEDROCK_REGION` `AWS_BEDROCK_MODEL_ID` `AWS_BEDROCK_AGENT_ID` `AWS_BEDROCK_AGENT_ALIAS_ID` `AI_REQUEST_TIMEOUT` `AI_MAX_RETRIES` | same. `TERA_BEDROCK_*` and `PROVIDER_BEDROCK_*` are **not** carried over |
| channels.sendgrid | `SENDGRID_API_KEY` `DEFAULT_EMAIL_SENDER` `SENDGRID_FROM_NAME` | same |
| channels.smtp | `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_SECURE` `SMTP_SERVICE` `SMTP_AUTH_TYPE` `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `GOOGLE_REFRESH_TOKEN` `GOOGLE_USER` | same |
| channels.twilio | `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` `TWILIO_PHONE_NUMBER` | same |
| channels.slack | `SLACK_BOT_TOKEN` `SLACK_DEFAULT_CHANNEL` | same |
| channels.push | `FCM_API_KEY` `APNS_KEY_ID` `APNS_TEAM_ID` `APNS_KEY_FILE` | same |
| channels | `CHANNEL_DRY_RUN` | **new** — replaces the implicit `NODE_ENV !== 'production'` checks in twilio/sendgrid |
| context | `PATIENT_SERVICE_URL` `PROVIDER_SERVICE_URL` `CONTEXT_CACHE_TTL_S` | **only read by `adapters/context/mentera.provider.ts`** |
| storage | `S3_MEMORY_BUCKET` `USE_LOCAL_STORAGE` `LOCAL_STORAGE_PATH` `TEMPLATES_PATH` `ASSETS_PATH` `IMAGE_STORAGE_PATH` | same |
| compliance | `UNSUBSCRIBE_BASE_URL` `DEFAULT_TIMEZONE` `ENFORCE_QUIET_HOURS` `RETENTION_DRY_RUN`(true) `COMPLIANCE_SHADOW_MODE`(true) | replaces `SERVICE_DOMAIN`/`SITE_URL`; shadow mode is **new** and defaults on |
| observability | `LOG_LEVEL` `LOG_DIR` | same |
| campaigns | `CAMPAIGN_GENERATE_CONCURRENCY`(5) | **new** |

**Dropped:** `USE_LOCAL_DB`, `DB_RESOURCE_ARN`, `DB_SECRET_ARN`, `RDS_*` (RDS Data API path removed), `HEALTH_MONITOR_URL`/`USE_HEALTH_MONITOR` (Mentera-internal), `IN_DOCKER` (behavior moved to explicit URLs), `MCP_*` (the source `.env.example` declares 8 `MCP_*` vars; check whether `mcp/server.ts` actually reads them before carrying any over — most appear unused).

---

## Appendix D — shared-libs vendoring manifest

| Source file | LOC | → Target | Disposition |
|---|---|---|---|
| `utils/db-client.ts` | 620 | `src/platform/db/client.ts` | **Heavy edit.** Drop RDS Data API branch, drop `global.__dbConnectionPool`, keep pool config + shutdown + `batchQuery`. Expect ~250 LOC out. |
| `utils/tenant-scope.ts` | 35 | `src/platform/db/tenant-scope.ts` | Rename `medspaId`→`tenantId`, `locationId`→`subTenantId`. Semantics unchanged. |
| `utils/redis-cache.ts` | 396 | `src/platform/redis/cache.ts` | Near-verbatim. Add `REDIS_KEY_PREFIX`. |
| `utils/redis-client.ts` | 383 | `src/platform/redis/client.ts` | Near-verbatim. |
| `observability/logger.ts` | 92 | `src/platform/observability/logger.ts` | Verbatim; service name from config. |
| `observability/metrics.ts` | 75 | `src/platform/observability/metrics.ts` | Verbatim; metric prefix `outreach_`. |
| `observability/middleware.ts` | 137 | `src/platform/observability/middleware.ts` | Verbatim. |
| `observability/context.ts` | 51 | `src/platform/observability/context.ts` | Verbatim. |
| `middleware/auth.middleware.ts` | 257 | `src/platform/http/auth.middleware.ts` | **Heavy edit.** Generalize headers, add `AUTH_MODE`, replace the Mentera `Permission` enum. |
| `utils/encryption.ts` | 73 | `src/platform/crypto/encryption.ts` | Copy now, wire in P12. |
| `utils/audit.ts` | 82 | — | **Skip.** The `approvals.audit_trail` + `ai_interactions` cover the need. |
| `utils/authorization-client.ts` | 898 | — | **Skip.** Mentera authorization service. If role-based approvers need it in P12, add an `AuthorizationProvider` port instead. |
| `utils/analytics-*.ts`, `tool-permissions.ts`, `db-adapter.ts`, `redis-adapter.ts`, `pathUtils.ts`, `check-ports.ts`, `logging.ts` | — | — | **Skip.** Unused by communication-service. |
| `middleware/{tenant,location,rate-limit,https-redirect}.middleware.ts` | 320 | selective | `rate-limit` → `src/platform/http/rate-limit.ts` (used for the unsubscribe + webhook endpoints). `tenant`/`location` are folded into the new auth middleware. `https-redirect` skipped (edge concern). |
| `domain-models/*` | — | — | **Skip entirely.** These are Mentera domain types (patient, appointment, treatment, medspa, staff). The engine must not know them. |

Also vendored from the service itself: `src/utils/logger.ts` (13L wrapper), `src/utils/queue-config.ts`, `src/db/client.ts` — all collapse into the platform layer.

**Test files worth porting:** `shared-libs/tests/tenant-scope.test.ts`, `encryption.test.ts`.

---

## Appendix E — File-by-file port map

`services/communication-service/src/` → new repo. 123 files.

| Source | → | Phase |
|---|---|---|
| `index.ts` | `src/index.ts` (composition root) | P1 |
| `config/index.ts`, `config/database.ts` | `src/config/index.ts` | P1 |
| `db/client.ts`, `utils/shared-db.ts`, `utils/db-adapter.ts`, `helpers/postgres-helper.ts` | `src/platform/db/` | P1 |
| `utils/logger.ts`, `utils/queue-config.ts` | `src/platform/{observability,redis}/` | P1 |
| `middleware/auth.middleware.ts` | `src/platform/http/auth.middleware.ts` | P1 |
| `adapters/redis.adapter.ts` | `src/platform/redis/` | P1 |
| `schema/db.ts` | `src/db/schema/*.ts` | P2 |
| `schema/database.ts` | **deleted** (duplicate connection path) | P2 |
| `services/queue/notification-queue.ts` | `src/engine/delivery/{queue,dispatcher}.ts` | P3 |
| `services/queue/event-processing-queue.ts`, `default-event-processor.ts` | `src/engine/delivery/event-queue.ts` | P3 / P7 |
| `services/email/{sendgrid,nodemailer}.ts` | `src/adapters/channels/{sendgrid,smtp}.channel.ts` | P3 |
| `services/sms/twilio.ts` | `src/adapters/channels/twilio.channel.ts` | P3 |
| `services/slack/slack.service.ts` | `src/adapters/channels/slack.channel.ts` + pack helpers | P3 |
| `services/notification/{push,webhook,in-app}-notification.ts` | `src/adapters/channels/*.channel.ts` | P3 |
| `services/notification/{email,sms,slack}-notification.ts` | **deleted** (thin wrappers superseded by the port) | P3 |
| `services/config/{medspa,provider}-config.service.ts` | `src/engine/delivery/channel-config.service.ts` | P3 |
| `services/ai/ai-service.ts` | `src/adapters/llm/bedrock.provider.ts` | P4 |
| `services/ai/bedrock-agent-client.ts` | `src/adapters/llm/bedrock-agent.ts` | P4 |
| `services/templates/template-engine.ts` | `src/engine/content/{renderer,store,ai-generation,assets}.ts` | P4 |
| `services/ai/ai-message-generator.ts` | `src/engine/content/generator.ts` + `packs/medspa/prompts/` | P4 |
| `services/ai/ai-summary.service.ts` | `src/engine/content/summarizer.ts` | P4 |
| `controllers/template-controller.ts`, `ai-content-controller.ts` | `src/api/v1/{templates,content}.router.ts` | P4/P8 |
| `services/data/context-fetcher.service.ts` | `src/adapters/context/mentera.provider.ts` | P5 |
| `services/preference/preference.service.ts`, `models/preferences.model.ts` | `src/engine/compliance/preference.service.ts` | P5 |
| `controllers/preference.controller.ts` | `src/api/v1/preferences.router.ts` | P5/P8 |
| `services/memory/memory-service.ts` | `src/engine/recipients/memory.service.ts` (DB-backed, not `Map`) | P5 |
| `services/persona/persona-service.ts` | `packs/*/personas` + `src/engine/content/persona.ts` (DB-backed) | P5 |
| `controllers/approvals.controller.ts` | `src/engine/approvals/*` + `src/api/v1/approvals.router.ts` | P6 |
| `controllers/ai-enhanced-communication.controller.ts` | split: approvals→P6, generate→P4, batch→P11, compat→P8 | P6/P8 |
| `events/enhanced-event-handler.ts` | **deleted** → `packs/medspa/playbooks/*.json` | P7 |
| `events/event-handler.ts`, `event-subscriber.ts` | `src/engine/playbooks/runtime.ts` | P7 |
| `services/event-mapper.service.ts` | `src/engine/playbooks/ehr-mapper.ts` + `packs/medspa/ehr-mapping.json` | P7 |
| `models/communication.model.ts` | `src/domain/*.ts` (channels, priorities) + `packs/medspa/event-types.json` | P7 |
| `services/{onboarding,treatment,farewell,promotion,feedback}/*` | `packs/medspa/playbooks/*` + `src/engine/…` where generic | P7 |
| `models/{onboarding,treatment-followup,farewell,promotion,feedback}.model.ts` | pack data contracts | P7 |
| `controllers/communications.controller.ts` (2,571L) | `src/engine/messaging/{message,conversation,analytics}.service.ts` + `src/api/v1/*` | P8 |
| `controllers/webhooks-controller.ts` | `src/api/v1/webhooks.router.ts` | P8 |
| `controllers/{email,slack,event}.controller.ts` | folded into v1 routers | P8 |
| `routes/*.routes.ts` (24) | `src/api/compat/*.ts` + `src/api/v1/*.ts` | P8 |
| `mcp/**` | `src/mcp/**` | P8 |
| `services/lead/lead-message.service.ts`, `models/lead.model.ts` | `packs/lead-generation/` | P11 |
| `services/templates/generators/campaign-template-generator.ts` | `src/engine/campaigns/template-generator.ts` | P11 |
| `services/ai/automated-message-generator.service.ts` | `src/engine/campaigns/orchestrator.ts` | P11 |
| `types/*.d.ts` (15 files) | **deleted** — these exist because the source runs `strict: false` with ambient module declarations. Real types replace them. | P0–P8 |
| `utils/{api-discovery,module-fix,migrate-templates}.ts` | **deleted** | — |
| `scripts/fix-imports.cjs`, `scripts/build.js` | **deleted** (no path aliases ⇒ not needed) | P0 |

---

## Appendix F — Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ~~**Ghost tables don't exist / have different columns**~~ | ~~high~~ **closed** | — | **Retired (P2).** Verified 2026-08-04: all seven are empty and tenant-less, and none is migrated. P9 Step 1 keeps the recon query as a zero-count guard. |
| **A vertical-specific table creeps back into the engine** | medium | medium | §0.10 decides where a vertical's data goes. Run `grep -ri medspa src/db/ migrations/` at the end of every phase that adds tables. |
| ~~**Inbox rewrite changes FE-visible shape**~~ | ~~medium~~ **closed** | — | **Retired (P8).** The handler is invalid SQL and has always returned 500, so there is no shape to change (D61). Replaced by the row below. |
| **The inbox starts working, and the FE's success path has never run** | certain (intentional) | medium | Shape built from the unreachable code at `:1321–1377` and pinned by `tests/contract/legacy/endpoints.test.ts`. FE sign-off on a populated render before P10 Step 3. |
| **Messages sitting at `APPROVED` were never sent, and approval now sends** | certain (intentional) | high | D44. `CHANNEL_DRY_RUN` on and the gate in shadow until an operator flips them; P9 decides whether the historic backlog sends, cancels or is ignored. |
| **`patient_id NOT NULL` data has nulls anyway** | low | medium | P9 `verify.sql` counts nulls; the target columns are nullable so nothing blocks. |
| **Approval backfill loses in-flight items** | medium | high | `queued_message` retained on `messages` until P12; approvals idempotent on `message_id`; delta-sync re-runs 9007; the source DB is never written. |
| **Seam A: a template id is referenced but not migrated** | medium | high | 9004 preserves ids and `verify.sql` asserts set equality. `notification_rules` soft refs are validated by a query in the runbook before dropping FKs. |
| **BullMQ v4→v5 behavior change** | medium | medium | P3 queue integration test asserts retry counts and backoff explicitly, not by inspection. |
| **Prompt drift changes message tone** | medium | medium | P4 golden-file test on the assembled prompt. Model ids preserved from the source `.env`. |
| **`aiConfidence` is heuristic, threshold mode misfires** | high (if enabled) | high | Threshold mode ships hard-disabled behind a per-tenant flag; documented as heuristic; sampled QA required before enabling. |
| **Compliance gate suppresses messages that used to send** | medium | high | `COMPLIANCE_SHADOW_MODE=true` by default (P5): evaluate, log `outreach_would_suppress_total{reason}`, still send. Flip per tenant after a week of clean telemetry. |
| **Staff/system playbooks moved off approval** | certain (intentional) | medium | Called out in P7 as the one deliberate behavior change; requires operator confirmation before seeding. |
| **Two DBs drift during the parallel run** | medium | high | Delta-sync hourly; the final delta runs with the old service at 0 replicas; the window is minutes, not days. |
| **Playbook `where` matching grows into a DSL** | medium | medium | Bounded operator set is specified in P7 and asserted by a test that rejects unknown operators. |
| **Vendored platform code drifts from shared-libs** | certain | low | Accepted. Record the source commit SHA in `src/platform/VENDORED.md` per file. |
| **Context window blowout in P8** | high | low | P8 explicitly splittable into P8a/P8b; the "grep, don't read" instruction for `communications.controller.ts` is load-bearing. |

---

## Appendix G — Open questions

Answer before the phase in parentheses; none block starting.

1. **(before P5)** Does the FE consume `communicationPreference` from the patient-service payload? Determines whether Seam B needs an HTTP fallback or a straight removal.
2. **(before P7)** Confirm the staff/system playbooks (`staff-alert`, `shift-reminder`, `emergency-notification`, `system-alert`) should bypass approval. This is the only intentional behavior change in the medspa pack.
3. **(before P7)** `tenant_packs.config.emergencyContacts` — who are the real recipients that `emergency-team@medspa.com` was standing in for?
4. **(before P9)** Is there a maintenance window available for the cutover, and how long? Determines whether delta-sync needs to be sub-minute.
5. **(before P12)** Recipient ownership: does the engine own a full recipient store (CRM-lite) or stay a projection with contact info only? Currently built as a **projection with `external_ref`** — full ownership is additive.
6. **(before P12)** Approval UX: keep approvals inside each vendor's app via API, or ship a hosted review inbox?
7. **(before P12)** Is threshold-mode auto-approval ever acceptable for the medspa tenant (routine reminders), or is `always` a hard clinical requirement?
8. **(before P12)** Which channel matters next for reuse — WhatsApp (Twilio), voice, or LinkedIn for lead-gen?
9. **(before P12)** Pricing boundary: per-tenant flat, per-message, or per-AI-generation? Shapes how aggressively `ai_interactions` and delivery counts are metered.

---

## Appendix H — What NOT to do

- **Don't rewrite the queue, template, or retry machinery.** It is the good part. Only the vocabulary above it is coupled.
- **Don't add a new use case as more enum values.** That is how `LEAD_*` ended up hardcoded. Every new vertical arrives as a pack.
- **Don't weaken approvals while generalizing them.** `{always, agent}` ships first and is byte-compatible with today.
- **Don't build a second LLM abstraction.** One `LlmProvider` port, one Bedrock adapter.
- **Don't let playbook `where` become an expression language.** Bounded operators; anything more becomes a registered provider in code.
- **Don't run a migration.** Ever. Write it, print the command, stop.
- **Don't read `communications.controller.ts` top to bottom.** Grep for the handler you need.

