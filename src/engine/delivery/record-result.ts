/**
 * Persists a delivery outcome. Injected into the queue so the worker does not
 * own the schema, and so tests can assert on the calls without a database.
 */
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { messages } from '../../db/schema.js';
import type { DeliveryResult } from '../../ports/channel.js';
import type { SendJob } from './notification-queue.js';

export function createResultRecorder(db: Db, logger: Logger) {
  return async (job: SendJob, result: DeliveryResult): Promise<void> => {
    try {
      await db
        .update(messages)
        .set({
          status: result.success ? 'SENT' : 'FAILED',
          sentAt: result.success ? new Date() : null,
          providerMessageId: result.providerMessageId,
          updatedAt: new Date(),
          metadata: {
            correlationId: job.correlationId,
            to: job.to.value,
            attempt: job.attempt,
            dispatched: result.dispatched,
            ...(result.error ? { error: result.error } : {}),
          },
        })
        // Tenant predicate on every write, without exception (Rule 4).
        .where(and(eq(messages.id, job.messageId), eq(messages.tenantId, job.tenantId)));
    } catch (error) {
      // Never let a bookkeeping failure mask the delivery outcome — the worker
      // still needs to decide retry-or-not from `result`.
      logger.error('failed to record delivery result', {
        messageId: job.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
