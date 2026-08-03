# The lead-generation pack

A sales nurture pack for any industry. It exists to answer one question with a
test rather than an argument: **is this an outreach engine, or a medspa service
with the word filed off?**

`tests/acceptance/non-medspa-tenant.test.ts` is the answer. Its last assertion is
the real one — that no file under `src/engine/**` had to change to make a
real-estate tenant work.

## What is deliberately different from the medspa pack

| | medspa | lead-generation |
|---|---|---|
| `contextProviders` | `["mentera-patient"]` | **`[]`** — every rendered field arrives in the caller's payload |
| `requiredConfig` | four keys, because the source hardcoded four destinations | none |
| approver | `{kind: "agent"}` — a clinic message has an owner | `{kind: "role", role: "sales-manager"}` — a lead does not have one yet |
| approval mode | `always` for AI, `none` for template | `threshold` at 0.85, and it refuses to auto-approve until the tenant sets `allowAutoApprove` |
| compliance | PHI patterns, clinical phrase bans | CAN-SPAM/TCPA only. A sales message must be able to quote a price and say "results" |
| content | 17 playbooks ported from a switch | 5, re-expressing the `LEAD_*` enum values that never had a handler |

## The data contract replaces a table

`lead-message.service.ts` read a `lead_profiles` table — no tenant column, empty
in production, and the code behind it returned a hardcoded "Jane Smith" (D11).
Nothing here has a table. The fields it read (`interests`, `inquiry_source`,
`conversion_stage`, `last_interaction`, `metadata`) are the caller's to supply
per event; anything durable belongs on `recipients.attributes` (§0.10, tiers 1
and 2).

Every contract field is optional with a default, because the source read them
all defensively — requiring one would start failing events that work today.

## Before a tenant sends anything

`lead.followup` is the only model-written playbook and it ships **inactive**
(D59). Installing a pack must never be the moment a tenant starts sending
model-written messages to strangers.

```bash
curl -X POST .../v1/packs/lead-generation/install
curl -X POST .../v1/playbooks/lead.followup/activate
```
