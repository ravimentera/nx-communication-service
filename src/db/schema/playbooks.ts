/**
 * Playbooks — the replacement for the `EventType` enum + switch.
 *
 * Today: a 44-value `EventType` enum in `models/communication.model.ts` and a
 * single 17-case switch in `events/enhanced-event-handler.ts` (725 LOC) with 21
 * hardcoded template-id string literals and `to: 'emergency-team@medspa.com'`
 * at :549. Adding an event type means editing and redeploying the service.
 *
 * Here it is rows. A playbook says what to send, on which channels, whether it
 * needs approval, and how often it may fire. `playbook_triggers` says when.
 * The 17 medspa cases become 17 seeded rows in P7.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, subTenantId, tenantId, ts, updatedAt } from './_shared.js';

/**
 * Global catalogue of installable packs. Like `tenants`, this table has no
 * `tenant_id` — a pack is not owned by a tenant; `tenant_packs` records who
 * installed it. Second and last documented exception to the tenant_id rule.
 */
export const packs = pgTable('packs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  description: text('description'),
  /** Declares the playbooks, templates, prompts and policies the pack ships. */
  manifest: jsonb('manifest').notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tenantPacks = pgTable(
  'tenant_packs',
  {
    tenantId: tenantId(),
    packId: text('pack_id')
      .notNull()
      .references(() => packs.id, { onDelete: 'restrict' }),
    installedAt: ts('installed_at').notNull().defaultNow(),
    /** Per-tenant overrides of pack defaults. */
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.packId] })],
);

export const playbooks = pgTable(
  'playbooks',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    packId: text('pack_id'),
    /** e.g. 'medspa.appointment_reminder'. Stable across versions. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    /** Lower runs first when several playbooks match one event. */
    priority: integer('priority').notNull().default(100),
    /** JSON Schema for caller-supplied context, generated from Zod (§0.9). */
    dataContract: jsonb('data_contract').notNull().default(sql`'{}'::jsonb`),
    /** {kind:'template',templateKey} | {kind:'ai',promptPackKey} | {kind:'hybrid',...} */
    contentSource: jsonb('content_source').notNull().default(sql`'{}'::jsonb`),
    /** [{channel, priority, fallbackAfterMs}] — replaces the dispatch switch. */
    channelPlan: jsonb('channel_plan').notNull().default(sql`'[]'::jsonb`),
    /** -> approval_policies.id. Cross-file: FK declared in 0003. */
    approvalPolicyId: uuid('approval_policy_id'),
    /** {maxPerRecipientPerDay, cooldownHours} */
    throttle: jsonb('throttle').notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('playbooks_tenant_key_unique').on(t.tenantId, t.key),
    index('idx_playbooks_tenant_active').on(t.tenantId, t.isActive),
    index('idx_playbooks_pack').on(t.packId),
  ],
);

export const TRIGGER_TYPES = ['event', 'schedule', 'manual', 'campaign', 'webhook'] as const;

export const playbookTriggers = pgTable(
  'playbook_triggers',
  {
    id: id(),
    tenantId: tenantId(),
    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),
    triggerType: text('trigger_type').notNull(),
    /** {eventType:'APPOINTMENT_REMINDER', where:{...}} */
    matchRules: jsonb('match_rules').notNull().default(sql`'{}'::jsonb`),
    scheduleCron: text('schedule_cron'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'playbook_triggers_type_check',
      sql`${t.triggerType} IN ('event','schedule','manual','campaign','webhook')`,
    ),
    index('idx_playbook_triggers_playbook').on(t.playbookId),
    index('idx_playbook_triggers_tenant_type').on(t.tenantId, t.triggerType, t.isActive),
  ],
);
