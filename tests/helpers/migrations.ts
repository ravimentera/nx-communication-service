/**
 * Which migrations a test harness applies to a throwaway container.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT EVERY `0*.sql` FILE IS BASELINE SCHEMA.
 *
 * Until P12 the two sets were the same, so every harness carried its own copy
 * of `/^0\d{3}_.*\.sql$/` and got the right answer. `0013_encrypt_credentials.sql`
 * is the first file in the series that is **not** part of the schema every
 * environment gets:
 *
 *   - it nulls the plaintext credential columns and adds a CHECK forbidding
 *     them, which is correct only once credentials are actually sealed;
 *   - it must not be applied while the parallel run is going, because
 *     `9003_channel_configs.sql` is still inserting plaintext (D84);
 *   - applying it in a harness makes every fixture that writes a credential
 *     fail, which is the constraint working, not a broken test.
 *
 * So it is a decommissioning step — closer in kind to the 9xxx one-shots than to
 * `0001_core_schema.sql` — and it is applied deliberately, by the one suite that
 * tests it, and by an operator. See D97.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readdirSync } from 'node:fs';

/**
 * Migrations that exist in the `0*` series but are not baseline schema. Adding
 * to this set is a decision worth arguing for in the decision record — the
 * default for a schema migration is that everyone gets it.
 */
export const NON_BASELINE_MIGRATIONS = new Set([
  '0013_encrypt_credentials.sql',
  // A no-op against the current `0001`, which no longer creates the column it
  // drops. It exists for a development database built from the older file, so
  // applying it in a harness would prove nothing and hide the fact that the
  // baseline is already clean. See D103.
  '0014_drop_queued_message.sql',
]);

/** The schema a fresh environment starts with, in apply order. */
export function baselineMigrations(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^0\d{3}_.*\.sql$/.test(f))
    .filter((f) => !NON_BASELINE_MIGRATIONS.has(f))
    .sort();
}
