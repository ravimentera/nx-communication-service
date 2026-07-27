/**
 * What arrives at the engine's front door.
 *
 * The source's equivalent is `Event` in `models/communication.model.ts`, whose
 * `type` is a **44-value TypeScript enum**. Adding an event type there means
 * editing the enum, editing the 17-case switch in `enhanced-event-handler.ts`,
 * and redeploying — which is exactly why 27 of those 44 values have no handler
 * at all and silently hit `default: logger.warn('Unknown event type')`.
 *
 * Here `eventType` is a **string**. The engine does not enumerate what events
 * exist; a pack does, in `packs/<id>/event-types.json`, and that list is used
 * for validation and aliasing, not for dispatch.
 */
import type { Priority } from '../../domain/index.js';
import type { ChannelType } from '../../ports/channel.js';

export const TRIGGER_TYPES = ['event', 'schedule', 'manual', 'campaign', 'webhook'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export interface OutreachTrigger {
  type: TriggerType;
  tenantId: string;
  subTenantId?: string;
  /** e.g. 'APPOINTMENT_REMINDER'. Matched exactly, after alias resolution. */
  eventType?: string;
  payload: Record<string, unknown>;
  correlationId: string;
  /**
   * Redelivery guard. `(tenant_id, playbook_id, idempotency_key)` is unique, so
   * the same event arriving twice produces one run and one send. BullMQ retries
   * a failed job up to five times; without this, a job that failed *after*
   * dispatching would send five times.
   */
  idempotencyKey?: string;
  /**
   * Channels the caller asked for. **Intersected with the playbook's
   * `channel_plan`** — see D54: the source reads `event.channels` inside every
   * switch case (`if (event.channels.includes(EMAIL))`), so the caller has
   * always had the final say over which channels fire. Absent means "whatever
   * the playbook plans".
   */
  channels?: ChannelType[];
  priority?: Priority;
  /** Who this is about, when the caller already knows. */
  recipientId?: string;
  senderId?: string;
}

/** One playbook's outcome. A trigger may produce several. */
export interface PlaybookRunResult {
  playbookId: string;
  playbookKey: string;
  status: 'SENT' | 'QUEUED' | 'PENDING_APPROVAL' | 'SUPPRESSED' | 'SKIPPED' | 'FAILED';
  runId?: string;
  messageIds: string[];
  approvalIds: string[];
  /** Why, when the status is SKIPPED, SUPPRESSED or FAILED. Never null on those. */
  reason?: string;
  /** Schema errors when the context failed the playbook's data contract. */
  contractErrors?: string[];
}
