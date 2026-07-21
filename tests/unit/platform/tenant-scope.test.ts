/**
 * Ported from `shared-libs/tests/tenant-scope.test.ts`, renamed to the new
 * vocabulary. All four branches (scope with/without subTenant x table
 * with/without the column) plus includeShared.
 */
import { PgDialect, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { subTenantValueForInsert, tenantWhere } from '../../../src/platform/db/tenant-scope.js';

const scoped = pgTable('scoped', {
  id: uuid('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  subTenantId: uuid('sub_tenant_id'),
});

const tenantOnly = pgTable('tenant_only', {
  id: uuid('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
});

const dialect = new PgDialect();

/** Compile a drizzle SQL fragment to the actual parameterized statement. */
function render(sql: ReturnType<typeof tenantWhere>): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(sql);
  return { sql: query.sql, params: query.params };
}

describe('tenantWhere', () => {
  it('emits a tenant-only predicate when the scope has no subTenantId', () => {
    const { sql, params } = render(tenantWhere(scoped, { tenantId: 't1' }));
    expect(sql).toContain('"tenant_id"');
    expect(sql).not.toContain('sub_tenant_id');
    expect(params).toEqual(['t1']);
  });

  it('emits a tenant-only predicate when the table has no subTenantId column', () => {
    const { sql, params } = render(tenantWhere(tenantOnly, { tenantId: 't1', subTenantId: 's1' }));
    expect(sql).toContain('"tenant_id"');
    expect(sql).not.toContain('sub_tenant_id');
    expect(params).toEqual(['t1']);
  });

  it('constrains to the sub-tenant when both scope and column are present', () => {
    const { sql, params } = render(tenantWhere(scoped, { tenantId: 't1', subTenantId: 's1' }));
    expect(sql).toContain('"tenant_id"');
    expect(sql).toContain('"sub_tenant_id"');
    expect(sql.toLowerCase()).not.toContain('is null');
    expect(params).toEqual(['t1', 's1']);
  });

  it('also matches org-wide NULL rows when includeShared is set', () => {
    const { sql } = render(
      tenantWhere(scoped, { tenantId: 't1', subTenantId: 's1' }, { includeShared: true }),
    );
    expect(sql).toContain('"sub_tenant_id"');
    expect(sql.toLowerCase()).toContain('is null');
  });

  it('does not add the NULL branch when includeShared is set but the scope is org-wide', () => {
    const { sql } = render(tenantWhere(scoped, { tenantId: 't1' }, { includeShared: true }));
    expect(sql.toLowerCase()).not.toContain('is null');
  });
});

describe('subTenantValueForInsert', () => {
  it('returns the sub-tenant when scoped', () => {
    expect(subTenantValueForInsert({ tenantId: 't1', subTenantId: 's1' })).toBe('s1');
  });

  it('returns null (org-wide) when unscoped', () => {
    expect(subTenantValueForInsert({ tenantId: 't1' })).toBeNull();
  });
});
