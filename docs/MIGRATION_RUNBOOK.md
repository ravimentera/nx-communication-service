# Migration runbook — mentera-core → outreach

Moving the communication data out of the shared `postgres` database and into the
outreach engine's own. Everything here is run **by a person**, in order, with the
output kept.

The whole thing is designed around one property: **no script writes to the
source.** Not a row, not a column, not a sequence. That is what makes the
rollback trivial (§9) and it is enforced three ways — the foreign server is
declared `updatable 'false'`, the connecting role should be read-only, and
`tests/integration/migration.test.ts` greps every file for a write against
`src.*` on every CI run.

> **Who runs what.** Every `psql` line below is yours. No agent, no CI job and no
> `npm` script applies a migration in this repo — `npm run migrate:print` exists
> only to print the commands. (Hard rule 1 of the extraction plan; D-record §1.4.)

---

## 0. The shape of it

| | |
|---|---|
| **Source** | database `postgres` on `mentera-proxy.…rds.amazonaws.com`, shared by every mentera service |
| **Target** | database `outreach`, new, empty, same instance |
| **Transport** | `postgres_fdw` — the source is mounted read-only as schema `src` |
| **Scaffolding** | schema `mig` in the target: settings, watermarks, quarantine, log |
| **Rollback** | `DROP DATABASE outreach` — the source is untouched |
| **Downtime** | the length of the load. The old service is stopped first and does not restart (§7) |

The files:

| File | Does |
|---|---|
| `scripts/inspect-source.sql` | Step 1 recon. Read-only, run against the **source**. |
| `migrations/9000_prelude.sql` | `mig` schema: settings, watermarks, quarantine, helper functions |
| `migrations/9001_source_link.sql` | FDW server + user mapping + `src` schema + the source's baseline row counts |
| `migrations/9002_tenants.sql` | `tenants`, `sub_tenants` |
| `migrations/9003_channel_configs.sql` | `tenant_channel_configs`, `agent_channel_configs` |
| `migrations/9004_recipients.sql` | `recipients` |
| `migrations/9005_templates.sql` | `templates`, `template_versions` (§0.5 Seam A) |
| `migrations/9006_preferences.sql` | `recipient_preferences` (§0.5 Seam B) |
| `migrations/9007_events.sql` | batches, events, notifications, schedules, ai interactions, memories, campaigns |
| `migrations/9008_messages.sql` | `messages`, `message_analytics` — the big one |
| `migrations/9009_approvals.sql` | `approvals`, both storage shapes, plus the backlog decision |
| `migrations/9010_verify.sql` | `mig.verify()` — the PASS/FAIL table |
| `scripts/delta-sync.sql` | **not used** — the parallel-run path, kept and tested. See §7b |
| `scripts/csv-staging.sql` | the fallback transport, if FDW is impossible |

> **On the numbering.** The plan (§P9 step 2) sketched a different order: messages
> at 9006, approvals at 9007, events at 9008. That order cannot run.
> `messages.event_id` and `messages.notification_id` are real foreign keys
> (0001), so events and notifications have to exist before a single message row
> can be inserted. The files were renumbered so that **numeric order is
> dependency order** and `psql -f` them in sequence is always right. Verify keeps
> its number, 9010. There is no pack migration at any number — §0.5 Seam D is
> closed and nothing migrates from the seven ghost tables (D11, D12).

---

## 1. Pre-flight

- [ ] **A fresh `pg_dump` of the source tables.** Not because a script will
      damage them — none can — but because the rest of this document is only
      safe to attempt if that is true, and a dump is how you stop having to
      trust it.
      ```bash
      pg_dump "$SOURCE_URL" --no-owner \
        -t message_history -t message_analytics -t communication_events \
        -t notifications -t communication_preferences -t communication_templates \
        -t communication_memories -t communication_batches -t campaigns \
        -t campaign_recipients -t scheduled_communications -t ai_interactions \
        -t medspa_configurations -t provider_configurations -t template_versions \
        -f mentera-comm-preflight.dump
      ```
      **That file contains live Twilio, SendGrid and Slack credentials** (they
      are plaintext columns in `medspa_configurations`, and stay plaintext until
      P12). Treat it accordingly, and delete it when the cutover is signed off.
- [ ] **A read-only role on the source.** `GRANT CONNECT`, `GRANT USAGE ON
      SCHEMA public`, `GRANT SELECT` on the tables above. Nothing more.
- [ ] **The target has the baseline `0xxx` series applied** — `0001`–`0020`,
      minus the deliberately-absent `0004`, `0013` and `0014` — and no rows.
      **`0013` is not part of the baseline**: it retires the plaintext credential
      columns and is applied after the load, in §8b (D97). `0014` is a no-op
      against the current `0001` and exists only for a database built from the
      older file (D103).

      `0015`–`0020` landed in P13 and every one of them is baseline:

      | | What it adds | Why the load cares |
      |---|---|---|
      | `0015` | `UNIQUE (tenant_id, recipient_id, channel)` on `consent_records` | `9011` upserts against it and refuses to run without it |
      | `0016` | `playbooks.context_mapping`, `playbooks.priority_rules` | pack install writes both |
      | `0017` | partial unique index on inbound `provider_message_id` | dedupes a retried provider callback |
      | `0018` | `playbook_runs` status `RUNNING` | the run reservation writes it |
      | `0019` | `UNIQUE (campaign_id, recipient_id)` | campaign expansion upserts against it |
      | `0020` | webhook credential columns on `tenant_channel_configs` | none — but `9003` should not be re-run after it without re-reading §8b |
      | `0021` | `UNIQUE` on active `twilio_account_sid` | **refuses to apply** while two tenants share one — decide who owns each account first |
      ```bash
      npm run migrate:print          # prints the exact commands, runs nothing
      ```
      `0010_recipient_optins.sql` is the one to check twice if this database was
      first built before P10: `9006_preferences.sql` loads five columns that
      `0010` adds, so a target stuck at `0009` fails that loader outright. If
      `9006` already ran against such a target, re-run it after applying `0010` —
      it upserts, and its `DO UPDATE` repairs the rows that took the column
      default instead of the source's value.
- [ ] **Disk on the target** ≥ 1.5× the source's size for these tables.
- [ ] **`max_connections` headroom** — the FDW opens one connection per session.
- [ ] **A maintenance window IS required**, and it is the whole cutover (§7).
      Nothing in this document blocks the source — it is mounted read-only and no
      script can write to it — but the old service is stopped before the load and
      does not restart, so the window is however long §4 takes. It used to say
      "not required", which was true of the migration and false of the cutover
      once the two stopped being separated by a parallel run (D99).
- [ ] **Decide whether `COMPLIANCE_SHADOW_MODE` stays on.** It defaults to
      `true` and should stay that way through the window. `9011_consent.sql`
      seeds consent from the legacy preference data, and its second log line is
      the number of migrated recipients left with **no** consent on any channel —
      who will be blocked the moment shadow mode is turned off. Read that number
      before flipping it, not after.

      Until P13 there was nothing to decide: `consent_records` had no writer at
      all, so leaving shadow mode would have blocked essentially every send with
      `CONSENT_REQUIRED` and there was no API to clear a single one.

      **`require_opt_in` now defaults to `true` for a tenant with no
      `tenant_channel_configs` row.** It always did in the column; the gate read
      a missing row as `false`, so the least-configured tenant got the most
      permissive treatment. The count above is therefore not the whole picture —
      a tenant that never configured a channel needs consent too:

      ```sql
      SELECT t.id
      FROM tenants t
      LEFT JOIN tenant_channel_configs c ON c.tenant_id = t.id AND c.is_active
      WHERE t.is_active AND c.tenant_id IS NULL;
      ```

      Each of those either records consent, or gets a config row saying
      `require_opt_in = false` — deliberately, as a decision somebody made
      rather than as the absence of a row.
- [ ] **Decide `CHANNEL_DRY_RUN` before the window, not during it.** Approving a
      message sends for real in the new engine and sent nothing in the old one
      (D44), so the first approval after the repoint is the first real send this
      product has ever made.

---

## 2. Step 1 — reconnaissance

```bash
psql "$SOURCE_URL" -f scripts/inspect-source.sql | tee recon-$(date +%F).txt
```

Keep the output; §5 and §6 compare against it. Four numbers decide what you do
next:

| From the recon | Decides |
|---|---|
| §0 — the source's timezone, and the naive/UTC comparison | whether `mig.settings.source_timezone` (default `UTC`) is right. **Get this wrong and every timestamp in the new database is off by hours, silently.** |
| §4 — the approval backlog in **both** storage shapes | whether §5's approval count is complete. One shape alone reports half the queue (D46). |
| §5 — `approved_any` | `historic_approved_disposition`. See §5.3. |
| §8 — the seven ghost tables | whether §0.5 Seam D is still closed. **A non-zero count stops the migration.** |
| the distinct `medspa_id` list | whether any is literally `platform`. `0011_platform_tenant.sql` reserves that id, and 9002 uses `medspa_id` verbatim — a collision means 9002 silently skips that medspa and its mail goes out under the platform tenant. `0011` refuses to apply over an existing row it did not create, so you will hit this at apply time rather than in production, but it is cheaper to see it here. |

Also read §1 (columns) against the loaders: `medspa_id`, `message_direction`,
`conversation_id`, `sender_name` and `participant_phone` are declared in the
source's Drizzle model but appear in none of its own migrations — they arrived
via `drizzle push`. If one is genuinely absent, the load fails on its first
statement rather than halfway.

---

## 3. Step 2 — link the source

```bash
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f migrations/9000_prelude.sql
```

Then fill in the connection, and the timezone the recon confirmed:

```sql
UPDATE mig.settings SET value = 'mentera-proxy.…rds.amazonaws.com' WHERE key = 'source_host';
UPDATE mig.settings SET value = 'postgres'                          WHERE key = 'source_dbname';
UPDATE mig.settings SET value = 'outreach_migration_ro'             WHERE key = 'source_user';
UPDATE mig.settings SET value = '…'                                 WHERE key = 'source_password';
UPDATE mig.settings SET value = 'UTC'                               WHERE key = 'source_timezone';
```

```bash
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f migrations/9001_source_link.sql
```

9001 clears the password from `mig.settings` once the user mapping holds it, and
records the source's row counts in `mig.source_baseline` — which is how 9010 can
later prove nothing vanished from the source while you worked.

Three checks before continuing:

```sql
SELECT foreign_table_name FROM information_schema.foreign_tables WHERE foreign_table_schema = 'src';
SELECT count(*) FROM src.message_history;                  -- matches the recon
UPDATE src.message_history SET status = status WHERE false; -- MUST fail
```

The last one must answer `ERROR: foreign table "message_history" does not allow
updates`. If it succeeds, stop: the read-only guarantee this runbook rests on is
not in place.

**No FDW available?** Use `scripts/csv-staging.sql` instead and read its header
first — the export lands plaintext PHI and credentials on a disk, and a
truncated export is invisible to every check downstream except the row counts
you compare by hand.

---

## 4. Step 3 — load, in order

Each file is idempotent and each of the last three is resumable: interrupted,
they keep every window they committed and restart from their watermark. Re-run
the same command.

```bash
for f in 9002_tenants 9003_channel_configs 9004_recipients 9005_templates \
         9006_preferences 9007_events 9008_messages 9009_approvals \
         9011_consent; do
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f "migrations/$f.sql"
done
```

`9011_consent` is last, and after `9006` specifically: it reads the preference
rows `9006` wrote. It seeds a consent record for every migrated recipient the
legacy data shows as contactable — `allow_communications` AND the per-channel
opt-in — on `email` and `sms` only.

**Read its second log line before you turn compliance enforcement on.** It
counts the migrated recipients left with no consent on any channel, who will be
blocked the moment `COMPLIANCE_SHADOW_MODE` goes to `false`:

```sql
SELECT detail, n FROM mig.log WHERE loader = '9011_consent' ORDER BY at;
```

Every row it writes carries `source = 'migration'` and a `proof` object naming
the columns it was derived from. That is deliberate and it should stay legible:
the source system recorded **no explicit consent event**, so these are an
inference from a pre-existing contact relationship, not evidence that anybody
signed anything. A recipient who had opted out gets **no row** rather than a
revoked one — a revoked row would assert they once consented, which is exactly
the thing this cannot know.

Run them one at a time the first time, and read the tail of each — every file
ends with the queries worth running immediately after it.

| File | Expect | Watch for |
|---|---|---|
| 9002 | seconds | tenants whose `name` equals their `id` — those had no configuration row |
| 9003 | seconds | counts must equal the source exactly; there is no legitimate reason for a config not to migrate |
| 9004 | seconds–minutes | the count must match the recon's "recipients_expected" |
| 9005 | seconds | quarantined templates (§5.4) and the `notification_rules` check — **P10 depends on it** |
| 9006 | seconds | collapsed duplicate preference rows, and rows with no `patient_id` |
| 9007 | minutes | quarantined notifications and batches: both derive their tenant from a parent |
| 9008 | **the long one** — one commit per month of history | progress with `SELECT * FROM mig.progress` from another session |
| 9009 | seconds–minutes | the two shape counts, against the recon's §4 |

Watch a long run from a second session:

```sql
SELECT loader, watermark, rows_done, updated_at FROM mig.progress ORDER BY loader;
SELECT loader, detail, n FROM mig.log ORDER BY id DESC LIMIT 20;
```

---

## 5. The five decisions you own

Everything else in the migration is mechanical. These are not.

### 5.1 `source_timezone` (default `UTC`)

The source stores `timestamp without time zone` everywhere, so the instant a
value represents is implied by whatever wrote it. The migration states the
assumption instead of inheriting the session's. Recon §0 is the check.

### 5.2 `default_tenant_timezone` (default `America/New_York`)

For tenants that exist only in message rows. It matches the source's own default
for a medspa configuration, **not** the target schema's `UTC` — a clinic sending
9am reminders should not begin sending them at 4am.

### 5.3 `historic_approved_disposition` (default `CANCELLED`)

Approving a message in mentera-core has never sent anything: it flips two status
columns nothing reads back (D44). So the source holds `APPROVED` messages going
back to launch that no recipient ever received. Migrating them as `APPROVED`
means the engine's release path could put a year of stale appointment reminders
into the world at cutover.

Default: they become `CANCELLED`, with the reason in the audit trail, and the
message goes with them.

**Widened in D99, and it now governs two procedures rather than one:**

| Procedure | Covers | Runs |
|---|---|---|
| `mig.apply_backlog_disposition()` | approvals at `APPROVED` / `SCHEDULED`, and their messages | at the end of `9009`, and on every delta |
| `mig.finalize_cutover()` | the above, **plus** approvals still `PENDING_APPROVAL`, **plus** never-sent messages with no approval at all (`PENDING`, `QUEUED`) | once, by hand, after the source has stopped |

`PENDING_APPROVAL` used to be left alone on the reasoning that those rows were
"genuinely in flight". That reasoning assumed a live system on both sides of the
cutover. There is none: the old service stops before the migration and does not
restart, so in flight means never moving.

**Why `CANCELLED` and not `SENT`.** Marking them sent was considered — it demos
better, and it is mechanically safe, because nothing in the engine re-sends a
message whatever its status (neither the rate limiter nor the per-playbook
throttle reads the column, and no sweeper walks it). It was rejected because it
is not true: the product would be asserting it delivered messages nobody
received, and `sent_at` — copied verbatim from a source that writes it at INSERT
time — would read as a delivery timestamp for a delivery that never happened.

Nothing is lost either way. Every migrated message carries its original word:

```sql
SELECT metadata->'migration'->>'sourceStatus' AS was, count(*)
  FROM messages WHERE metadata->>'migrated' = 'true' GROUP BY 1 ORDER BY 2 DESC;
```

Read `approved_any` from recon §5 before changing this. (Note that recon prints
`approved_and_sent_at_is_null` too, and that it is always 0: `sent_at` is
`NOT NULL` in the source and written at insert time, so "never sent" is not
expressible as a predicate on it. The number that matters is `approved_any`.)

Setting it to anything other than `CANCELLED` disables **both** procedures and
the two verify checks that depend on them — the rows load as-is, and live-state
rows are then your intent rather than a fault.

```sql
-- only after reading the count
UPDATE mig.settings SET value = 'APPROVED' WHERE key = 'historic_approved_disposition';
```

### 5.4 `template_fallback_tenant` (default: unset)

`communication_templates.medspa_id` is nullable and the table has two owners
(§0.5 Seam A). A template with no tenant cannot be migrated — `tenant_id` is
`NOT NULL` and guessing is how one clinic's message body ends up in another
clinic's inbox — so those rows are quarantined.

That has a consequence: a `notification_rules` row pointing at a quarantined
template will not resolve after P10. 9010 checks for exactly this. If the recon
shows such templates and their owner is genuinely knowable, either fix
`medspa_id` in the source and re-run 9005, or set the fallback deliberately:

```sql
UPDATE mig.settings SET value = 'medspa-xyz' WHERE key = 'template_fallback_tenant';
```

### 5.5 `watermark_lag_minutes` (default `5`)

How far behind `now()` a watermark may advance. It exists to close a race, not
to be tuned: a loader scans under one MVCC snapshot and marks the window done,
while a transaction that began before that snapshot commits after it — inserting
rows whose `created_at` falls inside the window just completed. Nothing looks
there again. The lag makes the next pass re-read the overlap, which costs
nothing because every insert is `ON CONFLICT DO NOTHING`.

The cost is that the most recent few minutes always wait for the next run.

**Set it to 0 before the load.** The race it guards against needs a source that
is still writing, and this cutover stops the old service first (§7). Leaving the
default at 5 would strand the last five minutes of history with no second pass
to collect it:

```sql
UPDATE mig.settings SET value = '0' WHERE key = 'watermark_lag_minutes';
```

---

## 6. Step 4 — verify

```bash
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f migrations/9010_verify.sql
```

```sql
SELECT * FROM mig.verify() WHERE status <> 'PASS';
```

**Do not cut over with a FAIL.** Each one means a count the migration cannot
explain, and every one of them has a diagnostic query in the tail of the file
that produced it.

`WARN` needs a person, not a glance:

| WARN | Means | What to do |
|---|---|---|
| `quarantined rows` | rows the migration refused to guess at | reconcile against the recon: every quarantined row should be one the recon predicted |
| `source rows added since the link` | the old service is still writing | **must be 0.** The old service is stopped before the load (§7); anything else means it is not actually stopped |

```sql
SELECT loader, source_table, reason, count(*) FROM mig.rejects GROUP BY 1,2,3 ORDER BY 4 DESC;
SELECT loader, detail, n FROM mig.log ORDER BY id;
```

Then look at the data with your own eyes. Counts agreeing is not the same as the
data being right:

```sql
-- a conversation, end to end
SELECT m.sent_at, m.direction, m.channel, m.status, r.display_name, left(m.content, 60)
FROM messages m LEFT JOIN recipients r ON r.id = m.recipient_id
WHERE m.tenant_id = '<a real tenant>'
ORDER BY m.sent_at DESC LIMIT 20;

-- who is actually waiting on an approval
SELECT approver_ref, count(*) FROM approvals WHERE status = 'PENDING_APPROVAL' GROUP BY 1;
```

---

## 7. Step 5 — the cutover

> **There is no parallel run.** This section used to describe one: the old
> service kept serving while an hourly delta sync kept the target current, and
> the migration ran days before the repoint.
>
> That was written for a product with live traffic. This one is in demo phase —
> no real client, no meaningful traffic, and no staging environment. **The old
> service is stopped before the migration and never starts again**, which makes
> the parallel run machinery not just unnecessary but wrong to use: its whole
> premise is that mentera-core is still the source of truth for migrated rows.
>
> The delta sync still exists, is still tested, and §7b describes when it would
> apply. It is not your path. See D99.

The cutover is one sitting, and the old service is down for its duration.
Nothing is queued behind it, so the window is however long the load takes —
dominated by `9008`, which is the only file measured in more than minutes.

### The window

**1. Stop the old communication-service.** Scale it to 0. Note the time. Keep
the container image — it is the rollback (§9).

**2. Drain nothing.** There is no queue worth draining: a BullMQ job in flight
is a message the new service has no job for, and `mig.finalize_cutover()` in
step 5 cancels those rows rather than pretending they will arrive. `SELECT * FROM
messages WHERE status = 'QUEUED'` in the source is the count you are choosing to
abandon; read it once so the number is known rather than discovered.

**3. Let the watermarks run right up to now.** The lag exists to close a race
against a *writing* source (§5.5). Nothing is writing.

```sql
UPDATE mig.settings SET value = '0' WHERE key = 'watermark_lag_minutes';
```

**4. Run the load** — §4, in order, `9002` through `9009`. First time and last
time; there is no earlier bulk pass to catch up from.

**5. Finalize.** The step that makes everything migrated terminal:

```sql
CALL mig.finalize_cutover();
```

It cancels approvals still open, and never-sent messages with no approval of
their own — because with the old service stopped for good, a row that was in
flight is a row that will never move, and leaving it puts a queue of drafts
nobody will action into every provider's inbox on day one.

It is **not** part of the load, and must not be run before the source has
stopped: cancelling appends an audit entry, which permanently disqualifies a row
from any later refresh. Run it early and you freeze rows the source would still
have moved on. It is idempotent once the source is stopped.

Read what it did:

```sql
SELECT loader, detail, n FROM mig.log WHERE detail LIKE '%finalize%' ORDER BY id;

-- and what those rows used to say, which cancelling does not destroy
SELECT metadata->'migration'->>'sourceStatus' AS was, count(*)
  FROM messages WHERE metadata->>'migrated' = 'true' GROUP BY 1 ORDER BY 2 DESC;
```

**6. Verify** (§6). No `FAIL`, and `source rows added since the link` must be 0 —
with the source stopped, anything else means it is not actually stopped.
`finalize_cutover` also flips two checks from no-ops into hard assertions:
`migrated messages left in a live state` and `migrated approvals left in a live
state` must both be 0.

**7. Encrypt the credentials** (§8b). This used to be blocked until the parallel
run ended, because `9003` kept re-inserting plaintext. There is no parallel run,
so it happens here, once, before anything serves traffic.

**8. Install the packs.** Not part of this migration — `packs`, `tenant_packs`
and the playbook rows are *content*, they come from `packs/medspa/`, and P7's
installer owns them:

```bash
curl -X POST …/v1/packs/medspa/install -d '{"config": {…}}'
```

Install now refuses if the pack's `requiredConfig` is missing, naming every
absent key (D95). See `docs/PACKS.md`.

**9. Repoint and start.** Change `COMMUNICATION_SERVICE_URL` in each of the five
places (P10 Step 3), start the new service, and walk `docs/api/BREAKING.md`.

### What to check first, and why it is a short list

The "watch at cutover" list in `BREAKING.md` was written for a service with
users. Two entries still matter here, for a different reason:

- **Approvals now dispatch.** Approving sent nothing in the old service (D44).
  It sends for real now. The historic backlog is cancelled by step 5, so there
  is no queue waiting to go out — but the first *new* approval will send.
  Confirm `CHANNEL_DRY_RUN` is what you intend before anyone clicks approve.
- **The provider inbox returns 200 for the first time.** Its SQL was invalid and
  it has never returned anything but a 500 (D61), so the frontend's success path
  for that screen has never run against real data. It is the single most likely
  place to find a surprise.

### One thing that does not come back

**A delivery receipt for a message sent before the cutover will not match.** The
source never recorded a provider message id — it matched inbound replies by
(patient, provider, channel, most recent) at `webhooks-controller.ts:353` — so
`messages.provider_message_id` is NULL on every migrated row and `ReceiptService`
has nothing to join on. Those receipts are recorded as unmatched. One-off, and
it decays within the provider's retry window.

---

## 7b. The delta sync — not your path

Kept because it is written and tested, and because a future onboarding with live
traffic would need it. **Do not run it for this cutover.**

```bash
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f scripts/delta-sync.sql
```

It re-runs the loaders from their watermarks, then refreshes a trailing window
(`mig.settings.delta_refresh_days`, default 7) because `message_history` has no
`updated_at` — a row migrated last week and delivered today still carries last
week's `created_at`, so no watermark can see the change. A row older than the
window that changes is not picked up.

If it is ever used:

- **Only while the new service is not taking writes.** The refresh treats
  mentera-core as the source of truth for every migrated row; after a repoint it
  would overwrite the new service's own work with a stale copy.
- **`9002`, `9003` and `9005` are insert-only** — a tenant, credential or
  template *edited* in the old system is not carried across by re-running them.
  Delete the target row and re-run, or fix it by hand.
- **`9006_preferences.sql` is the exception**: it upserts, so re-applying carries
  an opt-out made during the window across. A lost opt-out is not staleness, it
  is messaging somebody who asked not to be messaged.
- **`mig.finalize_cutover()` runs once, at the very end** — never between deltas.

---

## 8. What does not come across

Written down so nobody has to discover it during an incident.

| Not migrated | Why | Consequence |
|---|---|---|
| `messages.provider_message_id` | the source never records one | §7, receipts for pre-cutover messages do not match |
| `template_versions.channel` / `.format` / `.status` | no column in the target; they are properties of the template, and the parent row carries all three | none, unless someone reads a version row expecting them |
| `recipient_preferences.unsubscribe_token` | the source has none; P5 mints one on demand | none |
| `ai_interactions.cost_usd` | the source estimated tokens by word count and never priced anything (D31) | historic AI spend is unknowable, and inventing it would be worse |
| the seven §0.5 Seam D tables | all empty, no tenant column, demo scaffolding behind them (D11) | none — and 9010 re-checks the premise |
| BullMQ jobs in flight | a queue is not a database | drain the old queues before stopping the service, or accept that queued-but-unsent messages are lost. They are visible: `SELECT * FROM messages WHERE status = 'QUEUED'` |
| scheduled sends | the source's `scheduledFor` was a string no scheduler consumed (D44); the approval keeps `SCHEDULED` but **no job exists** | re-schedule them by hand after cutover: `SELECT * FROM approvals WHERE status = 'SCHEDULED'` |

---

## 8b. Encrypting the channel credentials (P12, after cutover)

`credentials_encrypted` and `encryption_key_id` were reserved in P2 and unused
until P12. Filling them is **three ordered steps, and the order is the whole
thing** — the failure mode of getting it wrong is a tenant that cannot send.

> **Amended (D99).** This used to say "do not start until the parallel run is
> over", because `9003_channel_configs.sql` inserts plaintext credentials and the
> delta sync re-runs it — so nulling them mid-run meant they came straight back
> unsealed (D84). There is no parallel run: `9003` runs once, in the cutover
> window, and nothing re-inserts after it.
>
> **So this happens inside the window, at §7 step 7** — after the load and
> finalize, before the service serves anything. The steps below are unchanged;
> only their timing is.

### Step 1 — generate a key and deploy with it set

```bash
openssl rand -base64 32
```

Set `CREDENTIAL_ENCRYPTION_KEYS=k1:<that value>` and deploy. The service logs
`credential encryption is on` at boot with the key ids; if it logs
`credential encryption is off`, the variable did not reach the process — stop
and fix that before going on.

From this moment every credential written through `POST|PUT /config/medspa/*`
or `/v1/channels/configs` is sealed and its plaintext column is nulled in the
same write. Rows that already existed are untouched, which is what step 2 is for.

**Keep this key.** It is not in the database and it is not derivable. Losing it
means every sealed credential is gone and every tenant re-enters theirs.

### Step 2 — seal the rows that were already there

```bash
node scripts/encrypt-credentials.mjs            # reports, writes nothing
node scripts/encrypt-credentials.mjs --apply    # writes
```

Safe to re-run; an interrupted run resumes. It finishes by telling you whether
step 3 will be accepted.

### Step 3 — retire the plaintext

**Take a backup of `tenant_channel_configs` first.** This is the one step with
no rollback from inside the database: the plaintext is gone afterwards and only
the application can produce it again.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0013_encrypt_credentials.sql
```

It refuses to run if any row still holds an unsealed credential, and names the
tenants. It nulls the plaintext columns, leaves them in place, and adds a CHECK
so nothing puts plaintext back. `twilio_account_sid` is deliberately left alone
— an inbound Twilio callback is matched to a tenant by it.

Then send one message per configured channel per tenant. A credential that did
not seal correctly fails loudly at resolution; nothing falls back to plaintext.

### Rotating later

Add the new key alongside the old and move the active id:

```
CREDENTIAL_ENCRYPTION_KEYS=k1:<old>,k2:<new>
CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=k2
```

Deploy, then `node scripts/encrypt-credentials.mjs --apply --rotate`. Values
sealed under `k1` keep opening throughout, so there is no window where anything
is unreadable. Remove `k1` once no row names it:

```sql
SELECT encryption_key_id, count(*) FROM tenant_channel_configs GROUP BY 1;
```

### What this does not cover

`CredentialResolver` caches resolved credentials in Redis (D27), so a decrypted
credential lives in Redis for the cache TTL. Encryption at rest in Postgres does
not change that, and treating Redis as a secret store is a separate decision —
see D96.

---

## 9. Rollback

The target is new. Rollback is:

```sql
DROP DATABASE outreach;
```

…and re-create it, re-apply the `0xxx` series, and start again. Nothing in the source
changed, which is the property every other choice in this runbook was made to
protect.

Partial rollback, when one loader went wrong and the rest is fine:

```sql
-- example: redo the messages load from scratch
DELETE FROM message_analytics;
DELETE FROM approvals;      -- FK: messages cannot go before these
DELETE FROM messages;
DELETE FROM mig.progress WHERE loader IN ('messages','analytics','approvals');
DELETE FROM mig.rejects  WHERE loader IN ('9008_messages','9009_approvals');
```

then re-run 9008 and 9009. Deleting the watermark is what makes the loader start
over rather than resume.

After cutover is signed off, the scaffolding goes:

```sql
DROP SCHEMA mig CASCADE;
DROP SCHEMA src CASCADE;
DROP SERVER IF EXISTS mentera_source CASCADE;
```

Keep `mig` until then. `mig.rejects` is the only record of what was not
migrated, and someone will ask.
