/**
 * Schema barrel. `drizzle.config.ts` points here for generation, and the
 * composition root passes this module to `createDb` for typed queries.
 *
 * Tables NOT carried over as tables (§0.7, §0.5 Seam D):
 *   lead_profiles              -> recipients.attributes + recipient_context
 *   outreach_rules             -> playbooks rows
 *   treatment_follow_up_rules  -> playbooks rows
 *   farewell_messages          -> messages with playbook_id = 'medspa.farewell'
 */
export * from './schema/tenancy.js';
export * from './schema/recipients.js';
export * from './schema/content.js';
export * from './schema/playbooks.js';
export * from './schema/approvals.js';
export * from './schema/messaging.js';
export * from './schema/campaigns.js';
export * from './schema/packs-medspa.js';
