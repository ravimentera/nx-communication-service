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

  /** Accepts a uuid or a pack key — callers should not have to know which. */
  async get(tenantId: string, idOrKey: string): Promise<TemplateRecord | null> {
    const match = UUID_RE.test(idOrKey)
      ? eq(templates.id, idOrKey)
      : eq(templates.key, idOrKey);

    const [row] = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.tenantId, tenantId), match))
      .limit(1);

    return row ? toRecord(row) : null;
  }

  async list(tenantId: string, filter: TemplateFilter = {}): Promise<TemplateRecord[]> {
    const conditions: SQL[] = [eq(templates.tenantId, tenantId)];
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
    tenantId: string,
    template: TemplateCreate,
    actor?: string,
  ): Promise<TemplateRecord> {
    const [row] = await this.db
      .insert(templates)
      .values({
        tenantId,
        subTenantId: template.subTenantId ?? null,
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
    await this.snapshot(tenantId, row, actor, 'created');
    return toRecord(row);
  }

  async update(
    tenantId: string,
    id: string,
    patch: TemplateUpdate,
    actor?: string,
  ): Promise<TemplateRecord> {
    const current = await this.get(tenantId, id);
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
      .where(and(eq(templates.tenantId, tenantId), eq(templates.id, id)))
      .returning();

    if (!row) throw new NotFoundError(`Template '${id}' not found`);
    if (contentChanged) await this.snapshot(tenantId, row, actor, 'content updated');
    return toRecord(row);
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(templates)
      .where(and(eq(templates.tenantId, tenantId), eq(templates.id, id)))
      .returning({ id: templates.id });
    return deleted.length > 0;
  }

  async incrementUsage(tenantId: string, id: string): Promise<void> {
    await this.db
      .update(templates)
      .set({
        usageCount: sql`${templates.usageCount} + 1`,
        lastUsedAt: new Date(),
      })
      .where(and(eq(templates.tenantId, tenantId), eq(templates.id, id)));
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
  async setDefault(tenantId: string, id: string): Promise<TemplateRecord> {
    const target = await this.get(tenantId, id);
    if (!target) throw new NotFoundError(`Template '${id}' not found`);

    return this.db.transaction(async (tx) => {
      const siblingConditions: SQL[] = [
        eq(templates.tenantId, tenantId),
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
        .where(and(eq(templates.tenantId, tenantId), eq(templates.id, target.id)))
        .returning();

      if (!row) throw new NotFoundError(`Template '${id}' not found`);
      this.logger.info('template set as default', {
        tenantId,
        templateId: row.id,
        channel: row.channel,
        category: row.category,
      });
      return toRecord(row);
    });
  }

  async versions(tenantId: string, templateId: string): Promise<TemplateVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.tenantId, tenantId),
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
