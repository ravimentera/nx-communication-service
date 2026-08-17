/**
 * The three places that decide which migrations are baseline schema agree.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS NEEDS A TEST
 *
 * "Which files does a fresh environment apply?" is answered in four places, in
 * three languages: `tests/helpers/migrations.ts` (used by every harness),
 * `scripts/print-migrations.mjs` (what an operator runs),
 * `docker-compose.yml`'s hint, and `docs/LOCAL_DEV.md`. They cannot share a
 * module — one is a `.mjs` script and one is YAML — so the knowledge is
 * duplicated, and duplicated knowledge drifts.
 *
 * It had already drifted. The helper excluded `0013` and `0014`; the script and
 * the compose hint listed them with the rest. That is not cosmetic: `0013`
 * retires the plaintext credential columns and belongs AFTER a data load, so an
 * operator following the script in order sealed their credentials before
 * `9003_channel_configs.sql` had inserted any — and every send for a freshly
 * migrated tenant then failed.
 *
 * This test is what makes the duplication safe: the copies may exist, but they
 * may not disagree.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NON_BASELINE_MIGRATIONS, baselineMigrations } from '../../helpers/migrations.js';

const root = process.cwd();

describe('which migrations are baseline', () => {
  it('scripts/print-migrations.mjs excludes exactly the same files', () => {
    const source = readFileSync(join(root, 'scripts/print-migrations.mjs'), 'utf8');
    const match = /const NON_BASELINE = \{([\s\S]*?)\n\};/.exec(source);
    expect(match).not.toBeNull();

    // Keys of the object, which are the file names.
    const listed = [...match![1]!.matchAll(/^\s{2}'([^']+)':/gm)].map((m) => m[1]!);
    expect(listed.sort()).toEqual([...NON_BASELINE_MIGRATIONS].sort());
  });

  it('gives every excluded file its own heading and reason', () => {
    // ── WHY THIS ASSERTION EXISTS ──────────────────────────────────────────
    //
    // `0013` and `0014` were printed under one heading: "applied deliberately
    // — read the runbook first". That reads as "risky, leave it alone", which
    // is true of `0013` and the opposite of true for `0014`: every statement in
    // it is `IF EXISTS`, and it is REQUIRED on any database created before P12,
    // because `0001` is `CREATE TABLE IF NOT EXISTS` and therefore cannot
    // remove a column a previous `0001` created.
    //
    // Following the shared heading left a local database carrying
    // `messages.queued_message` that a fresh deploy has never had — schema
    // drift produced by doing exactly what the docs said.
    //
    // So: a file may be excluded from the baseline, but it may not be excluded
    // silently. The next one has to say why and what to do instead.
    const source = readFileSync(join(root, 'scripts/print-migrations.mjs'), 'utf8');
    const match = /const NON_BASELINE = \{([\s\S]*?)\n\};/.exec(source);
    const body = match![1]!;

    for (const file of NON_BASELINE_MIGRATIONS) {
      const entry = new RegExp(
        `'${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*\\{([\\s\\S]*?)\\n  \\},`,
      ).exec(body);
      // The file name is folded into the assertion rather than passed as a
      // message, because Jest's `expect` takes no message argument.
      expect(entry === null ? `${file}: no entry in NON_BASELINE` : 'ok').toBe('ok');

      expect(entry![1]).toContain('heading:');
      expect(entry![1]).toContain('note:');
    }
  });

  it('docker-compose.yml excludes exactly the same files', () => {
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    // The hint filters with a shell `case` over prefixes: *0013_*|*0014_*
    const match = /case "\$\$f" in ([^)]*)\)\s*continue/.exec(compose);
    expect(match).not.toBeNull();

    const prefixes = match![1]!
      .split('|')
      .map((p) => p.trim().replace(/^\*/, '').replace(/\*$/, ''));

    for (const file of NON_BASELINE_MIGRATIONS) {
      expect(prefixes.some((prefix) => file.startsWith(prefix))).toBe(true);
    }
    expect(prefixes).toHaveLength(NON_BASELINE_MIGRATIONS.size);
  });

  it('every excluded file actually exists', () => {
    // A stale exclusion is worse than none: it silently drops a migration that
    // was renamed, and the database is short a table nobody notices until a
    // query fails.
    const onDisk = new Set(readdirSync(join(root, 'migrations')));
    for (const file of NON_BASELINE_MIGRATIONS) {
      expect(onDisk.has(file)).toBe(true);
    }
  });

  it('the baseline is every other 0-series file, in numeric order', () => {
    const files = baselineMigrations(join(root, 'migrations'));

    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => NON_BASELINE_MIGRATIONS.has(f))).toBe(false);
    expect(files).toEqual([...files].sort());
    // 0004 is deliberately absent — everything it would have created is
    // already in 0001 (D36). Its absence is a fact worth pinning, because a
    // future file numbered 0004 would apply out of the order anyone expects.
    expect(files.some((f) => f.startsWith('0004'))).toBe(false);
  });
});
