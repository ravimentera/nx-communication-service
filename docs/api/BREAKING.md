# Behaviour changes on the legacy surface

> **Trimmed in P12 (D100).** The shim serves **28 endpoints**, not 110 — the set
> six consumers actually reach, established by grepping them rather than by
> reading a hit counter that no traffic was feeding. Everything else answers
> **`410 Gone`** with its successor named.
>
> Retired mounts: `/sms`, `/slack`, `/preferences`, `/queue`, `/ai`,
> `/ai-enhanced`, `/leads`, `/treatments`, `/patients`, `/providers`,
> `/promotions`, `/gift-cards` — plus the unreached routes inside the mounts that
> survived. Appendix A of the extraction plan has the surviving list.
>
> Two mounts are kept **without proof of use**: `/messages/webhook/*` and
> `/ehr-webhook/*`. Their URLs are configured in Twilio's, SendGrid's and an EHR
> vendor's dashboards, where no grep reaches.
>
> Everything below still describes what a caller of a **surviving** path sees.
> Entries for retired paths are left in place as the record of what was ported.

Everything a caller of the **legacy paths** can observe that differs from
`mentera_core/services/communication-service`. The compat shim exists to make
the P10 cutover an env-var change; this is the list of places where it is not
quite one.

Each entry says what a caller sees today, what it will see after the repoint,
and whether that is a fix or a tightening. Nothing here is accidental — an
accidental difference is a bug, and belongs in an issue rather than this file.

Rows are grouped by how much attention they need at cutover.

---

## Watch at cutover

> **Retitled (D99).** There is no parallel run — the product is in demo phase,
> the old service is stopped before the migration and never restarts, and the
> repoint is one window. These are still the things to look at first; there is
> just no soak period to look at them during, and no users generating the
> traffic that would surface them gradually.

### The provider inbox starts returning 200

`GET /communications/provider/:providerId/inbox`

**Today:** always `500 {success:false, message:'Failed to get provider inbox'}`.
The handler builds `SELECT DISTINCT … GROUP BY patient_id` with a correlated
subquery over two ungrouped columns, which Postgres rejects at plan time —
`ERROR: subquery uses ungrouped column "message_history.provider_id" from outer
query`. It fails on an empty table, so no data state avoids it. See D61.

**After:** a populated inbox in the documented envelope.

**Fix, not a regression** — but the FE's success path for this screen has never
run against real data. Worth eyes on the first render.

### Approving a message sends it

`POST /approvals/approve/:messageId`, `/edit-approve/:messageId`,
`/schedule/:messageId`

**Today:** flips `message_history.status` and `communication_events.status` to
`APPROVED`; nothing reads either back. `scheduledFor` is a string no scheduler
consumes. See D44.

**After:** the message is dispatched, and a scheduled one becomes a delayed
BullMQ job that survives a restart.

**Intended, and the single highest-impact change at cutover.**

**The historic backlog does not go out.** That was the fear here, and it is
settled: `mig.finalize_cutover()` cancels every never-sent message and every
open approval during the migration, so nothing that accumulated as `APPROVED` in
the old system is waiting to escape (D99). The rows keep their original word on
`metadata.migration.sourceStatus`, so the count is still answerable.

What does send is the first **new** approval after the repoint. `CHANNEL_DRY_RUN`
defaults on — decide it before the window, not during it.

### The entire `/templates` router becomes tenant-scoped

`services/templates/template-engine.ts` contains **zero** occurrences of
`medspaId` or `tenantId`. All fourteen endpoints — including `PUT /:id` and
`DELETE /:id` — operate on any template by id, from any tenant.

**After:** every path carries a tenant predicate. A cross-tenant read is 404, a
cross-tenant list is empty, a cross-tenant delete reports `success: false`.

**Tightening**, and the most consequential one in P8b: this is Seam A, and a
cross-tenant `DELETE` cascades into `template_versions`. See D66.

### The two approval inboxes start agreeing

`/ai-enhanced/pending-approvals/:providerId` and `/approvals/pending/:providerId`
show **disjoint sets** today — one filters on the `status` column, the other on
`queued_message->>'approvalStatus'`, and drafts are created through one path or
the other (D46). Neither list is the whole queue.

**After:** both read the same `approvals` table. A provider who has been using
one screen starts seeing drafts they did not know existed.

### Cross-tenant and cross-provider reads now 403 / 404

| Endpoint | Today | After |
|---|---|---|
| `GET /communications/provider/:providerId` | returns rows for any provider id, from any tenant — the query filters on `provider_id` alone | tenant-scoped |
| `PUT /communications/:messageId/read` | returns another tenant's row in the 200 body when it is already read (the existence check at `:1745` carries no tenant predicate) | 404 |
| `POST /approvals/approve/:messageId` and the other five mutations | act on any message id, any tenant, any provider | 404 outside the tenant, 403 outside the caller's queue |
| `GET /approvals/history/:providerId` | reads across tenants | tenant-scoped |
| `GET /config/medspa/:medspaId` | a `super_admin` role could read any tenant's config | 403 unless the path id is the caller's tenant |

See D45 and D62. **Tightenings.** A caller that depends on any of them is
depending on a cross-tenant read; watch for 403s and 404s after the repoint
and identify the caller rather than loosening the check.

---

## Fixes to endpoints that were broken

| Endpoint | Today | After | Ref |
|---|---|---|---|
| `GET /communications/analytics/medspa/:medspaId` with no `dateFrom`/`dateTo` | 500 — the handler formats the bounds before testing them and casts the literal string `"undefined 00:00:00"` | 200 over all time | D63 |
| any list endpoint with `?eventType=X` | the filter branch is empty; everything is returned | filters on the joined event type | D63 |
| `POST /queue/maintenance` | probes the queue service for `cleanQueue`/`clearQueue`, finds neither, swallows the miss, reports success | reports `performed: []` and the current stats; retention is BullMQ's job | — |
| `POST /events/*` when no handler matches | `{success:false, message:'Failed to process event'}` — indistinguishable from a real failure, which is how 27 of 44 enum values went unnoticed | `{success:true, matched:0}` plus an `outreach_events` row with status `UNMATCHED` | D56 |

---

## Shape and semantics

| Endpoint | Change | Why |
|---|---|---|
| `POST /email/send` | response gains `jobId`, `messageId`, `results[]` | the source returns a bare `{success:true}`, so a caller cannot follow a message. `success` is unchanged. |
| `POST /email/send`, `/sms/send*` | marked **transactional** | verification, invitation and password-reset mail must not be held by a quiet-hours window or a marketing opt-out. The source has no gate, so this had nowhere to be expressed. |
| `POST /sms/send-direct` | no longer bypasses the queue | the worker holds the credentials and the retry policy; a synchronous send has neither. It is transactional instead, which is the property `-direct` callers wanted. |
| `POST /slack/message` | 400 when no `channel` is given | the source defaults to the literal `urgent-alerts`, a destination shared across tenants (D55). Configure `slackDefaultChannel` per tenant. |
| `POST /config/medspa` (second call) | 201 upsert instead of 409 | `tenant_channel_configs` has `UNIQUE(tenant_id)`; create and update address the same row. The split pair makes an idempotent deploy script impossible. |
| `PUT /config/medspa/:medspaId` before any POST | 200 upsert instead of 404 | same reason |
| `GET|PUT /preferences/quiet-hours` | per **tenant**, not per process | the source's `setGlobalQuietHours` writes one process-wide value that any tenant's call overwrites for every other tenant |
| `POST /approvals/bulk-action` | requires `outreach:approve:bulk` **and** the policy's `bulk` right | the source's has neither, plus no tenant predicate and no `PENDING_APPROVAL` guard on the rows it updates (D51) |
| `POST /approvals/approve/:messageId` twice | 200 both times | the source returns 400 `"Message is not pending approval"` on a double-click |
| every 4xx | the real status code | the source answers 500 with `{success:false, message}` for bad input as well as for failures. `success` is unchanged, so a consumer that only reads that field sees no difference. |

---

## More shape and semantics (P8b)

| Endpoint | Change | Why |
|---|---|---|
| `POST /ai/*` | `temperature` and `maxTokens` in the body are ignored | the prompt pack owns sampling, so two callers of the same mode cannot get differently-sampled output and blame the pack. `model` stays overridable. |
| `POST /ai/*` | 404 when the mode's prompt pack is not installed | the source's prompts are compiled in, which is also why nobody can change one without a release (D67) |
| `POST /ai/*` | response `metadata` gains `tokensIn`, `tokensOut`, `costUsd`, `lintWarnings` | real token accounting; the source estimated by word count (D31) |
| `POST /ehr-webhook/process-event` with an unrecognised event | `200 {mapped: false}`, nothing sent | the source guesses and sends a message chosen by heuristic (D68) |
| `GET /ehr-webhook/mapping-preview/:type` | reports `matchedBy: 'exact' \| 'contains'` | the source's `reasonForDecision` is a string hardcoded next to the rule |
| `GET /communications/patient/:id/conversation/summary` | counted facts, no model prose | the source generates a summary on every page load: a model call per render, and nothing citable |
| `POST /promotions/:id/campaign` | 400 naming the reason | the source builds it on `findEligiblePatients()`, which returns a hardcoded `Jane Smith` / `John Doe` and is commented *"For demo purposes"*. Campaigns land in P11. |
| `GET /providers/:id/feedback/adverse` | sourced from `message_analytics.metadata` | `patient_feedback` is a ghost table and has always been empty, so the answer is unchanged today (D11, §0.7) |
| `/leads/:leadId/profile` | stored on `recipients.attributes` | `lead_profiles` is a ghost table; §0.7 folds it |

---

---

## After the data migration (P9)

These appear on the legacy surface only once the migrated rows are in front of
it. Everything else in the migration is invisible to a caller.

| Endpoint | Change | Why |
|---|---|---|
| `GET /templates?channel=SMS` | filter is case-sensitive and wants `sms` | template channels are lower-cased to match the engine's own lookup, which compares `templates.channel` exactly (`content/store.ts:56`) and is fed lowercase by every pack. Message and notification channels are lower-cased too, but no caller sees it: `toLegacyChannel` restores the upper case on every legacy response (D80) |
| any list carrying a migrated message that was never sent | `status` is `CANCELLED` — for `APPROVED` and `SCHEDULED` rows, and after D99 for `PENDING_APPROVAL`, `PENDING` and `QUEUED` too | approving never dispatched anything (D44), so a year of approved-but-unsent messages would otherwise be release candidates at cutover. Widened because with no parallel run the old service never restarts, so a row in flight is a row that will never move — and leaving it fills every provider's inbox with work nobody will do. `metadata.migration.sourceStatus` keeps the original word. The operator can override the disposition; the runbook makes them read the count first |
| the approvals inbox, on day one | empty of migrated rows | same. Nothing that was open in the old system is carried across as open |
| `GET /approvals/pending/:providerId` | shows drafts created through *either* legacy path | the two inboxes were disjoint sets (D46) and the backfill reads both storage shapes |
| a delivery receipt for a message sent before cutover | recorded as unmatched | the source never stored a provider message id — it matched replies by (patient, provider, channel, most recent) — so migrated rows have nothing to join on. One-off; decays within the provider's retry window |
| `GET\|POST\|PUT /preferences/*` | response gains `emailOptIn`, `smsOptIn`, `pushOptIn`, `voiceOptIn`, `directMailOptIn` | **restores** five fields the source's `communication_preferences` row carried and P9 had dropped. Added in P10 for Seam B, since patient-service's JOIN was the FE's only source for them. **Read-only and unenforced**: `PUT` ignores them, and no send is gated on them — `allowCommunications` and `preferredChannels` do that. Reserved for a per-channel opt-in feature that is not finished (D85) |

---

## Appointment notifications start arriving (P10)

`scheduling-service` posted to `/notifications/email` and `/notifications/sms`
for the life of the service. Neither route ever existed — the source mounted 23
paths and `/notifications` was not among them — so every appointment
notification 404'd silently behind a retry loop.

It posts events now, and four of them match playbooks the medspa pack has
shipped since P7:

| Event | Playbook | Channels | Effect |
|---|---|---|---|
| `APPOINTMENT_CONFIRMATION` | `medspa.appointment-confirmation` | email | **starts sending** |
| `APPOINTMENT_REMINDER` | `medspa.appointment-reminder` | sms | **starts sending** |
| `APPOINTMENT_CANCELLATION` | `medspa.appointment-cancellation` | email, sms | **starts sending** |
| `APPOINTMENT_RESCHEDULING` | `medspa.appointment-rescheduling` | email | **starts sending** |
| `APPOINTMENT_REQUESTED` / `_APPROVED` / `_DENIED` | none | — | recorded `UNMATCHED`, sends nothing |

**This is the second-highest-impact change at cutover**, after approvals
beginning to dispatch (D44). Patients who have never received an appointment
email from this system will start receiving them. `CHANNEL_DRY_RUN` defaults on;
read the volume before turning it off.

Channels are pinned per call site, so a reminder stays SMS-only even though its
playbook supports email. Widening that is a pack edit.

---

## The rich-media endpoints start working (P12)

**Six of the seven endpoints this section used to list as blocked were never
blocked on anything.** This file said they needed "an image-capable
`LlmProvider`"; the plan repeated it and D84 repeated it again. Nobody had read
the method they bottom out in.

`AIService.generateImage` (`ai-service.ts:562-570`) is a body that throws:

> "Image generation not supported with current Bedrock models. Please implement
> with a compatible image generation model."

Every caller either swallows that or never reaches it. See D92.

| Endpoint | Today | After | Why |
|---|---|---|---|
| `POST /ai/multimodal` | 501 | `200 {multimodalContent: {textContent, images[]}}` | Never used an image model. The source builds a **text** prompt asking for copy plus N image *descriptions* and calls `generateJsonContent` (`ai-content-controller.ts:406`). The eight-line shape it described in prose is now a JSON Schema the provider enforces, so a model that ignores it fails validation instead of returning prose the caller must parse |
| `POST /templates/generate-with-images` | 501 | `201` with the template, `imageAssets` absent | The source generates the body, then loops image suggestions through a `try/catch` that logs and continues (`template-controller.ts:368`). Every attempt threw, so it has always returned 201 with `imageAssets` undefined — which is exactly what it returns now |
| `POST /templates/campaigns`, `/campaigns/follow-up`, `/campaigns/educational`, `/campaigns/promotional` | 501 | `201 {templateId, emailConfig, previewContent}` | Campaign **copy**, generated with Bedrock text. The image pass is `Promise.all` over prompts, each in a `try/catch` returning `null` (`campaign-template-generator.ts:232`), filtered out. Same 201, same absent `imageAssets` |
| `POST /templates/assets/upload` | 501 | `201` with the stored asset | The storage adapter exists now |

**Two shape changes on the ported endpoints:**

- `POST /templates/assets/upload` keeps the source's `{filename, originalName,
  size, mimeType}` and **gains `assetId` and `url`**. The source returned a bare
  filename, which nothing could fetch — its assets were addressable only by
  guessing a path in a shared directory.
- `filename` is now a **service-assigned key**, `<tenantId>/<kind>/<uuid>.<ext>`.
  The name the client sends is recorded in `metadata.filename` and never reaches
  a path. The source joined its storage root with the caller's filename and wrote
  there, with no check of any kind.
- Assets are **tenant-scoped**, and recorded in `assets` — which has existed
  since P2 with no writer. In the source an asset had no tenant at all.

**`POST /templates/campaigns*` are also now tenant-scoped and permission-gated**
(`outreach:templates:write`), like the rest of the `/templates` router. Same
tightening as the one recorded above for Seam A.

---

## Still not ported

| Endpoint | Blocked on | Lands in |
|---|---|---|
| `POST /templates/assets/generate-image` | an image model. `src/ports/image.ts` is declared and the engine ships **no adapter** | when a deployment supplies one |

**This is the one endpoint that genuinely needed an image model, and the source
could not serve it either** — it calls the throwing method with nothing catching
it, so it has answered **500** for its entire life. A 501 naming the missing
piece is the same capability and better information.

The port exists so that stops being an engine change: a deployment with an image
model writes one adapter, registers it in the composition root, and the endpoint
starts working.

---

## API keys, usage and GDPR (P12, new surface)

Nothing on the legacy surface changes. New `/v1` routes, documented in
`openapi.yaml`:

| Route | Note |
|---|---|
| `POST\|GET\|DELETE /v1/api-keys`, `POST /v1/api-keys/:id/rotate` | `AUTH_MODE=apikey`, for a vendor with no Mentera gateway. The plaintext key is returned once and never stored |
| `GET /v1/usage` | Model spend and delivery volume per tenant |
| `POST /v1/recipients/:id/erase`, `GET /v1/recipients/:id/export` | GDPR articles 17 and 20. Both need `outreach:admin` **and** the tenant carrying `{"gdpr": true}` on `compliance_profile`; a tenant without it gets 403 naming the profile |

**Two behaviour changes a sender can observe**, both gated on
`tenants.compliance_profile`, which is `{}` for every tenant today — and both
still in shadow mode until an operator enforces per tenant (D41):

| Change | Applies to |
|---|---|
| A marketing SMS or voice message outside 8am–9pm in the **recipient's** local time is **deferred**, not dropped | every tenant — TCPA is not opt-in |
| Content the linter flags as PHI is **blocked** on sms, slack, push and webhook | tenants carrying `{"hipaa": true}` |
| Marketing requires a consent record whatever `require_opt_in` says | tenants carrying `{"gdpr": true}` |

**`POST /v1/packs/:packId/install` now validates `requiredConfig`** and refuses
an install missing it, naming every missing key. It used to accept anything and
the failure surfaced later as a `SKIPPED` run. Config is also **merged** now
rather than replaced, so a partial re-install no longer drops the operator's
other settings (D95).

---

## `queuedMessage` goes constant (P12)

`messages.queued_message` is gone — out of `0001`, out of the Drizzle model, and
out of the P9 load. It held the source's approval blob; **this engine never wrote
it**, and approval state has lived in the `approvals` table since P6, so the
column has been permanently null for every message the new service creates since
P9. The migrated rows that did carry a value were all cancelled by
`mig.finalize_cutover()` (D99). See D103.

| Endpoint | Change | Why |
|---|---|---|
| `GET /communications/conversation/:p/:pt` | `queuedMessage` is always `null`; `isPendingApproval`, `isApproved` and `isDeclined` are always `false` | the column behind all four is dropped. **The keys stay** — the web app reads `message.queuedMessage.content` (`inbox.utils.ts:301`) and the mobile app reads it too, and both guard on the object being present, so `null` is a path they already take and a missing key is not |

**Not a behaviour change for any message this service sent.** A caller that has
been running against the new service sees exactly what it saw before, because
these four have been constant for every non-migrated row since P9. Live approval
state comes from `/approvals/*`, which reads the table both legacy inboxes have
shared since P6 (D46).

`pendingApprovalCount` on the conversation summary is **unchanged** — it reads
`approvals` now instead of the JSONB, but keeps the `status = 'QUEUED'` filter
that makes it structurally zero, as it has been since P8.

---

## A new v1 route, and five MCP tools (P12, new surface)

Nothing on the legacy surface changes.

| Route | Note |
|---|---|
| `POST /v1/outreach/generate` | Write a message with the model **and open an approval on it**. The capability existed only inside the compat shim, which is why `/ai-enhanced` and `/automated-messages` have been answering `410` naming a route that did not exist. It does not send: the draft waits for a person unless the caller names a `none`-mode `policyKey` (D101) |

`/communications/generate-message` and `/automated-messages/generate` are
unchanged in shape — they delegate to the same service now, so the two paths
produce the same content and the same status by construction.

**MCP gains five tools** — `generateDraft`, `listPendingApprovals`,
`approveMessage`, `listConversations`, `createCampaign` — and `GET /mcp/tools`
now publishes `mutationTools` alongside the schemas, plus a `mutation` flag on
each tool. That is a fix, not a nicety: the orchestrator's own list named
`sendSlack`, which is not a tool, so both Slack sends ran without the
confirmation the gate exists to require (D102).

---

## An approval survives a queue outage (P12)

| Endpoint | Change | Why |
|---|---|---|
| `POST /approvals/approve/:messageId` and every other approve path | when the queue will not take the job, the approval stays `APPROVED` instead of becoming `CANCELLED`, and the message is `FAILED` rather than `QUEUED` | a queue outage is not a decision. `release()` could not tell "the queue is unreachable" from "compliance refused", so an infrastructure blip destroyed a human's decision and wrote a compliance refusal into the audit trail that never happened (D105) |
| the same paths, called again | a second approve **retries the send** instead of answering `idempotent` | with the approval left `APPROVED` and nothing on the queue, "already done" was a lie and the message was stranded permanently. Idempotency is unchanged for every other case, including a genuine double-click and a message that already sent |

**Fix, and it changes a status a caller can observe.** A list that showed
`CANCELLED` for these will show `APPROVED`, and the message `FAILED` rather than
`QUEUED`. Both are more accurate; neither has ever been reachable in a deployed
environment, because the service is not deployed.

**Compliance refusals are unchanged** — a permanently refused message still
cancels its approval, so nothing that can never be delivered sits in an inbox
looking actionable.

---

## `x-medspa-id` is no longer read (P12)

**The one caller-visible protocol change in the whole extraction**, and the last
place a vertical noun appeared in something every caller has to speak.

| Header | Before | After |
|---|---|---|
| `x-tenant-id` | preferred | **the only tenant header** |
| `x-medspa-id` | accepted as a fallback | **ignored** — a request carrying only this has no tenant and is rejected |
| `x-sub-tenant-id` | preferred | **the only sub-tenant header** |
| `x-location-id` | accepted as a fallback | **ignored** |
| `x-sender-id` / `x-provider-id` | both accepted | **unchanged** — still both |

**Nothing that goes through the gateway is affected.** The gateway forwards both
spellings as of the same change, and still *requires* `x-medspa-id` from the web
and mobile apps — that is its contract with its clients and it did not move. The
three service clients (providers, patient, scheduling) have sent both since P10,
and tera-orchestrator now does too.

**Affected: a caller that talks to this service directly and sends only the
medspa spelling.** There is no such caller today; that is why this could be done
at all. If one appears, it gets a 4xx rather than a silent empty-tenant query,
which is the reason the alias was removed outright instead of being tolerated
with a warning.

`x-provider-id` was left alone deliberately — it is a sender identity, not the
tenancy boundary, and its callers were not surveyed.
