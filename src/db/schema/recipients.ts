/**
 * Recipients and everything keyed to them.
 *
 * This table is the answer to §0.5 Seam C: `communications.controller.ts` reads
 * `SELECT ... FROM patients` at :1240, :1441 and :1671 to resolve display names
 * for the inbox. That cross-database read does not survive — the engine owns
 * `recipients`, populated by the ContextProvider on first contact (P5).
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

export const RECIPIENT_STATUSES = ['active', 'unsubscribed', 'bounced', 'deleted'] as const;

export const recipients = pgTable(
  'recipients',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    displayName: text('display_name'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    timezone: text('timezone'),
    locale: text('locale'),
    /** [{type:'email'|'phone'|'slack'|'push', value, verified, primary}] */
    contactPoints: jsonb('contact_points').notNull().default(sql`'[]'::jsonb`),
    /** {system:'mentera-patient', id:'...'} — the link back to a source system. */
    externalRef: jsonb('external_ref'),
    status: text('status').notNull().default('active'),
    /** Pack-specific and schemaless: lead score, treatment history, whatever. */
    attributes: jsonb('attributes').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('recipients_status_check', sql`${t.status} IN ('active','unsubscribed','bounced','deleted')`),
    index('idx_recipients_tenant').on(t.tenantId),
    index('idx_recipients_tenant_subtenant').on(t.tenantId, t.subTenantId),
    index('idx_recipients_status').on(t.tenantId, t.status),
    // UNIQUE (tenant_id, external_ref->>'system', external_ref->>'id') is an
    // expression index — declared in migrations/0001, not expressible here.
  ],
);

/** Proof of consent per channel. New: the source had no consent record at all. */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => recipients.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    granted: boolean('granted').notNull(),
    /** 'signup_form' | 'double_optin' | 'import' | 'verbal' | 'api' */
    source: text('source'),
    /** Whatever proves it: form payload, IP, timestamp, recording ref. */
    proof: jsonb('proof'),
    grantedAt: ts('granted_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_consent_recipient_channel').on(t.tenantId, t.recipientId, t.channel),
  ],
);

/**
 * ← `communication_preferences`, rekeyed from (user_id, patient_id) to
 * recipient_id. §0.5 Seam B: patient-service LEFT JOINs the old table onto
 * `patients`; that JOIN is dropped in P10.
 *
 * Two additions:
 *  - `quiet_hours_timezone`. Today quiet hours are bare 'HH:MM' strings and the
 *    zone is resolved at check time from a config lookup
 *    (`preference.service.ts:331`). Storing it here removes a whole class of
 *    ambiguity, especially across DST.
 *  - `event_opt_outs`. Per-playbook opt-out, which the source could not express.
 */
export const recipientPreferences = pgTable(
  'recipient_preferences',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => recipients.id, { onDelete: 'cascade' }),
    /** Source-system user id, carried through the migration. Was NOT NULL. */
    userId: text('user_id'),
    allowCommunications: boolean('allow_communications').notNull().default(true),
    preferredChannels: text('preferred_channels').array(),
    preferredLanguage: text('preferred_language'),
    preferredFrequency: text('preferred_frequency').notNull().default('MODERATE'),
    preferredTimeOfDay: text('preferred_time_of_day'),
    quietHoursStart: text('quiet_hours_start'),
    quietHoursEnd: text('quiet_hours_end'),
    quietHoursTimezone: text('quiet_hours_timezone'),
    /** Playbook keys this recipient has opted out of. */
    eventOptOuts: text('event_opt_outs').array().notNull().default(sql`'{}'::text[]`),
    unsubscribeToken: text('unsubscribe_token'),
    contactInfo: jsonb('contact_info'),
    metadata: jsonb('metadata'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('recipient_preferences_tenant_recipient_unique').on(t.tenantId, t.recipientId),
    unique('recipient_preferences_unsubscribe_token_unique').on(t.unsubscribeToken),
    index('idx_recipient_prefs_recipient').on(t.recipientId),
  ],
);

/** ← `communication_memories`. patient_id -> recipient_id, provider_id -> sender_id. */
export const recipientMemories = pgTable(
  'recipient_memories',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    recipientId: uuid('recipient_id').references(() => recipients.id, { onDelete: 'cascade' }),
    senderId: text('sender_id'),
    memoryType: text('memory_type').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata'),
    tags: text('tags').array(),
    relevanceScore: integer('relevance_score'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_recipient_memories_tenant_subtenant').on(t.tenantId, t.subTenantId),
    index('idx_recipient_memories_recipient').on(t.tenantId, t.recipientId),
  ],
);

/**
 * Cache for ContextProvider results (P5). `lead_profiles` (§0.5 Seam D) folds in
 * here plus `recipients.attributes` rather than becoming its own table.
 */
export const recipientContext = pgTable(
  'recipient_context',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => recipients.id, { onDelete: 'cascade' }),
    /** Which provider produced it: 'inline' | 'mentera' | 'csv' | pack id. */
    source: text('source').notNull(),
    payload: jsonb('payload').notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('recipient_context_recipient_source_unique').on(t.recipientId, t.source),
    index('idx_recipient_context_expiry').on(t.expiresAt),
  ],
);
