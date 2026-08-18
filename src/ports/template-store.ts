/**
 * The template store port. Backed by `templates` + `template_versions`.
 *
 * §0.5 Seam A: this table is declared in both communication-service and
 * providers-service today, with different columns and the real foreign keys on
 * the providers side. The engine owns it after P10, and
 * `providers-service/src/services/template.service.ts` becomes an HTTP client
 * against this interface.
 */
import type { TenantScope } from '../platform/db/tenant-scope.js';
import type { ChannelType } from './channel.js';

export interface TemplateRecord {
  id: string;
  tenantId: string;
  subTenantId?: string | null;
  packId?: string | null;
  key?: string | null;
  name: string;
  description?: string | null;
  channel: string;
  subject?: string | null;
  content: string;
  htmlVersion?: string | null;
  previewText?: string | null;
  variables?: unknown;
  format: string;
  category?: string | null;
  templateType?: string | null;
  tags?: string[] | null;
  status: string;
  isActive: boolean;
  isDefault: boolean;
  version: number;
  usageCount: number;
}

export interface TemplateFilter {
  channel?: ChannelType | string;
  category?: string;
  templateType?: string;
  packId?: string;
  isActive?: boolean;
  isDefault?: boolean;
  subTenantId?: string;
  limit?: number;
  offset?: number;
}

/** `tenantId` is a separate argument on every method — never part of the body. */
export type TemplateCreate = Omit<
  TemplateRecord,
  'id' | 'tenantId' | 'version' | 'usageCount' | 'isDefault' | 'isActive' | 'status'
> &
  Partial<Pick<TemplateRecord, 'isDefault' | 'isActive' | 'status'>>;

export type TemplateUpdate = Partial<Omit<TemplateRecord, 'id' | 'tenantId'>>;

export interface TemplateVersionRecord {
  id: string;
  templateId: string;
  version: number;
  name?: string | null;
  subject?: string | null;
  content: string;
  htmlVersion?: string | null;
  changedBy?: string | null;
  changeNote?: string | null;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY METHOD TAKES A SCOPE, NOT A TENANT ID.
 *
 * It used to take a bare `tenantId`, so a caller scoped to one location could
 * read, edit, default and **delete** another location's templates by id. The
 * delete is the sharp one: it cascades into `template_versions` (Seam A, D66).
 *
 * A `TenantScope` carries the optional `subTenantId`, and the store applies
 * `tenantWhere(..., { includeShared: true })` — so a location sees its own
 * templates AND the org-wide ones, which is the semantics that helper was
 * written for and never used.
 *
 * `includeShared` is not a nicety here. `installTemplates` stamps
 * `subTenantId: scope.subTenantId`, which is NULL for an org-wide pack install
 * — so a plain equality filter would hide every pack template from every
 * location-scoped user, which is the shape of fix a reader reaches for first.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface TemplateStore {
  /** Accepts either a uuid or a pack key such as `medspa.reminder.sms`. */
  get(scope: TenantScope, idOrKey: string): Promise<TemplateRecord | null>;
  list(scope: TenantScope, filter?: TemplateFilter): Promise<TemplateRecord[]>;
  create(scope: TenantScope, template: TemplateCreate, actor?: string): Promise<TemplateRecord>;
  update(
    scope: TenantScope,
    id: string,
    patch: TemplateUpdate,
    actor?: string,
  ): Promise<TemplateRecord>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
  incrementUsage(scope: TenantScope, id: string): Promise<void>;
  /**
   * Marks one template default and clears the flag on its siblings — the same
   * `(tenant, channel, category)` group, **including when category is NULL**.
   */
  setDefault(scope: TenantScope, id: string): Promise<TemplateRecord>;
  versions(scope: TenantScope, templateId: string): Promise<TemplateVersionRecord[]>;
}
