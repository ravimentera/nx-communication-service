/** Domain types and enums. No I/O, no dependencies on adapters or the database. */

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** BullMQ orders ascending, so URGENT must be the smallest. Ported verbatim. */
export const JOB_PRIORITY: Record<Priority, number> = {
  URGENT: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
};

export const MESSAGE_STATUSES = [
  'PENDING',
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'SKIPPED',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export type Direction = 'outbound' | 'inbound';
