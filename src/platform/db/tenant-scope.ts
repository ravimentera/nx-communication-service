/**
 * Tenant scoping — vendored from `@mentera/shared-libs/utils/tenant-scope.ts`.
 * Semantics are identical; only the vocabulary changed (§0.7):
 *   medspaId   -> tenantId
 *   locationId -> subTenantId
 *
 * Rule 4 of the extraction plan: no query leaves this service without a tenant
 * predicate. This is where that predicate is built.
 */
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';

export interface TenantScope {
  tenantId: string;
  /** Active sub-tenant for this request. undefined = org-wide. */
  subTenantId?: string;
}

export interface TenantScopedTable {
  tenantId: AnyColumn;
  subTenantId?: AnyColumn;
}

/**
 * Build the tenant predicate for a table with `tenantId` (and optionally
 * `subTenantId`).
 *
 *  - subTenantId on the scope AND the table has the column:
 *        tenant_id = X AND (sub_tenant_id = Y [OR sub_tenant_id IS NULL when includeShared])
 *  - no subTenantId on the scope, OR the table has no such column:
 *        tenant_id = X   (org-wide: everything under the tenant)
 *
 * `includeShared = true` lets a sub-tenant also see org-wide (NULL) rows — use
 * for catalog/config/templates. Default false: operational/PHI-bearing data sees
 * only its own sub-tenant.
 */
export function tenantWhere(
  table: TenantScopedTable,
  scope: TenantScope,
  opts: { includeShared?: boolean } = {},
): SQL {
  const base = eq(table.tenantId, scope.tenantId);
  if (!scope.subTenantId || !table.subTenantId) return base;

  const match = eq(table.subTenantId, scope.subTenantId);
  const sub = opts.includeShared ? or(match, isNull(table.subTenantId))! : match;
  return and(base, sub)!;
}

/** Value to stamp on INSERT (null = org-wide). */
export function subTenantValueForInsert(scope: TenantScope): string | null {
  return scope.subTenantId ?? null;
}
