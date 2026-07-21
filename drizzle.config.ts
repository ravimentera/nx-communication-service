import type { Config } from 'drizzle-kit';

/**
 * Drizzle is used for SCHEMA GENERATION ONLY.
 *
 *   npm run db:generate      -> emits SQL into ./migrations for review
 *
 * `drizzle-kit push` and `drizzle-kit migrate` are FORBIDDEN in this repo.
 * Migrations are hand-reviewed, numbered, idempotent SQL applied by an operator:
 *
 *   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_core_schema.sql
 *
 * See migrations/README.md for the operator contract.
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
