/**
 * Schema conformance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS DOES NOT RUN A MIGRATION AGAINST ANY REAL DATABASE.
 *
 * Hard rule 1 of the extraction plan forbids an agent or a tool from applying a
 * migration. What happens here is different in kind: testcontainers starts a
 * brand-new, empty, throwaway Postgres inside Docker, the SQL is applied to
 * that container, the assertions run, and the container is destroyed. It never
 * has credentials for, or a route to, any database that holds data. Applying
 * the migrations is the only way to verify they are correct, and verifying them
 * before an operator runs them is the point.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * What is asserted:
 *   - every table carries tenant_id (with two documented exceptions)
 *   - not one `timestamp without time zone` column exists
 *   - approvals.status accepts exactly the 10 canonical states
 *   - UNIQUE (message_id) on approvals — the idempotency key
 *   - identity columns that block generalization are nullable
 *   - re-applying all three migrations is a no-op
 *   - the Drizzle model and the SQL describe the same tables and columns
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { baselineMigrations } from '../helpers/migrations.js';

import { getTableName, getTableColumns, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import * as schema from '../../src/db/schema.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/** Tables whose own primary key IS the tenant identifier, or that are global. */
const TENANT_ID_EXEMPT = new Set(['tenants', 'packs']);

/**
 * The Drizzle model flattened to plain data. Going through `unknown` keeps
 * `is()` from trying to narrow the heterogeneous union of table types (the
 * barrel also exports plain const arrays like APPROVAL_STATUSES).
 */
const MODEL_TABLES: { name: string; columns: string[] }[] = Object.values(
  schema as Record<string, unknown>,
).flatMap((value) => {
  if (!is(value, PgTable)) return [];
  const table = value as PgTable;
  return [
    {
      name: getTableName(table),
      columns: Object.values(getTableColumns(table)).map((c) => c.name),
    },
  ];
});

/**
 * The SCHEMA series only. The 9xxx files are one-shot data migrations from
 * mentera-core: they need a linked source database, they create scaffolding in
 * the `mig` schema that this file's "no unmodelled tables" assertions would
 * (correctly) reject, and they are exercised by migration.test.ts instead.
 */
function migrationFiles(): string[] {
  return baselineMigrations(MIGRATIONS_DIR);
}

async function applyMigrations(client: Client): Promise<void> {
  for (const file of migrationFiles()) {
    await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

let container: StartedPostgreSqlContainer;
let client: Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  await applyMigrations(client);
}, 180_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

async function tableNames(): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

describe('migrations apply cleanly', () => {
  it('creates every table the Drizzle model declares', async () => {
    const inDatabase = new Set(await tableNames());
    expect(MODEL_TABLES.length).toBeGreaterThan(20);
    const missing = MODEL_TABLES.map((t) => t.name).filter((n) => !inDatabase.has(n));
    expect(missing).toEqual([]);
  });

  it('creates no table the Drizzle model does not declare', async () => {
    const inModel = new Set(MODEL_TABLES.map((t) => t.name));
    const unexpected = (await tableNames()).filter((n) => !inModel.has(n));
    expect(unexpected).toEqual([]);
  });

  it('gives every Drizzle column a matching database column', async () => {
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    const actual = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));

    const missing = MODEL_TABLES.flatMap((t) =>
      t.columns.map((c) => `${t.name}.${c}`).filter((key) => !actual.has(key)),
    );
    expect(missing).toEqual([]);
  });

  it('gives every database column a matching Drizzle column', async () => {
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    const inModel = new Set(
      MODEL_TABLES.flatMap((t) => t.columns.map((c) => `${t.name}.${c}`)),
    );
    const extra = rows
      .map((r) => `${r.table_name}.${r.column_name}`)
      .filter((key) => !inModel.has(key));
    expect(extra).toEqual([]);
  });

  it('is idempotent — re-applying all migrations changes nothing', async () => {
    const before = await tableNames();
    await applyMigrations(client);
    await applyMigrations(client);
    expect(await tableNames()).toEqual(before);
  });
});

describe('the platform tenant (0011)', () => {
  it('seeds exactly one, marked reserved', async () => {
    const { rows } = await client.query(
      `SELECT name, timezone, settings->>'engineReserved' AS reserved
       FROM tenants WHERE id = 'platform'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Platform', timezone: 'UTC', reserved: 'true' });
  });

  it('refuses to run when a migrated medspa already holds the id', async () => {
    // 0011 applies before 9002, so the collision this guards against shows up as
    // 9002 silently skipping a medspa and its mail sharing the platform tenant.
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE tenants SET settings = '{}'::jsonb WHERE id = 'platform'`);
      await expect(
        client.query(readFileSync(join(MIGRATIONS_DIR, '0011_platform_tenant.sql'), 'utf8')),
      ).rejects.toThrow(/almost certainly a migrated medspa/);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

describe('Rule 4 — every table is tenant-scoped', () => {
  it('gives every table a tenant_id, except tenants and packs', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT t.table_name FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = 'public' AND c.table_name = t.table_name
             AND c.column_name = 'tenant_id')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TENANT_ID_EXEMPT].sort());
  });

  it('makes tenant_id NOT NULL everywhere except the two catalogue tables', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id'
         AND is_nullable = 'YES'
       ORDER BY table_name`,
    );
    // prompt_packs and approval_policies allow NULL: a NULL row is a
    // pack-provided default shared across every tenant.
    expect(rows.map((r) => r.table_name)).toEqual(['approval_policies', 'prompt_packs']);
  });
});

describe('timestamptz everywhere', () => {
  it('has not one `timestamp without time zone` column', async () => {
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`,
    );
    expect(rows).toEqual([]);
  });

  it('gives every table created_at and updated_at as timestamptz', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT t.table_name FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = 'public' AND c.table_name = t.table_name
             AND c.column_name = 'created_at'
             AND c.data_type = 'timestamp with time zone')`,
    );
    // audience_members is a pure join table: added_at carries the timestamp.
    expect(rows.map((r) => r.table_name)).toEqual(['audience_members']);
  });
});

describe('approvals', () => {
  it('accepts exactly the 10 canonical states', async () => {
    const { rows } = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'approvals_status_check'`,
    );
    expect(rows).toHaveLength(1);
    const definition = rows[0]!.definition;

    for (const state of schema.APPROVAL_STATUSES) {
      expect(definition).toContain(`'${state}'`);
    }
    expect(schema.APPROVAL_STATUSES).toHaveLength(10);
    // REJECTED was the ai-enhanced controller's spelling; DECLINED is canonical.
    expect(definition).not.toContain("'REJECTED'");
  });

  it('enforces one approval per message', async () => {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = 'approvals_message_unique' AND contype = 'u'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects a status outside the CHECK', async () => {
    await client.query(`INSERT INTO tenants (id, name) VALUES ('t-chk','Check') ON CONFLICT DO NOTHING`);
    await client.query(
      `INSERT INTO messages (id, tenant_id, channel, content, status)
       VALUES ('11111111-1111-1111-1111-111111111111','t-chk','EMAIL','hi','SENT')
       ON CONFLICT DO NOTHING`,
    );
    await expect(
      client.query(
        `INSERT INTO approvals (tenant_id, message_id, status)
         VALUES ('t-chk','11111111-1111-1111-1111-111111111111','REJECTED')`,
      ),
    ).rejects.toThrow(/approvals_status_check/);
  });
});

describe('generalization — the NOT NULLs that had to go', () => {
  const nullableNow: [string, string][] = [
    ['messages', 'recipient_id'],
    ['messages', 'sender_id'],
    ['messages', 'sent_at'],
    ['message_analytics', 'recipient_id'],
    ['recipient_memories', 'recipient_id'],
    ['campaigns', 'sender_id'],
    ['campaign_recipients', 'recipient_id'],
  ];

  it.each(nullableNow)('%s.%s is nullable', async (table, column) => {
    const { rows } = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe('YES');
  });

  it('records a message with no recipient and no sender', async () => {
    await client.query(`INSERT INTO tenants (id, name) VALUES ('t-sys','System') ON CONFLICT DO NOTHING`);
    await expect(
      client.query(
        `INSERT INTO messages (tenant_id, channel, content, status)
         VALUES ('t-sys','SLACK','deploy finished','SENT')`,
      ),
    ).resolves.toBeDefined();
  });
});

describe('indexes carried forward from the source', () => {
  it.each([
    'idx_messages_tenant_sender',
    'idx_messages_conversation',
    'idx_messages_unread',
    'idx_messages_sent_at',
    'idx_messages_status',
    'idx_messages_channel',
    'idx_messages_tenant_subtenant',
    'idx_outreach_events_status',
    'idx_recipient_prefs_recipient',
    'idx_approvals_tenant_status_deadline',
    'idx_approvals_tenant_approver',
    // 0008 — both load-bearing, neither expressible in the Drizzle model.
    'message_analytics_message_unique',
    'idx_messages_provider_message_id_lookup',
  ])('%s exists', async (indexName) => {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [indexName],
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps idx_messages_unread partial', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'idx_messages_unread'`,
    );
    expect(rows[0]!.indexdef).toContain('WHERE (read_at IS NULL)');
  });

  it('lets a receipt look a message up without a tenant', async () => {
    // A provider callback carries no tenant, so ReceiptService queries
    // `provider_message_id` alone and reads the tenant off the row. A btree
    // cannot serve a predicate that skips its leading column, so the
    // (tenant_id, provider_message_id) index from 0001 is useless here — every
    // receipt would sequentially scan the largest table in the service.
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'idx_messages_provider_message_id_lookup'`,
    );
    expect(rows[0]!.indexdef).toMatch(/\(provider_message_id\)/);
    expect(rows[0]!.indexdef).toContain('WHERE (provider_message_id IS NOT NULL)');
  });

  it('allows only one analytics row per message', async () => {
    // Three read paths LEFT JOIN message_analytics. A second row per message
    // duplicates that message in every list while `total` counts it once.
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'message_analytics_message_unique'`,
    );
    expect(rows[0]!.indexdef).toContain('CREATE UNIQUE INDEX');
    expect(rows[0]!.indexdef).toContain('WHERE (message_id IS NOT NULL)');
  });

  it('does not carry over the queued_message approval index', async () => {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
         AND indexname LIKE '%queued_approval%'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('uniqueness that the engine depends on', () => {
  it('scopes recipients by (tenant, external system, external id)', async () => {
    await client.query(`INSERT INTO tenants (id, name) VALUES ('t-uq','Uniq') ON CONFLICT DO NOTHING`);
    const ref = `'{"system":"mentera-patient","id":"p-1"}'::jsonb`;
    await client.query(
      `INSERT INTO recipients (tenant_id, external_ref) VALUES ('t-uq', ${ref})`,
    );
    await expect(
      client.query(`INSERT INTO recipients (tenant_id, external_ref) VALUES ('t-uq', ${ref})`),
    ).rejects.toThrow(/recipients_tenant_external_ref_unique/);

    // A different tenant may hold the same external reference.
    await client.query(`INSERT INTO tenants (id, name) VALUES ('t-uq2','Uniq2') ON CONFLICT DO NOTHING`);
    await expect(
      client.query(`INSERT INTO recipients (tenant_id, external_ref) VALUES ('t-uq2', ${ref})`),
    ).resolves.toBeDefined();
  });

  it('makes the template key unique per tenant but allows many keyless templates', async () => {
    await client.query(`INSERT INTO tenants (id, name) VALUES ('t-tpl','Tpl') ON CONFLICT DO NOTHING`);
    const insert = (key: string | null) =>
      client.query(
        `INSERT INTO templates (tenant_id, key, name, channel, content)
         VALUES ('t-tpl', $1, 'n', 'EMAIL', 'c')`,
        [key],
      );
    await insert('welcome');
    await expect(insert('welcome')).rejects.toThrow(/templates_tenant_key_unique/);
    await insert(null);
    await expect(insert(null)).resolves.toBeDefined();
  });
});
