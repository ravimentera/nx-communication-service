/**
 * Postgres client — vendored from `@mentera/shared-libs/utils/db-client.ts`.
 *
 * Deliberate divergences from the source, all called out in EXTRACTION_PLAN P1:
 *
 *  1. The AWS RDS Data API path is GONE. The source supported dual-mode via
 *     `USE_LOCAL_DB` and branched on it in six places (~600 LOC). This service
 *     owns its database, so it is plain `pg` + drizzle/node-postgres against
 *     `DATABASE_URL`. If prod later needs the Data API it comes back as a
 *     second adapter behind this same interface, not as branching in here.
 *  2. `global.__dbConnectionPool` is GONE. That global existed to share one pool
 *     across services co-located in a single Node process. Irrelevant here — the
 *     composition root owns the pool and passes it down.
 *  3. `batchQuery` now runs its queries INSIDE the transaction it opens. See the
 *     note on that function; the source version did not, which made
 *     `useTransaction: true` a no-op.
 *
 * Kept from the source: pool sizing knobs, pool error listeners that log rather
 * than crash, connection-test-on-init, graceful shutdown.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Logger } from 'winston';

export interface DbConfig {
  url: string;
  poolMax?: number;
  poolMin?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  ssl?: boolean;
}

/**
 * P2 re-exports this narrowed to the real schema:
 *   export type Db = PlatformDb<typeof schema>
 */
export type Db<TSchema extends Record<string, unknown> = Record<string, never>> =
  NodePgDatabase<TSchema>;

export interface DbHandle<TSchema extends Record<string, unknown> = Record<string, never>> {
  db: Db<TSchema>;
  pool: pg.Pool;
}

export function createDb<TSchema extends Record<string, unknown> = Record<string, never>>(
  cfg: DbConfig,
  options: { schema?: TSchema; logger?: Logger } = {},
): DbHandle<TSchema> {
  const { schema, logger } = options;

  const pool = new pg.Pool({
    connectionString: cfg.url,
    // RDS terminates TLS with a cert chain node does not trust by default. The
    // source service used the same setting; keep it, but only when SSL is on.
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    max: cfg.poolMax ?? 20,
    min: cfg.poolMin ?? 2,
    idleTimeoutMillis: cfg.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: cfg.connectionTimeoutMs ?? 5_000,
  });

  // A pool-level error must never take the process down: pg emits these for
  // idle clients dropped by the server, and the pool reconnects on its own.
  pool.on('error', (err: Error & { code?: string }) => {
    logger?.error('postgres pool error', { error: err.message, code: err.code });
  });

  const db = schema
    ? (drizzle(pool, { schema }) as Db<TSchema>)
    : (drizzle(pool) as Db<TSchema>);

  return { db, pool };
}

/** Liveness probe for the pool. Acquires and immediately releases a client. */
export async function checkConnection(pool: pg.Pool, logger?: Logger): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    return true;
  } catch (error) {
    logger?.error('database health check failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    return false;
  }
}

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export function getPoolStats(pool: pg.Pool): PoolStats {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

export async function closeDb(pool: pg.Pool, logger?: Logger): Promise<void> {
  logger?.info('closing postgres pool');
  await pool.end();
}

export interface BatchQueryOptions {
  /** Wrap the whole batch in one transaction. Default true. */
  useTransaction?: boolean;
  /** Split batches larger than this into sequential chunks. Default 100. */
  maxBatchSize?: number;
}

/**
 * Run many queries as one unit.
 *
 * **Divergence from the source.** `shared-libs` opened `BEGIN` on a client it
 * checked out of the pool, then invoked query functions that each took their
 * OWN connection from that same pool. Those queries were never part of the
 * transaction, so a mid-batch failure rolled back an empty transaction and left
 * every prior write committed. `useTransaction: true` bought nothing.
 *
 * Here each query function receives the transaction handle and must use it. The
 * signature change is safe because P1 is the first consumer — nothing depends on
 * the old shape.
 */
export async function batchQuery<
  TSchema extends Record<string, unknown>,
  TResult,
>(
  db: Db<TSchema>,
  queries: ((tx: Db<TSchema>) => Promise<TResult>)[],
  options: BatchQueryOptions = {},
): Promise<TResult[]> {
  const { useTransaction = true, maxBatchSize = 100 } = options;
  if (queries.length === 0) return [];

  if (queries.length > maxBatchSize) {
    const results: TResult[] = [];
    for (let i = 0; i < queries.length; i += maxBatchSize) {
      results.push(
        ...(await batchQuery(db, queries.slice(i, i + maxBatchSize), options)),
      );
    }
    return results;
  }

  if (!useTransaction) {
    const results: TResult[] = [];
    for (const query of queries) results.push(await query(db));
    return results;
  }

  return db.transaction(async (tx) => {
    const results: TResult[] = [];
    for (const query of queries) {
      results.push(await query(tx as Db<TSchema>));
    }
    return results;
  });
}
