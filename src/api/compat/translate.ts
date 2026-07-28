// DELETE IN P12
/**
 * The vocabulary bridge. Legacy callers speak `patientId` / `providerId` /
 * `medspaId`; the engine speaks `recipientId` / `senderId` / `tenantId` (§0.7).
 *
 * Two of the three are pure renames — a provider id *is* a sender id, a medspa
 * id *is* a tenant id, same value on both sides. `patientId` is not: it is an
 * id in **patient-service's** namespace, and the engine's `recipients.id` is a
 * UUID it minted itself. The bridge is `recipients.external_ref`,
 * `{system: 'mentera-patient', id: <patientId>}`, which the P5 recipient
 * service already writes.
 *
 * Read paths and write paths want different behaviour on a miss:
 *
 *  - **Read** — an unknown `patientId` means "no messages for that patient",
 *    which is an empty page, not a 404. Returning 404 would change the FE's
 *    behaviour for a patient who simply has no correspondence yet.
 *  - **Write** — an unknown `patientId` must become a recipient, or the send
 *    fails for someone the caller can see and we cannot. `ensure` creates the
 *    row from whatever identity hints the request carried.
 */
import type { RecipientService } from '../../engine/recipients/recipient.service.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';

/** The external system every medspa-pack recipient is keyed by. */
export const MEDSPA_RECIPIENT_SYSTEM = 'mentera-patient';

export interface LegacyIdentityHints {
  patientName?: string;
  email?: string;
  phone?: string;
}

export class CompatIdentity {
  constructor(
    private readonly recipients: RecipientService,
    private readonly system: string = MEDSPA_RECIPIENT_SYSTEM,
  ) {}

  /** Read path: `null` when this tenant has never seen the patient. */
  async lookup(scope: TenantScope, patientId: string): Promise<string | null> {
    const row = await this.recipients.getByExternalRef(scope, { system: this.system, id: patientId });
    return row?.id ?? null;
  }

  /** Write path: resolve or create. */
  async ensure(
    scope: TenantScope,
    patientId: string,
    hints: LegacyIdentityHints = {},
  ): Promise<string> {
    const contactPoints = [
      ...(hints.email ? [{ type: 'email', value: hints.email, primary: true }] : []),
      ...(hints.phone ? [{ type: 'phone', value: hints.phone, primary: !hints.email }] : []),
    ];

    const row = await this.recipients.upsertByExternalRef(
      scope,
      { system: this.system, id: patientId },
      {
        displayName: hints.patientName,
        ...(contactPoints.length ? { contactPoints } : {}),
      },
    );
    return row.id;
  }

  /**
   * Reverse direction, in bulk. Every legacy response carries `patientId`, so
   * the whole page is translated in one query rather than per row.
   */
  async patientIds(
    scope: TenantScope,
    recipientIds: Array<string | null | undefined>,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(recipientIds.filter((id): id is string => Boolean(id)))];
    const rows = await this.recipients.listByIds(scope, ids);

    const out = new Map<string, string>();
    for (const row of rows) {
      const ref = row.externalRef as { system?: string; id?: string } | null;
      // Fall back to the internal id when the recipient has no external ref —
      // one this engine created itself, e.g. a staff Slack destination. A legacy
      // consumer gets a stable id it can round-trip, which is all it uses this
      // field for.
      out.set(row.id, ref?.id ?? row.id);
    }
    return out;
  }
}

/** Legacy channel names are upper case; the engine's are lower (`ChannelType`). */
export function toLegacyChannel(channel: string): string {
  return channel.toUpperCase();
}

export function fromLegacyChannel(channel: string): string {
  return channel.toLowerCase();
}

/** `direction` was `metadata->>'direction'` and upper case; it is a column now. */
export function toLegacyDirection(direction: string): string {
  return direction.toUpperCase();
}

export interface LegacyMessageRecord {
  id: string;
  patientId: string | null;
  providerId: string | null;
  medspaId: string;
  channel: string;
  content: string;
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  eventId: string | null;
  eventType: string | null;
  notificationId: string | null;
  metadata: unknown;
  engagementData: unknown;
  createdAt: Date;
  engagementScore: number | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  repliedAt: Date | null;
}

/**
 * `CommunicationRecord` as `communications.controller.ts:44-66` declares it.
 * Field order and names are the contract; the FE reads them positionally in a
 * couple of places.
 */
export function toLegacyMessage(
  record: {
    id: string;
    recipientId: string | null;
    senderId: string | null;
    tenantId: string;
    channel: string;
    content: string;
    status: string;
    sentAt: Date | null;
    deliveredAt: Date | null;
    readAt: Date | null;
    eventId: string | null;
    eventType: string | null;
    notificationId: string | null;
    metadata: unknown;
    engagementData: unknown;
    createdAt: Date;
    engagementScore: number | null;
    openedAt: Date | null;
    clickedAt: Date | null;
    repliedAt: Date | null;
  },
  patientIds: Map<string, string>,
): LegacyMessageRecord {
  return {
    id: record.id,
    patientId: record.recipientId ? (patientIds.get(record.recipientId) ?? null) : null,
    providerId: record.senderId,
    medspaId: record.tenantId,
    channel: toLegacyChannel(record.channel),
    content: record.content,
    status: record.status,
    sentAt: record.sentAt,
    deliveredAt: record.deliveredAt,
    readAt: record.readAt,
    eventId: record.eventId,
    eventType: record.eventType,
    notificationId: record.notificationId,
    metadata: record.metadata,
    engagementData: record.engagementData,
    createdAt: record.createdAt,
    engagementScore: record.engagementScore,
    openedAt: record.openedAt,
    clickedAt: record.clickedAt,
    repliedAt: record.repliedAt,
  };
}

/** The `PaginatedResponse<T>` envelope (`:68-78`), unchanged. */
export function legacyPagination(page: number, limit: number, total: number) {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}
