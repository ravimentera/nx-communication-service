/**
 * Schema barrel. `drizzle.config.ts` points here, and the composition root
 * passes this module to `createDb` for typed queries.
 *
 * NOTHING IN THIS SCHEMA KNOWS WHAT A MEDSPA IS. `grep -ri medspa src/db/`
 * returns nothing, and that is the test for "industry-agnostic" — keep it true.
 *
 * A vertical's own data reaches the engine one of three ways (§0.10):
 *   1. in the event payload, validated against `playbooks.data_contract`
 *   2. in a generic extension column — `recipients.attributes`,
 *      `recipient_context.payload`, `message_analytics.metadata`
 *   3. in the vertical's own service, which the engine never reads
 *
 * The `pack_id` columns and `packs`/`tenant_packs` are the pack MECHANISM, and
 * they are generic: a pack id is a string, and no table here is shaped by what
 * any particular pack contains.
 *
 * §0.5 Seam D tables, none of which survive as tables:
 *   promotions, gift_cards         -> the vertical's own service (a gift card
 *                                     balance is a ledger; it belongs with
 *                                     commerce, not with outreach)
 *   patient_feedback               -> inbound `messages` + message_analytics
 *   lead_profiles                  -> recipients.attributes + recipient_context
 *   outreach_rules                 -> playbooks rows
 *   treatment_follow_up_rules      -> playbooks rows
 *   farewell_messages              -> messages with playbook_id 'medspa.farewell'
 */
export * from './schema/tenancy.js';
export * from './schema/recipients.js';
export * from './schema/content.js';
export * from './schema/playbooks.js';
export * from './schema/approvals.js';
export * from './schema/messaging.js';
export * from './schema/campaigns.js';
