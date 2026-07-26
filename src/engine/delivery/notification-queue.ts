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
export interface NotificationQueue {
  enqueue(job: Omit<SendJob, 'attempt'>, options?: EnqueueOptions): Promise<EnqueueResult>;
  enqueueMany(jobs: Omit<SendJob, 'attempt'>[], options?: EnqueueOptions): Promise<EnqueueResult[]>;
  stats(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

function jobOptions(priority: Priority, retry: QueueRetryConfig, options?: EnqueueOptions) {
  const urgent = priority === 'URGENT';
  return {
    priority: JOB_PRIORITY[priority],
    attempts: urgent ? retry.urgentAttempts : retry.attempts,
    // Urgent messages must not back off exponentially into minutes.
    backoff: urgent
      ? { type: 'fixed' as const, delay: retry.backoffDelayMs }
      : { type: 'exponential' as const, delay: retry.backoffDelayMs },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
    ...(options?.delayMs && options.delayMs > 0 ? { delay: options.delayMs } : {}),
  };
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
        lockDuration: 30_000,
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

    const result = await channel.send(data.rendered, data.to, credentials);

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

  async stats(): Promise<Record<string, number>> {
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0 };
  }

  async close(): Promise<void> {}
}
