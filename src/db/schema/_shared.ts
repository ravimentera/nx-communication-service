/**
 * Column builders every table in this schema shares.
 *
 * DESIGN RULES (P2 §"Design rules"), applied without exception unless a comment
 * on the table says why:
 *
 *  - `id uuid PK default gen_random_uuid()`
 *  - `tenant_id text NOT NULL` — the isolation boundary. Rule 4: no query
 *    without a tenant predicate.
 *  - `sub_tenant_id uuid NULL` on every operational / PHI-bearing table.
 *    NULL = org-wide. Mirrors today's `location_id`.
 *  - `created_at` / `updated_at` as **`timestamptz`**, never naked `timestamp`.
 *
 * ON TIMESTAMPTZ. The source service uses `timestamp without time zone`
 * everywhere. That is a latent bug, not a style choice: quiet-hours checks and
 * scheduled sends compare wall-clock values whose zone is implied by whichever
 * server wrote them. A medspa in Los Angeles and one in New York get different
 * meanings from the same stored value. Every timestamp here carries its zone.
 *
 * ON CROSS-FILE FOREIGN KEYS. Within one schema file, relationships use
 * `.references()`. Across files they are declared as plain `uuid` columns and
 * the FK is added in the SQL migration instead. Drizzle's `.references()` needs
 * a real import, and the natural graph here has cycles (playbooks -> approvals
 * -> messages -> playbooks). The hand-written migration is the source of truth
 * for constraints regardless — we never run `drizzle-kit push`.
 */
import { sql } from 'drizzle-orm';
import { timestamp, text, uuid } from 'drizzle-orm/pg-core';

export const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

export const tenantId = () => text('tenant_id').notNull();

/** NULL = org-wide. */
export const subTenantId = () => uuid('sub_tenant_id');

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Every non-key timestamp in this schema goes through here. */
export const ts = (name: string) => timestamp(name, { withTimezone: true });

export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() });
