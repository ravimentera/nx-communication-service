/**
 * The P9 data migration, end to end, against two real databases.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS DOES NOT RUN A MIGRATION AGAINST ANY REAL DATABASE.
 *
 * Hard rule 1 forbids an agent or a tool from applying a migration. What happens
 * here is different in kind: testcontainers starts a brand-new, empty, throwaway
 * Postgres inside Docker, two databases are created inside it, synthetic rows
 * are inserted into one, the 9xxx series moves them into the other, and the
 * container is destroyed. It never has credentials for, or a route to, a
 * database that holds data. Verifying a migration before an operator runs it is
 * the entire point of writing one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The shape mirrors production deliberately: source and target are two databases
 * on ONE server, linked with postgres_fdw, which is the default transport in
 * docs/MIGRATION_RUNBOOK.md §3. The alternative CSV transport shares its DDL
 * with this test's source fixture, so a drift in one shows up as a failure here.
 *
 * What is asserted:
 *   - no 9xxx file and no recon query writes to the source, ever (static check)
 *   - 9000-9010 apply to a database that already has 0001-0008
 *   - naive source timestamps land as the right instant
 *   - both approval storage shapes migrate, including the one the plan's
 *     predicate would have missed (D46)
 *   - the historic APPROVED backlog is cancelled rather than released (D44)
 *   - unattributable rows are quarantined, not dropped, and not guessed at
 *   - mig.verify() reports no FAIL
 *   - re-running the whole series changes nothing
 *   - the delta sync picks up new rows and in-place status changes
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const SCRIPTS_DIR = join(ROOT, 'scripts');

const SOURCE_DB = 'mentera_source';

/**
 * Files are executed segment by segment, split on the `-- @@ SPLIT @@` marker.
 *
 * psql runs a file statement by statement and needs no such help. node-postgres
 * sends the whole string as one simple-query message, which Postgres wraps in an
 * implicit transaction — and the chunked loaders COMMIT between windows, which
 * is illegal inside one. The marker is a comment psql ignores; here it decides
 * where one `query()` ends and the next begins.
 */
function segments(sql: string): string[] {
  return sql
    .split(/^-- @@ SPLIT @@\s*$/m)
    .map((s) => s.trim())
    // A segment that is nothing but comments (every file ends with a block of
    // them) is not a statement. Stripping and testing what is left is linear;
    // a regex over the whole comment block is not.
    .filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

async function applyFile(client: Client, path: string): Promise<void> {
  for (const segment of segments(readFileSync(path, 'utf8'))) {
    try {
      await client.query(segment);
    } catch (error) {
      // A segment that fails inside its own BEGIN leaves the session in an
      // aborted transaction, and every later assertion then fails with
      // "current transaction is aborted" instead of the real reason.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

function schemaMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^0\d{3}_.*\.sql$/.test(f))
    .sort();
}

function dataMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^9\d{3}_.*\.sql$/.test(f))
    .sort();
}

let container: StartedPostgreSqlContainer;
let target: Client;
let source: Client;

/** The whole 9xxx series, in numeric order, exactly as the runbook runs it. */
async function runDataMigrations(): Promise<void> {
  for (const file of dataMigrations()) {
    await applyFile(target, join(MIGRATIONS_DIR, file));
  }
}

async function verify(): Promise<{ check_name: string; expected: string; actual: string; status: string }[]> {
  const { rows } = await target.query(
    `SELECT check_name, expected::text, actual::text, status FROM mig.verify() ORDER BY check_name`,
  );
  return rows;
}

async function one<T = string>(client: Client, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params);
  return rows[0] ? (Object.values(rows[0])[0] as T) : (undefined as T);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const uri = container.getConnectionUri();
  target = new Client({ connectionString: uri });
  await target.connect();

  // Two databases on one server — the production topology (§P9 step 2).
  await target.query(`CREATE DATABASE ${SOURCE_DB}`);
  source = new Client({ connectionString: uri.replace(/\/[^/]+$/, `/${SOURCE_DB}`) });
  await source.connect();

  // The source's shape comes from scripts/csv-staging.sql with `src.` rewritten
  // to `public.`. That file exists to stage the source inside the target, so its
  // DDL is by definition the source's DDL — and using it here means a column
  // added to one and not the other fails this test rather than a cutover.
  const sourceDdl = readFileSync(join(SCRIPTS_DIR, 'csv-staging.sql'), 'utf8').replace(
    /\bsrc\./g,
    'public.',
  );
  await source.query(sourceDdl);
  // A §0.5 Seam D ghost that exists and is empty, to exercise the guard's
  // present-but-empty branch (the other six are absent, which is the other one).
  await source.query(`CREATE TABLE IF NOT EXISTS promotions (id uuid PRIMARY KEY, name text)`);

  await seedSource();

  for (const file of schemaMigrations()) {
    await target.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  await applyFile(target, join(MIGRATIONS_DIR, '9000_prelude.sql'));
  await target.query(
    `UPDATE mig.settings SET value = $1 WHERE key = 'source_host'`,
    ['localhost'],
  );
  await target.query(`UPDATE mig.settings SET value = '5432'      WHERE key = 'source_port'`);
  await target.query(`UPDATE mig.settings SET value = $1 WHERE key = 'source_dbname'`, [SOURCE_DB]);
  await target.query(`UPDATE mig.settings SET value = $1 WHERE key = 'source_user'`, [
    container.getUsername(),
  ]);
  await target.query(`UPDATE mig.settings SET value = $1 WHERE key = 'source_password'`, [
    container.getPassword(),
  ]);

  for (const file of dataMigrations().filter((f) => f !== '9000_prelude.sql')) {
    await applyFile(target, join(MIGRATIONS_DIR, file));
  }
}, 300_000);

afterAll(async () => {
  await source?.end();
  await target?.end();
  await container?.stop();
});

/**
 * A fixture that reproduces the awkward parts of the real data rather than a
 * tidy version of it: two tenants where only one has a configuration row, a
 * message with no medspa_id, a preference row with no patient_id, duplicate
 * preferences, duplicate analytics, a template owned by nobody, and — the one
 * that matters most — an approval in each of the two storage shapes (D46).
 */
async function seedSource(): Promise<void> {
  const day = (n: number) => `now()::timestamp - interval '${n} days'`;

  await source.query(`
    INSERT INTO medspa_configurations
      (id, medspa_id, name, twilio_account_sid, twilio_auth_token, twilio_enabled,
       timezone, default_language, require_opt_in, retention_days, is_active,
       created_at, updated_at)
    VALUES
      ('11111111-1111-1111-1111-111111111111', 'medspa-a', 'Clinic A', 'AC123', 'tok-secret',
       true, 'America/Los_Angeles', 'en', true, 365, true, ${day(90)}, ${day(90)});

    INSERT INTO provider_configurations
      (id, provider_id, medspa_id, name, twilio_enabled, email_enabled, slack_enabled,
       receive_patient_notifications, receive_system_notifications,
       receive_marketing_notifications, auto_response_enabled, is_active,
       created_at, updated_at)
    VALUES
      ('22222222-2222-2222-2222-222222222222', 'provider-1', 'medspa-a', 'Dr A',
       true, true, false, true, true, false, false, true, ${day(90)}, ${day(90)});

    -- t1 migrates; t2 has no tenant; t3 has no channel. The last two are the
    -- quarantine cases, and 'active' -> 'published' / 'SMS' -> 'sms' are the
    -- normalisations 9005 has to make.
    INSERT INTO communication_templates
      (id, medspa_id, name, channel, subject, content, format, status, is_active,
       is_default, usage_count, version, created_at, updated_at)
    VALUES
      ('aaaa1111-0000-0000-0000-000000000001', 'medspa-a', 'Reminder', 'SMS', NULL,
       'Hi {{patientName}}', 'TEXT', 'active', true, false, 3, 1, ${day(80)}, ${day(80)}),
      ('aaaa1111-0000-0000-0000-000000000002', NULL, 'Orphan', 'Email', 's', 'body',
       'HTML', 'draft', true, false, 0, 1, ${day(80)}, ${day(80)}),
      ('aaaa1111-0000-0000-0000-000000000003', 'medspa-a', 'No channel', NULL, NULL,
       'body', 'TEXT', 'active', true, false, 0, 1, ${day(80)}, ${day(80)});

    INSERT INTO template_versions (id, template_id, version, name, content, created_by, created_at)
    VALUES
      ('bbbb1111-0000-0000-0000-000000000001', 'aaaa1111-0000-0000-0000-000000000001', 1,
       'Reminder', 'Hi', 'user-1', ${day(80)}),
      ('bbbb1111-0000-0000-0000-000000000002', 'aaaa1111-0000-0000-0000-000000000002', 1,
       'Orphan', 'Hi', 'user-1', ${day(80)});

    INSERT INTO notification_rules (id, medspa_id, event_key, email_template_id, created_at, updated_at)
    VALUES ('cccc1111-0000-0000-0000-000000000001', 'medspa-a', 'appointment.reminder',
            'aaaa1111-0000-0000-0000-000000000001', ${day(80)}, ${day(80)});

    -- Two rows for one (medspa, patient): the newer one wins. The third has no
    -- patient_id and cannot be keyed to a recipient at all.
    INSERT INTO communication_preferences
      (id, user_id, patient_id, medspa_id, allow_communications, preferred_channels,
       preferred_frequency, quiet_hours_start, quiet_hours_end, contact_info,
       created_at, updated_at)
    VALUES
      ('dddd1111-0000-0000-0000-000000000001', 'user-1', 'patient-1', 'medspa-a', true,
       ARRAY['EMAIL'], 'MODERATE', '21:00', '08:00',
       '{"email":"old@example.com"}'::json, ${day(70)}, ${day(70)}),
      ('dddd1111-0000-0000-0000-000000000002', 'user-1', 'patient-1', 'medspa-a', false,
       ARRAY['SMS'], 'LOW', '22:00', '07:00',
       '{"email":"jane@example.com","phone":"+15550001"}'::json, ${day(70)}, ${day(10)}),
      ('dddd1111-0000-0000-0000-000000000003', 'user-2', NULL, 'medspa-a', true,
       NULL, 'MODERATE', NULL, NULL, '{}'::json, ${day(70)}, ${day(70)});

    -- b1 has an event and so has a tenant; b2 has neither.
    INSERT INTO communication_batches (id, name, status, event_count, success_count, failure_count, created_at)
    VALUES ('eeee1111-0000-0000-0000-000000000001', 'Batch one', 'COMPLETED', 1, 1, 0, ${day(60)}),
           ('eeee1111-0000-0000-0000-000000000002', 'Orphan batch', 'DRAFT', 0, 0, 0, ${day(60)});

    INSERT INTO communication_events
      (id, type, priority, status, data, channels, metadata, patient_id, provider_id,
       medspa_id, location_id, created_at, retry_count, batch_id)
    VALUES
      ('ffff1111-0000-0000-0000-000000000001', 'APPOINTMENT_REMINDER', 'HIGH', 'PROCESSED',
       '{"appointmentDate":"2026-03-01"}'::json, ARRAY['sms'], '{}'::json, 'patient-1',
       'provider-1', 'medspa-a', '99999999-9999-9999-9999-999999999999', ${day(60)}, 0,
       'eeee1111-0000-0000-0000-000000000001'),
      ('ffff1111-0000-0000-0000-000000000002', 'TREATMENT_FOLLOWUP', 'MEDIUM', 'PENDING',
       '{}'::json, NULL, NULL, NULL, NULL, 'medspa-b', NULL, ${day(50)}, 0, NULL),
      ('ffff1111-0000-0000-0000-000000000003', 'ORPHAN_EVENT', 'LOW', 'PENDING',
       '{}'::json, NULL, NULL, NULL, NULL, NULL, NULL, ${day(50)}, 0, NULL);

    -- n1's recipient_id is a patient id and resolves; n2's is an address and
    -- lands in channel_ref; n3 has no event and so has no tenant.
    INSERT INTO notifications (id, event_id, channel, recipient_id, content, status, sent_at, created_at)
    VALUES
      ('a1a1a1a1-0000-0000-0000-000000000001', 'ffff1111-0000-0000-0000-000000000001',
       'SMS', 'patient-1', 'See you Friday', 'SENT', ${day(60)}, ${day(60)}),
      ('a1a1a1a1-0000-0000-0000-000000000002', 'ffff1111-0000-0000-0000-000000000001',
       'EMAIL', 'someone@example.com', 'See you Friday', 'SENT', ${day(60)}, ${day(60)}),
      ('a1a1a1a1-0000-0000-0000-000000000003', NULL,
       'SMS', 'patient-9', 'Orphan', 'PENDING', NULL, ${day(60)});

    INSERT INTO scheduled_communications (id, event_id, scheduled_for, status, created_at)
    VALUES ('b2b2b2b2-0000-0000-0000-000000000001', 'ffff1111-0000-0000-0000-000000000001',
            ${day(-5)}, 'PENDING', ${day(60)});

    INSERT INTO ai_interactions (id, event_id, model_id, success, tokens_used, created_at)
    VALUES ('c3c3c3c3-0000-0000-0000-000000000001', 'ffff1111-0000-0000-0000-000000000001',
            'anthropic.claude', true, 120, ${day(60)});

    INSERT INTO communication_memories
      (id, patient_id, provider_id, medspa_id, memory_type, content, created_at)
    VALUES ('d4d4d4d4-0000-0000-0000-000000000001', 'patient-1', 'provider-1', 'medspa-a',
            'PREFERENCE', 'Prefers afternoons', ${day(55)});

    INSERT INTO campaigns
      (id, name, type, status, template_id, provider_id, medspa_id, created_at, updated_at)
    VALUES ('e5e5e5e5-0000-0000-0000-000000000001', 'Spring', 'PROMOTIONAL', 'DRAFT',
            'aaaa1111-0000-0000-0000-000000000001', 'provider-1', 'medspa-a', ${day(45)}, ${day(45)});

    INSERT INTO campaign_recipients (id, campaign_id, patient_id, status, created_at)
    VALUES ('f6f6f6f6-0000-0000-0000-000000000001', 'e5e5e5e5-0000-0000-0000-000000000001',
            'patient-2', 'PENDING', ${day(45)});
  `);

  await source.query(`
    INSERT INTO message_history
      (id, notification_id, event_id, patient_id, provider_id, medspa_id, location_id,
       channel, content, status, sent_at, delivered_at, read_at, queued_message,
       metadata, created_at, message_direction, sender_name, participant_phone)
    VALUES
      -- m1: an ordinary delivered message, and the only source of a display name
      ('10000000-0000-0000-0000-000000000001', 'a1a1a1a1-0000-0000-0000-000000000001',
       'ffff1111-0000-0000-0000-000000000001', 'patient-1', 'provider-1', 'medspa-a',
       '99999999-9999-9999-9999-999999999999', 'SMS', 'See you Friday', 'SENT',
       ${day(60)}, ${day(60)}, NULL, NULL,
       '{"patientName":"Jane Doe","aiGenerated":true}'::json, ${day(60)},
       'OUTBOUND', 'Dr A', '+15550001'),

      -- m2: shape A, still pending
      ('10000000-0000-0000-0000-000000000002', NULL, NULL, 'patient-1', 'provider-1',
       'medspa-a', NULL, 'SMS', 'draft body', 'QUEUED', ${day(40)}, NULL, NULL,
       '{"approvalStatus":"PENDING_APPROVAL","content":"draft body"}'::jsonb,
       '{}'::json, ${day(40)}, 'OUTBOUND', NULL, NULL),

      -- m3: shape A, approved months ago and never sent — the D44 backlog. Note
      -- the status COLUMN is 'APPROVED' too, which is why shape A cannot be
      -- predicated on status = 'QUEUED'.
      ('10000000-0000-0000-0000-000000000003', NULL, NULL, 'patient-1', 'provider-1',
       'medspa-a', NULL, 'EMAIL', 'edited body', 'APPROVED', ${day(35)}, NULL, NULL,
       ('{"approvalStatus":"APPROVED","approvedBy":"user-9",'
        || '"approvedAt":"2026-02-01T10:00:00.000Z","content":"original body",'
        || '"originalContent":"original body","editedContent":"edited body"}')::jsonb,
       '{}'::json, ${day(35)}, 'OUTBOUND', NULL, NULL),

      -- m4: shape B, queued_message genuinely NULL
      ('10000000-0000-0000-0000-000000000004', NULL, NULL, 'patient-2', 'provider-1',
       'medspa-a', NULL, 'EMAIL', 'awaiting review', 'PENDING_APPROVAL', ${day(30)},
       NULL, NULL, NULL, '{}'::json, ${day(30)}, 'OUTBOUND', NULL, NULL),

      -- m5: shape B with queued_message = '{}' — the row the plan's
      -- "queued_message IS NULL" predicate would have skipped in BOTH passes.
      ('10000000-0000-0000-0000-000000000005', NULL, NULL, 'patient-2', 'provider-1',
       'medspa-a', NULL, 'EMAIL', 'no thanks', 'REJECTED', ${day(28)}, NULL, NULL,
       '{}'::jsonb, '{"originalContent":"before the edit"}'::json, ${day(28)},
       'OUTBOUND', NULL, NULL),

      -- m6: no tenant. Quarantined, never guessed at.
      ('10000000-0000-0000-0000-000000000006', NULL, NULL, 'patient-1', 'provider-1',
       NULL, NULL, 'SMS', 'tenantless', 'SENT', ${day(25)}, NULL, NULL, NULL,
       '{}'::json, ${day(25)}, 'OUTBOUND', NULL, NULL),

      -- m7: inbound, under the tenant that has no configuration row
      ('10000000-0000-0000-0000-000000000007', NULL, NULL, 'patient-3', 'provider-2',
       'medspa-b', NULL, 'SMS', 'thanks!', 'RECEIVED', ${day(20)}, ${day(20)}, NULL,
       NULL, '{}'::json, ${day(20)}, 'INBOUND', 'Patient', '+15550009'),

      -- m8: a status nobody has ever seen. Quarantined rather than mapped.
      ('10000000-0000-0000-0000-000000000008', NULL, NULL, 'patient-1', 'provider-1',
       'medspa-a', NULL, 'SMS', 'who knows', 'WEIRD_STATUS', ${day(15)}, NULL, NULL,
       NULL, '{}'::json, ${day(15)}, 'OUTBOUND', NULL, NULL);

    -- Two analytics rows for one message: 0008 forbids that in the target, so
    -- they fold into one rather than one of them being dropped.
    INSERT INTO message_analytics
      (id, message_id, notification_id, patient_id, opened_at, clicked_at, clicked_link,
       engagement_score, created_at)
    VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
       NULL, 'patient-1', ${day(59)}, NULL, NULL, 10, ${day(59)}),
      ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
       NULL, 'patient-1', NULL, ${day(58)}, 'https://example.com/x', 20, ${day(58)}),
      ('20000000-0000-0000-0000-000000000003', NULL,
       'a1a1a1a1-0000-0000-0000-000000000002', 'patient-1', ${day(57)}, NULL, NULL, 5, ${day(57)});
  `);
}

describe('the 9xxx series never writes to the source', () => {
  it('contains no write statement against src.*', () => {
    const offenders: string[] = [];
    for (const file of dataMigrations()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      // Comments are stripped first so that prose about what the migration does
      // NOT do cannot fail its own check.
      const code = sql.replace(/--[^\n]*/g, '');
      if (/\b(insert\s+into|update|delete\s+from)\s+src\./i.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the recon script read-only', () => {
    const sql = readFileSync(join(SCRIPTS_DIR, 'inspect-source.sql'), 'utf8').replace(
      /--[^\n]*/g,
      '',
    );
    expect(/\b(insert|update|delete|create|drop|alter|truncate)\b/i.test(sql)).toBe(false);
  });

  it('declares the foreign server read-only, so an accident fails at plan time', async () => {
    await expect(
      target.query(`UPDATE src.message_history SET status = status WHERE false`),
    ).rejects.toThrow(/does not allow updates/i);
  });
});

describe('tenants and sub-tenants', () => {
  it('creates a tenant for the configured medspa and for the one only messages mention', async () => {
    const { rows } = await target.query(`SELECT id, name, timezone FROM tenants ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['medspa-a', 'medspa-b']);
    expect(rows[0]).toMatchObject({ name: 'Clinic A', timezone: 'America/Los_Angeles' });
    // Invented tenants take the source's own default zone, not the schema's UTC:
    // a clinic sending 9am reminders must not start sending them at 4am.
    expect(rows[1]).toMatchObject({ name: 'medspa-b', timezone: 'America/New_York' });
  });

  it('turns every location_id into a sub_tenant under its tenant', async () => {
    const { rows } = await target.query(`SELECT id, tenant_id, external_ref FROM sub_tenants`);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe('medspa-a');
    expect(rows[0].external_ref).toEqual({ system: 'mentera-location', id: '99999999-9999-9999-9999-999999999999' });
  });

  it('copies channel credentials verbatim', async () => {
    const { rows } = await target.query(
      `SELECT tenant_id, twilio_account_sid, twilio_auth_token FROM tenant_channel_configs`,
    );
    expect(rows).toEqual([
      { tenant_id: 'medspa-a', twilio_account_sid: 'AC123', twilio_auth_token: 'tok-secret' },
    ]);
    expect(await one(target, `SELECT count(*) FROM agent_channel_configs`)).toBe('1');
  });
});

describe('recipients', () => {
  it('derives one recipient per (tenant, patient) with a reproducible id', async () => {
    const ids = await target.query(`
      SELECT tenant_id, external_ref->>'id' AS patient, display_name, first_name, last_name,
             contact_points, id = mig.recipient_id(tenant_id, external_ref->>'id') AS derived
      FROM recipients ORDER BY tenant_id, patient`);
    expect(ids.rows.map((r) => `${r.tenant_id}/${r.patient}`)).toEqual([
      'medspa-a/patient-1',
      'medspa-a/patient-2',
      'medspa-b/patient-3',
    ]);
    expect(ids.rows.every((r) => r.derived)).toBe(true);
  });

  it('takes the display name the source recorded and splits it for templates', async () => {
    const { rows } = await target.query(
      `SELECT display_name, first_name, last_name, contact_points FROM recipients
       WHERE external_ref->>'id' = 'patient-1'`,
    );
    expect(rows[0]).toMatchObject({
      display_name: 'Jane Doe',
      first_name: 'Jane',
      last_name: 'Doe',
    });
    // Email from the newest preference row, phone from it too — not from the
    // superseded row and not from the message's participant_phone.
    expect(rows[0].contact_points).toEqual([
      { type: 'email', value: 'jane@example.com', primary: true },
      { type: 'phone', value: '+15550001', primary: false },
    ]);
  });
});

describe('templates (§0.5 Seam A)', () => {
  it('preserves ids, so notification_rules still resolve after P10', async () => {
    expect(
      await one(
        target,
        `SELECT count(*) FROM src.notification_rules r
         WHERE r.email_template_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = r.email_template_id)`,
      ),
    ).toBe('0');
  });

  it('normalises channel and status to what the engine matches on', async () => {
    const { rows } = await target.query(
      `SELECT id, tenant_id, channel, status, format FROM templates`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: 'medspa-a',
      channel: 'sms',      // content/store.ts matches exactly; packs are lowercase
      status: 'published', // providers-service's 'active' is not in the target CHECK
      format: 'TEXT',
    });
  });

  it('quarantines the template with no tenant and the one with no channel', async () => {
    const { rows } = await target.query(
      `SELECT source_id, reason FROM mig.rejects
       WHERE loader = '9005_templates' AND source_table = 'communication_templates'
       ORDER BY source_id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].reason).toMatch(/medspa_id is NULL/);
    expect(rows[1].reason).toMatch(/channel is NULL/);
  });

  it('migrates only the versions whose template survived', async () => {
    expect(await one(target, `SELECT count(*) FROM template_versions`)).toBe('1');
    expect(
      await one(
        target,
        `SELECT count(*) FROM mig.rejects WHERE source_table = 'template_versions'`,
      ),
    ).toBe('1');
  });
});

describe('preferences', () => {
  it('keeps the most recently updated row per recipient and drops the rest', async () => {
    const { rows } = await target.query(
      `SELECT allow_communications, preferred_channels, quiet_hours_start, quiet_hours_timezone
       FROM recipient_preferences`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      allow_communications: false,
      preferred_channels: ['SMS'],
      quiet_hours_start: '22:00',
      // New column: the source resolved the zone at check time from a config
      // lookup, so it is written down here instead (D38, D39).
      quiet_hours_timezone: 'America/Los_Angeles',
    });
  });

  it('quarantines the row with no patient_id rather than inventing a recipient', async () => {
    const { rows } = await target.query(
      `SELECT reason FROM mig.rejects WHERE source_table = 'communication_preferences'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/patient_id is NULL/);
  });
});

describe('events, notifications and the rest', () => {
  it('migrates events with a tenant and quarantines the one without', async () => {
    expect(await one(target, `SELECT count(*) FROM outreach_events`)).toBe('2');
    expect(
      await one(
        target,
        `SELECT count(*) FROM mig.rejects WHERE source_table = 'communication_events'`,
      ),
    ).toBe('1');
  });

  it('resolves a notification recipient when it is a patient id and keeps the address when it is not', async () => {
    const { rows } = await target.query(
      `SELECT channel, recipient_id IS NOT NULL AS resolved, channel_ref
       FROM notifications ORDER BY channel`,
    );
    expect(rows).toEqual([
      { channel: 'EMAIL', resolved: false, channel_ref: 'someone@example.com' },
      { channel: 'SMS', resolved: true, channel_ref: null },
    ]);
  });

  it('derives a batch tenant from its events and quarantines the batch with none', async () => {
    const { rows } = await target.query(`SELECT id, tenant_id FROM message_batches`);
    expect(rows).toEqual([
      { id: 'eeee1111-0000-0000-0000-000000000001', tenant_id: 'medspa-a' },
    ]);
    expect(
      await one(
        target,
        `SELECT count(*) FROM mig.rejects WHERE source_table = 'communication_batches'`,
      ),
    ).toBe('1');
  });

  it('carries campaigns, campaign recipients, memories, schedules and ai interactions across', async () => {
    expect(await one(target, `SELECT count(*) FROM campaigns`)).toBe('1');
    expect(await one(target, `SELECT count(*) FROM campaign_recipients`)).toBe('1');
    expect(await one(target, `SELECT count(*) FROM recipient_memories`)).toBe('1');
    expect(await one(target, `SELECT count(*) FROM scheduled_messages`)).toBe('1');
    expect(await one(target, `SELECT count(*) FROM ai_interactions`)).toBe('1');
    // campaign_recipients has no tenant column; it comes from the campaign.
    expect(await one(target, `SELECT tenant_id FROM campaign_recipients`)).toBe('medspa-a');
  });
});

describe('messages', () => {
  it('migrates every attributable message and quarantines the other two', async () => {
    expect(await one(target, `SELECT count(*) FROM messages`)).toBe('6');
    const { rows } = await target.query(
      `SELECT source_id, reason FROM mig.rejects
       WHERE source_table = 'message_history' ORDER BY source_id`,
    );
    expect(rows.map((r) => r.reason)).toEqual([
      'medspa_id is NULL',
      'unrecognised status: WEIRD_STATUS',
    ]);
  });

  it('reads direction from the column, lower-cased', async () => {
    const { rows } = await target.query(
      `SELECT direction, count(*)::int FROM messages GROUP BY 1 ORDER BY 1`,
    );
    expect(rows).toEqual([
      { direction: 'inbound', count: 1 },
      { direction: 'outbound', count: 5 },
    ]);
  });

  it('splits approval words out of the delivery status and records what it changed', async () => {
    const { rows } = await target.query(
      `SELECT id, status, metadata->'migration'->>'sourceStatus' AS source_status
       FROM messages ORDER BY id`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id.slice(-1), r]));
    expect(byId['1'].status).toBe('SENT');
    expect(byId['2'].status).toBe('PENDING_APPROVAL'); // what the engine itself writes
    expect(byId['3'].status).toBe('CANCELLED');        // approved, never sent, cancelled by 9009
    expect(byId['4'].status).toBe('PENDING_APPROVAL');
    expect(byId['5'].status).toBe('CANCELLED');        // REJECTED -> the decline path's word
    expect(byId['7'].status).toBe('RECEIVED');
    expect(byId['3'].source_status).toBe('APPROVED');
    expect(byId['1'].source_status).toBeNull();        // unchanged statuses get no marker
  });

  it('converts naive source timestamps at the declared source zone', async () => {
    const naive = await one(
      source,
      `SELECT sent_at::text FROM message_history WHERE id = '10000000-0000-0000-0000-000000000001'`,
    );
    const migrated = await one(
      target,
      `SELECT (sent_at AT TIME ZONE 'UTC')::text FROM messages
       WHERE id = '10000000-0000-0000-0000-000000000001'`,
    );
    // source_timezone is 'UTC', so the stored wall clock is the UTC wall clock.
    expect(migrated).toBe(naive);
  });

  it('carries the identity, threading and engagement columns', async () => {
    const { rows } = await target.query(
      `SELECT sender_id, sub_tenant_id, sender_name, participant_phone, ai_generated,
              recipient_id IS NOT NULL AS has_recipient, notification_id IS NOT NULL AS has_notification,
              event_id IS NOT NULL AS has_event
       FROM messages WHERE id = '10000000-0000-0000-0000-000000000001'`,
    );
    expect(rows[0]).toMatchObject({
      sender_id: 'provider-1',
      sub_tenant_id: '99999999-9999-9999-9999-999999999999',
      sender_name: 'Dr A',
      participant_phone: '+15550001',
      ai_generated: true,
      has_recipient: true,
      has_notification: true,
      has_event: true,
    });
  });

  it('folds duplicate analytics rows into one instead of dropping either', async () => {
    const { rows } = await target.query(
      `SELECT message_id, opened_at IS NOT NULL AS opened, clicked_link, engagement_score
       FROM message_analytics WHERE message_id IS NOT NULL`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      opened: true,
      clicked_link: 'https://example.com/x',
      engagement_score: 20,
    });
    // The notification-only row is kept as its own row; the unique index is
    // partial on message_id precisely so it can be.
    expect(
      await one(target, `SELECT count(*) FROM message_analytics WHERE message_id IS NULL`),
    ).toBe('1');
  });
});

describe('approvals (D46, D44)', () => {
  it('migrates both storage shapes, including the one with queued_message = {}', async () => {
    const { rows } = await target.query(
      `SELECT message_id, status, approver_ref, original_content, edited_content, decided_by
       FROM approvals ORDER BY message_id`,
    );
    expect(rows).toHaveLength(4);

    const [m2, m3, m4, m5] = rows;
    expect(m2).toMatchObject({ status: 'PENDING_APPROVAL', approver_ref: 'provider-1' });
    // Shape A, decided: the blob carries who and when.
    expect(m3).toMatchObject({
      status: 'CANCELLED',
      decided_by: 'user-9',
      original_content: 'original body',
      edited_content: 'edited body',
    });
    expect(m4).toMatchObject({ status: 'PENDING_APPROVAL' });
    // Shape B: REJECTED is the other controller's word for DECLINED, and the
    // pre-edit body lives in metadata rather than in queued_message.
    expect(m5).toMatchObject({
      status: 'DECLINED',
      original_content: 'before the edit',
      edited_content: 'no thanks',
    });
  });

  it('cancels the historic APPROVED backlog rather than releasing it', async () => {
    const { rows } = await target.query(
      `SELECT status, audit_trail FROM approvals
       WHERE message_id = '10000000-0000-0000-0000-000000000003'`,
    );
    expect(rows[0].status).toBe('CANCELLED');
    const trail = rows[0].audit_trail as { from: string; to: string; reason?: string }[];
    expect(trail).toHaveLength(2);
    expect(trail[1]).toMatchObject({ from: 'APPROVED', to: 'CANCELLED', actorRef: 'migration:p9' });
    expect(trail[1].reason).toMatch(/never dispatched/);
  });

  it('honours the APPROVED disposition when the operator chooses it', async () => {
    // Not the default, and the runbook makes the operator read the count first.
    await target.query(
      `UPDATE mig.settings SET value = 'APPROVED' WHERE key = 'historic_approved_disposition'`,
    );
    await target.query(`
      UPDATE approvals SET status = 'APPROVED',
        audit_trail = jsonb_build_array(audit_trail->0)
      WHERE message_id = '10000000-0000-0000-0000-000000000003'`);
    await target.query(`CALL mig.apply_backlog_disposition()`);
    expect(
      await one(
        target,
        `SELECT status FROM approvals WHERE message_id = '10000000-0000-0000-0000-000000000003'`,
      ),
    ).toBe('APPROVED');

    // Put it back the way the rest of the suite expects.
    await target.query(
      `UPDATE mig.settings SET value = 'CANCELLED' WHERE key = 'historic_approved_disposition'`,
    );
    await target.query(`CALL mig.apply_backlog_disposition()`);
  });

  it('links each message back to its approval', async () => {
    expect(
      await one(
        target,
        `SELECT count(*) FROM messages m JOIN approvals a ON a.id = m.approval_id`,
      ),
    ).toBe('4');
  });

  it('points every approval at the baseline policy the pack ships', async () => {
    expect(
      await one(
        target,
        `SELECT count(*) FROM approvals a JOIN approval_policies p ON p.id = a.policy_id
         WHERE p.key = 'medspa.provider-always'`,
      ),
    ).toBe('4');
  });
});

describe('verification', () => {
  it('reports no FAIL', async () => {
    const failures = (await verify()).filter((r) => r.status === 'FAIL');
    expect(failures).toEqual([]);
  });

  it('warns about exactly the rows that were quarantined', async () => {
    const warn = (await verify()).find((r) => r.check_name.startsWith('quarantined rows'));
    expect(warn?.status).toBe('WARN');
    expect(Number(warn?.actual)).toBe(
      Number(await one(target, `SELECT count(*) FROM mig.rejects`)),
    );
  });

  it('passes the Seam D guard for both an absent ghost table and an empty one', async () => {
    const ghosts = (await verify()).filter((r) => r.check_name.includes('ghost table'));
    expect(ghosts).toHaveLength(7);
    expect(ghosts.every((g) => g.status === 'PASS')).toBe(true);
  });

  it('is a no-op when the whole series is applied a second time', async () => {
    const before = await target.query(
      `SELECT (SELECT count(*) FROM messages) AS m, (SELECT count(*) FROM approvals) AS a,
              (SELECT count(*) FROM recipients) AS r, (SELECT count(*) FROM mig.rejects) AS x`,
    );
    await runDataMigrations();
    const after = await target.query(
      `SELECT (SELECT count(*) FROM messages) AS m, (SELECT count(*) FROM approvals) AS a,
              (SELECT count(*) FROM recipients) AS r, (SELECT count(*) FROM mig.rejects) AS x`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect((await verify()).filter((r) => r.status === 'FAIL')).toEqual([]);
  });
});

describe('delta sync', () => {
  it('picks up rows created since the bulk load, and status changes inside the window', async () => {
    await source.query(`
      INSERT INTO message_history
        (id, patient_id, provider_id, medspa_id, channel, content, status, sent_at,
         created_at, message_direction, metadata)
      VALUES ('10000000-0000-0000-0000-00000000000a', 'patient-1', 'provider-1', 'medspa-a',
              'SMS', 'sent during the parallel run', 'QUEUED',
              now()::timestamp - interval '1 minute', now()::timestamp - interval '1 minute',
              'OUTBOUND', '{}'::json);

      -- An in-place change to an already-migrated row: the case a watermark on
      -- created_at cannot see, because message_history has no updated_at.
      UPDATE message_history
      SET status = 'DELIVERED', delivered_at = now()::timestamp
      WHERE id = '10000000-0000-0000-0000-000000000004';
    `);

    // This is the FINAL delta as the runbook describes it (§7): the old service
    // is stopped, so nothing can still be in flight and the watermark may run
    // right up to now(). With the default five-minute lag a row a minute old is
    // deliberately left for the next pass.
    await target.query(`UPDATE mig.settings SET value = '0' WHERE key = 'watermark_lag_minutes'`);
    // The fixture's rows are up to 90 days old; production's trailing window is
    // 7 days (mig.settings.delta_refresh_days) and this is the knob for it.
    await target.query(`UPDATE mig.settings SET value = '3650' WHERE key = 'delta_refresh_days'`);
    await applyFile(target, join(SCRIPTS_DIR, 'delta-sync.sql'));

    expect(
      await one(
        target,
        `SELECT content FROM messages WHERE id = '10000000-0000-0000-0000-00000000000a'`,
      ),
    ).toBe('sent during the parallel run');

    // m4 had an approval, so the refresh moves the approval and the message
    // together rather than letting them disagree.
    expect(
      await one(
        target,
        `SELECT status FROM messages WHERE id = '10000000-0000-0000-0000-000000000004'`,
      ),
    ).toBe('DELIVERED');

    // …and the approval moves with it. A message that was approved and sent in
    // the old system during the window carries no approval word at all any
    // more, so the refresh reads the delivery status instead — otherwise the
    // approver is left with a phantom to action.
    expect(
      await one(
        target,
        `SELECT status FROM approvals WHERE message_id = '10000000-0000-0000-0000-000000000004'`,
      ),
    ).toBe('SENT');

    expect((await verify()).filter((r) => r.status === 'FAIL')).toEqual([]);
  });

  it('leaves an approval a human has already decided alone', async () => {
    // Simulate a decision made in the NEW system: a second audit entry.
    await target.query(`
      UPDATE approvals
      SET status = 'APPROVED',
          audit_trail = audit_trail || jsonb_build_array(jsonb_build_object(
            'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'from', 'PENDING_APPROVAL', 'to', 'APPROVED',
            'actorType', 'user', 'actorRef', 'a-real-person'))
      WHERE message_id = '10000000-0000-0000-0000-000000000002'`);

    await target.query(`CALL mig.refresh_recent()`);

    const { rows } = await target.query(
      `SELECT status, jsonb_array_length(audit_trail) AS entries FROM approvals
       WHERE message_id = '10000000-0000-0000-0000-000000000002'`,
    );
    expect(rows[0]).toMatchObject({ status: 'APPROVED', entries: 2 });
  });
});
