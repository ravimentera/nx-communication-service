/**
 * Health endpoints.
 *
 *  GET /health           liveness — no dependencies touched, 200 if the process
 *                        is up. Kubernetes restarts the pod on failure, so this
 *                        must NOT fail because Postgres is briefly unreachable.
 *  GET /health/detailed  readiness — pings each dependency and reports per-check
 *                        status. 503 when a required dependency is down.
 *
 * The source's `health.routes.ts:128` called out to HEALTH_MONITOR_URL, a
 * Mentera-internal service. That dependency is deliberately not carried over —
 * this service checks its own dependencies directly.
 */
import { Router } from 'express';
import type pg from 'pg';
import type { Logger } from 'winston';

import { checkConnection, getPoolStats } from '../platform/db/client.js';
import type { RedisHandle } from '../platform/redis/index.js';

export interface HealthDeps {
  serviceName: string;
  version: string;
  pool: pg.Pool;
  redis: RedisHandle;
  logger: Logger;
  /** Present once the delivery plane is wired (P3). */
  queueStats?: () => Promise<Record<string, number>>;
  /**
   * The loaded packs, so `GET /health/detailed` can report a pack whose JSON
   * failed validation. Absent means the check reports `degraded` and says so,
   * which is the honest answer for a deployment that wired no registry.
   */
  packs?: { list: () => string[]; errors: () => string[] };
}

type CheckStatus = 'up' | 'down' | 'degraded';

interface CheckResult {
  status: CheckStatus;
  latencyMs?: number;
  detail?: Record<string, unknown>;
}

async function timed(fn: () => Promise<boolean>): Promise<CheckResult> {
  const start = process.hrtime.bigint();
  const ok = await fn();
  const latencyMs = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
  return { status: ok ? 'up' : 'down', latencyMs };
}

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get('/', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: deps.serviceName,
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  router.get('/detailed', async (_req, res) => {
    const [db, redis] = await Promise.all([
      timed(() => checkConnection(deps.pool, deps.logger)),
      timed(() => deps.redis.isConnected()),
    ]);

    // Redis being down is a DEGRADATION, not an outage: the platform falls back
    // to an in-memory store and HTTP keeps serving. Only the database is
    // required for readiness.
    const checks = {
      database: { ...db, detail: getPoolStats(deps.pool) as unknown as Record<string, unknown> },
      redis: {
        ...redis,
        status: (redis.status === 'down' ? 'degraded' : 'up') as CheckStatus,
        detail: { mode: deps.redis.connection ? 'redis' : 'in-memory' },
      },
      queues: deps.queueStats
        ? { status: 'up' as CheckStatus, detail: await deps.queueStats() }
        : { status: 'degraded' as CheckStatus, detail: { note: 'queue disabled' } },
      // ── PACKS ────────────────────────────────────────────────────────────
      //
      // This reported `up` with the note "not wired until P7" for six phases
      // after P7 shipped. A health check that always says `up` is not a check;
      // it is a claim, and this one was false in the direction that matters —
      // a pack whose JSON fails validation means some playbook silently does
      // not exist, and the boot log is the only place that said so.
      //
      // `degraded`, not `down`: a broken pack costs that pack's playbooks, and
      // one bad file in a vertical nobody installed must not fail the whole
      // service's health check and take it out of the load balancer.
      packs: deps.packs
        ? (() => {
            const errors = deps.packs.errors();
            return {
              status: (errors.length === 0 ? 'up' : 'degraded') as CheckStatus,
              detail: {
                loaded: deps.packs.list(),
                ...(errors.length > 0 ? { errors } : {}),
              },
            };
          })()
        : { status: 'degraded' as CheckStatus, detail: { note: 'no pack registry wired' } },
    };

    const healthy = checks.database.status === 'up';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'unhealthy',
      service: deps.serviceName,
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks,
    });
  });

  return router;
}
