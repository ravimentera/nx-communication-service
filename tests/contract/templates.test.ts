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

/**
 * The store takes a `TenantScope`, not a tenant id — a location-scoped caller
 * could otherwise read, edit and DELETE another location's templates by id, and
 * the delete cascades into `template_versions`.
 *
 * Org-wide here (no `subTenantId`), which is what these cases are about;
 * `tests/integration/templates-scoping.test.ts` covers the location split.
 */
const SCOPE = { tenantId: TENANT };
const OTHER_TENANT = 't-other';
const OTHER_SCOPE = { tenantId: OTHER_TENANT };

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
  return store.create(SCOPE, {
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

    await store.setDefault(SCOPE, a.id);
    await store.setDefault(SCOPE, b.id);

    expect((await store.get(SCOPE, a.id))!.isDefault).toBe(false);
    expect((await store.get(SCOPE, b.id))!.isDefault).toBe(true);
  });

  it('clears a sibling when BOTH categories are NULL', async () => {
    // The trap: `category = NULL` matches nothing, so a naive implementation
    // leaves both rows default.
    const a = await make({ channel: 'sms', category: null });
    const b = await make({ channel: 'sms', category: null });

    await store.setDefault(SCOPE, a.id);
    await store.setDefault(SCOPE, b.id);

    expect((await store.get(SCOPE, a.id))!.isDefault).toBe(false);
    expect((await store.get(SCOPE, b.id))!.isDefault).toBe(true);
  });

  it('leaves a different category alone', async () => {
    const promo = await make({ channel: 'slack', category: 'promo' });
    const alerts = await make({ channel: 'slack', category: 'alerts' });

    await store.setDefault(SCOPE, promo.id);
    await store.setDefault(SCOPE, alerts.id);

    expect((await store.get(SCOPE, promo.id))!.isDefault).toBe(true);
    expect((await store.get(SCOPE, alerts.id))!.isDefault).toBe(true);
  });

  it('does not treat a NULL category as equal to a named one', async () => {
    const uncategorised = await make({ channel: 'push', category: null });
    const named = await make({ channel: 'push', category: 'named' });

    await store.setDefault(SCOPE, uncategorised.id);
    await store.setDefault(SCOPE, named.id);

    expect((await store.get(SCOPE, uncategorised.id))!.isDefault).toBe(true);
    expect((await store.get(SCOPE, named.id))!.isDefault).toBe(true);
  });

  it('leaves a different channel alone', async () => {
    const email = await make({ channel: 'webhook', category: 'x' });
    const sms = await make({ channel: 'in_app', category: 'x' });

    await store.setDefault(SCOPE, email.id);
    await store.setDefault(SCOPE, sms.id);

    expect((await store.get(SCOPE, email.id))!.isDefault).toBe(true);
    expect((await store.get(SCOPE, sms.id))!.isDefault).toBe(true);
  });

  it('throws for a template that does not exist', async () => {
    await expect(
      store.setDefault(SCOPE, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('tenant isolation', () => {
  it('does not clear another tenant’s default', async () => {
    const mine = await make({ channel: 'voice', category: 'shared' });
    const theirs = await store.create(OTHER_SCOPE, {
      name: 'theirs',
      channel: 'voice',
      content: 'x',
      format: 'TEXT',
      category: 'shared',
    });

    await store.setDefault(OTHER_SCOPE, theirs.id);
    await store.setDefault(SCOPE, mine.id);

    expect((await store.get(OTHER_SCOPE, theirs.id))!.isDefault).toBe(true);
    expect((await store.get(SCOPE, mine.id))!.isDefault).toBe(true);
  });

  it('cannot read another tenant’s template by id', async () => {
    const theirs = await store.create(OTHER_SCOPE, {
      name: 'private',
      channel: 'email',
      content: 'x',
      format: 'TEXT',
    });
    expect(await store.get(SCOPE, theirs.id)).toBeNull();
  });
});

describe('lookup, versioning and usage', () => {
  it('finds a template by pack key as well as by id', async () => {
    const created = await make({ key: 'medspa.reminder.sms', channel: 'sms' });
    expect((await store.get(SCOPE, 'medspa.reminder.sms'))!.id).toBe(created.id);
    expect((await store.get(SCOPE, created.id))!.id).toBe(created.id);
  });

  it('snapshots a version on create and on every content change', async () => {
    const created = await make();
    expect(await store.versions(SCOPE, created.id)).toHaveLength(1);

    const updated = await store.update(SCOPE, created.id, { content: 'new body' });
    expect(updated.version).toBe(2);
    expect(await store.versions(SCOPE, created.id)).toHaveLength(2);
  });

  it('does not bump the version for a non-content change', async () => {
    const created = await make();
    const updated = await store.update(SCOPE, created.id, { name: 'renamed' });
    expect(updated.version).toBe(1);
    expect(await store.versions(SCOPE, created.id)).toHaveLength(1);
  });

  it('increments usage', async () => {
    const created = await make();
    await store.incrementUsage(SCOPE, created.id);
    await store.incrementUsage(SCOPE, created.id);
    expect((await store.get(SCOPE, created.id))!.usageCount).toBe(2);
  });

  it('deletes and reports whether anything was removed', async () => {
    const created = await make();
    expect(await store.delete(SCOPE, created.id)).toBe(true);
    expect(await store.delete(SCOPE, created.id)).toBe(false);
  });
});

/**
 * Sub-tenant isolation, and the org-wide rows that must survive it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The store took a bare `tenantId`, so a caller scoped to location A could
 * list, read, edit, default and **delete** location B's templates by id. The
 * delete is the sharp one: `template_versions` cascades off it (Seam A, D66).
 *
 * The half that is easy to get wrong is the other direction. A template with a
 * NULL `sub_tenant_id` is ORG-WIDE, and that is exactly what a pack install
 * writes when it is not scoped to a location — so a plain `sub_tenant_id = A`
 * predicate would hide every pack template from every location user. That
 * looks like a fix and is a worse bug: `medspa.appointment-reminder` would stop
 * resolving and the playbook would fail its template lookup.
 *
 * `tenantWhere(..., { includeShared: true })` is what the helper was written
 * for, and it had no caller until now.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('sub-tenant scoping', () => {
  const LOCATION_A = '11111111-1111-4111-8111-111111111111';
  const LOCATION_B = '22222222-2222-4222-8222-222222222222';

  const scopeA = { tenantId: TENANT, subTenantId: LOCATION_A };
  const scopeB = { tenantId: TENANT, subTenantId: LOCATION_B };

  async function makeFor(
    scope: { tenantId: string; subTenantId?: string },
    key: string,
  ): Promise<{ id: string }> {
    return store.create(scope, {
      key,
      name: key,
      channel: 'email',
      content: 'body',
      format: 'TEXT',
    } as Parameters<typeof store.create>[1]);
  }

  it('stamps a location-scoped create with that location', async () => {
    const created = await makeFor(scopeA, 'scoping.a-only');
    expect(created.subTenantId).toBe(LOCATION_A);
  });

  it('hides another location’s template from list and get', async () => {
    const theirs = await makeFor(scopeB, 'scoping.b-only');

    expect(await store.get(scopeA, theirs.id)).toBeNull();
    expect(await store.get(scopeA, 'scoping.b-only')).toBeNull();

    const listed = await store.list(scopeA);
    expect(listed.map((t) => t.key)).not.toContain('scoping.b-only');
  });

  it('still shows org-wide templates to a location — the half that breaks first', async () => {
    // What a pack install writes when it is not scoped to a location.
    await makeFor({ tenantId: TENANT }, 'scoping.org-wide');

    expect(await store.get(scopeA, 'scoping.org-wide')).not.toBeNull();
    expect((await store.list(scopeA)).map((t) => t.key)).toContain('scoping.org-wide');
  });

  it('refuses to delete another location’s template', async () => {
    const theirs = await makeFor(scopeB, 'scoping.b-delete');

    // `false`, not a throw: the row is simply not visible to this caller, which
    // is the same answer they would get for an id that does not exist.
    expect(await store.delete(scopeA, theirs.id)).toBe(false);
    expect(await store.get(scopeB, theirs.id)).not.toBeNull();
  });

  it('refuses to edit or default another location’s template', async () => {
    const theirs = await makeFor(scopeB, 'scoping.b-edit');

    await expect(store.update(scopeA, theirs.id, { name: 'hijacked' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(store.setDefault(scopeA, theirs.id)).rejects.toThrow(NotFoundError);
    expect((await store.get(scopeB, theirs.id))!.name).toBe('scoping.b-edit');
  });

  it('does not hand another location’s revision history to a caller', async () => {
    const theirs = await makeFor(scopeB, 'scoping.b-versions');
    await store.update(scopeB, theirs.id, { content: 'changed' });

    expect(await store.versions(scopeB, theirs.id)).toHaveLength(2);
    // `template_versions` has a tenant column and no sub-tenant one, so this
    // has to be guarded through the template rather than by querying it.
    expect(await store.versions(scopeA, theirs.id)).toEqual([]);
  });

  it('an org-wide caller still sees everything under the tenant', async () => {
    const keys = (await store.list(SCOPE)).map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(['scoping.a-only', 'scoping.b-only']));
  });
});
