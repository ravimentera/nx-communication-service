#!/usr/bin/env node
/**
 * Produce a DRAFT SQL skeleton from the Drizzle schema.
 *
 * THE OUTPUT IS NOT A MIGRATION. It goes to .drizzle-draft/ (gitignored), never
 * to migrations/. Read it, take what is useful, and hand-write the real file
 * with the numbering, the IF NOT EXISTS guards, the transaction and the
 * comments explaining any deliberate divergence. Hard rule 1 still applies:
 * nothing here touches a database.
 *
 * WHY THE COPY. `drizzle-kit generate` cannot read this schema directly: it
 * bundles through esbuild in CJS mode and resolves relative imports literally,
 * so the `.js` extensions NodeNext ESM requires resolve to files that do not
 * exist (verified on drizzle-kit 0.30.6). So we copy the schema to a throwaway
 * directory, strip those extensions in the COPY, and generate from that.
 *
 * This is deliberately not the source repo's `fix-imports.cjs` hack. That one
 * rewrote emitted build output on every build and had to stay correct forever
 * or production broke. This touches a disposable copy, runs only when someone
 * is drafting a migration, and its worst failure mode is "no draft today".
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Must live inside the repo so the copy can resolve node_modules.
const tmp = join(root, '.drizzle-draft');

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

try {
  cpSync(join(root, 'src', 'db'), join(tmp, 'db'), { recursive: true });

  for (const file of walk(join(tmp, 'db')).filter((f) => f.endsWith('.ts'))) {
    // Only relative specifiers — leave bare package imports alone.
    writeFileSync(file, readFileSync(file, 'utf8').replace(/(from\s+'\.[^']*)\.js'/g, "$1'"));
  }

  writeFileSync(
    join(tmp, 'config.ts'),
    `import type { Config } from 'drizzle-kit';\n` +
      `export default { schema: './.drizzle-draft/db/schema.ts', out: './.drizzle-draft/out', dialect: 'postgresql' } satisfies Config;\n`,
  );

  execFileSync('npx', ['drizzle-kit', 'generate', '--config=.drizzle-draft/config.ts'], {
    cwd: root,
    stdio: 'inherit',
  });

  const out = join(tmp, 'out');
  const files = readdirSync(out).filter((f) => f.endsWith('.sql'));
  console.log('\nDRAFT ONLY — do not commit these as migrations:');
  for (const f of files) console.log(`  ${join('.drizzle-draft', 'out', f)}`);
  console.log('\nHand-write the real file in migrations/ and let');
  console.log('tests/integration/schema.test.ts prove the two agree.\n');
} catch (error) {
  rmSync(tmp, { recursive: true, force: true });
  console.error(`\ndraft failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
