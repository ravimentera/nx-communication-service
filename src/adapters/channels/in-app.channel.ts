/**
 * In-app adapter. Ports the persistence path of
 * `services/notification/in-app-notification.ts` (585L).
 *
 * The source keeps notifications in an in-process Map and pushes them over a
 * WebSocket server it owns, so notifications vanish on restart and only reach
 * clients connected to the same replica. Here "send" means one INSERT into
 * `notifications` — durable, tenant-scoped, and readable by any replica. The
 * realtime fan-out is a separate concern and not part of the delivery plane.
 */
import type { Db } from '../../db/index.js';
import { notifications } from '../../db/schema.js';
import type {
  Channel,
  ChannelCapabilities,
  ChannelCredentials,
  ChannelType,
  ContactPoint,
  DeliveryResult,
  RenderedMessage,
  ValidationOutcome,
} from '../../ports/channel.js';
import { dryRunResult, failure, type ChannelDeps } from './base.js';

export interface InAppChannelDeps extends ChannelDeps {
  db: Db;
}

export class InAppChannel implements Channel {
  readonly type: ChannelType = 'in_app';
  readonly capabilities: ChannelCapabilities = {
    subject: true,
    html: false,
    attachments: false,
    supportsDeliveryReceipts: true, // read_at on the row
  };

  constructor(private readonly deps: InAppChannelDeps) {}

  validate(msg: RenderedMessage, to: ContactPoint): ValidationOutcome {
    if (!to.value) return { ok: false, reason: 'no recipient id' };
    if (!msg.body) return { ok: false, reason: 'in-app notification requires a body' };
    return { ok: true };
  }

  async send(
    msg: RenderedMessage,
    to: ContactPoint,
    creds: ChannelCredentials,
  ): Promise<DeliveryResult> {
    // Honour dry-run here too: it must not write rows either.
    if (this.deps.dryRun) return dryRunResult(this.deps.logger, this.type, to, msg, creds);

    try {
      const [row] = await this.deps.db
        .insert(notifications)
        .values({
          tenantId: creds.tenantId,
          channel: 'in_app',
          // `to.value` is a recipients.id when the contact point came from a
          // recipient; channelRef keeps the raw target either way.
          recipientId: msg.metadata?.recipientId as string | undefined,
          channelRef: to.value,
          content: msg.body,
          status: 'DELIVERED',
          sentAt: new Date(),
          deliveredAt: new Date(),
          metadata: {
            title: msg.subject,
            ...(msg.metadata ?? {}),
          },
        })
        .returning({ id: notifications.id });

      if (!row) {
        return failure({
          code: 'INSERT_RETURNED_NOTHING',
          message: 'notification insert returned no row',
          retryable: true,
        });
      }

      this.deps.logger.info('in-app notification created', {
        notificationId: row.id,
        tenantId: creds.tenantId,
      });
      return { success: true, dispatched: true, providerMessageId: row.id };
    } catch (error) {
      return failure({
        code: 'IN_APP_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        // A database blip is worth another attempt.
        retryable: true,
      });
    }
  }
}
