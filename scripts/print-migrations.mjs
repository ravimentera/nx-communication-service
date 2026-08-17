#!/usr/bin/env node
/**
 * Prints the ordered psql commands an operator should run. Never executes them.
 * This is the only migration "runner" in this repo, and it runs nothing.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'migrations');

const files = readdirSync(dir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

/**
 * Files in the `0*` series that are NOT baseline schema.
 *
 * Must match `NON_BASELINE_MIGRATIONS` in `tests/helpers/migrations.ts`, and
 * `tests/unit/platform/migrations.test.ts` asserts that it does — this is a
 * `.mjs` script and that is a `.ts` module, so the list is duplicated and the
 * test is what keeps the duplication honest.
 *
 * Listing them with the baseline was a real inconsistency, not a cosmetic one:
 * `0013` retires the plaintext credential columns and belongs after a data
 * load, so an operator following this output in order sealed their credentials
 * before `9003_channel_configs.sql` had inserted any.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BUT THEY ARE EXCLUDED FOR OPPOSITE REASONS, AND SAYING SO MATTERS
 *
 * This used to print both under one heading — "applied deliberately, read the
 * runbook first". That reads as "risky, leave it alone" and it is true of
 * `0013` and false of `0014`:
 *
 *   0013  DANGEROUS AT THE WRONG TIME. Needs a key, must follow the data load,
 *         and sealing credentials early breaks every send.
 *
 *   0014  HARMLESS ALWAYS, AND REQUIRED ON AN OLD DATABASE. Every statement is
 *         `IF EXISTS`. It is a genuine no-op against the current `0001` — and
 *         because `0001` is `CREATE TABLE IF NOT EXISTS`, re-running the
 *         baseline does NOT remove a column that a *previous* `0001` created.
 *         So a database made before P12 keeps `messages.queued_message`
 *         forever while a fresh deploy has never had it, and the operator
 *         following this output has no way to find that out.
 *
 * One heading for both is how a schema silently diverges from production. Each
 * file now carries its own reason and its own instruction.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const NON_BASELINE = {
  '0013_encrypt_credentials.sql': {
    heading: 'Applied deliberately, INSIDE the cutover window — read the runbook first:',
    note: [
      'Retires the plaintext credential columns. It must run AFTER the data',
      'load: applying it before 9003_channel_configs.sql has inserted anything',
      'seals credentials that do not exist yet, and every send then fails.',
      'Needs CREDENTIAL_ENCRYPTION_KEYS set. See docs/MIGRATION_RUNBOOK.md §8b.',
    ],
  },
  '0014_drop_queued_message.sql': {
    heading: 'Safe to apply at any time — REQUIRED if your database predates P12:',
    note: [
      'Every statement is IF EXISTS, so this is a no-op on a database built',
      'from the current 0001 and does exactly the needed cleanup on an older',
      'one. Re-running the baseline cannot do it for you: 0001 is CREATE TABLE',
      'IF NOT EXISTS, so a column removed by EDITING 0001 never leaves a',
      'database that already exists.',
      '',
      'Check whether yours needs it:',
      '',
      '  psql "$DATABASE_URL" -tAc "SELECT 1 FROM information_schema.columns \\',
      '    WHERE table_name=\'messages\' AND column_name=\'queued_message\'"',
      '',
      'One row back means apply it. No rows means you are already clean.',
    ],
  },
};

const schema = files.filter((f) => !f.startsWith('9') && !(f in NON_BASELINE));
const nonBaseline = files.filter((f) => f in NON_BASELINE);
const data = files.filter((f) => f.startsWith('9'));

console.log('Migrations are NEVER run by tooling. Run these yourself, in order:\n');

if (schema.length === 0 && data.length === 0) {
  console.log('  (no migrations yet)\n');
} else {
  for (const f of schema) {
    console.log(`  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/${f}`);
  }
  // One block per file, not one heading for the set. See the note on
  // NON_BASELINE: these are excluded for opposite reasons, and collapsing them
  // is what let a stale column survive in a local database indefinitely.
  for (const f of nonBaseline) {
    const { heading, note } = NON_BASELINE[f];
    console.log(`\n${heading}\n`);
    console.log(`  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/${f}\n`);
    for (const line of note) {
      console.log(line ? `  ${line}` : '');
    }
  }
  if (data.length > 0) {
    console.log('\nOne-shot data migrations from mentera-core');
    console.log('(read docs/MIGRATION_RUNBOOK.md first):\n');
    for (const f of data) {
      console.log(`  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/${f}`);
    }
  }
  console.log('');

  // The local dev database runs in Docker (docker-compose.yml) and a macOS host
  // usually has no psql client. ./migrations is mounted read-only at /migrations
  // inside the postgres container, so the same files are applied by the same
  // psql, one version behind nothing.
  console.log('No psql on this machine? Same files, same order, from inside the');
  console.log('local container (docs/LOCAL_DEV.md):\n');
  for (const f of schema) {
    console.log(
      `  docker compose exec -T postgres psql -U outreach -d outreach -v ON_ERROR_STOP=1 -f /migrations/${f}`,
    );
  }
  console.log('');
}

process.exit(0);
