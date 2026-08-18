/**
 * The messaging core: events in, messages out, and what happened to them.
 *
 * Identity columns that are NOT NULL today are nullable here, deliberately.
 * `message_history.patient_id` and `.provider_id` are both NOT NULL in the
 * source, which is exactly what makes a system-to-staff message impossible to
 * record and what blocks a tenant with no per-agent concept. See P2 design rules.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, subTenantId, tenantId, ts, updatedAt } from './_shared.js';
import { recipients } from './recipients.js';

/** ← `communication_events`. */
export const outreachEvents = pgTable(
  'outreach_events',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    type: text('type').notNull(),
    priority: text('priority').notNull().default('MEDIUM'),
    status: text('status').notNull().default('PENDING'),
    data: jsonb('data').notNull(),
    channels: text('channels').array().notNull().default(sql`'{}'::text[]`),
    metadata: jsonb('metadata'),
    recipientId: uuid('recipient_id').references(() => recipients.id, { onDelete: 'set null' }),
    senderId: text('sender_id'),
    /** -> playbooks.id. Cross-file: FK declared in 0003. */
    playbookId: uuid('playbook_id'),
    triggerType: text('trigger_type'),
    /** Ties every message produced by one event back together. */
    correlationId: text('correlation_id'),
    /** -> message_batches.id. Cross-file: FK declared in 0001. */
    batchId: uuid('batch_id'),
    processedAt: ts('processed_at'),
    error: text('error'),
    retryCount: integer('retry_count').notNull().default(0),
    nextRetryAt: ts('next_retry_at'),
    scheduledFor: ts('scheduled_for'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_outreach_events_status').on(t.status),
    index('idx_outreach_events_tenant_subtenant').on(t.tenantId, t.subTenantId),
    index('idx_outreach_events_correlation').on(t.correlationId),
  ],
);

/** ← `notifications`. Already generic; gains tenant_id and channel_ref. */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    eventId: uuid('event_id').references(() => outreachEvents.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    recipientId: uuid('recipient_id').references(() => recipients.id, { onDelete: 'set null' }),
    /** The literal address dispatched to: email, E.164 number, slack channel. */
    channelRef: text('channel_ref'),
    content: text('content').notNull(),
    status: text('status').notNull().default('PENDING'),
    sentAt: ts('sent_at'),
    deliveredAt: ts('delivered_at'),
    readAt: ts('read_at'),
    error: text('error'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_notifications_tenant_status').on(t.tenantId, t.status)],
);

/**
 * ← `message_history`.
 *
 * Three divergences beyond the rename:
 *  - `recipient_id` / `sender_id` nullable (see file header).
 *  - `sent_at` nullable. The source has it NOT NULL, which is only coherent
 *    when every row is already sent. A message in DRAFT or PENDING_APPROVAL has
 *    no send time, and P6 needs to store exactly that.
 *  - `direction` is a real column with a CHECK. Today it is
 *    `message_direction text NOT NULL` with no constraint, and some code paths
 *    read `metadata->>'direction'` instead.
 */
export const messages = pgTable(
  'messages',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    notificationId: uuid('notification_id').references(() => notifications.id, {
      onDelete: 'set null',
    }),
    eventId: uuid('event_id').references(() => outreachEvents.id, { onDelete: 'set null' }),
    recipientId: uuid('recipient_id').references(() => recipients.id, { onDelete: 'set null' }),
    senderId: text('sender_id'),
    channel: text('channel').notNull(),
    direction: text('direction').notNull().default('outbound'),
    content: text('content').notNull(),
    status: text('status').notNull(),
    sentAt: ts('sent_at'),
    deliveredAt: ts('delivered_at'),
    readAt: ts('read_at'),
    /** -> playbooks.id / templates.id / approvals.id. FKs declared in 0003/0001/0002. */
    playbookId: uuid('playbook_id'),
    templateId: uuid('template_id'),
    approvalId: uuid('approval_id'),
    aiGenerated: boolean('ai_generated').notNull().default(false),
    /** SendGrid/Twilio message id — how delivery webhooks find this row. */
    providerMessageId: text('provider_message_id'),
    /**
     * Why the compliance gate stopped this message (P5). NULL on everything
     * that was actually sent. Without it a suppressed message is
     * indistinguishable from one that was never created.
     */
    suppressionReason: text('suppression_reason'),
    /**
     * When a message the gate HELD becomes sendable again (P10). Distinct from
     * a hard suppression, which never becomes sendable and leaves this NULL.
     * `deferral.worker.ts` sweeps on it; see `0012_deferred_messages.sql` for
     * why it is a column rather than the `metadata.retryAt` it duplicates.
     */
    deferredUntil: ts('deferred_until'),
    // `queuedMessage` was here until P12 — the source's approval blob, which
    // this engine never wrote. `approvals` has held approval state since P6, so
    // the column only ever carried migrated values. Removed from `0001` rather
    // than dropped in a later migration: nothing had applied it. See D103.
    metadata: jsonb('metadata'),
    engagementData: jsonb('engagement_data'),
    conversationId: uuid('conversation_id'),
    threadId: uuid('thread_id'),
    senderName: text('sender_name'),
    participantPhone: text('participant_phone'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('messages_direction_check', sql`${t.direction} IN ('outbound','inbound')`),
    // Carried forward from schema/db.ts:403-421 — these were added for real
    // production problems, renamed to the new vocabulary.
    index('idx_messages_tenant_sender').on(t.tenantId, t.senderId),
    index('idx_messages_conversation').on(t.tenantId, t.senderId, t.recipientId, t.sentAt.desc()),
    index('idx_messages_sent_at').on(t.sentAt.desc()),
    index('idx_messages_status').on(t.status),
    index('idx_messages_channel').on(t.channel),
    index('idx_messages_tenant_subtenant').on(t.tenantId, t.subTenantId),
    index('idx_messages_provider_message_id').on(t.tenantId, t.providerMessageId),
    // Partial on `direction = 'inbound' AND provider_message_id IS NOT NULL` —
    // declared in 0017; the predicate is not expressible here. It is what makes
    // a retried Twilio callback a no-op instead of a second copy of the same
    // patient reply, and Twilio sends no timestamp so nothing upstream can
    // reject the replay.
    uniqueIndex('messages_inbound_provider_id_unique').on(t.tenantId, t.providerMessageId),
    // The compliance gate's rate-limit and throttle windows (P5, 0005).
    index('idx_messages_rate_window').on(t.tenantId, t.channel, t.direction, t.createdAt.desc()),
    index('idx_messages_recipient_window').on(
      t.tenantId,
      t.recipientId,
      t.direction,
      t.createdAt.desc(),
    ),
    // idx_messages_suppressed is partial (WHERE suppression_reason IS NOT NULL).
    // idx_messages_unread is partial (WHERE read_at IS NULL) — see 0001.
    // The source's message_history_queued_approval_idx is NOT carried forward:
    // the approvals table replaces the JSONB approval-status query entirely.
  ],
);

/** ← `message_analytics`. patient_id -> recipient_id, and now nullable. */
export const messageAnalytics = pgTable(
  'message_analytics',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    notificationId: uuid('notification_id').references(() => notifications.id, {
      onDelete: 'set null',
    }),
    recipientId: uuid('recipient_id').references(() => recipients.id, { onDelete: 'set null' }),
    openedAt: ts('opened_at'),
    clickedAt: ts('clicked_at'),
    clickedLink: text('clicked_link'),
    repliedAt: ts('replied_at'),
    replyContent: text('reply_content'),
    engagementScore: integer('engagement_score'),
    device: text('device'),
    platform: text('platform'),
    location: text('location'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_message_analytics_message').on(t.messageId),
    // message_analytics_message_unique — PARTIAL UNIQUE (message_id) WHERE
    // message_id IS NOT NULL — lives in 0008 only. Drizzle cannot express a
    // partial index, so this is one of the constraints D15 flags as needing
    // human eyes. It is load-bearing: three read paths LEFT JOIN this table,
    // and a second row per message duplicates that message in every list.
  ],
);

/** ← `scheduled_communications`. */
export const scheduledMessages = pgTable(
  'scheduled_messages',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    eventId: uuid('event_id').references(() => outreachEvents.id, { onDelete: 'cascade' }),
    scheduledFor: ts('scheduled_for').notNull(),
    recurrenceRule: text('recurrence_rule'),
    status: text('status').notNull().default('PENDING'),
    metadata: jsonb('metadata'),
    createdBy: text('created_by'),
    processedAt: ts('processed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'scheduled_messages_status_check',
      sql`${t.status} IN ('PENDING','PROCESSED','CANCELLED')`,
    ),
    index('idx_scheduled_messages_due').on(t.status, t.scheduledFor),
  ],
);

/** ← `ai_interactions` + tenant_id, playbook_id and cost. */
export const aiInteractions = pgTable(
  'ai_interactions',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    eventId: uuid('event_id').references(() => outreachEvents.id, { onDelete: 'set null' }),
    notificationId: uuid('notification_id').references(() => notifications.id, {
      onDelete: 'set null',
    }),
    /** -> playbooks.id. Cross-file: FK declared in 0003. */
    playbookId: uuid('playbook_id'),
    agentId: text('agent_id'),
    modelId: text('model_id').notNull(),
    actionGroup: text('action_group'),
    inputSummary: text('input_summary'),
    outputSummary: text('output_summary'),
    tokensUsed: integer('tokens_used'),
    /** Milliseconds. */
    processingTime: integer('processing_time'),
    /** New: per-call spend, so a tenant's AI cost is answerable without vendor bills. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    success: boolean('success').notNull(),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_ai_interactions_tenant_created').on(t.tenantId, t.createdAt.desc())],
);
