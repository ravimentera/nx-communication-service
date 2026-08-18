# Outreach Engine — full local surface

Every endpoint this service exposes, generated from `docs/api/openapi.yaml` plus
the surfaces that spec deliberately does not describe.

## Before you send anything

1. `docker compose up -d postgres redis`
2. Apply migrations `0001`–`0021`, skipping `0013` and `0014`
   (`npm run migrate:print` prints the exact commands)
3. `docker compose exec -T postgres psql -U outreach -d outreach -v ON_ERROR_STOP=1 -f /testing/seed-local.sql`
4. `LLM_PROVIDER=stub npm run dev`
5. `./testing/seed-packs.sh`

Step 4 matters: with `LLM_PROVIDER=bedrock` and no AWS account, every AI endpoint
fails at the model call. `stub` returns deterministic synthetic content so the
whole pipeline around the model is testable. Its output is prefixed `[stub-llm]`
so it can never be mistaken for real copy.

## Folder order is the recommended run order

**`00 · Auth, tenancy and negative cases` first.** Those requests establish that
the isolation boundary is real. If one of them returns the wrong status, stop —
a broken tenancy boundary makes every other result meaningless.

`98 · Retired mounts` should be **all 410s**. A 404 there means a mount is
missing; a 200 means the P12 trim missed something.

`99 · Legacy compat surface` is where the interesting behaviour lives. Roughly
forty deliberate differences from the old service are documented in
`docs/api/BREAKING.md`, and this folder is where you observe them. Each request's
description names the specific change and the decision record behind it.

## Things that will look like bugs and are not

- **A suppressed message is a `200`, not a `4xx`.** `queued: false` plus a
  reason. The caller asked correctly; the engine decided not to send. Only a
  malformed request is a 4xx.
- **AI playbooks are `isActive: false`.** Deploying a pack must never be the
  moment a tenant starts sending model-written messages. `POST
  /v1/playbooks/:key/activate` switches one on.
- **`GET /templates?channel=SMS` returns nothing; `?channel=sms` works.** Channels
  are stored lower-case to match the engine's own lookup. Legacy *responses*
  restore the upper case, so this asymmetry is visible only on the filter.
- **`queuedMessage` is always `null`** on conversation responses, and
  `isPendingApproval` / `isApproved` / `isDeclined` are always `false`. The column
  behind all four was dropped; the keys stay because the web and mobile apps read
  them and guard on the object being present.
- **`pendingApprovalCount` is always 0.** Structurally so, for a documented
  reason. Live approval state comes from `/approvals/*`.
- **The GDPR endpoints 403 for `t-alpha`.** They need the tenant to carry
  `{"gdpr": true}`. Switch `tenantId` to `t-gdpr` and the same call works.
- **`CHANNEL_DRY_RUN=true` means nothing leaves the machine.** Adapters log
  instead of dialling out. The whole resolve → render → gate → dispatch path runs;
  only the final wire call is skipped.

## Variables

`tenantId` (`t-alpha`) and `otherTenantId` (`t-beta`) are the two halves of every
isolation test. `t-gdpr` is a third tenant carrying a compliance profile, because
the GDPR endpoints are otherwise untestable.

Recipient variables map to the seeded edge cases:

| Variable | Covers |
|---|---|
| `recipientId` | happy path — email and SMS, active, consented |
| `recipientEmailOnly` | no phone, so an SMS send fails on *no contact point* |
| `recipientUnsubscribed` | suppressed regardless of channel or priority |
| `recipientQuietHours` | Asia/Tokyo — marketing defers, transactional does not |
| `otherTenantRecipientId` | the target of every cross-tenant negative test |

Ids the seed cannot pre-create (templates, campaigns, approvals) are captured
into collection variables by the matching `POST`. Run the create before the
requests that use its id.

## Regenerating

**This file and its environment are gitignored**, so a fresh clone has neither.
Build both:

```
node testing/build-postman.mjs    # the collection, from docs/api/openapi.yaml
node testing/bootstrap.mjs        # the environment, after the service is up
```

They are output, not source. The collection is ~300KB regenerated from the spec,
so committing it would mean a large diff on every route change and — worse — a
stale copy, where a request that 404s reads as a bug in the service rather than
as a file nobody re-ran. The environment holds ids minted at bootstrap,
including a plaintext API key the service returns exactly once.

`tests/contract/openapi.test.ts` fails if `openapi.yaml` drifts from the
registered routes, so regenerating inherits that guarantee — the collection is
correct by construction rather than by maintenance.

`testing/seed-local.sql` is the opposite: hand-written, and therefore covered by
`tests/integration/seed.test.ts`, which applies it to a throwaway container and
checks the fixtures still match the schema and the constants the engine reads.
