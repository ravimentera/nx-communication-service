/**
 * What providers tell us after a send: delivery receipts and inbound replies.
 *
 * Neither exists in the source. `provider_message_id` was added in P2 and
 * populated in P3 (D22) precisely so a receipt has something to join against;
 * this is the first consumer. Before it, a message's status was whatever the
 * enqueue said and nothing ever corrected it — a bounced email and a delivered
 * one were both `SENT` forever.
 *
 * **The tenant comes from the data, not from the caller.** A provider callback
 * carries no gateway headers, so there is no scope to pass in. The provider's
 * own message id is globally unique within that provider, so the row it matches
 * *is* the tenant. That is safe in a way that trusting a body field would not
 * be: the caller cannot name a tenant, only a message id it was given.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { messageAnalytics, messages, recipients } from '../../db/schema.js';

/** What a provider is telling us happened. */
export type ReceiptEvent =
  | 'delivered'
  | 'failed'
  | 'bounced'
  | 'opened'
  | 'clicked'
  | 'unsubscribed'
  | 'spam'
  | 'deferred'
  | 'sent';

export interface Receipt {
  providerMessageId: string;
  event: ReceiptEvent;
  at: Date;
  /** Provider's own reason string, kept verbatim on the analytics row. */
  reason?: string;
  clickedLink?: string;
  raw?: Record<string, unknown>;
}

export interface InboundMessage {
  /** The address the recipient wrote from — phone number or email. */
  from: string;
  /** The address they wrote to: our number or our inbox. Identifies the tenant. */
  to: string;
  channel: string;
  content: string;
  at: Date;
  providerMessageId?: string;
  raw?: Record<string, unknown>;
}

export interface InboundResult {
  recorded: boolean;
  messageId?: string;
  tenantId?: string;
  recipientId?: string;
  reason?: string;
}

/**
 * Terminal states only. An `opened` does not move a message out of `SENT`, and
 * a late `delivered` after a `bounced` must not resurrect it.
 */
const STATUS_FOR: Partial<Record<ReceiptEvent, string>> = {
  delivered: 'DELIVERED',
  failed: 'FAILED',
  bounced: 'BOUNCED',
  spam: 'SPAM',
};

export class ReceiptService {
  constructor(private readonly deps: { db: Db; logger: Logger }) {}

  /**
   * Apply one receipt. Returns false when nothing matched — a provider replays
   * receipts for messages this deployment never sent, and that is normal
   * during a parallel run, not an error.
   */
  async apply(receipt: Receipt): Promise<{ applied: boolean; messageId?: string }> {
    const [row] = await this.deps.db
      .select({
        id: messages.id,
        tenantId: messages.tenantId,
        subTenantId: messages.subTenantId,
        recipientId: messages.recipientId,
        status: messages.status,
      })
      .from(messages)
      .where(eq(messages.providerMessageId, receipt.providerMessageId))
      .limit(1);

    if (!row) {
      this.deps.logger.debug('receipt for an unknown message', {
        providerMessageId: receipt.providerMessageId,
        event: receipt.event,
      });
      return { applied: false };
    }

    const status = STATUS_FOR[receipt.event];
    if (status) {
      await this.deps.db
        .update(messages)
        .set({
          status,
          ...(receipt.event === 'delivered' ? { deliveredAt: receipt.at } : {}),
          // Merge, never replace — `metadata.playbookKey` lives here and the
          // compliance gate's cooldown reads it back (D49).
          metadata: sql`COALESCE(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({
            lastReceipt: receipt.event,
            lastReceiptAt: receipt.at.toISOString(),
            ...(receipt.reason ? { receiptReason: receipt.reason } : {}),
          })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(messages.tenantId, row.tenantId), eq(messages.id, row.id)));
    }

    // Engagement lives on message_analytics, not on the message: a message has
    // one status and any number of opens.
    const engagement: Record<string, unknown> = {};
    if (receipt.event === 'opened') engagement.openedAt = receipt.at;
    if (receipt.event === 'clicked') {
      engagement.clickedAt = receipt.at;
      if (receipt.clickedLink) engagement.clickedLink = receipt.clickedLink;
    }

    if (Object.keys(engagement).length > 0 || receipt.reason) {
      await this.upsertAnalytics(
        {
          tenantId: row.tenantId,
          subTenantId: row.subTenantId,
          messageId: row.id,
          recipientId: row.recipientId,
        },
        {
          ...engagement,
          metadata: {
            lastEvent: receipt.event,
            ...(receipt.reason ? { reason: receipt.reason } : {}),
          },
        },
      );
    }

    // A bounce or a spam report is a statement about the address, and the
    // compliance gate refuses to send to a bounced recipient. Recording it here
    // is what stops the next message repeating the mistake.
    if ((receipt.event === 'bounced' || receipt.event === 'spam') && row.recipientId) {
      await this.deps.db
        .update(recipients)
        .set({ status: 'bounced', updatedAt: new Date() })
        .where(and(eq(recipients.tenantId, row.tenantId), eq(recipients.id, row.recipientId)));
    }

    this.deps.logger.info('receipt applied', {
      messageId: row.id,
      tenantId: row.tenantId,
      event: receipt.event,
    });
    return { applied: true, messageId: row.id };
  }

  /**
   * Record an inbound reply.
   *
   * The tenant is resolved from the address the message was sent **to** — our
   * number, which belongs to exactly one tenant or agent. Resolving it from the
   * sender instead would be ambiguous the moment two tenants have the same
   * patient, which is the normal case for a chain.
   */
  async recordInbound(inbound: InboundMessage): Promise<InboundResult> {
    const owner = await this.resolveDestination(inbound.to);
    if (!owner) {
      // Not an error: a number can be reassigned, and a stray callback for a
      // number we no longer own should be dropped quietly rather than 500.
      this.deps.logger.warn('inbound message for an unrecognised destination', {
        to: inbound.to,
        channel: inbound.channel,
      });
      return { recorded: false, reason: 'unknown destination' };
    }

    const recipient = await this.resolveSender(owner.tenantId, inbound.from);

    return this.recordInboundFor({
      tenantId: owner.tenantId,
      senderId: owner.senderId,
      recipientId: recipient?.id,
      senderName: recipient?.displayName ?? undefined,
      channel: inbound.channel,
      content: inbound.content,
      at: inbound.at,
      from: inbound.from,
      to: inbound.to,
      providerMessageId: inbound.providerMessageId,
    });
  }

  /**
   * Record an inbound message whose tenant and recipient are already known.
   *
   * The authenticated legacy `/messages/webhook/*` path uses this: it arrives
   * with a resolved `patientId` and gateway headers, so none of the address
   * matching above applies. `recordInbound` is the same write after it has
   * worked out who the parties are.
   */
  async recordInboundFor(input: {
    tenantId: string;
    subTenantId?: string;
    recipientId?: string;
    senderId?: string;
    senderName?: string;
    channel: string;
    content: string;
    at: Date;
    from?: string;
    to?: string;
    providerMessageId?: string;
  }): Promise<InboundResult> {
    const [inserted] = await this.deps.db
      .insert(messages)
      .values({
        tenantId: input.tenantId,
        subTenantId: input.subTenantId ?? null,
        senderId: input.senderId ?? null,
        recipientId: input.recipientId ?? null,
        channel: input.channel.toUpperCase(),
        direction: 'inbound',
        content: input.content,
        status: 'RECEIVED',
        sentAt: input.at,
        providerMessageId: input.providerMessageId ?? null,
        senderName: input.senderName ?? null,
        participantPhone: input.channel.toLowerCase() === 'sms' ? (input.from ?? null) : null,
        metadata: { messageType: 'REPLY', from: input.from, to: input.to },
      })
      .returning({ id: messages.id });

    // Mark the most recent outbound message in this conversation replied-to, so
    // engagement reporting can tell a reply from silence.
    if (input.recipientId) {
      const [original] = await this.deps.db
        .select({ id: messages.id, subTenantId: messages.subTenantId })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, input.tenantId),
            eq(messages.recipientId, input.recipientId),
            eq(messages.direction, 'outbound'),
          ),
        )
        .orderBy(desc(messages.sentAt))
        .limit(1);

      if (original) {
        await this.upsertAnalytics(
          {
            tenantId: input.tenantId,
            subTenantId: original.subTenantId,
            messageId: original.id,
            recipientId: input.recipientId,
          },
          { repliedAt: input.at, replyContent: input.content.slice(0, 2000) },
        );
      }
    }

    this.deps.logger.info('inbound message recorded', {
      messageId: inserted!.id,
      tenantId: input.tenantId,
      channel: input.channel,
      resolved: Boolean(input.recipientId),
    });

    return {
      recorded: true,
      messageId: inserted!.id,
      tenantId: input.tenantId,
      recipientId: input.recipientId,
    };
  }

  /**
   * One analytics row per message, updated in place.
   *
   * **This must never plain-INSERT.** `message_analytics` is LEFT JOINed by
   * `MessageService.list`, `.getById` and `ConversationService.thread`, so a
   * second row for the same message makes that message appear twice in a list
   * while `total` still counts it once — `data.length !== total`, and the
   * legacy pagination envelope the FE reads stops being coherent.
   *
   * The first version used `onConflictDoNothing()` with no target, which does
   * nothing at all without a unique constraint to conflict on. `0008` adds the
   * partial unique index this targets.
   *
   * **First event wins** on each timestamp: `opened_at` is when it was *first*
   * opened, which is the number "time to open" needs. A provider sends one
   * callback per open, so last-write-wins would quietly turn that into "most
   * recently opened".
   */
  private async upsertAnalytics(
    key: {
      tenantId: string;
      subTenantId: string | null;
      messageId: string;
      recipientId: string | null | undefined;
    },
    fields: {
      openedAt?: Date;
      clickedAt?: Date;
      clickedLink?: string;
      repliedAt?: Date;
      replyContent?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.deps.db
      .insert(messageAnalytics)
      .values({
        tenantId: key.tenantId,
        subTenantId: key.subTenantId,
        messageId: key.messageId,
        recipientId: key.recipientId ?? null,
        ...fields,
      })
      .onConflictDoUpdate({
        target: messageAnalytics.messageId,
        // The index is partial, so the conflict target has to name its predicate.
        targetWhere: sql`${messageAnalytics.messageId} IS NOT NULL`,
        set: {
          openedAt: sql`COALESCE(${messageAnalytics.openedAt}, excluded.opened_at)`,
          clickedAt: sql`COALESCE(${messageAnalytics.clickedAt}, excluded.clicked_at)`,
          clickedLink: sql`COALESCE(${messageAnalytics.clickedLink}, excluded.clicked_link)`,
          repliedAt: sql`COALESCE(${messageAnalytics.repliedAt}, excluded.replied_at)`,
          replyContent: sql`COALESCE(${messageAnalytics.replyContent}, excluded.reply_content)`,
          // Merged, not replaced — the same mistake as D49, in a second place.
          metadata: sql`COALESCE(${messageAnalytics.metadata}, '{}'::jsonb) || COALESCE(excluded.metadata, '{}'::jsonb)`,
          updatedAt: sql`now()`,
        },
      });
  }

  /** Which tenant (and possibly which agent) owns the address that was written to. */
  private async resolveDestination(
    to: string,
  ): Promise<{ tenantId: string; senderId?: string } | null> {
    const result = await this.deps.db.execute(sql`
      SELECT tenant_id AS "tenantId", sender_id AS "senderId"
      FROM agent_channel_configs
      WHERE twilio_phone_number = ${to} OR email_from_address = ${to}
      UNION ALL
      SELECT tenant_id AS "tenantId", NULL AS "senderId"
      FROM tenant_channel_configs
      WHERE twilio_phone_number = ${to} OR sendgrid_from_email = ${to}
      LIMIT 1
    `);
    const row = result.rows[0] as { tenantId?: string; senderId?: string } | undefined;
    return row?.tenantId ? { tenantId: row.tenantId, senderId: row.senderId ?? undefined } : null;
  }

  /** Which recipient of that tenant holds the address it came from. */
  private async resolveSender(
    tenantId: string,
    from: string,
  ): Promise<{ id: string; displayName: string | null } | null> {
    const result = await this.deps.db.execute(sql`
      SELECT id, display_name AS "displayName"
      FROM recipients
      WHERE tenant_id = ${tenantId}
        AND contact_points @> ${JSON.stringify([{ value: from }])}::jsonb
      LIMIT 1
    `);
    const row = result.rows[0] as { id?: string; displayName?: string | null } | undefined;
    return row?.id ? { id: row.id, displayName: row.displayName ?? null } : null;
  }
}
