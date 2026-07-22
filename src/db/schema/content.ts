/**
 * Content plane: templates, their versions, prompt packs and assets.
 *
 * §0.5 Seam A. `communication_templates` is declared in BOTH
 * `communication-service/src/schema/db.ts:104` and
 * `providers-service/src/db/schema.ts:344`, with different columns. `templates`
 * below is the UNION of the two column sets, because the engine has to own this
 * table — a non-medspa tenant has no providers-service.
 *
 * `template_versions` MOVES here from providers-service (it holds the real FK
 * today). providers-service's `notification_rules.email_template_id` /
 * `sms_template_id` become soft references: FK dropped, column kept, and
 * `templates.id` values PRESERVED across the P9 migration so they stay valid.
 * That id preservation is a hard requirement, not a nicety.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, subTenantId, tenantId, ts, updatedAt } from './_shared.js';

export const templates = pgTable(
  'templates',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    /** Non-null when the row was seeded by a pack rather than authored. */
    packId: text('pack_id'),
    /** Stable lookup key, e.g. 'medspa.appointment_reminder.sms'. */
    key: text('key'),
    name: text('name').notNull(),
    description: text('description'),
    channel: text('channel').notNull(),
    subject: text('subject'),
    content: text('content').notNull(),
    htmlVersion: text('html_version'),
    previewText: text('preview_text'),
    variables: jsonb('variables'),
    format: text('format').notNull().default('TEXT'),
    category: text('category'),
    templateType: text('template_type'),
    tags: text('tags').array(),
    /** [{fileName, fileUrl, fileType, fileSize}] */
    attachments: jsonb('attachments').notNull().default(sql`'[]'::jsonb`),
    /** From the providers-service column set: 'draft' | 'published' | 'archived'. */
    status: text('status').notNull().default('published'),
    isActive: boolean('is_active').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    version: integer('version').notNull().default(1),
    usageCount: integer('usage_count').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('templates_format_check', sql`${t.format} IN ('TEXT','HTML','MARKDOWN','MJML')`),
    check('templates_status_check', sql`${t.status} IN ('draft','published','archived')`),
    index('idx_templates_tenant').on(t.tenantId),
    index('idx_templates_tenant_channel').on(t.tenantId, t.channel),
    index('idx_templates_pack').on(t.packId),
    // UNIQUE (tenant_id, key) WHERE key IS NOT NULL is partial — see 0001.
  ],
);

/** ← moved from providers-service (`schema.ts:4406`). */
export const templateVersions = pgTable(
  'template_versions',
  {
    id: id(),
    tenantId: tenantId(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    name: text('name'),
    subject: text('subject'),
    content: text('content').notNull(),
    htmlVersion: text('html_version'),
    variables: jsonb('variables'),
    changedBy: text('changed_by'),
    changeNote: text('change_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('template_versions_template_version_unique').on(t.templateId, t.version),
    index('idx_template_versions_tenant').on(t.tenantId),
  ],
);

/**
 * Prompt assembly inputs for AI-generated content (P4). This is where the
 * healthcare vocabulary currently inlined in `ai-message-generator.ts` and
 * `ai-enhanced-communication.controller.ts` moves to — out of code, into
 * pack-owned rows.
 *
 * `tenant_id` is NULLABLE here: a NULL row is a pack-provided default shared by
 * every tenant that installed the pack. A non-null row overrides it.
 */
export const promptPacks = pgTable(
  'prompt_packs',
  {
    id: id(),
    tenantId: text('tenant_id'),
    packId: text('pack_id'),
    key: text('key').notNull(),
    version: integer('version').notNull().default(1),
    persona: text('persona'),
    goal: text('goal'),
    constraints: text('constraints'),
    /** {SMS:{maxChars:160}, EMAIL:{...}} */
    channelRules: jsonb('channel_rules'),
    /** {model, temperature, maxTokens} */
    modelHints: jsonb('model_hints'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_prompt_packs_key').on(t.key)],
);

export const assets = pgTable(
  'assets',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    /** 'image' | 'document' | 'generated' */
    kind: text('kind').notNull(),
    url: text('url').notNull(),
    mimeType: text('mime_type'),
    size: integer('size'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_assets_tenant').on(t.tenantId)],
);
