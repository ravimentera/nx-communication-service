/**
 * The event ingestion queue. Ports `services/queue/event-processing-queue.ts`
 * (415L), which the plan correctly calls generic — the port is mostly a rename
 * plus the same BullMQ v5 and degradation treatment as the send queue.
 *
 * The processor is injected. In P3 the composition root passes a stub that logs
 * and drops; P7 replaces it with the playbook runtime. That seam is the reason
 * this file knows nothing about playbooks.
 */
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'winston';

import { queueDepth } from './metrics.js';
import { QUEUE_NAMES } from './notification-queue.js';

export interface OutreachEventJob {
  eventId: string;
  tenantId: string;
  subTenantId?: string;
  type: string;
  payload: Record<string, unknown>;
  correlationId: string;
  recipientId?: string;
  senderId?: string;
  scheduledFor?: string;
}

export type EventProcessor = (event: OutreachEventJob) => Promise<void>;

export interface EventQueueDeps {
  connection: Redis | null;
  logger: Logger;
  concurrency: number;
  attempts: number;
  backoffDelayMs: number;
  process: EventProcessor;
  queueName?: string;
}

export interface EventQueue {
  publish(event: OutreachEventJob, opts?: { delayMs?: number }): Promise<string | undefined>;
  stats(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

export class BullEventQueue implements EventQueue {
  private readonly queue: Queue<OutreachEventJob>;
  private readonly worker: Worker<OutreachEventJob>;
  private readonly events: QueueEvents;
  private readonly name: string;

  constructor(private readonly deps: EventQueueDeps) {
    if (!deps.connection) {
      throw new Error('BullEventQueue requires a live Redis connection');
    }
    const connection = deps.connection;
    this.name = deps.queueName ?? QUEUE_NAMES.EVENT_PROCESSING;

    this.queue = new Queue<OutreachEventJob>(this.name, { connection });
    this.events = new QueueEvents(this.name, { connection: connection.duplicate() });
    this.worker = new Worker<OutreachEventJob>(
      this.name,
      (job: Job<OutreachEventJob>) => deps.process(job.data),
      {
        connection: connection.duplicate(),
        concurrency: deps.concurrency,
      },
    );

    this.worker.on('error', (error) =>
      deps.logger.error('event worker error', { error: error.message }),
    );
    this.worker.on('failed', (job, error) =>
      deps.logger.error('event job failed', {
        jobId: job?.id,
        eventId: job?.data.eventId,
        type: job?.data.type,
        attempt: job?.attemptsMade,
        error: error.message,
      }),
    );
    this.events.on('stalled', ({ jobId }) => deps.logger.warn('event job stalled', { jobId }));
  }

  async publish(
    event: OutreachEventJob,
    opts: { delayMs?: number } = {},
  ): Promise<string | undefined> {
    const job = await this.queue.add(`event-${event.type}-${event.eventId}`, event, {
      attempts: this.deps.attempts,
      backoff: { type: 'exponential', delay: this.deps.backoffDelayMs },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
      // v5 handles delayed jobs in the Worker — no QueueScheduler needed.
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    });
    return job.id;
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
      queueDepth.set({ queue: this.name, state }, value);
    }
    return { ...stats, total: waiting + active + completed + failed + delayed };
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.events.close();
    await this.queue.close();
  }
}

export class DisabledEventQueue implements EventQueue {
  constructor(
    private readonly logger: Logger,
    private readonly reason: string,
  ) {}

  async publish(event: OutreachEventJob): Promise<string | undefined> {
    this.logger.warn('event dropped — queue disabled', {
      reason: this.reason,
      eventId: event.eventId,
      type: event.type,
    });
    return undefined;
  }

  async stats(): Promise<Record<string, number>> {
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0 };
  }

  async close(): Promise<void> {}
}

/**
 * P3 stub. Logs and drops. P7 replaces this with the playbook runtime —
 * `default-event-processor.ts` in the source hands off to the 17-case switch,
 * and there is nothing to hand off to until playbooks exist.
 */
export function createStubEventProcessor(logger: Logger): EventProcessor {
  return async (event) => {
    logger.info('event received (no playbook runtime until P7 — dropping)', {
      eventId: event.eventId,
      type: event.type,
      tenantId: event.tenantId,
      correlationId: event.correlationId,
    });
  };
}
