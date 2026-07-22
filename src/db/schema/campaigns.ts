/**
 * Campaigns and audiences. Tables land in P2; the runtime is P11.
 *
 * `campaigns.provider_id` is NOT NULL today, which means a campaign cannot be
 * owned by the organisation rather than a person. Here `sender_id` is nullable.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, subTenantId, tenantId, ts, updatedAt } from './_shared.js';
import { recipients } from './recipients.js';

export const AUDIENCE_KINDS = ['static', 'query', 'accumulating'] as const;

export const audiences = pgTable(
  'audiences',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    name: text('name').notNull(),
    /**
     * static       — a fixed member list
     * query        — re-evaluated from `definition` at send time
     * accumulating — members added over time by a trigger, never removed
     */
    kind: text('kind').notNull().default('static'),
    definition: jsonb('definition').notNull().default(sql`'{}'::jsonb`),
    memberCount: integer('member_count').notNull().default(0),
    lastMaterializedAt: ts('last_materialized_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('audiences_kind_check', sql`${t.kind} IN ('static','query','accumulating')`),
    index('idx_audiences_tenant').on(t.tenantId),
  ],
);

/** Join table: composite PK, no surrogate id. */
export const audienceMembers = pgTable(
  'audience_members',
  {
    audienceId: uuid('audience_id')
      .notNull()
      .references(() => audiences.id, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => recipients.id, { onDelete: 'cascade' }),
    tenantId: tenantId(),
    addedAt: ts('added_at').notNull().defaultNow(),
    source: text('source'),
  },
  (t) => [
    primaryKey({ columns: [t.audienceId, t.recipientId] }),
    index('idx_audience_members_recipient').on(t.recipientId),
  ],
);

/** ← `communication_batches` + tenant_id and campaign_id. */
export const messageBatches = pgTable(
  'message_batches',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    /** -> campaigns.id. Same file, but campaigns is declared below. FK in 0001. */
    campaignId: uuid('campaign_id'),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('DRAFT'),
    eventCount: integer('event_count').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    scheduledFor: ts('scheduled_for'),
    metadata: jsonb('metadata'),
    createdBy: text('created_by'),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'message_batches_status_check',
      sql`${t.status} IN ('DRAFT','QUEUED','PROCESSING','COMPLETED','CANCELLED')`,
    ),
    index('idx_message_batches_tenant_status').on(t.tenantId, t.status),
  ],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    name: text('name').notNull(),
    description: text('description'),
    type: text('type').notNull(),
    status: text('status').notNull().default('DRAFT'),
    startDate: ts('start_date'),
    endDate: ts('end_date'),
    /** Legacy free-form targeting, superseded by audience_id. Kept for P9. */
    targetAudience: jsonb('target_audience'),
    /** -> templates.id. Cross-file: FK declared in 0001. */
    templateId: uuid('template_id'),
    /** -> playbooks.id. Cross-file: FK declared in 0003. */
    playbookId: uuid('playbook_id'),
    audienceId: uuid('audience_id').references(() => audiences.id, { onDelete: 'set null' }),
    /** Was provider_id NOT NULL. Nullable so a campaign can be org-owned. */
    senderId: text('sender_id'),
    /** {cron} | {sendAt} | {waves:[...]} */
    schedule: jsonb('schedule'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_campaigns_tenant_subtenant').on(t.tenantId, t.subTenantId),
    index('idx_campaigns_tenant_status').on(t.tenantId, t.status),
  ],
);

export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: id(),
    tenantId: tenantId(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id').references(() => recipients.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('PENDING'),
    sentAt: ts('sent_at'),
    deliveredAt: ts('delivered_at'),
    error: text('error'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_campaign_recipients_campaign').on(t.campaignId, t.status),
    index('idx_campaign_recipients_recipient').on(t.recipientId),
  ],
);
