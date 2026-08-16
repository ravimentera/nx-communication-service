/**
 * The send queue. Ports `services/queue/notification-queue.ts` (743L) to
 * BullMQ v5.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED, AND WHY
 *
 * 1. THE SWITCH IS GONE. `notification-queue.ts:273-300` dispatched on
 *    `notification.type` across six cases, each with its own payload interface
 *    and its own `processXNotification` method — roughly 200 lines whose only
 *    job was to pick a sender. It is now one line:
 *        registry.get(job.data.channel).send(...)
 *    Adding a channel is registering an adapter. That is the whole phase.
 *
 * 2. ONE JOB SHAPE. The six-way `NotificationPayload` union is replaced by
 *    `SendJob`, which carries an already-rendered message. Rendering happens
 *    before the queue (P4), not inside it.
 *
 * 3. NON-RETRYABLE FAILURES STOP. The source throws a plain Error on every
 *    failure, so an SMS to a number that has replied STOP is retried five times
 *    — five more messages to someone who opted out. Adapters classify their
 *    errors, and a non-retryable one becomes BullMQ's `UnrecoverableError`.
 *
 * 4. BULLMQ v4 -> v5. `QueueScheduler` was removed in v5; the source never
 *    instantiated one, so nothing to delete. Delayed jobs are handled by the
 *    Worker. `connection` still accepts a plain options object. Verified
 *    against bullmq 5.81.3.
 *
 * PRESERVED EXACTLY: 5 attempts / exponential / 5s base; URGENT gets 10
 * attempts and switches to FIXED backoff (`notification-queue.ts:571-574` — the
 * backoff-type change is easy to miss and is deliberate: an urgent message
 * should not back off to minutes); priority lanes 1/2/3/4; removeOnComplete
 * 24h+1000, removeOnFail 7d; the no-op fallback when the queue is disabled.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Queue, QueueEvents, UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'winston';

import { JOB_PRIORITY, type Priority } from '../../domain/index.js';
import type {
  ChannelRegistry,
  ChannelType,
  ContactPoint,
  DeliveryResult,
  RenderedMessage,
} from '../../ports/channel.js';
import { messageLatencySeconds, messagesSentTotal, queueDepth } from './metrics.js';

export const QUEUE_NAMES = {
  NOTIFICATION: 'outreach-notification-queue',
  EVENT_PROCESSING: 'outreach-event-processing-queue',
} as const;

/** The uniform job payload. No per-channel union. */
export interface SendJob {
  messageId: string;
  tenantId: string;
  subTenantId?: string;
  channel: ChannelType;
  recipientId?: string;
  senderId?: string;
  to: ContactPoint;
  rendered: RenderedMessage;
  priority: Priority;
  playbookId?: string;
  correlationId: string;
  attempt: number;
}

export interface QueueRetryConfig {
  attempts: number;
  urgentAttempts: number;
  backoffDelayMs: number;
  concurrency: number;
  /** Jobs this worker will start per `limiterIntervalMs`. See the limiter note. */
  maxPerInterval: number;
  limiterIntervalMs: number;
}

export interface NotificationQueueDeps {
  connection: Redis | null;
  registry: ChannelRegistry;
  logger: Logger;
  retry: QueueRetryConfig;
  /** Resolves credentials at send time, so a rotated key takes effect mid-queue. */
  resolveCredentials: (
    channel: ChannelType,
    scope: { tenantId: string; senderId?: string },
  ) => Promise<import('../../ports/channel.js').ChannelCredentials>;
  /** Persists the outcome. Injected so the queue does not own the schema. */
  onResult: (job: SendJob, result: DeliveryResult) => Promise<void>;
}

export interface EnqueueResult {
  queued: boolean;
  jobId?: string;
  reason?: string;
}

export interface EnqueueOptions {
  /**
   * Hold the job for this long before a worker may pick it up. Used by P6's
   * scheduled approvals: BullMQ owns the wait, so it survives a restart. The
   * source stored a `scheduledFor` timestamp that nothing ever read.
   */
  delayMs?: number;
}

/**
 * The shape everything else depends on. The disabled implementation satisfies
 * it too — unlike the source, whose mock (`notification-queue.ts:727-739`)
 * exposes `addEmailToQueue`/`addSMSToQueue`/... methods that the real service
 * does not have, so any caller using the mock's API breaks the moment the queue
 * is enabled.
 */
/**
 * What a recall achieved. Three outcomes, because they mean different things to
 * the caller and collapsing them would be a lie:
 *
 *   removed   the job is gone and will not send
 *   inFlight  a worker already has it — it is sending, or about to
 *   notFound  never queued, already completed, or aged out of the queue
 *
 * `inFlight` is the honest limit of a recall. Once a worker holds the lock the
 * provider call may already be in progress, and there is no point at which a
 * distributed queue can promise otherwise. A caller that reports "cancelled"
 * without accounting for these is telling somebody their message did not go out
 * when it did.
 */
export interface RemoveResult {
  removed: string[];
  inFlight: string[];
  notFound: string[];
}

export interface NotificationQueue {
  enqueue(job: Omit<SendJob, 'attempt'>, options?: EnqueueOptions): Promise<EnqueueResult>;
  enqueueMany(jobs: Omit<SendJob, 'attempt'>[], options?: EnqueueOptions): Promise<EnqueueResult[]>;
  /**
   * Recall queued jobs that have not started. Added in P12 — until then
   * `cancel` stopped generation and left anything already queued to send (D83).
   */
  remove(jobIds: string[]): Promise<RemoveResult>;
  stats(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

function jobOptions(priority: Priority, retry: QueueRetryConfig, options?: EnqueueOptions) {
  const urgent = priority === 'URGENT';
  return {
    priority: JOB_PRIORITY[priority],
    attempts: urgent ? retry.urgentAttempts : retry.attempts,
    // ── JITTERED ────────────────────────────────────────────────────────────
    //
    // A provider outage fails every in-flight job at once, and a deterministic
    // backoff then retries all of them at the same instant — and again, and
    // again, in a thundering herd that keeps the provider down and burns every
    // attempt in lockstep. `custom` spreads them.
    //
    // Urgent messages keep a FIXED base rather than exponential, so they do not
    // back off into minutes (the source's own choice, preserved). They get
    // jitter too: simultaneity is the problem, not the curve.
    backoff: {
      type: 'custom' as const,
      delay: retry.backoffDelayMs,
    },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
    ...(options?.delayMs && options.delayMs > 0 ? { delay: options.delayMs } : {}),
  };
}

/**
 * How long BullMQ lets a worker hold a job before deciding it stalled and
 * handing it to somebody else.
 */
const LOCK_DURATION_MS = 30_000;

/**
 * The deadline on one provider call. Comfortably below `LOCK_DURATION_MS`, so a
 * hung provider produces a failure this worker owns rather than a reclaim that
 * puts two workers on the same send.
 */
const SEND_TIMEOUT_MS = 20_000;

/**
 * Bound a provider call.
 *
 * Only the webhook and push adapters set their own timeout; the Twilio,
 * SendGrid and Slack SDKs use their defaults, which for a hung connection can
 * exceed `LOCK_DURATION_MS`. When that happens BullMQ decides the job stalled
 * and gives it to another worker while the first is still inside the provider
 * call — and both send.
 *
 * The timeout is a RETRYABLE failure. A provider slow once is usually not slow
 * twice, and dropping the message after one attempt is the more expensive
 * mistake.
 *
 * NOTE it does not cancel the underlying request; nothing at this layer can. It
 * stops the WORKER waiting, which is what keeps the job inside its lock. A
 * provider that eventually accepts a message we gave up on is the one duplicate
 * this cannot prevent, and it is far less likely than the reclaim it does.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, channel: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${channel} provider did not respond within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    // Cleared on both paths. An uncleared timer is what D30 records the source
    // getting wrong, and it keeps the event loop alive past shutdown.
    if (timer) clearTimeout(timer);
  }
}

export class BullNotificationQueue implements NotificationQueue {
  private readonly queue: Queue<SendJob>;
  private readonly worker: Worker<SendJob>;
  private readonly events: QueueEvents;

  constructor(private readonly deps: NotificationQueueDeps) {
    if (!deps.connection) {
      throw new Error('BullNotificationQueue requires a live Redis connection');
    }
    const connection = deps.connection;

    this.queue = new Queue<SendJob>(QUEUE_NAMES.NOTIFICATION, { connection });
    this.events = new QueueEvents(QUEUE_NAMES.NOTIFICATION, { connection: connection.duplicate() });
    this.worker = new Worker<SendJob>(
      QUEUE_NAMES.NOTIFICATION,
      (job) => this.process(job),
      {
        connection: connection.duplicate(),
        concurrency: deps.retry.concurrency,
        lockDuration: LOCK_DURATION_MS,
        // ── FAIRNESS ─────────────────────────────────────────────────────────
        //
        // Without a limiter, one tenant launching a 50,000-recipient campaign
        // fills the queue and every other tenant's appointment reminder waits
        // behind it. BullMQ's limiter caps the whole worker's throughput, which
        // does not partition by tenant — but it does bound how fast any single
        // producer can drain the workers, and it is the mechanism the queue
        // actually offers. Per-tenant fairness needs a queue per tenant or a
        // group key; both are a larger change than the starvation warrants
        // today, and this is recorded rather than pretended away.
        //
        // It also protects the providers: Twilio and SendGrid rate-limit, and
        // hitting those limits produces retries that make the burst worse.
        limiter: {
          max: deps.retry.maxPerInterval,
          duration: deps.retry.limiterIntervalMs,
        },
        settings: {
          // The `custom` backoff declared in `jobOptions`.
          backoffStrategy: (
            attemptsMade: number,
            _type?: string,
            _err?: Error,
            job?: { opts?: { backoff?: unknown }; data?: unknown },
          ) => {
            const base = (job?.opts?.backoff as { delay?: number } | undefined)?.delay ?? 5_000;
            const urgent = (job?.data as SendJob | undefined)?.priority === 'URGENT';
            // Urgent stays flat; everything else doubles.
            const window = urgent ? base : base * 2 ** Math.max(0, attemptsMade - 1);
            // Full jitter: anywhere in [0, window). Spreads a synchronised
            // failure across the whole window rather than bunching it at the
            // end, which is what a "delay ± 10%" scheme does.
            return Math.round(Math.random() * window);
          },
        },
      },
    );

    this.wireEvents();
  }

  private wireEvents(): void {
    const { logger } = this.deps;

    this.events.on('stalled', ({ jobId }) =>
      logger.warn('send job stalled, will be reprocessed', { jobId }),
    );
    this.worker.on('error', (error) => logger.error('send worker error', { error: error.message }));
    this.worker.on('failed', (job, error) =>
      logger.error('send job failed', {
        jobId: job?.id,
        channel: job?.data.channel,
        messageId: job?.data.messageId,
        attempt: job?.attemptsMade,
        error: error.message,
      }),
    );
  }

  /** The former 200-line switch. */
  private async process(job: Job<SendJob>): Promise<DeliveryResult> {
    const data = { ...job.data, attempt: job.attemptsMade };
    const started = process.hrtime.bigint();
    const channel = this.deps.registry.get(data.channel);

    const credentials = await this.deps.resolveCredentials(data.channel, {
      tenantId: data.tenantId,
      senderId: data.senderId,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // A PROVIDER CALL GETS A DEADLINE.
    //
    // Only the webhook and push adapters set their own; the Twilio, SendGrid
    // and Slack SDKs use their defaults, which for a hung connection can exceed
    // BullMQ's 30-second `lockDuration`. When it does, the queue decides the
    // job stalled and hands it to another worker — while the first is still
    // inside the provider call. Both then send.
    //
    // The bound is below `lockDuration` on purpose, so a slow provider produces
    // a retryable failure this worker owns, rather than a second worker
    // holding the same job.
    // ─────────────────────────────────────────────────────────────────────────
    const result = await withDeadline(
      channel.send(data.rendered, data.to, credentials),
      SEND_TIMEOUT_MS,
      data.channel,
    );

    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const status = result.success ? 'sent' : 'failed';
    messagesSentTotal.inc({ channel: data.channel, tenant: data.tenantId, status });
    messageLatencySeconds.observe({ channel: data.channel, status }, seconds);

    await this.deps.onResult(data, result);

    if (!result.success) {
      const error = result.error;
      const message = `${data.channel} send failed: ${error?.code ?? 'UNKNOWN'} ${error?.message ?? ''}`;
      // A permanent failure must not consume the remaining attempts.
      if (error && !error.retryable) throw new UnrecoverableError(message);
      throw new Error(message);
    }

    return result;
  }

  async enqueue(
    job: Omit<SendJob, 'attempt'>,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult> {
    const added = await this.queue.add(
      `send-${job.channel}-${job.messageId}`,
      { ...job, attempt: 0 },
      jobOptions(job.priority, this.deps.retry, options),
    );
    this.deps.logger.debug('send job queued', {
      jobId: added.id,
      channel: job.channel,
      messageId: job.messageId,
      priority: job.priority,
      delayMs: options?.delayMs,
    });
    return { queued: true, jobId: added.id };
  }

  async enqueueMany(
    jobs: Omit<SendJob, 'attempt'>[],
    options?: EnqueueOptions,
  ): Promise<EnqueueResult[]> {
    if (jobs.length === 0) return [];
    const added = await this.queue.addBulk(
      jobs.map((job) => ({
        name: `send-${job.channel}-${job.messageId}`,
        data: { ...job, attempt: 0 },
        opts: jobOptions(job.priority, this.deps.retry, options),
      })),
    );
    return added.map((j) => ({ queued: true, jobId: j.id }));
  }

  /**
   * Remove by job id, one at a time and tolerantly.
   *
   * Not `queue.removeJobs(pattern)`: that matches on job NAME, and this queue's
   * names are `send-<channel>-<messageId>` — a pattern broad enough to catch one
   * message is broad enough to catch a sibling. Ids are exact.
   *
   * A job a worker already holds cannot be removed; BullMQ throws rather than
   * silently succeeding, and that error is the signal, not a failure. It is
   * reported as `inFlight` so the caller can say so.
   */
  async remove(jobIds: string[]): Promise<RemoveResult> {
    const result: RemoveResult = { removed: [], inFlight: [], notFound: [] };

    for (const jobId of jobIds) {
      try {
        const job = await this.queue.getJob(jobId);
        if (!job) {
          result.notFound.push(jobId);
          continue;
        }
        // Checked before removing so the common case reports accurately; the
        // catch below still covers the race where it becomes active in between.
        if (await job.isActive()) {
          result.inFlight.push(jobId);
          continue;
        }
        await job.remove();
        result.removed.push(jobId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // "could not be removed because it is locked by another worker"
        if (/locked|could not be removed/i.test(message)) {
          result.inFlight.push(jobId);
        } else {
          this.deps.logger.warn('failed to remove send job', { jobId, error: message });
          result.notFound.push(jobId);
        }
      }
    }

    this.deps.logger.info('send jobs recalled', {
      requested: jobIds.length,
      removed: result.removed.length,
      inFlight: result.inFlight.length,
      notFound: result.notFound.length,
    });
    return result;
  }

  async stats(): Promise<Record<string, number>> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);
    const stats = { waiting, active, completed, failed, delayed };
    for (const [state, value] of Object.entries(stats)) {
      queueDepth.set({ queue: QUEUE_NAMES.NOTIFICATION, state }, value);
    }
    return { ...stats, total: waiting + active + completed + failed + delayed };
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.events.close();
    await this.queue.close();
    this.deps.logger.info('notification queue shut down');
  }
}

/**
 * Used when Redis is down or the queue is disabled. Boot must succeed either
 * way — the service degrades, it does not fail to start.
 */
export class DisabledNotificationQueue implements NotificationQueue {
  constructor(
    private readonly logger: Logger,
    private readonly reason: string,
  ) {}

  async enqueue(
    job: Omit<SendJob, 'attempt'>,
    _options?: EnqueueOptions,
  ): Promise<EnqueueResult> {
    this.logger.warn('send job dropped — queue disabled', {
      reason: this.reason,
      channel: job.channel,
      messageId: job.messageId,
    });
    return { queued: false, reason: this.reason };
  }

  async enqueueMany(
    jobs: Omit<SendJob, 'attempt'>[],
    options?: EnqueueOptions,
  ): Promise<EnqueueResult[]> {
    return Promise.all(jobs.map((job) => this.enqueue(job, options)));
  }

  /** Nothing was ever queued, so nothing can be recalled. */
  async remove(jobIds: string[]): Promise<RemoveResult> {
    return { removed: [], inFlight: [], notFound: [...jobIds] };
  }

  async stats(): Promise<Record<string, number>> {
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0 };
  }

  async close(): Promise<void> {}
}
