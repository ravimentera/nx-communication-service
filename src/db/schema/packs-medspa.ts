/**
 * Pack-owned tables for the `medspa` pack. Declared here in P2 so the §0.5
 * Seam D ghost tables are not forgotten; the runtime that uses them is P7.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FINDING (P2) — THE GHOST TABLES ARE ENTIRELY TENANT-BLIND.
 *
 * §0.5 Seam D lists six tables written by raw SQL that exist in neither
 * `schema/db.ts` nor the drizzle migrations. Verified against every INSERT:
 *
 *   promotions                  promotion.service.ts:25
 *   gift_cards                  promotion.service.ts:215
 *   lead_profiles               lead-message.service.ts:92,130
 *   treatment_follow_up_rules   treatment-follow-up.service.ts:271
 *   outreach_rules              onboarding-service.ts:222,271
 *   farewell_messages           farewell-message.service.ts:238
 *
 * `grep -c medspa_id` over all five service files returns **0**. Not one of
 * these tables has a tenant column, and not one INSERT supplies a tenant. Every
 * existing row is unattributable.
 *
 * Consequence for P9: these rows cannot be migrated by reading a tenant off
 * them. They must either be assigned wholesale to the single medspa tenant that
 * exists today, or dropped. That is a decision for the operator, and P9 Step 1
 * must surface it rather than assume.
 *
 * The tables below take `tenant_id NOT NULL` regardless, per Rule 4. Backfill
 * is P9's problem, not a reason to weaken the isolation boundary.
 * ────────────────────────────────────────────────────────────────────────────
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
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, subTenantId, tenantId, ts, updatedAt } from './_shared.js';
import { messages } from './messaging.js';
import { recipients } from './recipients.js';

/**
 * ← `patient_feedback`. Present in `schema/db.ts:248` but ABSENT from migration
 * `0000` — so the drizzle model and the real database already disagree. P9 must
 * dump `information_schema` for this table before trusting either.
 */
export const packMedspaFeedback = pgTable(
  'pack_medspa_feedback',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    recipientId: uuid('recipient_id').references(() => recipients.id, { onDelete: 'set null' }),
    treatmentId: text('treatment_id'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    /** MESSAGE_REPLY | SURVEY_RESPONSE | FORM_SUBMISSION | DIRECT_CONTACT | REVIEW */
    feedbackType: text('feedback_type').notNull(),
    content: text('content').notNull(),
    /** -100 to 100. */
    sentimentScore: integer('sentiment_score'),
    isAdverse: boolean('is_adverse').notNull().default(false),
    requiresFollowup: boolean('requires_followup').notNull().default(false),
    escalated: boolean('escalated').notNull().default(false),
    escalatedTo: text('escalated_to'),
    resolved: boolean('resolved').notNull().default(false),
    resolvedAt: ts('resolved_at'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_pack_medspa_feedback_recipient').on(t.tenantId, t.recipientId),
    index('idx_pack_medspa_feedback_message').on(t.messageId),
    index('idx_pack_medspa_feedback_adverse').on(t.tenantId, t.isAdverse),
    index('idx_pack_medspa_feedback_created').on(t.createdAt.desc()),
  ],
);

/** ← ghost table `promotions`. Column shape inferred from the INSERT — verify in P9. */
export const packMedspaPromotions = pgTable(
  'pack_medspa_promotions',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    name: text('name').notNull(),
    description: text('description'),
    treatmentTypes: text('treatment_types').array().notNull().default(sql`'{}'::text[]`),
    discountAmount: numeric('discount_amount', { precision: 12, scale: 2 }),
    discountType: text('discount_type'),
    startDate: ts('start_date'),
    endDate: ts('end_date'),
    /** {minTreatments, specificTreatments, daysSinceLastVisit, recipientStatus, excludeTags} */
    eligibilityRules: jsonb('eligibility_rules').notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb('metadata'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'pack_medspa_promotions_discount_type_check',
      sql`${t.discountType} IS NULL OR ${t.discountType} IN ('PERCENTAGE','FIXED_AMOUNT','FREE_ITEM')`,
    ),
    index('idx_pack_medspa_promotions_tenant').on(t.tenantId),
    index('idx_pack_medspa_promotions_window').on(t.tenantId, t.startDate, t.endDate),
  ],
);

/** ← ghost table `gift_cards`. Column shape inferred from the INSERT — verify in P9. */
export const packMedspaGiftCards = pgTable(
  'pack_medspa_gift_cards',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    code: text('code').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    balance: numeric('balance', { precision: 12, scale: 2 }).notNull(),
    /** Was `issued_to` holding a patient id. */
    issuedTo: uuid('issued_to').references(() => recipients.id, { onDelete: 'set null' }),
    issuedBy: text('issued_by'),
    treatmentRestriction: text('treatment_restriction'),
    expirationDate: ts('expiration_date'),
    isRedeemed: boolean('is_redeemed').notNull().default(false),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Scoped to the tenant: two tenants may legitimately mint the same code.
    unique('pack_medspa_gift_cards_tenant_code_unique').on(t.tenantId, t.code),
    index('idx_pack_medspa_gift_cards_issued_to').on(t.issuedTo),
  ],
);
