/**
 * Engagement roll-ups — the port of `getCommunicationAnalytics`
 * (`communications.controller.ts:546-703`).
 *
 * Response shape is preserved field for field. Two things are not:
 *
 *  1. **The date range is optional again.** The source formats the bounds
 *     before testing them (:551-552):
 *
 *         dateFrom = `${dateFrom} 00:00:00`
 *         dateTo   = `${dateTo} 23:59:59.999`
 *         if (dateFrom) whereConditions.push(gte(sentAt, CAST(dateFrom AS timestamptz)))
 *
 *     With no query string that produces the literal `"undefined 00:00:00"`,
 *     which is truthy, so the predicate is added and the cast throws — the
 *     endpoint 500s whenever both dates are omitted. The bounds are applied here
 *     only when they were actually supplied.
 *  2. `totalSent` / `totalDelivered` / `totalRead` are counted on `messages`
 *     alone. The source counts them across a LEFT JOIN to `message_analytics`
 *     (:606-615), so a message with two analytics rows counts twice. With one
 *     row per message — which is what the writer produces — the numbers agree.
 */
import { and, count, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { messageAnalytics, messages, outreachEvents } from '../../db/schema.js';
import { tenantWhere, type TenantScope } from '../../platform/db/tenant-scope.js';

export interface AnalyticsSummary {
  totalCommunications: number;
  byChannel: Record<string, number>;
  byStatus: Record<string, number>;
  byEventType: Record<string, number>;
  engagementStats: {
    totalSent: number;
    totalDelivered: number;
    totalRead: number;
    deliveryRate: number;
    readRate: number;
    avgEngagementScore: number;
  };
  recentActivity: Array<{ date: string; count: number; delivered: number; read: number }>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class AnalyticsService {
  constructor(private readonly deps: { db: Db; logger: Logger }) {}

  async summary(
    scope: TenantScope,
    range: { dateFrom?: string; dateTo?: string } = {},
  ): Promise<AnalyticsSummary> {
    const where: SQL[] = [tenantWhere(messages, scope)];
    // `2026-01-31` means the whole of that day, as the source intends at :552.
    if (range.dateFrom) where.push(gte(messages.sentAt, startOfDay(range.dateFrom)));
    if (range.dateTo) where.push(lte(messages.sentAt, endOfDay(range.dateTo)));
    const filter = and(...where);

    // Last 30 days, ignoring the requested range — matches :617-633, which
    // rebuilds its own predicate rather than reusing the filtered one.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

    const [totals, byChannel, byStatus, byEventType, engagement, activity] = await Promise.all([
      this.deps.db.select({ value: count() }).from(messages).where(filter),
      this.deps.db
        .select({ key: messages.channel, value: count() })
        .from(messages)
        .where(filter)
        .groupBy(messages.channel),
      this.deps.db
        .select({ key: messages.status, value: count() })
        .from(messages)
        .where(filter)
        .groupBy(messages.status),
      this.deps.db
        .select({ key: outreachEvents.type, value: count() })
        .from(messages)
        .leftJoin(outreachEvents, eq(messages.eventId, outreachEvents.id))
        .where(filter)
        .groupBy(outreachEvents.type),
      this.deps.db
        .select({
          totalSent: count(),
          totalDelivered: count(messages.deliveredAt),
          totalRead: count(messages.readAt),
          avgEngagementScore: sql<
            string | null
          >`(SELECT AVG(${messageAnalytics.engagementScore}) FROM ${messageAnalytics} WHERE ${messageAnalytics.messageId} IN (SELECT ${messages.id} FROM ${messages} WHERE ${filter}))`,
        })
        .from(messages)
        .where(filter),
      this.deps.db
        .select({
          date: sql<string>`TO_CHAR(DATE(${messages.sentAt}), 'YYYY-MM-DD')`,
          count: count(),
          delivered: count(messages.deliveredAt),
          read: count(messages.readAt),
        })
        .from(messages)
        .where(and(tenantWhere(messages, scope), gte(messages.sentAt, thirtyDaysAgo)))
        .groupBy(sql`DATE(${messages.sentAt})`)
        .orderBy(sql`DATE(${messages.sentAt})`),
    ]);

    const e = engagement[0];
    const totalSent = e?.totalSent ?? 0;
    const totalDelivered = e?.totalDelivered ?? 0;
    const totalRead = e?.totalRead ?? 0;

    return {
      totalCommunications: totals[0]?.value ?? 0,
      byChannel: toMap(byChannel),
      byStatus: toMap(byStatus),
      byEventType: toMap(byEventType),
      engagementStats: {
        totalSent,
        totalDelivered,
        totalRead,
        deliveryRate: totalSent ? round2((totalDelivered / totalSent) * 100) : 0,
        readRate: totalDelivered ? round2((totalRead / totalDelivered) * 100) : 0,
        avgEngagementScore: round2(Number(e?.avgEngagementScore ?? 0)),
      },
      recentActivity: activity.map((a) => ({
        date: a.date,
        count: a.count,
        delivered: a.delivered,
        read: a.read,
      })),
    };
  }
}

/** Rows with a null key are dropped, as `byEventType` does at :646-651. */
function toMap(rows: Array<{ key: string | null; value: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) if (row.key) out[row.key] = row.value;
  return out;
}

function startOfDay(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
}

function endOfDay(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59.999Z`) : new Date(value);
}
