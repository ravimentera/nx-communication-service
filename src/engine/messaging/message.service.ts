/**
 * Reading and marking messages — the query side of the messaging plane.
 * Sending goes through `Dispatcher`; nothing here writes a new message row.
 *
 * Ports the four list/read handlers of `communications.controller.ts`
 * (:121 by-tenant, :224 by-sender, :344 by-recipient, :454 by-id) plus the two
 * read-state mutations (:1731, :1805), with three deliberate changes:
 *
 *  1. **Every query carries a tenant predicate.** `getCommunicationsByProvider`
 *     (:242) filters on `provider_id` alone, and `markMessageAsRead` reads the
 *     row at :1745 with `eq(id)` and no scope before deciding its response. Both
 *     answer with another tenant's data given an id from it — the same shape as
 *     D45. Hard rule 4 does not have an exception for read paths.
 *  2. **`eventType` actually filters.** `addFilterConditions` (:1893-1895) has
 *     the branch and an empty body, so `?eventType=X` silently returns
 *     everything. A filter that does not filter is not behaviour worth
 *     preserving; the join it needs was already there.
 *  3. `messageType != 'AI_GENERATED'`, hardcoded into the by-sender query at
 *     :242, becomes the optional `excludeAiGenerated` flag. The compat router
 *     sets it, so the legacy endpoint is unchanged.
 */
import { and, asc, count, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { messageAnalytics, messages, outreachEvents } from '../../db/schema.js';
import { NotFoundError } from '../../platform/http/errors.js';
import { tenantWhere, type TenantScope } from '../../platform/db/tenant-scope.js';
import { normalizeChannel } from '../../ports/channel.js';

export interface MessageFilters {
  channel?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  eventType?: string;
  senderId?: string;
  recipientId?: string;
  /** The by-sender legacy list hides AI drafts (:242). */
  excludeAiGenerated?: boolean;
  page?: number;
  limit?: number;
  /** `field:direction`, e.g. `sentAt:desc`. Unknown fields fall back to sentAt desc. */
  sort?: string;
}

export interface MessageRecord {
  id: string;
  recipientId: string | null;
  senderId: string | null;
  tenantId: string;
  subTenantId: string | null;
  channel: string;
  direction: string;
  content: string;
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  eventId: string | null;
  notificationId: string | null;
  aiGenerated: boolean;
  metadata: unknown;
  engagementData: unknown;
  createdAt: Date;
  eventType: string | null;
  engagementScore: number | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  repliedAt: Date | null;
}

export interface MessagePage {
  data: MessageRecord[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const SORTABLE = {
  sentAt: messages.sentAt,
  createdAt: messages.createdAt,
  status: messages.status,
  channel: messages.channel,
} as const;

const MAX_PAGE_SIZE = 200;

export class MessageService {
  constructor(private readonly deps: { db: Db; logger: Logger }) {}

  private conditions(scope: TenantScope, f: MessageFilters): SQL[] {
    const where: SQL[] = [tenantWhere(messages, scope)];
    if (f.senderId) where.push(eq(messages.senderId, f.senderId));
    if (f.recipientId) where.push(eq(messages.recipientId, f.recipientId));
    // A caller may say 'SMS' or 'sms'; the column holds the latter. Uppercasing
    // here — as this did — matched nothing the engine had ever written.
    if (f.channel) where.push(eq(messages.channel, normalizeChannel(f.channel)));
    if (f.status) where.push(eq(messages.status, f.status.toUpperCase()));
    if (f.dateFrom) where.push(gte(messages.sentAt, new Date(f.dateFrom)));
    if (f.dateTo) where.push(lte(messages.sentAt, new Date(f.dateTo)));
    if (f.eventType) where.push(eq(outreachEvents.type, f.eventType));
    if (f.excludeAiGenerated) where.push(eq(messages.aiGenerated, false));
    return where;
  }

  async list(scope: TenantScope, filters: MessageFilters = {}): Promise<MessagePage> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(Math.max(1, filters.limit ?? 50), MAX_PAGE_SIZE);
    const where = and(...this.conditions(scope, filters));

    const [field = 'sentAt', direction = 'desc'] = (filters.sort ?? 'sentAt:desc').split(':');
    const column = SORTABLE[field as keyof typeof SORTABLE] ?? messages.sentAt;
    const orderBy = direction === 'asc' ? asc(column) : desc(column);

    // The count needs the same event join, because `eventType` filters on it.
    const [totals, rows] = await Promise.all([
      this.deps.db
        .select({ value: count() })
        .from(messages)
        .leftJoin(outreachEvents, eq(messages.eventId, outreachEvents.id))
        .where(where),
      this.deps.db
        .select({
          id: messages.id,
          recipientId: messages.recipientId,
          senderId: messages.senderId,
          tenantId: messages.tenantId,
          subTenantId: messages.subTenantId,
          channel: messages.channel,
          direction: messages.direction,
          content: messages.content,
          status: messages.status,
          sentAt: messages.sentAt,
          deliveredAt: messages.deliveredAt,
          readAt: messages.readAt,
          eventId: messages.eventId,
          notificationId: messages.notificationId,
          aiGenerated: messages.aiGenerated,
          metadata: messages.metadata,
          engagementData: messages.engagementData,
          createdAt: messages.createdAt,
          eventType: outreachEvents.type,
          engagementScore: messageAnalytics.engagementScore,
          openedAt: messageAnalytics.openedAt,
          clickedAt: messageAnalytics.clickedAt,
          repliedAt: messageAnalytics.repliedAt,
        })
        .from(messages)
        .leftJoin(outreachEvents, eq(messages.eventId, outreachEvents.id))
        .leftJoin(messageAnalytics, eq(messages.id, messageAnalytics.messageId))
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset((page - 1) * limit),
    ]);

    const total = totals[0]?.value ?? 0;
    return { data: rows as MessageRecord[], page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  async getById(scope: TenantScope, id: string): Promise<MessageRecord | null> {
    const [row] = await this.deps.db
      .select({
        id: messages.id,
        recipientId: messages.recipientId,
        senderId: messages.senderId,
        tenantId: messages.tenantId,
        subTenantId: messages.subTenantId,
        channel: messages.channel,
        direction: messages.direction,
        content: messages.content,
        status: messages.status,
        sentAt: messages.sentAt,
        deliveredAt: messages.deliveredAt,
        readAt: messages.readAt,
        eventId: messages.eventId,
        notificationId: messages.notificationId,
        aiGenerated: messages.aiGenerated,
        metadata: messages.metadata,
        engagementData: messages.engagementData,
        createdAt: messages.createdAt,
        eventType: outreachEvents.type,
        engagementScore: messageAnalytics.engagementScore,
        openedAt: messageAnalytics.openedAt,
        clickedAt: messageAnalytics.clickedAt,
        repliedAt: messageAnalytics.repliedAt,
      })
      .from(messages)
      .leftJoin(outreachEvents, eq(messages.eventId, outreachEvents.id))
      .leftJoin(messageAnalytics, eq(messages.id, messageAnalytics.messageId))
      .where(and(tenantWhere(messages, scope), eq(messages.id, id)))
      .limit(1);

    return (row as MessageRecord | undefined) ?? null;
  }

  /**
   * Toggle read state. Marking an already-read message read is a **success**,
   * not a 404 — the source goes to some trouble for that (:1762) and the FE
   * relies on it when two tabs are open on the same inbox.
   */
  async markRead(
    scope: TenantScope,
    messageId: string,
    isRead = true,
  ): Promise<{ id: string; readAt: Date | null; isRead: boolean }> {
    const where = [tenantWhere(messages, scope), eq(messages.id, messageId)];
    // Only claim the transition when there is one to make; re-marking a read
    // message must not move its timestamp forward.
    if (isRead) where.push(isNull(messages.readAt));

    const [updated] = await this.deps.db
      .update(messages)
      .set({ readAt: isRead ? sql`now()` : null, updatedAt: sql`now()` })
      .where(and(...where))
      .returning({ id: messages.id, readAt: messages.readAt });

    if (updated) return { id: updated.id, readAt: updated.readAt, isRead: Boolean(updated.readAt) };

    // Nothing updated: either the row is not ours, or it was already in the
    // requested state. Scoped, unlike the source's :1745.
    const [existing] = await this.deps.db
      .select({ id: messages.id, readAt: messages.readAt })
      .from(messages)
      .where(and(tenantWhere(messages, scope), eq(messages.id, messageId)))
      .limit(1);

    if (!existing) throw new NotFoundError(`Message '${messageId}' not found`);
    return { id: existing.id, readAt: existing.readAt, isRead: Boolean(existing.readAt) };
  }

  /**
   * Mark a whole conversation read. Inbound only — an outbound message's
   * `read_at` is the *recipient's* read receipt and is not ours to write
   * (:1825 has the same restriction).
   */
  async markConversationRead(
    scope: TenantScope,
    senderId: string,
    recipientId: string,
  ): Promise<{ messagesMarkedRead: number; markedAt: Date }> {
    const updated = await this.deps.db
      .update(messages)
      .set({ readAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          tenantWhere(messages, scope),
          eq(messages.senderId, senderId),
          eq(messages.recipientId, recipientId),
          isNull(messages.readAt),
          eq(messages.direction, 'inbound'),
        ),
      )
      .returning({ id: messages.id });

    this.deps.logger.info('conversation marked read', {
      tenantId: scope.tenantId,
      senderId,
      recipientId,
      count: updated.length,
    });

    return { messagesMarkedRead: updated.length, markedAt: new Date() };
  }
}
