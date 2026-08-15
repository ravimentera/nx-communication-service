/**
 * The deferral sweeper: what happens to a message the gate held back.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * P5 made the compliance gate **defer** rather than block. The source blocked:
 * a reminder that arrived during someone's quiet hours was dropped, and the
 * recipient simply never got it (D40). The gate computes a `retryAt` instead —
 * the end of the quiet window, or an hour on from a rate limit — and
 * `dispatcher.ts` writes it onto the message.
 *
 * And then nothing read it. `retryAt` has been computed, persisted and returned
 * to callers since P5 with no scheduler on the other end, which means every
 * "deferred" message has in practice been dropped exactly as the source dropped
 * it — but with a row saying it would be retried. That is worse than the
 * original behaviour, because it looks handled.
 *
 * This is the other end.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT RE-DISPATCHES; IT DOES NOT RE-SEND
 *
 * Every due message goes back through `dispatcher.dispatch()`, not straight
 * onto the queue. The gate therefore runs **again**, on the state of the world
 * now rather than at deferral time, which is the whole point: a recipient who
 * unsubscribed during their own quiet hours must not receive the message that
 * was waiting for them. Re-enqueueing directly would send it.
 *
 * A message still blocked simply defers again — `dispatch` writes a fresh
 * `retryAt` and increments the attempt count, and the next sweep picks it up.
 * There is no separate re-deferral path to keep in step.
 *
 * `messageId` is carried through so the retry **adopts the existing row**
 * (P6 added that for approvals). One logical message stays one row, so counts,
 * rate-limit windows and retention sweeps do not double-count a retry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN IT GIVES UP, AND WHY IT MUST
 *
 * Two bounds, either of which exhausts a message:
 *
 *   attempts >= maxAttempts   a message the gate keeps refusing
 *   age      >= maxAgeMs      a message whose moment has passed
 *
 * The second is the important one. An appointment reminder delivered two days
 * late is worse than one never delivered — the SLA sweeper makes the same
 * argument for its `decline` policy. Without an age bound, a tenant whose rate
 * limit is permanently saturated would accumulate a backlog that eventually
 * fires all at once.
 *
 * An exhausted message keeps `status = 'SUPPRESSED'` and its original
 * `suppression_reason` — it was, in the end, suppressed — and gains
 * `metadata.deferralExhausted`, which is what takes it out of the query. The
 * reason it stopped being retried is recorded next to it, because "why did this
 * never arrive?" is the question this table exists to answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON THE CROSS-TENANT SCAN
 *
 * The query has no tenant predicate, like `SlaSweeper`'s. This is a system
 * sweep with no tenant in scope — there is no caller to attribute it to — and
 * every *write* it performs goes through `dispatch()`, which carries the
 * tenant predicate on the row it adopts. Rule 4 constrains queries made on
 * behalf of a caller; a scheduler is not one.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { messages } from '../../db/schema.js';
import { metricsRegistry, promClient } from '../../platform/observability/metrics.js';
import type { Priority } from '../../domain/index.js';
import type { ChannelType } from '../../ports/channel.js';
import type { Dispatcher } from './dispatcher.js';

export const DEFERRAL_QUEUE_NAME = 'outreach-deferral-sweep';

export const messagesRetriedTotal = new promClient.Counter({
  name: 'outreach_deferred_messages_retried_total',
  help: 'Deferred messages re-dispatched after their retryAt passed',
  labelNames: ['tenant', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const messagesAwaitingRetryGauge = new promClient.Gauge({
  name: 'outreach_deferred_messages_awaiting_retry',
  help: 'Messages deferred by the compliance gate and not yet retried',
  registers: [metricsRegistry],
});

export interface DeferralSweepReport {
  scanned: number;
  /** Re-dispatched and queued for delivery. */
  sent: number;
  /** Still blocked, deferred again with a fresh retryAt. */
  deferred: number;
  /** Out of attempts or too old to be worth sending. */
  exhausted: number;
  failed: number;
}

/** The shape `dispatcher` wrote at deferral time. All of it optional — a row */
/** written before this feature existed has none of it, and is exhausted on sight. */
interface DeferralState {
  attempts?: number;
  firstDeferredAt?: string;
  toType?: string;
  html?: string;
  priority?: Priority;
  playbookKey?: string;
  transactional?: boolean;
  throttle?: { maxPerRecipientPerDay?: number; cooldownHours?: number };
}

export interface DeferralSweeperDeps {
  db: Db;
  logger: Logger;
  dispatcher: Dispatcher;
  /** Rows per sweep. Bounded so one backlog cannot monopolise a worker. */
  batchSize?: number;
  /** Give up after this many retries. Default 5. */
  maxAttempts?: number;
  /** Give up once the message is this old, however few attempts it has had. */
  maxAgeMs?: number;
}

/** The sweep itself, with no queue attached, so a test or an operator can call it. */
export class DeferralSweeper {
  constructor(private readonly deps: DeferralSweeperDeps) {}

  async sweep(now: Date = new Date()): Promise<DeferralSweepReport> {
    const maxAttempts = this.deps.maxAttempts ?? 5;
    const maxAgeMs = this.deps.maxAgeMs ?? 24 * 60 * 60_000;

    const due = await this.deps.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.status, 'SUPPRESSED'),
          isNotNull(messages.deferredUntil),
          lte(messages.deferredUntil, now),
        ),
      )
      .orderBy(asc(messages.deferredUntil))
      .limit(this.deps.batchSize ?? 200);

    const report: DeferralSweepReport = {
      scanned: due.length,
      sent: 0,
      deferred: 0,
      exhausted: 0,
      failed: 0,
    };

    for (const row of due) {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const state = (metadata.deferral ?? {}) as DeferralState;

      try {
        const attempts = state.attempts ?? 0;
        const firstDeferredAt = state.firstDeferredAt
          ? new Date(state.firstDeferredAt)
          : (row.createdAt ?? now);
        const ageMs = now.getTime() - firstDeferredAt.getTime();

        const exhaustion =
          attempts >= maxAttempts
            ? `no delivery window after ${attempts} attempts`
            : ageMs >= maxAgeMs
              ? `still undeliverable ${Math.round(ageMs / 3_600_000)}h after first deferral`
              : // A row deferred before this sweeper existed has no `to` recorded
                // in a form we can rebuild. Retiring it is the honest outcome:
                // guessing an address is not.
                !metadata.to
                ? 'no recipient address recorded on the deferred row'
                : null;

        if (exhaustion) {
          await this.exhaust(row.tenantId, row.id, exhaustion);
          messagesRetriedTotal.inc({ tenant: row.tenantId, outcome: 'exhausted' });
          report.exhausted += 1;
          continue;
        }

        const result = await this.deps.dispatcher.dispatch({
          // Adopt the row. Without this the retry inserts a second message and
          // every count in the system reads one send as two.
          messageId: row.id,
          tenantId: row.tenantId,
          ...(row.subTenantId ? { subTenantId: row.subTenantId } : {}),
          channel: row.channel as ChannelType,
          to: { type: state.toType ?? row.channel, value: String(metadata.to) },
          rendered: {
            body: row.content,
            ...(typeof metadata.subject === 'string' ? { subject: metadata.subject } : {}),
            ...(state.html ? { html: state.html } : {}),
          },
          ...(state.priority ? { priority: state.priority } : {}),
          ...(row.recipientId ? { recipientId: row.recipientId } : {}),
          ...(row.senderId ? { senderId: row.senderId } : {}),
          ...(row.playbookId ? { playbookId: row.playbookId } : {}),
          ...(state.playbookKey ? { playbookKey: state.playbookKey } : {}),
          ...(row.templateId ? { templateId: row.templateId } : {}),
          ...(row.approvalId ? { approvalId: row.approvalId } : {}),
          ...(state.transactional ? { transactional: true } : {}),
          ...(state.throttle ? { throttle: state.throttle } : {}),
          ...(typeof metadata.correlationId === 'string'
            ? { correlationId: metadata.correlationId }
            : {}),
          deferralAttempts: attempts,
        });

        if (result.queued) {
          messagesRetriedTotal.inc({ tenant: row.tenantId, outcome: 'sent' });
          report.sent += 1;
          this.deps.logger.info('deferred message released', {
            messageId: row.id,
            attempts: attempts + 1,
            waitedMs: ageMs,
          });
        } else if (result.deferrable) {
          // `dispatch` has already written the new retryAt and attempt count.
          messagesRetriedTotal.inc({ tenant: row.tenantId, outcome: 'deferred' });
          report.deferred += 1;
        } else {
          // Blocked by something that is not going to change — an opt-out
          // arriving during the wait is the common case. It is suppressed for a
          // new reason now, so it must not be swept again.
          await this.exhaust(row.tenantId, row.id, `no longer sendable: ${result.skipped}`);
          messagesRetriedTotal.inc({ tenant: row.tenantId, outcome: 'exhausted' });
          report.exhausted += 1;
        }
      } catch (error) {
        report.failed += 1;
        this.deps.logger.error('deferral sweep failed for one message', {
          messageId: row.id,
          tenantId: row.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.refreshGauge();

    if (report.scanned > 0) {
      this.deps.logger.info('deferral sweep complete', { ...report });
    }
    return report;
  }

  /**
   * Stop retrying, and say why on the row. The status and suppression reason are
   * left as they were — the message really was suppressed, and overwriting the
   * gate's reason with a scheduler's would lose why it was held in the first
   * place.
   */
  private async exhaust(tenantId: string, messageId: string, reason: string): Promise<void> {
    await this.deps.db
      .update(messages)
      .set({
        // Clearing the column is what takes the row out of the partial index —
        // the reason below is for a human reading the row, not for the query.
        deferredUntil: null,
        metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({
          deferralExhausted: true,
          deferralExhaustedReason: reason,
          deferralExhaustedAt: new Date().toISOString(),
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)));

    this.deps.logger.info('deferred message exhausted', { messageId, reason });
  }

  private async refreshGauge(): Promise<void> {
    const [row] = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.status, 'SUPPRESSED'), isNotNull(messages.deferredUntil)));
    messagesAwaitingRetryGauge.set(row?.n ?? 0);
  }
}

export interface DeferralWorkerDeps extends DeferralSweeperDeps {
  /** Null when Redis is unavailable; the sweeper then disables itself. */
  connection: Redis | null;
  /** How often to sweep. Default 60s — the gate's finest retryAt granularity. */
  intervalMs?: number;
}

/**
 * The sweeper on a BullMQ repeatable job, for the same reason the SLA sweeper
 * is: with N replicas the queue guarantees exactly one of them runs each tick.
 * A `setInterval` would have every replica dispatching the same rows at once.
 */
export class DeferralWorker {
  private readonly sweeper: DeferralSweeper;
  private readonly queue?: Queue;
  private readonly worker?: Worker;

  constructor(private readonly deps: DeferralWorkerDeps) {
    this.sweeper = new DeferralSweeper(deps);

    if (!deps.connection) {
      deps.logger.warn('deferral sweeper disabled — no Redis connection');
      return;
    }

    const connection = deps.connection;
    this.queue = new Queue(DEFERRAL_QUEUE_NAME, { connection });
    this.worker = new Worker(DEFERRAL_QUEUE_NAME, (_job: Job) => this.sweeper.sweep(), {
      connection: connection.duplicate(),
      concurrency: 1,
    });

    this.worker.on('error', (error) =>
      deps.logger.error('deferral sweeper error', { error: error.message }),
    );
  }

  async start(): Promise<void> {
    if (!this.queue) return;
    const every = this.deps.intervalMs ?? 60_000;
    await this.queue.add(
      'sweep',
      {},
      { repeat: { every }, removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } },
    );
    this.deps.logger.info('deferral sweeper scheduled', { everyMs: every });
  }

  /** Run one sweep now, ignoring the schedule. Used by tests and by operators. */
  async runOnce(now?: Date): Promise<DeferralSweepReport> {
    return this.sweeper.sweep(now);
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
