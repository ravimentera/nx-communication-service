# Manual test plan

For validating the extracted outreach engine from a cold start, with **no
third-party credentials**.

Everything below is runnable on a laptop with Docker. Where something genuinely
cannot be tested without a vendor account, it says so, says what you *can*
establish instead, and says exactly what you would see with the key.

**Time:** about 90 minutes for Parts 0–6. Parts 7–9 are deeper and can be done
separately.

---

## How to read this

Each test has a **⊳ do**, an **✓ expect**, and — where it matters — a **why**.
The *why* is the point. Roughly forty behaviours in this service deliberately
differ from the service it replaced, and a tester who does not know which is
which will file the intended ones as bugs and miss the real ones.

Statuses to internalise before you start:

| You see | It means |
|---|---|
| `200` with `queued: false` | **Not a failure.** The gate decided not to send. The reason is in the body. |
| `403` | You did not come through the gateway, or you lack the permission. |
| `404` on something that exists | Almost always a **tenancy** boundary doing its job. |
| `410` | A retired legacy mount. The body names the successor. |
| `501` | One endpoint only (`/v1/assets/generate`). Documented, expected. |
| `500` | A finding. Report it — there are no known ones left (D109). |

---

## Part 0 · Bring the stack up

### 0.1 Containers

⊳ `docker compose up -d postgres redis`

✓ Both healthy. Postgres on **5433**, Redis on **6380** — shifted deliberately so
they cannot collide with a local Mentera Postgres.

### 0.2 Migrations

**Nothing in this repo applies a migration for you** — not drizzle-kit, not the
scripts, not an agent. That is hard rule 1 of the extraction plan. The tooling
only prints.

⊳ `npm run migrate:print`

⊳ Apply `0001`–`0021`, **skipping `0013` and `0014`**:

```bash
for f in 0001_core_schema 0002_approvals 0003_playbooks 0005_compliance \
         0006_approval_policies 0007_playbook_runs 0008_receipt_integrity \
         0009_campaigns 0010_recipient_optins 0011_platform_tenant \
         0012_deferred_messages 0015_consent 0016_playbook_context_mapping \
         0017_receipt_idempotency 0018_playbook_run_reservation \
         0019_campaign_recipient_uniqueness 0020_webhook_credentials \
         0021_twilio_account_uniqueness; do
  docker compose exec -T postgres psql -U outreach -d outreach \
    -v ON_ERROR_STOP=1 -q -f "/migrations/${f}.sql" && echo "$f OK"
done
```

✓ 18 × OK. **33 tables.**

**Why 0013 and 0014 are excluded from the loop — and why that is not the same
reason twice.**

`0013` retires the plaintext credential columns. Applying it before the data
load seals credentials that do not exist yet and **every send then fails**.
Leave it alone locally.

`0014` is the opposite: every statement is `IF EXISTS`, it is safe at any time,
and it is **required** if your database was created before P12. Re-running the
baseline cannot do its job — `0001` is `CREATE TABLE IF NOT EXISTS`, so a column
removed by *editing* `0001` never leaves a database that already exists. Step
0.4 is how you find out; `npm run migrate:print` now prints the check.

### 0.3 Migrations are idempotent — verify, don't assume

⊳ Run the loop from 0.2 **again**.

✓ 18 × OK again, no errors. Every file is `IF NOT EXISTS` / `IF EXISTS` and
wrapped in a transaction. Re-applying the whole set after a later phase adds a
file is the *intended* workflow.

### 0.4 Prove the schema matches a clean build

This is the test that earns its keep. `IF NOT EXISTS` means re-running `0001`
does **not** apply a change made by editing `0001` — so an older database and a
fresh deploy can differ silently.

⊳ Build a throwaway database beside yours and diff them:

```bash
docker compose exec -T postgres psql -U outreach -d postgres \
  -c "CREATE DATABASE outreach_verify OWNER outreach;"
# apply the same 18 files to outreach_verify, then compare column/index/constraint sets
```

✓ Identical. **753 schema objects** compared here.

If `messages.queued_message` shows up in yours and not the clean one, your
volume predates P12 — apply `0014` once. See D109 in `docs/DECISIONS.md`.

⊳ Clean up: `DROP DATABASE outreach_verify;`

### 0.5 Configuration

⊳ `cp .env.example .env`, then set **`LLM_PROVIDER=stub`**.

✓ Leave `CHANNEL_DRY_RUN=true`. Adapters log instead of dialling out, so the
whole resolve → render → gate → dispatch path runs and only the final wire call
is skipped.

### 0.6 Boot

⊳ `npm run dev`, then `curl -s localhost:5007/health/detailed | jq`

✓ `database: up`, `redis: up`, `queues: up`, `packs.loaded: [core, lead-generation, medspa]`.

⊳ `curl -s localhost:5007/v1/packs -H 'x-gateway-request: true' -H 'x-tenant-id: t-alpha' -H 'x-user-id: d' -H 'x-user-role: admin'`

✓ **`errors: []`.** A malformed pack file does not stop the process — it costs
that playbook and reports itself here. An empty array is the goal; anything in
it names the file and the field path.

### 0.7 Fixtures

⊳ Seed, install packs, bootstrap:

```bash
docker compose exec -T postgres psql -U outreach -d outreach -v ON_ERROR_STOP=1 -f /testing/seed-local.sql
./testing/seed-packs.sh
node testing/bootstrap.mjs
```

✓ 3 tenants, 7 recipients, 7 pack installs, ~11 fixtures.

⊳ Build the collection, then import **both** files into Postman and select the
environment:

```bash
node testing/build-postman.mjs
```

Both Postman files are **generated and gitignored**, so a fresh clone has
neither — `build-postman.mjs` writes the collection from `openapi.yaml`, and
`bootstrap.mjs` (above) writes the environment. Regenerate rather than hunting
for a committed copy.

---

## Part 1 · The boundary (do this first)

If anything here is wrong, stop and report it. A broken tenancy boundary makes
every later result meaningless.

### 1.1 The gateway gate

⊳ `curl -s -o /dev/null -w '%{http_code}\n' localhost:5007/v1/messages`

✓ **403.** `GATEWAY_ONLY=true` rejects anything that did not arrive through the
gateway.

### 1.2 `x-medspa-id` is no longer read

⊳ Send `x-gateway-request: true` and **only** `x-medspa-id: t-alpha`.

✓ **4xx.**

**Why.** This is the one caller-visible protocol change in the whole extraction,
and the last place a vertical noun appeared in something every caller has to
speak. The alias was accepted throughout the extraction and dropped in P12 — a
request carrying only this spelling now has *no tenant* and fails, rather than
being served against an empty string. Tolerating it is how a header alias
survives forever. The gateway forwards both spellings, so only a direct caller
notices.

⊳ Now the same with `x-tenant-id`. ✓ **200.**

### 1.3 Cross-tenant read

⊳ `GET /v1/recipients/11111111-0000-4000-8000-00000000aaa1` with `x-tenant-id: t-beta`.

✓ **404** — not 403, and not a row.

⊳ Same id with `x-tenant-id: t-alpha`. ✓ **200**, Ada Lovelace.

### 1.4 Seam A — the templates router

The single most consequential tightening in the extraction.
`template-engine.ts` in the old service contains **zero** occurrences of
`medspaId` or `tenantId`. All fourteen endpoints operated on any template by id,
from any tenant — **including `PUT` and `DELETE`**, and a cross-tenant delete
cascaded into `template_versions`.

⊳ Create a template as `t-alpha`. Note its id.
⊳ `GET /v1/templates/<id>` as `t-beta`. ✓ **404.**
⊳ `PUT /v1/templates/<id>` as `t-beta`. ✓ **404.**
⊳ `DELETE /v1/templates/<id>` as `t-beta`. ✓ refused.
⊳ `GET /v1/templates` as `t-beta`. ✓ alpha's template **absent** from the list.
⊳ `GET /v1/templates/<id>` as `t-alpha`. ✓ **200**, still there.

### 1.5 Cross-tenant config read

⊳ `GET /config/medspa/t-alpha` with `x-tenant-id: t-beta`, `x-user-role: super_admin`.

✓ **403.** A `super_admin` could read any tenant's config in the source.

### 1.6 Pack isolation

⊳ `GET /v1/playbooks` for each tenant.

✓ `t-alpha` ~30, `t-beta` ~30, **`t-gdpr` 0**. `t-gdpr` has only `core`
installed, and `core` ships prompts rather than playbooks.

**Why it matters.** `contextProviders` is a security boundary, not a lookup
table: a provider can reach an external service using the *engine's* credentials,
so providers are registered against a pack id and resolution takes the tenant's
installed packs. A tenant without the pack gets **403, not 404** — it asked for
something real that it is not entitled to.

### 1.7 Metrics are not open

⊳ `curl -s -o /dev/null -w '%{http_code}\n' localhost:5007/metrics`

✓ **200** from loopback.

**Why the allow-list is by source address and not by auth.** Eight metric
families carry a `tenant` label, so one unauthenticated GET would return the
tenant roster along with each one's send volume and model spend. From a
non-allowed address it answers **404, not 403** — whether this deployment
exposes metrics at all is not something an unauthorized caller needs confirmed.

---

## Part 2 · Sending

### 2.1 The happy path

⊳ `POST /v1/messages`:

```json
{ "channel": "email",
  "to": { "type": "email", "value": "ada@example.com" },
  "recipientId": "11111111-0000-4000-8000-00000000aaa1",
  "senderId": "sender-1",
  "subject": "Test", "body": "Hello Ada.", "transactional": true }
```

✓ **202** with `queued: true`, a `messageId` and a `jobId`.

⊳ Watch the server log. ✓ A dry-run line, **not** a SendGrid call.

⊳ `GET /v1/messages/<messageId>`. ✓ the row, status progressing to `SENT`.

### 2.2 Contact-point types — the trap

The channel is `sms`; the contact point type is **`phone`**. Every call site maps
between them explicitly.

⊳ `POST /v1/messages` with `"to": {"type":"sms", ...}`.
✓ Refused. Use `phone`.

### 2.3 No contact point for the channel

⊳ Send `sms` to `recipientEmailOnly` (Grace, email only).

✓ Refused because there is **no phone contact point** — not a provider error.
The distinction matters: one is a data problem, the other is an outage.

### 2.4 An unsubscribed recipient

⊳ Send anything to `recipientUnsubscribed` (Alan).

✓ **200 with `queued: false`** and a reason. Not a 4xx — the caller asked
correctly and the engine decided not to send.

⊳ Check `messages` for a `SUPPRESSED` row.

✓ Present. **Nothing is ever dropped silently.** Every block and defer is
returned with a reason, counted in Prometheus, and written as a row.

### 2.5 Quiet hours defer; they do not block

⊳ Send a **marketing** (non-transactional) SMS to `recipientQuietHours` (Kiyoshi,
Asia/Tokyo, quiet 22:00–08:00 local).

✓ If it is quiet hours in **Tokyo**, `queued: false`, `deferrable: true`, and a
`retryAt`.

**Why this is the interesting one.** A block means never; a defer means not yet.
Getting it wrong either way is expensive — blocking a deferrable message loses it
silently, deferring a blockable one keeps retrying something the recipient asked
you to stop. Quiet hours and rate limits *defer*; everything else *blocks*.

The window is evaluated in the **recipient's** timezone, not the server's. A 9am
reminder reading as 2pm because the pod runs in UTC is the class of defect this
exists to prevent.

⊳ Now send the same message with `transactional: true`.

✓ Goes out. Verification, invitation and password-reset mail must not be held by
a quiet-hours window.

### 2.6 Shadow mode — know which one you are in

⊳ Check `COMPLIANCE_SHADOW_MODE` in `.env` (default **true**).

In shadow mode every check runs, records what it *would* have done, and **still
allows the send**. So 2.4 and 2.5 may report the reason and send anyway.

⊳ To see real suppression, set `COMPLIANCE_SHADOW_MODE=false` and restart.

**Why the default is shadow.** The old service's preference engine is an
in-memory Map that is empty after every restart, so its effective gate passed
everything. Switching on a durable gate is the single change most likely to
silently stop messages that currently ship. (Note: the open items record that
this reasoning does not apply while nothing ships, so it can be enforced from day
one at cutover — an operator decision.)

### 2.7 Scheduled send

⊳ `POST /v1/messages` with `sendAt` a few minutes ahead.

✓ Accepted; becomes a **delayed BullMQ job** that survives a restart. In the
source, `scheduledFor` was a string no scheduler ever consumed.

⊳ Restart the service. ✓ The job is still pending.

---

## Part 3 · Approvals

The highest-impact behaviour change in the whole cutover lives here.

### 3.1 Generate a draft

⊳ `POST /v1/outreach/generate` with a `recipientId`, `channel`,
`promptPackKey: "core.content-generate"` and an `x-sender-id` header.

✓ **201** with `approvalId`, `messageId`, `status: PENDING_APPROVAL`,
`aiConfidence`, `lintWarnings`. Content is prefixed **`[stub-llm]`**.

**It does not send.** The draft waits for a person unless the caller names a
`none`-mode policy.

⊳ Omit `x-sender-id`. ✓ A **400 naming the reason**: the policy resolves the
approver to the sender, the message has no sender, and the policy declares no
fallback. That error is the mechanism working.

### 3.2 `aiConfidence` is a heuristic — treat it as one

✓ It is a deterministic composite of context completeness minus a penalty per
lint warning. It is **not** the model's self-assessment.

`threshold`-mode auto-approval consumes it, and ships refusing to fire without
`tenant_packs.config.allowAutoApprove`.

### 3.3 Approving now sends

⊳ `POST /v1/approvals/{approvalId}/approve`.

✓ **200**, and the message dispatches.

**Why this is the single highest-impact change at cutover.** In the source this
flipped `message_history.status` and `communication_events.status` to `APPROVED`
— and *nothing read either back*. Approving never sent anything, for the life of
the service. Here it dispatches.

The historic backlog does not go out: `mig.finalize_cutover()` cancels every
never-sent message and every open approval during the migration, keeping the
original word on `metadata.migration.sourceStatus`.

### 3.4 Double-approve is idempotent

⊳ Approve the same one again. ✓ **200** again, not a 400.

The source returned `400 "Message is not pending approval"` on a double-click.

**One exception, and it is deliberate:** if the *queue* refused the job, the
approval stays `APPROVED` and the message goes `FAILED` — and a second approve
**retries the send** rather than reporting `idempotent`. A queue outage is not a
decision. Previously an infrastructure blip destroyed a human's decision and
wrote a compliance refusal into the audit trail that never happened.

### 3.5 The state machine refuses illegal moves

⊳ Try to edit an approval that has already sent.

✓ Refused, naming the current state (`Only a pending approval can be edited;
this one is SENT`).

**Why table-driven.** The source has no state machine — it has two, implicitly,
in different vocabularies and different storage, with the guard hand-written at
five call sites and **absent entirely from the bulk path**. A sixth caller
forgetting the guard is how an already-declined message gets approved.

### 3.6 Bulk needs a permission *and* a right

⊳ `POST /v1/approvals/bulk` against the `postman.fixture-policy` (which has
`rights.bulk: false`), as an admin.

✓ Refused despite the admin identity.

**Not redundant.** A permission is granted per user, usually broadly; the right
is authored per policy by the tenant. A clinic that decides messages under one
policy must be read one at a time is not overridden by an admin holding a broad
permission. The source's bulk path had *neither*, plus no tenant predicate and no
`PENDING_APPROVAL` guard on the rows it updated.

### 3.7 The two inboxes now agree

⊳ `GET /approvals/pending/sender-1` (legacy) and `GET /v1/approvals` (v1).

✓ The same drafts.

**Why.** In the source, `/ai-enhanced/pending-approvals/:providerId` and
`/approvals/pending/:providerId` showed **disjoint sets** — one filtered on the
`status` column, the other on `queued_message->>'approvalStatus'`, and drafts
were created through one path or the other. *Neither list was the whole queue.*
A provider who had been using one screen starts seeing drafts they did not know
existed.

---

## Part 4 · Playbooks and events

### 4.1 A matching event sends

⊳ `POST /events`:

```json
{ "type": "APPOINTMENT_REMINDER", "patientId": "pat-ada",
  "providerId": "sender-1", "channels": ["sms"],
  "data": { "appointmentDate": "2026-09-01T14:00:00Z", "doctorName": "Dr. Reed" } }
```

✓ **200**, `matched: 1`.

**Two things to notice.** The field is **`type`**, not `eventType`. And
`patientId` is the **external** id (`pat-ada`), not the engine's recipient UUID —
legacy routes address recipients by external ref. Passing the UUID makes the shim
treat it as an unknown patient and create a second, contactless recipient.

⊳ Check `playbook_runs`. ✓ A row recording which playbook ran and why.

**Why that row exists.** The old handler returned a bare `boolean`. When a
message did not arrive there was no evidence of which case ran or where it
stopped.

### 4.2 An unmatched event is a success, not a failure

⊳ Post `"type": "NOT_A_REAL_EVENT"`.

✓ **200** with `matched: 0`, plus an `outreach_events` row with status
`UNMATCHED`.

**Why this matters more than it looks.** The source answered
`{success:false, message:'Failed to process event'}` — indistinguishable from a
real failure. That is precisely how **27 of 44** enum values ended up with no
handler and nobody noticed.

### 4.3 The caller's channels win

⊳ Post `APPOINTMENT_REMINDER` with `"channels": ["email"]` against a playbook
whose plan is email **and** sms.

✓ One email. Not both.

**Why.** `channelPlan` is the *supported* set, not the effective one; the
caller's channels are **intersected** with it. Every case in the source guarded
each dispatch with `if (event.channels.includes(X))` — 24 such checks — so the
caller has always had the final say. Treating the plan as authoritative would
double the volume on every two-channel playbook.

### 4.4 A contract violation fails cleanly

⊳ Post `APPOINTMENT_REMINDER` with `data: {}` (missing the required
`appointmentDate`).

✓ A **`FAILED` run row carrying the schema errors** — and the model is never
called, no template is looked up, nothing is sent.

**Why.** In the source a missing field *threw*:
`handleAppointmentRescheduling` reads `oldAppointment.date` with no guard, the
outer catch returns `false`, and the caller logs "Event handling failed". No row,
no reason, no retry.

### 4.5 Redelivery does not double-send

⊳ Post the same event twice with the same idempotency inputs.

✓ One send. `(tenant_id, playbook_id, idempotency_key)` is unique.

**Why.** The queue retries five times, and a case that threw *after* queueing its
first channel re-queued that channel on every attempt.

### 4.6 AI playbooks ship switched off

⊳ `GET /v1/playbooks`, look for `isActive: false`.

✓ Every AI-content playbook is inactive.

**Why.** Nothing in the source sends them — they are new capability, not a port.
Deploying a pack must never be the moment a tenant starts sending model-written
messages. That is a tenant's decision.

⊳ `POST /v1/playbooks/<key>/activate`. ✓ It switches on.

### 4.7 Unmapped EHR events send nothing

⊳ `POST /ehr-webhook/process-event` with an event no rule maps.

✓ **200** with `mapped: false`, and nothing sent.

**Why.** The source *guesses* — a fallback that picks a mapping for anything, so
an unrecognised vendor event still sent a patient a message chosen by heuristic.
There is no safe default when the output is a message to someone's patient.

---

## Part 5 · Templates and rendering

### 5.1 Channel filtering is case-sensitive

⊳ `GET /templates?channel=SMS` ✓ empty.
⊳ `GET /templates?channel=sms` ✓ results.

**Why.** Template channels are stored lower-case to match the engine's own
lookup, which compares exactly and is fed lowercase by every pack. Message and
notification channels are lower-cased too, but no caller sees it —
`toLegacyChannel` restores the upper case on every legacy *response*. So the
asymmetry is visible only on the filter.

### 5.2 Render with the namespaced context

⊳ `POST /v1/templates/{id}/render` with a `context`.

✓ Interpolated output. The namespaces are `recipient`, `sender`, `tenant`,
`context`, `message`, `now`.

### 5.3 Timezone comes from the data, not the server

⊳ Render a template using `{{formatDate}}` for Ada (America/New_York) and for
Kiyoshi (Asia/Tokyo).

✓ Different local times from the same input.

**Why.** Resolution is recipient first, then tenant — never the server's clock.

### 5.4 Two levels of one payload do two different jobs

Worth knowing before you debug an empty render: the playbook **matcher** reads
its predicate from the payload **root**, while the renderer's `context` namespace
comes from **`payload.context`**. Nothing signals this, and putting a field at
the wrong level renders an empty template **with no error**. The campaign
orchestrator shipped with exactly that bug for one commit.

---

## Part 6 · Legacy surface and the retired mounts

### 6.1 Everything retired answers 410

⊳ Run the whole `98 ·` folder in Postman.

✓ **All 410**, each naming its successor.

A `404` means a mount is missing. A `200` means the P12 trim missed something.
Both are findings.

### 6.2 Deprecation headers

⊳ Any request in the `99 ·` folder; inspect response headers.

✓ `Deprecation: true` and `Link: </v1/…>; rel="successor-version"`.

That header is how a consumer finds its replacement without reading this repo.

### 6.3 The provider inbox returns 200 for the first time

⊳ `GET /communications/provider/sender-1/inbox`

✓ **200** with a populated inbox.

**Why it is worth a careful look.** In the source this was a *guaranteed* 500:
the handler builds `SELECT DISTINCT … GROUP BY patient_id` with a correlated
subquery over two ungrouped columns, which Postgres rejects at plan time. It
failed on an empty table, so no data state avoided it. **The FE's success path
for this screen has never run against real data.**

### 6.4 `queuedMessage` is permanently null

⊳ `GET /communications/conversation/sender-1/pat-ada`

✓ `queuedMessage: null`; `isPendingApproval`, `isApproved`, `isDeclined` all
`false`. ✓ **The keys are still present.**

**Why the keys stay.** The web app reads `message.queuedMessage.content` and the
mobile app reads it too — both guard on the object being present, so `null` is a
path they already take and a *missing key* is not.

✓ `pendingApprovalCount` is **0**, structurally. Live approval state comes from
`/approvals/*`.

### 6.5 Config create is an upsert

⊳ `POST /config/medspa` twice.

✓ **201 both times**, not a 409.

**Why.** `tenant_channel_configs` has `UNIQUE(tenant_id)` — create and update
address the same row, and the split pair made an idempotent deploy script
impossible.

⚠️ **This request rewrites the tenant's channel config.** If a later send starts
answering `503 CHANNEL_NOT_CONFIGURED`, re-apply `seed-local.sql` — it restores
every seeded column. It reads exactly like a credential-resolution bug and is
not one (D109).

---

## Part 7 · What needs credentials, and what you can still prove

Nothing below is a gap in the service. It is the honest boundary of a laptop.

| Area | Without keys you **can** | You **cannot**, and with keys you would see |
|---|---|---|
| **SendGrid / Twilio / Slack sends** | Everything up to the wire: credential resolution per tenant, capability validation, the `messages` row, the queue job, the dry-run log line, retries, and the `SUPPRESSED`/`FAILED` paths. Per-tenant credential isolation is fully testable with the fake values in the seed. | The provider accepting the payload. With real keys and `CHANNEL_DRY_RUN=false`, a delivered email/SMS and a real `provider_message_id` on the row. |
| **Delivery receipts** | The endpoint, the signature check, idempotency, and the unmatched path. | A genuine signed callback. Provider webhooks are **signature-verified**, so a hand-made body correctly answers `401 Invalid webhook signature` — that 401 *is* the test passing. To go further, set the signing secret and compute a valid signature. |
| **AI generation** | Everything, via `LLM_PROVIDER=stub`: prompt assembly, pack resolution, JSON-schema conformance, lint warnings, `aiConfidence`, approval creation, `ai_interactions` audit rows and `GET /v1/usage` cost aggregation. | Whether the *prompts are any good*. That is the one thing the stub cannot tell you and real Bedrock can. |
| **Image generation** | That `POST /v1/assets/generate` answers **501** naming the missing piece. | Nothing more — **the engine ships no image adapter**, and the source could not serve this either: it calls a method whose body throws, with nothing catching it, so it answered 500 for its entire life. A 501 naming the missing piece is the same capability and better information. |
| **Mentera context provider** | The inline provider, and that a tenant without the pack gets **403**. | Live patient/provider enrichment, which needs `PATIENT_SERVICE_URL` and a reachable service. |
| **The 9xxx data migration** | Reading it. | Running it — it loads out of the mentera-core database via a foreign server and needs a linked source. **Do not run these locally.** Read `docs/MIGRATION_RUNBOOK.md`. |

### 7.1 Prove the stub is not hiding anything

⊳ `GET /v1/usage`

✓ Non-zero `tokensIn`, `tokensOut` and `costUsd`.

The stub derives token counts from the actual text and goes through
`RecordingLlmProvider` like the real one, so the audit trail and the usage
endpoint are exercised rather than bypassed.

⊳ Set `STUB_LLM_FAIL=true`, restart, and generate.

✓ The model-outage path runs — a retryable `LlmError`, and the caller's error
handling rather than a happy path.

---

## Part 8 · Automated suites

⊳ `npm run typecheck` ✓ clean
⊳ `npm run lint` ✓ clean
⊳ `npm test`

✓ **1,335 tests, 52 suites, all passing** (797 unit/contract + 538
integration/acceptance). Docker must be running — the integration suites start
their own throwaway Postgres via testcontainers, apply the migrations to it,
assert the Drizzle model and the SQL agree, and destroy it. **Your local
`outreach` database is untouched by a test run.**

⊳ `node testing/smoke.mjs`

✓ **0 failures** across 150 requests. Expect ~31 4xx (deliberate refusals and the
generator's placeholder values being correctly rejected) and 1 documented 501.

Two suites worth knowing by name:

- `tests/integration/schema.test.ts` — the **bidirectional** Drizzle↔SQL
  conformance check. With no working migration generator for this schema, it is
  the only thing keeping the model and the DDL in sync. Extend it, never weaken
  it.
- `tests/contract/openapi.test.ts` — fails if `openapi.yaml` drifts from the
  registered routes. It is why the generated Postman collection can be trusted.

---

## Part 9 · Verifying against the source

`mentera_core` is at `/Users/weevil/projects/elevano/mentera_core`. The original
service lives on **`develop`** at `services/communication-service`, and that
branch is not currently checked out — read it without touching the working tree:

```bash
git -C /Users/weevil/projects/elevano/mentera_core \
  show develop:services/communication-service/src/services/ai/ai-service.ts | less
```

Useful comparisons, each backing a claim above:

| Claim | Where to look |
|---|---|
| Approving never sent | `approvals.controller.ts` — the status write with no reader |
| The provider inbox always 500'd | the `SELECT DISTINCT … GROUP BY` with the correlated subquery |
| Templates had no tenancy | `grep -c medspaId services/templates/template-engine.ts` → **0** |
| Two disjoint approval inboxes | `approvals.controller.ts` vs `ai-enhanced-communication.controller.ts` |
| 27 of 44 event types unhandled | the `EventType` enum vs the handler switch |
| Prompts were compiled in | the eight hardcoded prompt builders, now seven pack files |
| Image generation always threw | `ai-service.ts` `generateImage` — a body that throws |

---

## Reporting

For anything unexpected, capture: the **request** (method, path, headers, body),
the **response** (status and body), the **`requestId`** from the body — every
error carries one and it correlates to the server log — and the relevant
`playbook_runs` / `messages` / `outreach_events` row.

Check it against `docs/api/BREAKING.md` first. If the behaviour is listed there,
it is intended and the entry says why.

**D109 in `docs/DECISIONS.md`** records what the validation pass that produced
this plan turned up. All three defects it found are fixed:

- a malformed UUID in a path answered `500` on 37 routes — now `400` naming the
  parameter, covered by `tests/contract/uuid-params.test.ts`;
- a duplicate key answered `500` — now `409`, same suite;
- `0014` was required on a pre-P12 database while every doc said to skip it —
  `npm run migrate:print` now gives `0013` and `0014` separate headings with a
  reason and a check each, and `tests/unit/platform/migrations.test.ts` fails if
  a future non-baseline file arrives without one.

So a `500` on any of those is a **new** regression, not a known one.

D109 also lists three things that looked like defects and were not — the
`phone`-vs-`sms` contact point type, legacy routes taking the external patient
id rather than the recipient UUID, and the config-write that clobbers channel
credentials. Each cost an hour; read them before filing.
