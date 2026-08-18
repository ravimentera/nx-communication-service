/**
 * Tenancy: who the tenants are and what credentials they send with.
 *
 * §0.7 vocabulary: medspa -> tenant, location -> sub-tenant, provider -> agent.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { createdAt, id, subTenantId, tenantId, ts, updatedAt } from './_shared.js';

/**
 * `tenants.id` IS the tenant identifier — this table has no `tenant_id` column
 * and is the one documented exception to that rule. Values are today's
 * `medspaId`s, preserved verbatim so P9 can migrate without remapping.
 */
export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Selects the default pack: 'medspa', 'lead-generation', ... */
  industry: text('industry'),
  timezone: text('timezone').notNull().default('UTC'),
  locale: text('locale').notNull().default('en'),
  /** {hipaa: bool, tcpa: bool, gdpr: bool, retentionDays: n, ...} */
  complianceProfile: jsonb('compliance_profile').notNull().default(sql`'{}'::jsonb`),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** ← today's `locations`. NULL sub_tenant_id anywhere else means "org-wide". */
export const subTenants = pgTable(
  'sub_tenants',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    timezone: text('timezone'),
    /** {system:'mentera-location', id:'...'} */
    externalRef: jsonb('external_ref'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_sub_tenants_tenant').on(t.tenantId)],
);

/** Used by AUTH_MODE=apikey. Table lands now; the lookup is wired in P12. */
export const tenantApiKeys = pgTable(
  'tenant_api_keys',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    /** Argon2/bcrypt digest. The plaintext key is shown once, at creation. */
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('tenant_api_keys_hash_unique').on(t.keyHash),
    index('idx_tenant_api_keys_tenant').on(t.tenantId),
  ],
);

/**
 * ← `medspa_configurations`, renamed.
 *
 * The flat credential columns are kept EXACTLY as the source has them so the P9
 * data migration has somewhere to land. They are plaintext today, as they are
 * today in `medspa_configurations` (which carries a
 * `-- Should be encrypted in production` comment and no encryption).
 *
 * `credentials_encrypted` + `encryption_key_id` are added now, unused, so P12
 * can flip to envelope encryption and drop the flat columns without another
 * migration. Do NOT change the storage in P2 — that would break the P9 landing.
 */
export const tenantChannelConfigs = pgTable(
  'tenant_channel_configs',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),

    /**
     * The Twilio account this tenant owns.
     *
     * UNIQUE among active rows (0021). It is what an inbound callback is
     * resolved by, and it is settable through `PUT /v1/channels/config` — so
     * without the constraint one tenant could enter another's SID and be
     * resolved as the owner of their callbacks.
     */
    twilioAccountSid: text('twilio_account_sid'),
    twilioAuthToken: text('twilio_auth_token'),
    twilioPhoneNumber: text('twilio_phone_number'),
    twilioEnabled: boolean('twilio_enabled').notNull().default(false),

    sendgridApiKey: text('sendgrid_api_key'),
    sendgridFromEmail: text('sendgrid_from_email'),
    sendgridFromName: text('sendgrid_from_name'),
    sendgridEnabled: boolean('sendgrid_enabled').notNull().default(false),

    slackBotToken: text('slack_bot_token'),

    /**
     * Outbound webhook signing key. Here rather than on the message, because a
     * secret in a message is a secret in the BullMQ job payload in Redis, in
     * plaintext, for the queue's retention window. Sealed by 0013 with the rest.
     */
    webhookSigningSecret: text('webhook_signing_secret'),
    /**
     * Hosts this tenant's webhooks may reach, suffix-matched. NULL means the
     * engine default — any public address, no private or link-local ranges.
     * See `adapters/channels/url-guard.ts`. Added in 0020.
     */
    webhookAllowedHosts: text('webhook_allowed_hosts').array(),
    slackDefaultChannel: text('slack_default_channel'),
    slackEnabled: boolean('slack_enabled').notNull().default(false),

    /** Reserved for P12. {twilio:{...}, sendgrid:{...}} sealed with a data key. */
    credentialsEncrypted: jsonb('credentials_encrypted'),
    encryptionKeyId: text('encryption_key_id'),

    timezone: text('timezone').notNull().default('America/New_York'),
    defaultLanguage: text('default_language').notNull().default('en'),

    businessHoursStart: text('business_hours_start').default('09:00'),
    businessHoursEnd: text('business_hours_end').default('17:00'),
    businessDays: text('business_days')
      .array()
      .default(sql`ARRAY['monday','tuesday','wednesday','thursday','friday']::text[]`),

    smsRateLimit: jsonb('sms_rate_limit').default(
      sql`'{"maxPerHour":100,"maxPerDay":500,"burstLimit":10}'::jsonb`,
    ),
    emailRateLimit: jsonb('email_rate_limit').default(
      sql`'{"maxPerHour":200,"maxPerDay":1000,"burstLimit":20}'::jsonb`,
    ),

    requireOptIn: boolean('require_opt_in').notNull().default(true),
    retentionDays: integer('retention_days').notNull().default(365),

    metadata: jsonb('metadata'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
  },
  (t) => [
    // One config row per tenant, matching medspa_configurations' UNIQUE(medspa_id).
    unique('tenant_channel_configs_tenant_unique').on(t.tenantId),
    index('idx_tenant_channel_configs_active').on(t.isActive),
    // One tenant owns a Twilio account. Partial on
    // `twilio_account_sid IS NOT NULL AND is_active` — declared in 0021, and
    // the predicate is not expressible here. It is what makes the inbound
    // callback lookup deterministic, and what stops a tenant claiming another's
    // account through the config API.
    uniqueIndex('tenant_channel_configs_twilio_account_unique').on(t.twilioAccountSid),
  ],
);

/** ← `provider_configurations`. provider_id -> sender_id, medspa_id -> tenant_id. */
export const agentChannelConfigs = pgTable(
  'agent_channel_configs',
  {
    id: id(),
    tenantId: tenantId(),
    subTenantId: subTenantId(),
    senderId: text('sender_id').notNull(),
    name: text('name').notNull(),

    twilioPhoneNumber: text('twilio_phone_number'),
    twilioEnabled: boolean('twilio_enabled').notNull().default(false),

    emailFromAddress: text('email_from_address'),
    emailFromName: text('email_from_name'),
    emailEnabled: boolean('email_enabled').notNull().default(false),

    slackUserId: text('slack_user_id'),
    slackEnabled: boolean('slack_enabled').notNull().default(false),

    credentialsEncrypted: jsonb('credentials_encrypted'),
    encryptionKeyId: text('encryption_key_id'),

    preferredChannel: text('preferred_channel').default('SMS'),
    timezone: text('timezone'),
    language: text('language'),

    workingHoursStart: text('working_hours_start'),
    workingHoursEnd: text('working_hours_end'),
    workingDays: text('working_days').array(),

    smsRateLimit: jsonb('sms_rate_limit'),
    emailRateLimit: jsonb('email_rate_limit'),

    receiveRecipientNotifications: boolean('receive_recipient_notifications')
      .notNull()
      .default(true),
    receiveSystemNotifications: boolean('receive_system_notifications').notNull().default(true),
    receiveMarketingNotifications: boolean('receive_marketing_notifications')
      .notNull()
      .default(false),

    autoResponseEnabled: boolean('auto_response_enabled').notNull().default(false),
    autoResponseMessage: text('auto_response_message'),
    autoResponseDelayMinutes: integer('auto_response_delay_minutes').default(5),

    metadata: jsonb('metadata'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
  },
  (t) => [
    unique('agent_channel_configs_sender_tenant_unique').on(t.senderId, t.tenantId),
    index('idx_agent_channel_configs_tenant').on(t.tenantId),
    index('idx_agent_channel_configs_active').on(t.isActive),
  ],
);
