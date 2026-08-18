/**
 * `TemplateStore` over `templates` + `template_versions`.
 * Ports the CRUD half of `template-engine.ts` plus the pieces of
 * `providers-service/src/services/template.service.ts` the engine now owns
 * (§0.5 Seam A).
 *
 * Every method takes `tenantId` and every query carries a tenant predicate —
 * Rule 4, without exception.
 */
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import {
  subTenantValueForInsert,
  tenantWhere,
  type TenantScope,
} from '../../platform/db/tenant-scope.js';
import { templates, templateVersions } from '../../db/schema.js';
import { NotFoundError } from '../../platform/http/errors.js';
import type {
  TemplateCreate,
  TemplateFilter,
  TemplateRecord,
  TemplateStore,
  TemplateUpdate,
  TemplateVersionRecord,
} from '../../ports/template-store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = typeof templates.$inferSelect;

function toRecord(row: Row): TemplateRecord {
  return row as unknown as TemplateRecord;
}

export class DrizzleTemplateStore implements TemplateStore {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  /**
   * The tenant predicate every method here uses.
   *
   * `includeShared: true` is the whole point: a template with a NULL
   * `sub_tenant_id` is ORG-WIDE, and that is what a pack install writes when it
   * is not scoped to a location. A location-scoped caller must see its own
   * templates and the org-wide ones — a plain `sub_tenant_id = X` would hide
   * every pack template from every location user, which looks like a fix and is
   * a worse bug.
   */
  private scoped(scope: TenantScope): SQL {
    return tenantWhere(templates, scope, { includeShared: true });
  }

  /** Accepts a uuid or a pack key — callers should not have to know which. */
  async get(scope: TenantScope, idOrKey: string): Promise<TemplateRecord | null> {
    const match = UUID_RE.test(idOrKey)
      ? eq(templates.id, idOrKey)
      : eq(templates.key, idOrKey);

    const [row] = await this.db
      .select()
      .from(templates)
      .where(and(this.scoped(scope), match))
      .limit(1);

    return row ? toRecord(row) : null;
  }

  async list(scope: TenantScope, filter: TemplateFilter = {}): Promise<TemplateRecord[]> {
    const conditions: SQL[] = [this.scoped(scope)];
    if (filter.channel) conditions.push(eq(templates.channel, filter.channel));
    if (filter.category) conditions.push(eq(templates.category, filter.category));
    if (filter.templateType) conditions.push(eq(templates.templateType, filter.templateType));
    if (filter.packId) conditions.push(eq(templates.packId, filter.packId));
    if (filter.subTenantId) conditions.push(eq(templates.subTenantId, filter.subTenantId));
    if (filter.isActive !== undefined) conditions.push(eq(templates.isActive, filter.isActive));
    if (filter.isDefault !== undefined) conditions.push(eq(templates.isDefault, filter.isDefault));

    const rows = await this.db
      .select()
      .from(templates)
      .where(and(...conditions))
      .orderBy(desc(templates.updatedAt))
      .limit(filter.limit ?? 100)
      .offset(filter.offset ?? 0);

    return rows.map(toRecord);
  }

  async create(
    scope: TenantScope,
    template: TemplateCreate,
    actor?: string,
  ): Promise<TemplateRecord> {
    const [row] = await this.db
      .insert(templates)
      .values({
        tenantId: scope.tenantId,
        // The caller's explicit choice, else the scope's own sub-tenant. A
        // location-scoped user creating a template gets a template for their
        // location, not one silently shared with every other location.
        subTenantId: template.subTenantId ?? subTenantValueForInsert(scope),
        packId: template.packId ?? null,
        key: template.key ?? null,
        name: template.name,
        description: template.description ?? null,
        channel: template.channel,
        subject: template.subject ?? null,
        content: template.content,
        htmlVersion: template.htmlVersion ?? null,
        previewText: template.previewText ?? null,
        variables: template.variables ?? null,
        format: template.format,
        category: template.category ?? null,
        templateType: template.templateType ?? null,
        tags: template.tags ?? null,
        status: template.status ?? 'published',
        isActive: template.isActive ?? true,
        isDefault: template.isDefault ?? false,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();

    if (!row) throw new Error('template insert returned no row');
    await this.snapshot(scope.tenantId, row, actor, 'created');
    return toRecord(row);
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: TemplateUpdate,
    actor?: string,
  ): Promise<TemplateRecord> {
    const current = await this.get(scope, id);
    if (!current) throw new NotFoundError(`Template '${id}' not found`);

    // A content change bumps the version and snapshots the previous body, so
    // `template_versions` is a real history rather than an empty table.
    const contentChanged =
      patch.content !== undefined && patch.content !== current.content;

    const [row] = await this.db
      .update(templates)
      .set({
        ...patch,
        ...(contentChanged ? { version: current.version + 1 } : {}),
        updatedBy: actor,
        updatedAt: new Date(),
      })
      .where(and(this.scoped(scope), eq(templates.id, id)))
      .returning();

    if (!row) throw new NotFoundError(`Template '${id}' not found`);
    if (contentChanged) await this.snapshot(scope.tenantId, row, actor, 'content updated');
    return toRecord(row);
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(templates)
      .where(and(this.scoped(scope), eq(templates.id, id)))
      .returning({ id: templates.id });
    return deleted.length > 0;
  }

  async incrementUsage(scope: TenantScope, id: string): Promise<void> {
    await this.db
      .update(templates)
      .set({
        usageCount: sql`${templates.usageCount} + 1`,
        lastUsedAt: new Date(),
      })
      .where(and(this.scoped(scope), eq(templates.id, id)));
  }

  /**
   * Ported from `providers-service/src/services/template.service.ts:275-305`.
   *
   * THE `category IS NULL` CASE IS LOAD-BEARING. Clearing siblings with
   * `eq(category, template.category)` when the category is null matches nothing
   * in SQL — `NULL = NULL` is unknown — so two uncategorised templates would
   * both end up default and the FE would pick whichever the database returned
   * first. The null branch must use `IS NULL`.
   *
   * Both writes run in one transaction: a crash between them would leave the
   * tenant with no default at all.
   */
  async setDefault(scope: TenantScope, id: string): Promise<TemplateRecord> {
    const target = await this.get(scope, id);
    if (!target) throw new NotFoundError(`Template '${id}' not found`);

    return this.db.transaction(async (tx) => {
      const siblingConditions: SQL[] = [
        // Siblings are scoped the same way the target was found, so a location
        // setting its own default does not clear the org-wide one for everybody.
        this.scoped(scope),
        eq(templates.channel, target.channel),
        eq(templates.isDefault, true),
        target.category
          ? eq(templates.category, target.category)
          : isNull(templates.category),
      ];

      await tx
        .update(templates)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(...siblingConditions));

      const [row] = await tx
        .update(templates)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(this.scoped(scope), eq(templates.id, target.id)))
        .returning();

      if (!row) throw new NotFoundError(`Template '${id}' not found`);
      this.logger.info('template set as default', {
        tenantId: scope.tenantId,
        templateId: row.id,
        channel: row.channel,
        category: row.category,
      });
      return toRecord(row);
    });
  }

  async versions(scope: TenantScope, templateId: string): Promise<TemplateVersionRecord[]> {
    // Guarded through the template, not just the version rows: `template_versions`
    // has a tenant column and no sub-tenant one, so reading it directly would
    // hand a location every other location's revision history.
    const template = await this.get(scope, templateId);
    if (!template) return [];

    const rows = await this.db
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.tenantId, scope.tenantId),
          eq(templateVersions.templateId, templateId),
        ),
      )
      .orderBy(asc(templateVersions.version));

    return rows as unknown as TemplateVersionRecord[];
  }

  private async snapshot(
    tenantId: string,
    row: Row,
    actor: string | undefined,
    note: string,
  ): Promise<void> {
    await this.db
      .insert(templateVersions)
      .values({
        tenantId,
        templateId: row.id,
        version: row.version,
        name: row.name,
        subject: row.subject,
        content: row.content,
        htmlVersion: row.htmlVersion,
        variables: row.variables,
        changedBy: actor,
        changeNote: note,
      })
      .onConflictDoNothing();
  }
}
