/**
 * Recipients — the engine's own identity store, and the death of §0.5 Seam C.
 *
 * `communications.controller.ts` reaches across the database boundary into
 * patient-service's table at three places to resolve display names for the
 * inbox:
 *
 *   :1238-1246  SELECT patient_id, first_name || ' ' || last_name FROM patients
 *               WHERE patient_id IN (…)
 *   :1439-1443  the same, for one patient
 *   :1669-1673  the same again
 *
 * Those queries are why "own database" was expensive, and they do not survive.
 * `listByIds` is the direct replacement for the first; `getOrResolve` for the
 * other two.
 */
import { and, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { recipients } from '../../db/schema.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { tenantWhere } from '../../platform/db/tenant-scope.js';
import type { ContextRef, ResolvedRecipient } from '../../ports/context-provider.js';
import type { ContextRegistry } from '../context/registry.js';

export type Recipient = typeof recipients.$inferSelect;

/**
 * The `external_ref.system` for a recipient the engine minted from an address
 * alone, because a caller sent to one without naming a person. Distinct from a
 * real system's ids so it is obvious in the table which rows those are.
 */
export const CONTACT_POINT_SYSTEM = 'contact-point';

export interface ExternalRef {
  system: string;
  id: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RecipientServiceDeps {
  db: Db;
  logger: Logger;
  context?: ContextRegistry;
}

export class RecipientService {
  constructor(private readonly deps: RecipientServiceDeps) {}

  /**
   * The recipient holding this address, created if there is none.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WHY THE ENGINE NEEDS THIS AT ALL
   *
   * The compliance gate is keyed on `recipientId`. Without one it skips
   * consent, per-channel preference, per-playbook opt-out and every throttle —
   * so a send with an address but no recipient faced none of them. The MCP
   * tools, `POST /v1/messages` with a bare address, the compat test-SMS route
   * and `compat/send.ts` without a `patientId` were all in that state: an agent
   * could text a number that had unsubscribed, and nothing would stop it.
   *
   * Resolving here rather than requiring callers to is deliberate. There are
   * eight paths and a ninth will be written; making the DISPATCHER answer
   * "who is this going to?" is what stops the ninth from arriving unguarded.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * THE external_ref IT MINTS
   *
   * `{system: 'contact-point', id: '<type>:<value>'}` — deterministic, so the
   * same address always resolves to the same recipient and their opt-out is
   * found on the second send as well as the first. It also means the row merges
   * naturally if a context provider later attaches a real external ref.
   */
  async resolveByContactPoint(
    scope: TenantScope,
    point: { type: string; value: string },
  ): Promise<Recipient | null> {
    const value = point.value?.trim();
    if (!value) return null;

    // Match an existing recipient who already lists this address, whatever
    // system they came from — a patient resolved from mentera-patient must not
    // acquire a second row because one send happened to omit their id.
    const [existing] = await this.deps.db
      .select()
      .from(recipients)
      .where(
        and(
          eq(recipients.tenantId, scope.tenantId),
          sql`${recipients.contactPoints} @> ${JSON.stringify([{ value }])}::jsonb`,
        ),
      )
      .limit(1);

    if (existing) return existing;

    return this.upsertByExternalRef(
      scope,
      { system: CONTACT_POINT_SYSTEM, id: `${point.type}:${value}` },
      { contactPoints: [{ type: point.type, value, primary: true }] },
    );
  }

  /**
   * Idempotent on `recipients_tenant_external_ref_unique`. Two workers handling
   * the same event concurrently must not create two recipients — the unique
   * index makes that a conflict rather than a duplicate, and `onConflictDoUpdate`
   * turns the conflict into the update it should have been.
   */
  async upsertByExternalRef(
    scope: TenantScope,
    ref: ExternalRef,
    patch: ResolvedRecipient = {},
  ): Promise<Recipient> {
    // `recipients_tenant_external_ref_unique` is an EXPRESSION index — on
    // `external_ref->>'system'` and `->>'id'` — and drizzle's
    // `onConflictDoUpdate` only accepts columns as a conflict target. So:
    // insert-or-nothing (atomic, the index decides the race), then update the
    // existing row if the insert lost. Both concurrent callers converge on the
    // same row, which is what idempotent means here.
    const [inserted] = await this.deps.db
      .insert(recipients)
      .values({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId ?? null,
        externalRef: ref,
        displayName: patch.displayName ?? null,
        firstName: patch.firstName ?? null,
        lastName: patch.lastName ?? null,
        timezone: patch.timezone ?? null,
        locale: patch.locale ?? null,
        ...(patch.contactPoints ? { contactPoints: patch.contactPoints } : {}),
        ...(patch.attributes ? { attributes: patch.attributes } : {}),
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) return inserted;

    const hasUpdate =
      patch.displayName !== undefined ||
      patch.firstName !== undefined ||
      patch.lastName !== undefined ||
      patch.timezone !== undefined ||
      patch.locale !== undefined ||
      patch.contactPoints !== undefined;

    if (!hasUpdate) {
      const existing = await this.getByExternalRef(scope, ref);
      if (!existing) throw new Error('recipient upsert found no row after conflict');
      return existing;
    }

    // COALESCE so a partial refresh never blanks a field we already knew.
    const [updated] = await this.deps.db
      .update(recipients)
      .set({
        displayName: sql`COALESCE(${patch.displayName ?? null}, ${recipients.displayName})`,
        firstName: sql`COALESCE(${patch.firstName ?? null}, ${recipients.firstName})`,
        lastName: sql`COALESCE(${patch.lastName ?? null}, ${recipients.lastName})`,
        timezone: sql`COALESCE(${patch.timezone ?? null}, ${recipients.timezone})`,
        locale: sql`COALESCE(${patch.locale ?? null}, ${recipients.locale})`,
        ...(patch.contactPoints ? { contactPoints: patch.contactPoints } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recipients.tenantId, scope.tenantId),
          sql`${recipients.externalRef}->>'system' = ${ref.system}`,
          sql`${recipients.externalRef}->>'id' = ${ref.id}`,
        ),
      )
      .returning();

    if (!updated) throw new Error('recipient upsert found no row after conflict');
    return updated;
  }

  async getById(scope: TenantScope, id: string): Promise<Recipient | null> {
    const [row] = await this.deps.db
      .select()
      .from(recipients)
      .where(and(tenantWhere(recipients, scope), eq(recipients.id, id)))
      .limit(1);
    return row ?? null;
  }

  async getByExternalRef(scope: TenantScope, ref: ExternalRef): Promise<Recipient | null> {
    const [row] = await this.deps.db
      .select()
      .from(recipients)
      .where(
        and(
          eq(recipients.tenantId, scope.tenantId),
          sql`${recipients.externalRef}->>'system' = ${ref.system}`,
          sql`${recipients.externalRef}->>'id' = ${ref.id}`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Read-through: a known recipient is returned as-is; an unknown one is
   * resolved through the context provider and stored. This is what replaces the
   * single-patient lookups at `communications.controller.ts:1439` and `:1669`,
   * which fell back to the literal string `'Unknown Patient'`.
   */
  async getOrResolve(scope: TenantScope, ref: ContextRef): Promise<Recipient | null> {
    if (!ref.id) return null;
    const externalRef: ExternalRef = { system: ref.kind, id: ref.id };

    const existing = await this.getByExternalRef(scope, externalRef);
    if (existing?.displayName) return existing;

    if (!this.deps.context) return existing;

    try {
      const resolved = await this.deps.context.resolveRecipient(ref, scope);
      return await this.upsertByExternalRef(scope, resolved.externalRef ?? externalRef, resolved);
    } catch (error) {
      // A resolution failure must not fail the caller — an inbox that renders
      // without one display name beats an inbox that 500s.
      this.deps.logger.warn('failed to resolve recipient identity', {
        kind: ref.kind,
        id: ref.id,
        tenantId: scope.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return existing;
    }
  }

  /**
   * Batch lookup. The direct replacement for the `IN (…)` raw query.
   *
   * **The empty-array guard is load-bearing.** `IN ()` is invalid SQL in
   * Postgres, and the source 500'd the entire inbox for any provider with no
   * messages until someone noticed — there is a comment about it at
   * `communications.controller.ts:1234`. Drizzle's `inArray` with `[]` has had
   * the same sharp edge across versions, so the guard stays explicit rather than
   * relying on the library.
   */
  async listByIds(scope: TenantScope, ids: string[]): Promise<Recipient[]> {
    if (ids.length === 0) return [];
    return this.deps.db
      .select()
      .from(recipients)
      .where(and(tenantWhere(recipients, scope), inArray(recipients.id, ids)));
  }

  /** Same guard, keyed by the source system's ids. */
  async listByExternalIds(
    scope: TenantScope,
    system: string,
    ids: string[],
  ): Promise<Recipient[]> {
    if (ids.length === 0) return [];
    return this.deps.db
      .select()
      .from(recipients)
      .where(
        and(
          eq(recipients.tenantId, scope.tenantId),
          sql`${recipients.externalRef}->>'system' = ${system}`,
          sql`${recipients.externalRef}->>'id' = ANY(${ids})`,
        ),
      );
  }

  async search(
    scope: TenantScope,
    query: string,
    page = 1,
    pageSize = 25,
  ): Promise<Page<Recipient>> {
    const term = `%${query}%`;
    const filters: SQL[] = [tenantWhere(recipients, scope)];
    if (query) {
      const match = or(
        ilike(recipients.displayName, term),
        ilike(recipients.firstName, term),
        ilike(recipients.lastName, term),
      );
      if (match) filters.push(match);
    }
    const where = and(...filters);

    const [items, [counted]] = await Promise.all([
      this.deps.db
        .select()
        .from(recipients)
        .where(where)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.deps.db
        .select({ count: sql<number>`count(*)::int` })
        .from(recipients)
        .where(where),
    ]);

    return { items, total: counted?.count ?? 0, page, pageSize };
  }

  async setStatus(
    scope: TenantScope,
    id: string,
    status: 'active' | 'unsubscribed' | 'bounced' | 'deleted',
  ): Promise<void> {
    await this.deps.db
      .update(recipients)
      .set({ status, updatedAt: new Date() })
      .where(and(tenantWhere(recipients, scope), eq(recipients.id, id)));
  }
}
