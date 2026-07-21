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

const schema = files.filter((f) => !f.startsWith('9'));
const data = files.filter((f) => f.startsWith('9'));

console.log('Migrations are NEVER run by tooling. Run these yourself, in order:\n');

if (schema.length === 0 && data.length === 0) {
  console.log('  (no migrations yet)\n');
} else {
  for (const f of schema) {
    console.log(`  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/${f}`);
  }
  if (data.length > 0) {
    console.log('\nOne-shot data migrations from mentera-core');
    console.log('(read docs/MIGRATION_RUNBOOK.md first):\n');
    for (const f of data) {
      console.log(`  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/${f}`);
    }
  }
  console.log('');
}

process.exit(0);
