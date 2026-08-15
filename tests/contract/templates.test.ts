/**
 * `setDefault` against a real Postgres.
 *
 * The `category IS NULL` case is why this is an integration test rather than a
 * unit test: `eq(category, null)` compiles to `category = NULL`, which matches
 * nothing in SQL and cannot be caught by mocking the database. Two
 * uncategorised templates would both stay default and the FE would pick
 * whichever came back first.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { baselineMigrations } from '../helpers/migrations.js';

import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import winston from 'winston';

import { createDb } from '../../src/db/index.js';
import { DrizzleTemplateStore } from '../../src/engine/content/store.js';
import { NotFoundError } from '../../src/platform/http/errors.js';

const logger = winston.createLogger({ silent: true });
const TENANT = 't-tpl';
const OTHER_TENANT = 't-other';

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createDb>['pool'];
let store: DrizzleTemplateStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  // The 0xxx schema series only — the 9xxx files are the one-shot mentera-core
  // data migration and need a linked source database (migration.test.ts covers them).
  for (const file of baselineMigrations(dir)) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.query(
    `INSERT INTO tenants (id, name) VALUES ('${TENANT}','Tpl'), ('${OTHER_TENANT}','Other')`,
  );
  await client.end();

  const handle = createDb({ url: container.getConnectionUri() }, logger);
  pool = handle.pool;
  store = new DrizzleTemplateStore(handle.db, logger);
}, 240_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  await container?.stop();
});

async function make(
  overrides: { channel?: string; category?: string | null; name?: string; key?: string } = {},
) {
  return store.create(TENANT, {
    name: overrides.name ?? `t-${Math.random().toString(36).slice(2)}`,
    channel: overrides.channel ?? 'email',
    content: 'hello {{recipient.displayName}}',
    format: 'TEXT',
    category: overrides.category ?? null,
    key: overrides.key,
  });
}

describe('setDefault clears siblings in the same (tenant, channel, category) group', () => {
  it('clears a sibling with the same non-null category', async () => {
    const a = await make({ channel: 'email', category: 'reminders' });
    const b = await make({ channel: 'email', category: 'reminders' });

    await store.setDefault(TENANT, a.id);
    await store.setDefault(TENANT, b.id);

    expect((await store.get(TENANT, a.id))!.isDefault).toBe(false);
    expect((await store.get(TENANT, b.id))!.isDefault).toBe(true);
  });

  it('clears a sibling when BOTH categories are NULL', async () => {
    // The trap: `category = NULL` matches nothing, so a naive implementation
    // leaves both rows default.
    const a = await make({ channel: 'sms', category: null });
    const b = await make({ channel: 'sms', category: null });

    await store.setDefault(TENANT, a.id);
    await store.setDefault(TENANT, b.id);

    expect((await store.get(TENANT, a.id))!.isDefault).toBe(false);
    expect((await store.get(TENANT, b.id))!.isDefault).toBe(true);
  });

  it('leaves a different category alone', async () => {
    const promo = await make({ channel: 'slack', category: 'promo' });
    const alerts = await make({ channel: 'slack', category: 'alerts' });

    await store.setDefault(TENANT, promo.id);
    await store.setDefault(TENANT, alerts.id);

    expect((await store.get(TENANT, promo.id))!.isDefault).toBe(true);
    expect((await store.get(TENANT, alerts.id))!.isDefault).toBe(true);
  });

  it('does not treat a NULL category as equal to a named one', async () => {
    const uncategorised = await make({ channel: 'push', category: null });
    const named = await make({ channel: 'push', category: 'named' });

    await store.setDefault(TENANT, uncategorised.id);
    await store.setDefault(TENANT, named.id);

    expect((await store.get(TENANT, uncategorised.id))!.isDefault).toBe(true);
    expect((await store.get(TENANT, named.id))!.isDefault).toBe(true);
  });

  it('leaves a different channel alone', async () => {
    const email = await make({ channel: 'webhook', category: 'x' });
    const sms = await make({ channel: 'in_app', category: 'x' });

    await store.setDefault(TENANT, email.id);
    await store.setDefault(TENANT, sms.id);

    expect((await store.get(TENANT, email.id))!.isDefault).toBe(true);
    expect((await store.get(TENANT, sms.id))!.isDefault).toBe(true);
  });

  it('throws for a template that does not exist', async () => {
    await expect(
      store.setDefault(TENANT, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('tenant isolation', () => {
  it('does not clear another tenant’s default', async () => {
    const mine = await make({ channel: 'voice', category: 'shared' });
    const theirs = await store.create(OTHER_TENANT, {
      name: 'theirs',
      channel: 'voice',
      content: 'x',
      format: 'TEXT',
      category: 'shared',
    });

    await store.setDefault(OTHER_TENANT, theirs.id);
    await store.setDefault(TENANT, mine.id);

    expect((await store.get(OTHER_TENANT, theirs.id))!.isDefault).toBe(true);
    expect((await store.get(TENANT, mine.id))!.isDefault).toBe(true);
  });

  it('cannot read another tenant’s template by id', async () => {
    const theirs = await store.create(OTHER_TENANT, {
      name: 'private',
      channel: 'email',
      content: 'x',
      format: 'TEXT',
    });
    expect(await store.get(TENANT, theirs.id)).toBeNull();
  });
});

describe('lookup, versioning and usage', () => {
  it('finds a template by pack key as well as by id', async () => {
    const created = await make({ key: 'medspa.reminder.sms', channel: 'sms' });
    expect((await store.get(TENANT, 'medspa.reminder.sms'))!.id).toBe(created.id);
    expect((await store.get(TENANT, created.id))!.id).toBe(created.id);
  });

  it('snapshots a version on create and on every content change', async () => {
    const created = await make();
    expect(await store.versions(TENANT, created.id)).toHaveLength(1);

    const updated = await store.update(TENANT, created.id, { content: 'new body' });
    expect(updated.version).toBe(2);
    expect(await store.versions(TENANT, created.id)).toHaveLength(2);
  });

  it('does not bump the version for a non-content change', async () => {
    const created = await make();
    const updated = await store.update(TENANT, created.id, { name: 'renamed' });
    expect(updated.version).toBe(1);
    expect(await store.versions(TENANT, created.id)).toHaveLength(1);
  });

  it('increments usage', async () => {
    const created = await make();
    await store.incrementUsage(TENANT, created.id);
    await store.incrementUsage(TENANT, created.id);
    expect((await store.get(TENANT, created.id))!.usageCount).toBe(2);
  });

  it('deletes and reports whether anything was removed', async () => {
    const created = await make();
    expect(await store.delete(TENANT, created.id)).toBe(true);
    expect(await store.delete(TENANT, created.id)).toBe(false);
  });
});
