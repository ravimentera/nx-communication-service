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
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import {
  aiInteractions,
  messageAnalytics,
  messages,
  tenantChannelConfigs,
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

export class RetentionJob {
  constructor(private readonly deps: RetentionJobDeps) {}

  async runAll(): Promise<RetentionReport[]> {
    const tenants = await this.deps.db
      .select({
        tenantId: tenantChannelConfigs.tenantId,
        retentionDays: tenantChannelConfigs.retentionDays,
      })
      .from(tenantChannelConfigs)
      .where(eq(tenantChannelConfigs.isActive, true));

    const reports: RetentionReport[] = [];
    for (const tenant of tenants) {
      reports.push(await this.runFor(tenant.tenantId, tenant.retentionDays));
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
