/**
 * The queue's consumer. Replaces `createStubEventProcessor` (P3) and, with it,
 * the source's `default-event-processor.ts` — which was seven lines wrapping
 * `enhancedEventHandler.handleEvent(event)`.
 *
 * The whole file is the conversion from a queue job to an `OutreachTrigger`,
 * plus one decision worth explaining:
 *
 * WHEN TO THROW, AND THEREFORE WHEN BULLMQ RETRIES
 *
 * A `FAILED` run is usually the caller's problem — a payload that does not
 * satisfy the playbook's data contract will not satisfy it on the fifth attempt
 * either, and retrying spends four more LLM calls and four more log lines to
 * reach the same conclusion. Those complete normally; the `playbook_runs` row is
 * the record.
 *
 * An *infrastructure* failure is different: a dropped database connection or a
 * provider timeout is exactly what retries are for. The source cannot tell these
 * apart — `handleEvent` catches everything and returns `false`, so a transient
 * database blip silently loses the message with no retry at all.
 */
import type { Logger } from 'winston';

import type { OutreachEventJob } from '../delivery/event-processing-queue.js';
import type { PlaybookRuntime } from './runtime.js';
import type { OutreachTrigger } from './trigger.js';
import type { ChannelType } from '../../ports/channel.js';
import type { Priority } from '../../domain/index.js';

export function createPlaybookEventProcessor(runtime: PlaybookRuntime, logger: Logger) {
  return async (event: OutreachEventJob): Promise<void> => {
    const payload = event.payload ?? {};

    const trigger: OutreachTrigger = {
      type: 'event',
      tenantId: event.tenantId,
      subTenantId: event.subTenantId,
      eventType: event.type,
      payload,
      correlationId: event.correlationId,
      // The queue's own event id is a natural idempotency key: BullMQ redelivers
      // the same job on retry, so the same id arrives again and the partial
      // unique index turns the second run into a no-op.
      idempotencyKey: event.eventId,
      recipientId: event.recipientId,
      senderId: event.senderId,
      channels: Array.isArray(payload.channels)
        ? (payload.channels as string[]).map((c) => c.toLowerCase() as ChannelType)
        : undefined,
      priority: payload.priority as Priority | undefined,
    };

    const results = await runtime.run(trigger);

    // Nothing here throws on a FAILED run — see the header. The run row carries
    // the reason, and `outreach_playbook_runs_total{result="FAILED"}` is what an
    // alert should watch.
    const failed = results.filter((r) => r.status === 'FAILED');
    if (failed.length > 0) {
      logger.warn('event processed with failures', {
        eventId: event.eventId,
        type: event.type,
        tenantId: event.tenantId,
        failures: failed.map((f) => ({ playbook: f.playbookKey, reason: f.reason })),
      });
    }
  };
}
