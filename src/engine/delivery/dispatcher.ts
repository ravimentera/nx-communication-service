/**
 * The single entry point for sending anything. Everything upstream — the v1 API
 * (P8), the playbook runtime (P7), campaigns (P11) — goes through `dispatch`.
 *
 * It resolves credentials, validates against the channel's declared
 * capabilities, writes the `messages` row, and enqueues. It does not send;
 * the worker does.
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { messages } from '../../db/schema.js';
import type { Priority } from '../../domain/index.js';
import type {
  ChannelRegistry,
  ChannelType,
  ContactPoint,
  RenderedMessage,
} from '../../ports/channel.js';
import type { CredentialResolver } from './credential-resolver.js';
import type { NotificationQueue } from './notification-queue.js';

export interface OutboundMessage {
  tenantId: string;
  subTenantId?: string;
  channel: ChannelType;
  to: ContactPoint;
  rendered: RenderedMessage;
  priority?: Priority;
  recipientId?: string;
  senderId?: string;
  playbookId?: string;
  templateId?: string;
  approvalId?: string;
  aiGenerated?: boolean;
  correlationId?: string;
}

export interface DispatchResult {
  queued: boolean;
  messageId?: string;
  jobId?: string;
  skipped?: string;
}

export interface DispatcherDeps {
  db: Db;
  registry: ChannelRegistry;
  credentials: CredentialResolver;
  queue: NotificationQueue;
  logger: Logger;
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  async dispatch(msg: OutboundMessage): Promise<DispatchResult> {
    const { registry, logger } = this.deps;
    const correlationId = msg.correlationId ?? randomUUID();
    const priority: Priority = msg.priority ?? 'MEDIUM';

    const channel = registry.get(msg.channel);

    // ─────────────────────────────────────────────────────────────────────────
    // COMPLIANCE GATE (P5)
    //
    // P5 inserts the preference/quiet-hours/consent check HERE, before anything
    // is written or queued, and returns `{ queued: false, skipped: <reason> }`
    // when it blocks. It must run after credential resolution has proven the
    // channel is usable but before the messages row exists, so a suppressed
    // message leaves an audit trail without ever looking sent.
    //
    // Do not move this hook downstream into the worker: by then the row says
    // QUEUED and a crash would leak a send.
    // ─────────────────────────────────────────────────────────────────────────

    const validation = channel.validate(msg.rendered, msg.to);
    if (!validation.ok) {
      logger.warn('message rejected by channel validation', {
        channel: msg.channel,
        reason: validation.reason,
        tenantId: msg.tenantId,
        correlationId,
      });
      return { queued: false, skipped: validation.reason };
    }

    // Fail fast and loudly when the tenant has no credentials, rather than
    // queueing something that can never succeed. Throws ChannelNotConfiguredError.
    await this.deps.credentials.resolve(msg.channel, {
      tenantId: msg.tenantId,
      senderId: msg.senderId,
    });

    const [row] = await this.deps.db
      .insert(messages)
      .values({
        tenantId: msg.tenantId,
        subTenantId: msg.subTenantId,
        recipientId: msg.recipientId,
        senderId: msg.senderId,
        channel: msg.channel,
        direction: 'outbound',
        content: msg.rendered.body,
        status: 'QUEUED',
        playbookId: msg.playbookId,
        templateId: msg.templateId,
        approvalId: msg.approvalId,
        aiGenerated: msg.aiGenerated ?? false,
        metadata: {
          correlationId,
          subject: msg.rendered.subject,
          to: msg.to.value,
        },
      })
      .returning({ id: messages.id });

    if (!row) {
      throw new Error('failed to persist message row');
    }

    const enqueued = await this.deps.queue.enqueue({
      messageId: row.id,
      tenantId: msg.tenantId,
      subTenantId: msg.subTenantId,
      channel: msg.channel,
      recipientId: msg.recipientId,
      senderId: msg.senderId,
      to: msg.to,
      rendered: msg.rendered,
      priority,
      playbookId: msg.playbookId,
      correlationId,
    });

    if (!enqueued.queued) {
      // The row stays QUEUED but nothing will pick it up. Say so plainly.
      logger.error('message persisted but not queued', {
        messageId: row.id,
        reason: enqueued.reason,
      });
      return { queued: false, messageId: row.id, skipped: enqueued.reason };
    }

    return { queued: true, messageId: row.id, jobId: enqueued.jobId };
  }
}
