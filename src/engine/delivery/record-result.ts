/**
 * Persists a delivery outcome. Injected into the queue so the worker does not
 * own the schema, and so tests can assert on the calls without a database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * METADATA IS MERGED, NOT REPLACED
 *
 * The first version of this file did `.set({ metadata: {...} })`, which replaces
 * the whole JSONB document. That silently destroyed `metadata.playbookKey` the
 * moment a message was sent — and the P5 compliance gate's per-playbook cooldown
 * check counts recent sends with
 *
 *     WHERE metadata->>'playbookKey' = $1
 *
 * (`gate.ts`, `throttleExceeded`). Every message that succeeded lost the key on
 * its way out, so the cooldown could only ever match messages that had NOT been
 * sent, and `throttle.cooldownHours` never fired for a delivered message. It
 * also took the submit-time dispatch envelope (P6) with it.
 *
 * Merging with `||` is what the column is for. Do not "simplify" this back.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { messages } from '../../db/schema.js';
import type { DeliveryResult } from '../../ports/channel.js';
import type { SendJob } from './notification-queue.js';

export interface ResultRecorderDeps {
  /**
   * Called after a successful send so an approval can move to SENT. Optional:
   * the delivery plane must not require the approvals plane to exist (P3 tests
   * construct the queue on its own).
   */
  onSent?: (job: SendJob) => Promise<void>;
}

export function createResultRecorder(db: Db, logger: Logger, deps: ResultRecorderDeps = {}) {
  return async (job: SendJob, result: DeliveryResult): Promise<void> => {
    try {
      await db
        .update(messages)
        .set({
          status: result.success ? 'SENT' : 'FAILED',
          sentAt: result.success ? new Date() : null,
          providerMessageId: result.providerMessageId,
          updatedAt: new Date(),
          metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({
            correlationId: job.correlationId,
            to: job.to.value,
            attempt: job.attempt,
            dispatched: result.dispatched,
            ...(result.error ? { error: result.error } : {}),
          })}::jsonb`,
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

    // Only a real send closes an approval. A failure leaves it APPROVED so a
    // retry — or a human — can still act on it.
    //
    // GUARDED, because this runs AFTER the provider accepted the message.
    // Anything that throws from here reaches BullMQ, which retries the job —
    // and the job's work is "call the provider", so the retry sends the SMS
    // again. Up to five times, ten for URGENT, with no idempotency key on the
    // provider side to catch it.
    //
    // `approvals.markSent` happens to swallow its own errors today, so the
    // path is not currently reachable. That is a property of one implementation
    // of an injected hook, not of this code — and it is the wrong thing to be
    // relying on at the point where a duplicate costs a real message.
    if (result.success && deps.onSent) {
      try {
        await deps.onSent(job);
      } catch (error) {
        logger.error('post-send bookkeeping failed; the message was already sent', {
          messageId: job.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}
