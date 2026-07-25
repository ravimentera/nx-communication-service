/**
 * The template store port. Backed by `templates` + `template_versions`.
 *
 * §0.5 Seam A: this table is declared in both communication-service and
 * providers-service today, with different columns and the real foreign keys on
 * the providers side. The engine owns it after P10, and
 * `providers-service/src/services/template.service.ts` becomes an HTTP client
 * against this interface.
 */
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

export interface TemplateStore {
  /** Accepts either a uuid or a pack key such as `medspa.reminder.sms`. */
  get(tenantId: string, idOrKey: string): Promise<TemplateRecord | null>;
  list(tenantId: string, filter?: TemplateFilter): Promise<TemplateRecord[]>;
  create(tenantId: string, template: TemplateCreate, actor?: string): Promise<TemplateRecord>;
  update(
    tenantId: string,
    id: string,
    patch: TemplateUpdate,
    actor?: string,
  ): Promise<TemplateRecord>;
  delete(tenantId: string, id: string): Promise<boolean>;
  incrementUsage(tenantId: string, id: string): Promise<void>;
  /**
   * Marks one template default and clears the flag on its siblings — the same
   * `(tenant, channel, category)` group, **including when category is NULL**.
   */
  setDefault(tenantId: string, id: string): Promise<TemplateRecord>;
  versions(tenantId: string, templateId: string): Promise<TemplateVersionRecord[]>;
}
