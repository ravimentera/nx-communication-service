/**
 * Per-tenant usage — model spend and delivery volume.
 *
 * The pricing model is undecided (the plan's Open Question 5), and that is the
 * reason to build this now rather than later: whatever the decision turns out to
 * be, it will want to be applied to a period that has already happened. Metering
 * from the day the decision lands means the first invoice covers a month nobody
 * has numbers for.
 *
 * Nothing here is new storage. `ai_interactions` has carried `cost_usd` since
 * P2 and `messages` has always recorded a channel and a status; this is the
 * first thing that reads either as an aggregate.
 *
 * **Counts are of what the engine did, not of what was delivered.** A message
 * counted as `sent` is one a provider accepted. A bounce recorded later by a
 * receipt shows up in `byStatus`, not by decrementing the send count, because a
 * provider charges for the attempt.
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { aiInteractions, messages } from '../../db/schema.js';

export interface UsagePeriod {
  from: Date;
  to: Date;
}

export interface UsageReport {
  tenantId: string;
  period: { from: string; to: string };
  ai: {
    calls: number;
    failedCalls: number;
    tokensIn: number;
    tokensOut: number;
    tokensTotal: number;
    costUsd: number;
    byModel: { model: string; calls: number; tokensTotal: number; costUsd: number }[];
  };
  messages: {
    total: number;
    byChannel: { channel: string; count: number }[];
    byStatus: { status: string; count: number }[];
  };
}

export interface UsageServiceDeps {
  db: Db;
  logger: Logger;
}

export class UsageService {
  constructor(private readonly deps: UsageServiceDeps) {}

  async report(tenantId: string, period: UsagePeriod): Promise<UsageReport> {
    const within = (column: typeof aiInteractions.createdAt | typeof messages.createdAt) =>
      and(gte(column, period.from), lt(column, period.to));

    const [ai, byModel, byChannel, byStatus] = await Promise.all([
      this.deps.db
        .select({
          calls: sql<number>`count(*)::int`,
          failedCalls: sql<number>`count(*) filter (where not ${aiInteractions.success})::int`,
          // `tokens_used` is one total; the split lives on metadata because
          // input and output are priced differently and a total cannot be
          // re-costed. Older rows have no split, so this reads 0 for them
          // while `tokensTotal` stays correct.
          tokensIn: sql<number>`coalesce(sum((${aiInteractions.metadata} ->> 'tokensIn')::int), 0)::int`,
          tokensOut: sql<number>`coalesce(sum((${aiInteractions.metadata} ->> 'tokensOut')::int), 0)::int`,
          tokensTotal: sql<number>`coalesce(sum(${aiInteractions.tokensUsed}), 0)::int`,
          costUsd: sql<string>`coalesce(sum(${aiInteractions.costUsd}), 0)`,
        })
        .from(aiInteractions)
        .where(and(eq(aiInteractions.tenantId, tenantId), within(aiInteractions.createdAt))),

      this.deps.db
        .select({
          model: aiInteractions.modelId,
          calls: sql<number>`count(*)::int`,
          tokensTotal: sql<number>`coalesce(sum(${aiInteractions.tokensUsed}), 0)::int`,
          costUsd: sql<string>`coalesce(sum(${aiInteractions.costUsd}), 0)`,
        })
        .from(aiInteractions)
        .where(and(eq(aiInteractions.tenantId, tenantId), within(aiInteractions.createdAt)))
        .groupBy(aiInteractions.modelId)
        .orderBy(sql`count(*) desc`),

      this.deps.db
        .select({ channel: messages.channel, count: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.tenantId, tenantId), within(messages.createdAt)))
        .groupBy(messages.channel)
        .orderBy(sql`count(*) desc`),

      this.deps.db
        .select({ status: messages.status, count: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.tenantId, tenantId), within(messages.createdAt)))
        .groupBy(messages.status)
        .orderBy(sql`count(*) desc`),
    ]);

    const totals = ai[0];

    return {
      tenantId,
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      ai: {
        calls: totals?.calls ?? 0,
        failedCalls: totals?.failedCalls ?? 0,
        tokensIn: totals?.tokensIn ?? 0,
        tokensOut: totals?.tokensOut ?? 0,
        tokensTotal: totals?.tokensTotal ?? 0,
        // `numeric` comes back as a string from pg — deliberately, because it is
        // exact and a float is not. Rounded to the cent-fraction the column
        // stores rather than handed over as a string nobody will parse.
        costUsd: round6(totals?.costUsd),
        byModel: byModel.map((row) => ({
          model: row.model,
          calls: row.calls,
          tokensTotal: row.tokensTotal,
          costUsd: round6(row.costUsd),
        })),
      },
      messages: {
        total: byStatus.reduce((sum, row) => sum + row.count, 0),
        byChannel,
        byStatus,
      },
    };
  }
}

function round6(value: string | null | undefined): number {
  return Number(Number(value ?? 0).toFixed(6));
}
