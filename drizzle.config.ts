import type { Config } from 'drizzle-kit';

/**
 * Kept for `drizzle-kit`'s introspection/diff commands and as the canonical
 * pointer to the schema. **No drizzle-kit command is part of any workflow here.**
 *
 *   drizzle-kit push     FORBIDDEN — never mutates a database from this repo
 *   drizzle-kit migrate  FORBIDDEN — same
 *   drizzle-kit generate DOES NOT WORK — see below
 *
 * `generate` fails on this repo (verified with drizzle-kit 0.30.6). It bundles
 * the schema through esbuild in CJS mode and resolves relative imports
 * literally, so the `.js` extensions that NodeNext ESM requires resolve to
 * files that do not exist:
 *
 *   Error: Cannot find module './schema/tenancy.js'
 *
 * Pointing `schema` at a glob does not help — the same failure moves to the
 * cross-file imports inside each schema file. This is the same ESM + NodeNext +
 * bundler friction that forced the source repo's `fix-imports.cjs` hack, and we
 * are not reintroducing that hack to regain a drafting convenience.
 *
 * Migrations are hand-authored, numbered and idempotent, and applied by an
 * operator (Hard rule 1; migrations/README.md). `tests/integration/schema.test.ts`
 * is what keeps the Drizzle schema and the SQL honest: it applies the migrations
 * to a throwaway container and asserts the result matches this schema.
 */
export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
} satisfies Config;
