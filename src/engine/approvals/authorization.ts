/**
 * Who holds a role, for approvals assigned to one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS ACTUALLY BROKEN
 *
 * `policy.service.ts:334-346` assigns a role approval and says, in a comment,
 * that "members are resolved at authorization time instead". They were not. The
 * per-row check in `approval.service.ts` fell through to a bare permission test:
 * anyone holding `outreach:approve` could approve a message assigned to any
 * role, in their tenant, whether or not they held it.
 *
 * That is not the same defect as D45 — the tenant boundary held — but it is the
 * same shape: an authorization decision that reads as enforced and is not. A
 * clinic that routes aesthetician messages to a `nurse-practitioner` role gets
 * no separation from it at all, and the only sign is that nothing complains.
 *
 * `group` was already checked, because its `approverRef` carries the member ids
 * inline. `role` had nowhere to look them up.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHERE MEMBERSHIP COMES FROM
 *
 * `tenant_packs.config.roleMembers` — a map of role name to user ids, set by the
 * tenant at install:
 *
 *   { "roleMembers": { "nurse-practitioner": ["user-1", "user-2"] } }
 *
 * That is §0.10 tier 2, and it is deliberately not a table. The engine does not
 * own identity: a consumer already has one, and modelling users here would mean
 * every tenant syncing its directory into this service to send a message.
 *
 * A deployment with a real directory implements `AuthorizationProvider` against
 * it and registers that instead — the interface is the seam, and it predates
 * this file.
 *
 * **An unknown role resolves to no members**, so an approval assigned to a role
 * nobody is configured for cannot be acted on by anyone except an admin. That
 * is the safe direction: the alternative — treating "no configuration" as "all
 * users" — is how the check ends up decorative again.
 */
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { tenantPacks } from '../../db/schema.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import type { AuthorizationProvider } from './policy.service.js';

export interface TenantConfigAuthorizationDeps {
  db: Db;
  logger: Logger;
  /** Seconds. Membership changes rarely and is read on every role decision. */
  cacheTtlSeconds?: number;
}

interface CacheEntry {
  roles: Record<string, string[]>;
  expiresAt: number;
}

export class TenantConfigAuthorizationProvider implements AuthorizationProvider {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: TenantConfigAuthorizationDeps) {}

  async membersOf(scope: TenantScope, role: string): Promise<string[]> {
    const roles = await this.rolesFor(scope);
    return roles[role] ?? [];
  }

  /**
   * Merged across every pack the tenant has installed.
   *
   * A tenant with two packs has two config blobs and one set of people; making
   * the caller name a pack to ask "who is a nurse practitioner here" would push
   * a detail of the pack mechanism into an authorization decision.
   */
  private async rolesFor(scope: TenantScope): Promise<Record<string, string[]>> {
    const cached = this.cache.get(scope.tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.roles;

    const rows = await this.deps.db
      .select({ config: tenantPacks.config })
      .from(tenantPacks)
      .where(and(eq(tenantPacks.tenantId, scope.tenantId), eq(tenantPacks.isActive, true)));

    const roles: Record<string, string[]> = {};
    for (const row of rows) {
      const configured = (row.config as { roleMembers?: unknown } | null)?.roleMembers;
      if (!configured || typeof configured !== 'object' || Array.isArray(configured)) continue;

      for (const [role, members] of Object.entries(configured as Record<string, unknown>)) {
        if (!Array.isArray(members)) continue;
        const ids = members.filter((m): m is string => typeof m === 'string');
        roles[role] = [...new Set([...(roles[role] ?? []), ...ids])];
      }
    }

    // In-process rather than Redis: the value is small, the TTL is short, and a
    // replica holding a stale membership for a minute can only ever be wrong in
    // the direction of the check it already applies — an admin is unaffected,
    // and a newly-added member waits up to a minute for their inbox.
    this.cache.set(scope.tenantId, {
      roles,
      expiresAt: Date.now() + (this.deps.cacheTtlSeconds ?? 60) * 1000,
    });

    return roles;
  }

  /** Called after a config write, so a membership change is not held for a minute. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
