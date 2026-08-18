/**
 * Retention purge. **Dry-run by default and it must stay that way.**
 *
 * `tenant_channel_configs.retention_days` has existed since
 * `0001_add_communication_configs.sql`, defaults to 365, and **nothing reads
 * it**. Every message, every analytics row and every AI interaction ever
 * written is still there. For a service handling clinical correspondence, a
 * retention policy that exists only as a column is worse than none: it reads
 * like a promise that was never kept.
 *
 * This job makes the column real, but deletion is destructive and irreversible,
 * so `RETENTION_DRY_RUN=true` is the default. In dry-run it counts what it
 * *would* delete and logs per tenant. **Do not enable deletion without operator
 * sign-off**, and not before the counts have been reviewed at least once.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import {
  aiInteractions,
  messageAnalytics,
  messages,
  tenantChannelConfigs,
  tenants,
} from '../../db/schema.js';
import { metricsRegistry, promClient } from '../../platform/observability/metrics.js';

export const retentionCandidates = new promClient.Gauge({
  name: 'outreach_retention_candidates',
  help: 'Rows older than the tenant retention window',
  labelNames: ['tenant', 'table'] as const,
  registers: [metricsRegistry],
});

export const retentionDeleted = new promClient.Counter({
  name: 'outreach_retention_deleted_total',
  help: 'Rows actually deleted by the retention job',
  labelNames: ['tenant', 'table'] as const,
  registers: [metricsRegistry],
});

export interface RetentionReport {
  tenantId: string;
  retentionDays: number;
  cutoff: string;
  counts: Record<string, number>;
  dryRun: boolean;
}

export interface RetentionJobDeps {
  db: Db;
  logger: Logger;
  /** Default true. Deletion requires an explicit, deliberate flip. */
  dryRun: boolean;
}

/**
 * What a tenant with no channel config gets. Matches the column's own default
 * in `0001`, so wiring the job changes nothing about what any tenant was
 * already promised.
 */
const DEFAULT_RETENTION_DAYS = 365;

export class RetentionJob {
  constructor(private readonly deps: RetentionJobDeps) {}

  /**
   * Every tenant, not every tenant with a channel config.
   *
   * This iterated `tenant_channel_configs`, so a tenant that had never
   * configured a channel — which is every tenant before its first setup, and
   * any tenant sending only through env-level credentials — was never purged
   * at all. Its data simply accumulated, silently, while the job reported
   * success for everybody else.
   *
   * `tenants` LEFT JOIN the config is the honest set: the retention window
   * comes from the config when there is one, and from the engine default when
   * there is not.
   */
  async runAll(): Promise<RetentionReport[]> {
    const rows = await this.deps.db
      .select({
        tenantId: tenants.id,
        retentionDays: tenantChannelConfigs.retentionDays,
      })
      .from(tenants)
      .leftJoin(
        tenantChannelConfigs,
        and(
          eq(tenantChannelConfigs.tenantId, tenants.id),
          eq(tenantChannelConfigs.isActive, true),
        ),
      )
      .where(eq(tenants.isActive, true));

    const reports: RetentionReport[] = [];
    for (const row of rows) {
      reports.push(
        await this.runFor(row.tenantId, row.retentionDays ?? DEFAULT_RETENTION_DAYS),
      );
    }
    return reports;
  }

  async runFor(tenantId: string, retentionDays: number): Promise<RetentionReport> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000);

    const targets = [
      { name: 'messages', table: messages },
      { name: 'message_analytics', table: messageAnalytics },
      { name: 'ai_interactions', table: aiInteractions },
    ] as const;

    const counts: Record<string, number> = {};

    for (const target of targets) {
      const where = and(
        eq(target.table.tenantId, tenantId),
        lt(target.table.createdAt, cutoff),
      );

      const [counted] = await this.deps.db
        .select({ count: sql<number>`count(*)::int` })
        .from(target.table)
        .where(where);
      const count = counted?.count ?? 0;
      counts[target.name] = count;
      retentionCandidates.set({ tenant: tenantId, table: target.name }, count);

      if (!this.deps.dryRun && count > 0) {
        await this.deps.db.delete(target.table).where(where);
        retentionDeleted.inc({ tenant: tenantId, table: target.name }, count);
      }
    }

    const report: RetentionReport = {
      tenantId,
      retentionDays,
      cutoff: cutoff.toISOString(),
      counts,
      dryRun: this.deps.dryRun,
    };

    this.deps.logger[this.deps.dryRun ? 'info' : 'warn'](
      this.deps.dryRun ? 'retention dry run — nothing deleted' : 'retention purge DELETED rows',
      report,
    );

    return report;
  }
}

export const RETENTION_QUEUE_NAME = 'outreach-retention';

export interface RetentionWorkerDeps extends RetentionJobDeps {
  connection: Redis | null;
  /** Default 24h. Retention is a daily concern, not a minute-by-minute one. */
  intervalMs?: number;
}

/**
 * The purge on a BullMQ repeatable job, for the same reason the SLA and
 * deferral sweepers are: with N replicas the queue guarantees exactly one runs
 * each tick, and a `setInterval` would have every replica deleting the same
 * rows at once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT HAD NO CALLER AT ALL UNTIL P13
 *
 * `RetentionJob` shipped in P12 and was never instantiated — no cron, no route,
 * nothing. `tenant_channel_configs.retention_days` has existed since the
 * source's own `0001`, defaults to 365, and every message ever written was
 * still there. The stated deliverable did not run, and nothing said so.
 *
 * `RETENTION_DRY_RUN` defaults to **true**, which is why wiring this is safe to
 * do without an operator present: the first thing it does is count and report.
 * Deletion still needs a deliberate flip, and now the counts an operator would
 * want before flipping actually exist.
 */
export class RetentionWorker {
  private readonly job: RetentionJob;
  private readonly queue?: Queue;
  private readonly worker?: Worker;

  constructor(private readonly deps: RetentionWorkerDeps) {
    this.job = new RetentionJob(deps);

    if (!deps.connection) {
      deps.logger.warn('retention job disabled — no Redis connection');
      return;
    }

    const connection = deps.connection;
    this.queue = new Queue(RETENTION_QUEUE_NAME, { connection });
    this.worker = new Worker(RETENTION_QUEUE_NAME, (_job: Job) => this.job.runAll(), {
      connection: connection.duplicate(),
      concurrency: 1,
    });

    this.worker.on('error', (error) =>
      deps.logger.error('retention job error', { error: error.message }),
    );
  }

  async start(): Promise<void> {
    if (!this.queue) return;
    const every = this.deps.intervalMs ?? 24 * 60 * 60_000;
    await this.queue.add(
      'purge',
      {},
      { repeat: { every }, removeOnComplete: { count: 10 }, removeOnFail: { count: 20 } },
    );
    this.deps.logger.info('retention job scheduled', {
      everyMs: every,
      dryRun: this.deps.dryRun,
    });
  }

  /** Run one pass now, ignoring the schedule. Used by tests and by operators. */
  async runOnce(): Promise<RetentionReport[]> {
    return this.job.runAll();
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
