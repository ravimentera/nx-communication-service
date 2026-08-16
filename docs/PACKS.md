# Packs

A pack is a directory of JSON. It carries everything about **a vertical** that
the engine itself must not know: which events matter, what the messages say, who
reviews them, and what counts as a compliance problem.

The engine ships the mechanism — `packs`, `tenant_packs`, and the `pack_id`
provenance column on playbooks, templates, prompt packs and approval policies. A
pack id is a string. **No table in this schema is shaped by what any pack
contains**, and that is the property that makes this an industry-agnostic engine
rather than a medspa service with the word filed off.

```bash
grep -ri medspa src/db/ migrations/   # no table name, no column name
```

Run that after any change that adds a table.

---

## Where a vertical's data lives

Before adding anything to a pack, decide which of four tiers it belongs to. The
rule is one sentence:

> **The engine needs a table only if the engine reads it.**

Apply it literally. "Does the engine itself read this row to do its job?" If no,
the engine does not get a table, however naturally the data seems to belong to
messaging.

| Tier | Lives in | Use for | Consumer DDL? |
|---|---|---|---|
| **1. Event payload** | nowhere — transient | data needed only at render time, validated against the playbook's `dataContract` | none |
| **2. Generic extension columns** | `recipients.attributes`, `recipient_context.payload`, `message_analytics.metadata`, `tenant_packs.config` | data the engine must query, filter or segment on | none |
| **3. The vertical's own service** | the consumer's database | data the vertical owns and queries; the engine never reads it | it already has them |
| **4. Pack-owned migration** | engine DB, opt-in | rare: relational storage that must sit beside engine data | opt-in, ships with the pack |

Worked example — a promotion. Does the engine read a `promotions` table to send
a message? No. It needs the promotion's *fields at render time* (name, discount,
expiry), and those arrive with the event. The promotion's lifecycle is the
vertical's problem, and the vertical has that table whether or not this engine
exists. Tier 3 plus tier 1.

A gym adopting the engine for class reminders creates **no tables at all**: it
sends events and the engine sends messages.

Reach for tier 4 only when 1–3 have each been ruled out in writing, and when it
lands, it lands as a migration shipped with the pack — never in the engine's
`migrations/0*.sql`.

---

## Layout

```
packs/<id>/
├── manifest.json           who the pack is, and what a tenant must configure
├── aliases.json            legacy template variable names → context paths
├── compliance.json         lint rules, merged over the engine defaults
├── event-types.json        accepted trigger names and their alternate spellings
├── ehr-mapping.json        vendor event names → outreach events (optional)
├── prompts/*.json          prompt packs, one per file
├── policies/*.json         approval policies
├── templates/*.json        message bodies, per channel
└── playbooks/*.json        what fires on what, and how
```

Two packs ship in this repo:

- **`core`** — ten generic writing prompts. Seven content modes
  (`core.content-generate`, `-enhance`, `-personalize`, `-analyze`, `-followup`,
  `-promotional`, `-educational`) backing `POST /v1/content/generate` and the
  legacy `/ai` router, plus three added in P12: `core.content-multimodal`
  (copy with image descriptions, for `/ai/multimodal`), `core.template-author`
  (which `POST /templates/generate` had defaulted to since P8b while no pack
  shipped it — D93) and `core.campaign-author`. "Rewrite this more clearly" is
  not vertical vocabulary; a law firm would use them unchanged.

  `core.campaign-author` is where the campaign endpoints' phrasing lives. The
  source built that prompt in TypeScript with the vertical's nouns baked in —
  *"new patients who have recently joined the practice"* — so the engine now
  passes `campaignType`, `audience`, `tone` and `purpose` through as context and
  the pack does the wording. A vertical wanting its own vocabulary overrides the
  key in its own pack.
- **`medspa`** — the vertical this engine was extracted from. All 17 playbooks
  derived from the source's event switch, nine more from its service modules,
  and the engine's own escalation playbook.

### Every file may hold one definition or an array

`playbooks/appointments.json` is an array of playbooks; `prompts/followup.json`
is a single prompt pack. Group by whatever reads well — the loader does not care,
and forcing one file per definition turned 11 files into 46 before this was
allowed.

### `$comment` keys are documentation

Any key beginning with `$` is stripped before validation, **in every pack file
and at every depth** — so `$comment` works at the top of a playbook, inside a
`modelHints` block, and as a per-field `$comment.<field>` beside the field it
describes. Use them. A pack file is read by someone six months from now who has
no other source of truth.

> **Corrected in P13.** This said the convention applied only to the files
> taking a flat map. Pack authors had already used it in `prompts/*.json` and
> `ehr-mapping.json`, and were right to — a commenting convention with
> exceptions is one nobody can rely on. Adding Zod validation to those files
> turned the discrepancy into seven startup errors, which is how it surfaced.

---

## Validation

**Every file is parsed through Zod with `.strict()` at boot**, and a failure
names the file and the field path.

> **True as of P13.** It was written aspirationally: the manifest, policies,
> templates and playbooks were validated, while `prompts/*.json`,
> `compliance.json`, `ehr-mapping.json` and `event-types.json` were
> `JSON.parse` plus a cast. That mattered because those shapes are consumed
> *structurally*, not field by field — a prompt pack's `constraints` given as a
> string instead of an array spreads character by character into the system
> prompt, and an EHR rule's `contains` given as a string matches per character,
> so `"appointment"` matches almost every event name there is. `phiPatterns`
> are now compiled at load, so an invalid regex is a named startup error rather
> than a throw inside the compliance gate on the send path.

Strictness matters more than it looks. A `templateKey` misspelled `template_key`
would be silently ignored by a permissive parser, and the playbook would render
the wrong channel's body forever. `.strict()` turns that into a startup error a
person fixes in seconds.

**A bad file does not stop the process.** One malformed playbook costs that
playbook, not the pack; one broken pack does not stop a tenant that never
installed it from being served. Errors are collected on `LoadedPack.errors`,
logged at `error` with the paths, and exposed through `GET /v1/packs` so an
operator asking "why is this playbook missing?" finds out from the API rather
than the boot log.

Refusing to boot was the alternative, and it turns a typo in an unused vertical's
pack into an outage.

---

## `manifest.json`

```jsonc
{
  "id": "medspa",                      // must match the directory name
  "name": "MedSpa",
  "version": "1.0.0",
  "description": "…",
  "requires": { "engine": ">=0.1.0" }, // optional
  "contextProviders": ["mentera-patient"],
  "requiredConfig": [
    "emergencyContacts",
    "slackChannels.staffAlerts"
  ]
}
```

**`contextProviders`** is a security boundary, not a lookup table. A context
provider can reach an external service using the engine's own credentials, so
providers are registered *against a pack id* and resolution takes the tenant's
installed packs. A tenant without the pack cannot resolve that kind even by
crafting the reference by hand — it gets **403, not 404**, because it asked for
something real that it is not entitled to.

**`requiredConfig`** lists the dotted keys a tenant must supply at install, via
`POST /v1/packs/:packId/install`. Anything a playbook references as
`$config.<key>` belongs here. A playbook whose reference is unset produces a
`SKIPPED` run and an error log — **never a send to the wrong place**. That
matters because the source hardcoded four destinations (`emergency-team@…` and
three Slack channel names), which meant a second tenant's staff alerts would have
posted into the first tenant's Slack.

**Install refuses when a required key is missing** (P12), naming every one of
them. Before that the field was declared and read by nothing, so installing the
medspa pack with no `emergencyContacts` succeeded and the first sign of trouble
was an emergency notification producing a `SKIPPED` run at 3am — the failure this
mechanism exists to prevent.

**Config is merged, not replaced.** Re-installing with one setting keeps the
others, at every level of nesting — `{"slackChannels": {"staffAlerts": "#new"}}`
does not drop `emergencyAlerts`. Arrays replace: a shorter `emergencyContacts` is
a request to shorten it. And `requiredConfig` is checked against the config the
tenant *ends up with*, so adding one setting later does not mean resending all of
them. See D95.

**`roleMembers`** is read by the approvals plane: a policy that resolves the
approver to a `role` needs to know who holds it, and the engine does not own
identity.

```jsonc
{ "roleMembers": { "nurse-practitioner": ["user-1", "user-2"] } }
```

A role with no members admits nobody but an admin — "no configuration" must not
read as "everyone", which is what it effectively did before P12 (D98).

---

## `playbooks/*.json`

The unit of "when X happens, send Y". Replaces what was a 17-case switch.

```jsonc
{
  "key": "medspa.appointment-reminder",   // stable across versions
  "name": "Appointment reminder",
  "isActive": true,
  "priority": 100,                        // higher runs first when several match

  "triggers": [
    {
      "type": "event",
      "eventType": "APPOINTMENT_REMINDER",
      "eventTypeAliases": ["APPOINTMENT_REMINDER_24H"],
      "where": { "appointment.status": { "eq": "confirmed" } }
    }
  ],

  "dataContract": {
    "required": ["appointmentDate"],
    "properties": {
      "appointmentDate": { "type": "string" },
      "doctorName": { "type": "string", "default": "your provider" }
    }
  },

  "contentSource": {
    "kind": "template",
    "templateKey": "medspa.appointment-reminder.email"
  },

  "channelPlan": [
    { "channel": "email", "templateKey": "medspa.appointment-reminder.email" },
    { "channel": "sms",   "templateKey": "medspa.appointment-reminder.sms" }
  ],

  "approvalPolicyKey": "system.transactional",
  "throttle": { "maxPerRecipientPerDay": 2, "cooldownHours": 12 }
}
```

### `channelPlan` is the *supported* set, not the effective one

The caller's `channels` are **intersected** with it. Every case in the source
guarded each dispatch with `if (event.channels.includes(X))` — 24 such checks —
so the caller has always had the final say. An `APPOINTMENT_REMINDER` arriving
with `channels: ['email']` sends one email, not an email and an SMS. Treating the
plan as authoritative would double the volume on every two-channel playbook.

A trigger naming no channels takes the whole plan, which is what a scheduled or
manual invocation wants.

`metadata.alwaysSendChannels` exempts an entry from the intersection. One
playbook uses it: `medspa.emergency-notification`, because the source posts its
Slack alert unconditionally and an emergency a caller could silence by omitting a
channel would be a bad design.

### `fixedTarget` for destinations that are not a recipient's

A Slack channel or a webhook URL. Prefix with `$config.` to resolve it from
`tenant_packs.config` at install:

```jsonc
{ "channel": "slack", "fixedTarget": "$config.slackChannels.staffAlerts" }
```

### `dataContract`: optional-with-default, not required

Validated **before** any model call, template lookup or send, so a contract
violation produces a `FAILED` run row carrying the schema errors instead of a
thrown exception and a `logger.warn`.

The rule when porting: **a field the old code read defensively becomes optional
with a default.** The source's `data.patientName || 'there'` becomes
`{"type": "string", "default": "there"}`. Marking it required would start
failing events that work today.

### `where` is a bounded predicate object, deliberately

Seven operators — `eq`, `neq`, `in`, `nin`, `gt`, `lt`, `exists` — over dotted
paths into the payload. **Do not turn this into an expression language.** The
answer to a harder condition is a named predicate registered in code behind a
port, not a parser in a JSON file. A test rejects unknown operators.

### Approval is decided by content source

> `contentSource.kind === 'ai'` → a policy that reviews
> `contentSource.kind === 'template'` → `system.transactional`

**The schema enforces the reasoning, not the outcome**: a playbook with a
non-template `contentSource` and no `approvalPolicyKey` **fails validation at
load**, naming the file. An AI-written message that silently needs no review is
the one mistake this must not allow.

Why a rule rather than a list: it reproduces the source's behaviour exactly,
because every switch-derived playbook is template-rendered and every
approval-requiring path there is AI-generated. Seeding all 17 as
"provider must approve" would have stopped every appointment reminder at cutover.

### AI playbooks ship inactive

Nothing in the source sends them; they are new capability, not a port. Deploying
a pack must never be the moment a tenant starts sending model-written messages —
that is a tenant's decision. One call switches it on:

```bash
curl -X POST .../v1/playbooks/medspa.treatment-followup-ai/activate
```

---

## `policies/*.json`

```jsonc
{
  "key": "medspa.provider-always",
  "name": "Provider reviews every message",
  "mode": "always",                 // always | threshold | sample | none
  "confidenceThreshold": 0.8,       // threshold mode only
  "sampleRate": 0.1,                // sample mode only
  "approverResolution": { "kind": "agent" },
  "rights": { "edit": true, "bulk": false },
  "sla": { "hours": 24, "onExpiry": "escalate", "fallbackApproverRef": "…" }
}
```

**`mode: "none"` writes no approval row at all.** The runtime skips `submit()`
entirely and dispatches. An appointment-reminder-heavy tenant would otherwise
grow `approvals` at exactly the rate it grows `messages`, entirely with rows
recording that no decision was needed.

`sample` and `threshold` *do* go through submit, and that is not inconsistent:
there the auto-approval is a real decision about a specific message — this one
was in the 90% the sample skipped, that one cleared the bar — and recording it is
the point of having the mode.

A playbook still names `system.transactional` explicitly rather than leaving the
policy unset, so "no approval needed" is an authored, auditable choice.

**`threshold` mode consumes `aiConfidence`, which is a heuristic** — a
deterministic composite of context completeness less a penalty per lint warning,
*not* the model's self-assessment. It ships refusing to fire without
`tenant_packs.config.allowAutoApprove`.

**`rights.bulk` is required in addition to the `outreach:approve:bulk`
permission.** Not redundant: a permission is granted per user, usually broadly,
while the right is authored per policy by the tenant. A clinic that decides
messages under one policy must be read one at a time is not overridden by an
admin holding a broad permission.

---

## `templates/*.json`

```jsonc
{
  "key": "medspa.appointment-reminder.sms",
  "name": "Appointment reminder (SMS)",
  "channel": "sms",
  "subject": "Your appointment on {{context.appointmentDate}}",
  "content": "Hi {{recipient.firstName}}, …",
  "format": "TEXT",                 // TEXT | HTML | MARKDOWN | MJML
  "category": "reminders"
}
```

Handlebars. The render context is namespaced deliberately:

| Namespace | Filled by |
|---|---|
| `recipient` | the recipients table, plus whatever the context provider resolved |
| `sender` | the agent config |
| `tenant` | the tenant row — including `timezone` and `locale` |
| `context` | the caller's event payload, after contract validation |
| `message` | channel, playbook key, `unsubscribeUrl` |
| `now` | ISO timestamp at render |

`{{formatDate}}` resolves timezone and locale from the context — recipient first,
then tenant. Not the server's. A 9am reminder for a New York clinic reading as
2pm because the pod runs in UTC is the class of defect this exists to prevent.

The renderer has **its own Handlebars environment**, not the global singleton, so
two packs' helpers cannot overwrite each other and test order cannot matter.

---

## `aliases.json`

Legacy variable names, rewritten in the template source before compilation:

```jsonc
{
  "$comment": "Old template bodies say {{patientName}}; the context says recipient.displayName.",
  "patientName": "recipient.displayName",
  "providerName": "sender.displayName"
}
```

Only bare identifiers are rewritten — a path that already contains a dot is left
alone, so a migrated template is unaffected. `{{#if patientName}}` works too.

---

## `event-types.json`

```jsonc
{
  "aliases": {
    "APPOINTMENT_RESCHEDULING": ["APPOINTMENT_RESCHEDULED"],
    "TREATMENT_COMPLETION": ["TREATMENT_COMPLETED"]
  },
  "known": ["APPOINTMENT_REMINDER", "APPOINTMENT_CONFIRMATION"]
}
```

**Aliases are required, not convenience.** The source's `EventType` enum and its
handler switch disagree: the enum declares `APPOINTMENT_RESCHEDULED` while the
switch matches `APPOINTMENT_RESCHEDULING`, and **eight** handled event types are
not enum members at all. Both spellings are in production callers, so both must
resolve to the same playbook.

The engine's own trigger type is a plain `string`. It does not enumerate what
events exist — which is exactly how the enum and the switch came to drift apart
with nobody noticing, and 27 of 44 enum values ended up with no handler.

---

## `ehr-mapping.json`

Vendor event names → outreach events. Two rule kinds:

```jsonc
{
  "rules": [
    { "event": "appointment_no_show", "eventType": "APPOINTMENT_MISSED",
      "priority": "HIGH", "channels": ["sms"], "reason": "…" },
    { "contains": ["appointment", "reminder"], "eventType": "APPOINTMENT_REMINDER" },
    { "event": "visit_done", "source": "epic", "eventType": "TREATMENT_FOLLOWUP" }
  ]
}
```

**Exact beats pattern. Within a tier, the first declared rule wins.** Declaration
order is the tie-break rather than "most specific wins", because specificity
sounds better and becomes unpredictable once three rules overlap. You order the
file; the engine does not second-guess it.

`contains` requires **every** term, not any.

**An unmapped event returns nothing.** The source guesses — a fallback that picks
a mapping for anything, so an unrecognised vendor event still sends a patient a
message chosen by heuristic. There is no safe default when the output is a
message to someone's patient. `POST /ehr-webhook/process-event` reports
`{mapped: false}` with a 200.

---

## `compliance.json`

Lint rules, merged over the engine defaults:

```jsonc
{
  "$comment": "Rules on top of the engine's own length and PHI checks.",
  "prohibitedPhrases": ["guaranteed results", "cure"],
  "phiPatterns": ["\\bMRN[- ]?\\d+\\b"],
  "maxLength": { "sms": 320 }
}
```

Warnings, not errors: they lower `aiConfidence` (0.15 each) and surface on the
draft for a human to glance at. Every installed pack's rules are merged, not just
the draft's own — the composition root builds one generator and does not know
which pack a given draft belongs to. A false warning from another vertical costs
one human glance; threading a pack id through generation is the playbook
runtime's job.

---

## `prompts/*.json`

```jsonc
{
  "key": "medspa.followup",
  "version": 1,
  "persona": "You are writing on behalf of {{sender.displayName}} at {{tenant.name}}…",
  "goal": "Write a post-treatment follow-up…",
  "constraints": [
    "Never restate clinical details the recipient did not already receive in writing.",
    "Do not give medical advice. Direct clinical questions to the clinic."
  ],
  "channelRules": {
    "sms": "One or two sentences, under 320 characters. No subject line.",
    "email": "Subject under 60 characters. Short paragraphs."
  },
  "modelHints": { "temperature": 0.7, "maxTokens": 800 }
}
```

**The pack owns sampling.** `temperature` and `maxTokens` are not overridable per
request: two callers of the same prompt getting differently-sampled output, then
blaming the prompt, is a debugging problem nobody needs. `model` and `tone` stay
overridable because they are editorial choices.

Prompts are content. Changing the wording of one is a data change, not a release
— which is the whole reason the eight hardcoded `/ai` prompt builders became
seven pack files.

---

## Installing a pack

```bash
curl -X POST .../v1/packs/medspa/install \
  -H 'content-type: application/json' \
  -d '{"config": {"emergencyContacts": ["ops@clinic.example"],
                  "slackChannels": {"staffAlerts": "#staff"}}}'
```

Install is idempotent. It seeds the pack's playbooks, templates and policies for
the tenant, and records `config` on `tenant_packs`. A second install updates.

Check what loaded, and what did not:

```bash
curl .../v1/packs        # { packs: [...], errors: [...] }
curl .../v1/playbooks    # this tenant's playbooks, with isActive
```

---

## Known gaps

Found by writing the second pack. Each is a place the engine is *not* yet as
general as this document claims, recorded here rather than patched around —
P11's exit criterion is that no engine file changes to make a new pack work, so
a gap that would need one is a finding, not a bug to sneak a fix in for.

### A campaign cannot name its playbook directly

`OutreachTrigger` has no "run this playbook" field, and the matcher selects on
trigger type, event type and a `where` predicate. So a campaign targets its
playbook through the predicate: the orchestrator puts `campaignPlaybookKey` in
the payload and a campaign-capable playbook declares

```jsonc
{ "type": "campaign", "where": { "campaignPlaybookKey": { "eq": "lead.followup" } } }
```

It works, and it is arguably better than a dedicated field — the rule is
readable in the pack file.

**~~But nothing enforces it~~ — closed in P12.** It was a convention, and a pack
author who omitted the predicate got a playbook that fired on **every** campaign
the tenant ran with nothing warning them. The playbook schema now rejects a
campaign trigger with no `campaignPlaybookKey` predicate, naming the file and
the fix:

```
playbook 'lead.followup' has a campaign trigger with no 'campaignPlaybookKey'
predicate, so it would fire on every campaign this tenant runs — add
where: { campaignPlaybookKey: { eq: 'lead.followup' } }
```

The convention is unchanged; it is now checked at load. See D82.

### ~~`cancel` cannot recall a queued message~~ — closed

`NotificationQueue.remove()` exists now, and cancel uses it: queued-but-unsent
messages are pulled back and marked `CANCELLED`. The response reports
`{cancelled, recalled, alreadySending}`, where the last is the honest limit — a
message a worker already holds may be mid-send, and no queue can promise
otherwise. See D91.

### Two levels of one payload do two different jobs

The matcher reads its predicate from the payload **root**; the renderer's
`context` namespace comes from `payload.context`. Nothing signals this, and
putting a field at the wrong level renders an empty template with no error —
the campaign orchestrator shipped with exactly that bug for one commit, caught
only by a test whose expected value happened to differ from the contract
default.

---

## Writing a new pack

1. **Decide the tier for every piece of data** before writing any file. Most of
   it is tier 1 or 2, and the answer is usually "no table".
2. `manifest.json` first — the id must match the directory.
3. List the events in `event-types.json`, including every spelling a caller
   already sends.
4. Write templates before playbooks; a playbook referencing a missing
   `templateKey` fails validation, which is the fast way to catch a typo.
5. Give every AI playbook an `approvalPolicyKey`, or it will not load.
6. Ship AI playbooks `isActive: false`.
7. Boot, and read `GET /v1/packs`. An empty `errors` array is the goal.
