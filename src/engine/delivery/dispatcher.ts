/**
 * The single entry point for sending anything. Everything upstream — the v1 API
 * (P8), the playbook runtime (P7), campaigns (P11) — goes through `dispatch`.
 *
 * It resolves credentials, validates against the channel's declared
 * capabilities, writes the `messages` row, and enqueues. It does not send;
 * the worker does.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { messages } from '../../db/schema.js';
import type { Priority } from '../../domain/index.js';
import { NotFoundError } from '../../platform/http/errors.js';
import type {
  ChannelRegistry,
  ChannelType,
  ContactPoint,
  RenderedMessage,
} from '../../ports/channel.js';
import type { ComplianceGate } from '../compliance/gate.js';
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
  /**
   * Adopt an existing `messages` row instead of inserting one (P6).
   *
   * An approved message already has a row — written at submit time with status
   * `PENDING_APPROVAL`, because `approvals.message_id` is NOT NULL and has to
   * point at something. Without this the same logical message would end up as
   * two rows, and every count, retention sweep and rate-limit window would
   * double-count it.
   */
  messageId?: string;
  playbookId?: string;
  /** Stable key, e.g. 'medspa.followup'. Drives per-playbook opt-out and cooldown. */
  playbookKey?: string;
  templateId?: string;
  approvalId?: string;
  aiGenerated?: boolean;
  correlationId?: string;
  /** A transactional message may bypass a global opt-out when URGENT. */
  transactional?: boolean;
  throttle?: { maxPerRecipientPerDay?: number; cooldownHours?: number };
  /**
   * Send later. Becomes a BullMQ job delay, so the wait survives a restart —
   * unlike the source's `scheduledFor`, which was a string nothing read.
   */
  sendAt?: Date;
  /**
   * How many times the deferral sweeper has already retried this message.
   * Set only by `DeferralSweeper`; a first dispatch leaves it undefined.
   */
  deferralAttempts?: number;
}

export interface DispatchResult {
  queued: boolean;
  messageId?: string;
  jobId?: string;
  skipped?: string;
  /** True when the caller should re-enqueue later rather than give up. */
  deferrable?: boolean;
  retryAt?: Date;
}

export interface DispatcherDeps {
  db: Db;
  registry: ChannelRegistry;
  credentials: CredentialResolver;
  queue: NotificationQueue;
  logger: Logger;
  /** Present from P5. Absent means no gate — used only in delivery-plane tests. */
  compliance?: ComplianceGate;
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  /**
   * One place that writes a `messages` row, whatever its fate.
   *
   * Inserts, unless `msg.messageId` names a row this message already owns — in
   * which case it updates that row in place (P6). The metadata is MERGED with
   * `||`, never replaced: the submit-time envelope, the playbook key and the
   * correlation id all live there and are needed after this write.
   */
  private async persist(
    msg: OutboundMessage,
    correlationId: string,
    options: {
      status: string;
      rendered?: RenderedMessage;
      suppressionReason?: string;
      extraMetadata?: Record<string, unknown>;
      /** Set when deferring; explicit null clears a previous deferral. */
      deferredUntil?: Date | null;
    },
  ): Promise<string> {
    const rendered = options.rendered ?? msg.rendered;
    const metadata = {
      correlationId,
      subject: rendered.subject,
      to: msg.to.value,
      ...(msg.playbookKey ? { playbookKey: msg.playbookKey } : {}),
      ...(options.extraMetadata ?? {}),
    };

    if (msg.messageId) {
      const [updated] = await this.deps.db
        .update(messages)
        .set({
          content: rendered.body,
          status: options.status,
          suppressionReason: options.suppressionReason,
          // undefined leaves it alone; null clears a deferral that has now been
          // released, so the row drops out of the sweeper's partial index.
          ...(options.deferredUntil !== undefined ? { deferredUntil: options.deferredUntil } : {}),
          approvalId: msg.approvalId,
          metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
          updatedAt: new Date(),
        })
        // Tenant predicate on every write, without exception (Rule 4).
        .where(and(eq(messages.tenantId, msg.tenantId), eq(messages.id, msg.messageId)))
        .returning({ id: messages.id });

      if (!updated) {
        throw new NotFoundError(`Message '${msg.messageId}' not found for this tenant`);
      }
      return updated.id;
    }

    const [row] = await this.deps.db
      .insert(messages)
      .values({
        tenantId: msg.tenantId,
        subTenantId: msg.subTenantId,
        recipientId: msg.recipientId,
        senderId: msg.senderId,
        channel: msg.channel,
        direction: 'outbound',
        content: rendered.body,
        status: options.status,
        suppressionReason: options.suppressionReason,
        ...(options.deferredUntil ? { deferredUntil: options.deferredUntil } : {}),
        playbookId: msg.playbookId,
        templateId: msg.templateId,
        approvalId: msg.approvalId,
        aiGenerated: msg.aiGenerated ?? false,
        metadata,
      })
      .returning({ id: messages.id });

    if (!row) throw new Error('failed to persist message row');
    return row.id;
  }

  async dispatch(msg: OutboundMessage): Promise<DispatchResult> {
    const { registry, logger } = this.deps;
    const correlationId = msg.correlationId ?? randomUUID();
    const priority: Priority = msg.priority ?? 'MEDIUM';

    const channel = registry.get(msg.channel);

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

    // ─────────────────────────────────────────────────────────────────────────
    // COMPLIANCE GATE (P5)
    //
    // Runs after credential resolution has proven the channel is usable, and
    // BEFORE the message row is written — so a suppressed message is recorded
    // as suppressed and never passes through a state that looks sent.
    //
    // Do not move this into the worker: by then the row says QUEUED, and a
    // crash between the two would leak a send the recipient opted out of.
    // ─────────────────────────────────────────────────────────────────────────
    let rendered = msg.rendered;
    let shadowed: string | undefined;

    if (this.deps.compliance) {
      const verdict = await this.deps.compliance.check({
        scope: { tenantId: msg.tenantId, subTenantId: msg.subTenantId },
        channel: msg.channel,
        priority,
        recipientId: msg.recipientId,
        playbookKey: msg.playbookKey,
        transactional: msg.transactional,
        throttle: msg.throttle,
        rendered: msg.rendered,
      });

      if (!verdict.allow) {
        // Recorded, not dropped. A SUPPRESSED row is the audit trail the source
        // never had — today a preference failure leaves no evidence at all.
        const suppressed = await this.persist(msg, correlationId, {
          status: 'SUPPRESSED',
          suppressionReason: verdict.reason,
          // The queryable copy of retryAt. A hard suppression has no retryAt
          // and leaves the column NULL, which is what keeps it out of the sweep.
          deferredUntil: verdict.deferrable ? (verdict.retryAt ?? null) : null,
          extraMetadata: {
            deferrable: verdict.deferrable,
            retryAt: verdict.retryAt,
            // A deferred message has to be re-sendable from its row alone,
            // hours later, in a different process. The row carries the body,
            // the channel and the recipient; everything else that `dispatch`
            // needs is only in this call's arguments, so it is written down
            // here. Only on the deferrable path — a hard suppression is never
            // retried and does not need the baggage.
            ...(verdict.deferrable
              ? {
                  deferral: {
                    attempts: (msg.deferralAttempts ?? 0) + 1,
                    firstDeferredAt:
                      msg.deferralAttempts ? undefined : new Date().toISOString(),
                    toType: msg.to.type,
                    ...(rendered.html ? { html: rendered.html } : {}),
                    priority,
                    ...(msg.playbookKey ? { playbookKey: msg.playbookKey } : {}),
                    ...(msg.transactional ? { transactional: true } : {}),
                    ...(msg.throttle ? { throttle: msg.throttle } : {}),
                  },
                }
              : {}),
          },
        });
        logger.info('message suppressed by compliance gate', {
          messageId: suppressed,
          reason: verdict.reason,
          deferrable: verdict.deferrable,
          correlationId,
        });
        return {
          queued: false,
          messageId: suppressed,
          skipped: verdict.reason,
          deferrable: verdict.deferrable,
          retryAt: verdict.retryAt,
        };
      }

      if (verdict.mutations) rendered = { ...rendered, ...verdict.mutations };
      shadowed = verdict.shadowed;
    }

    const messageId = await this.persist(msg, correlationId, {
      status: 'QUEUED',
      rendered,
      // Released: whether this is a first dispatch or the sweeper's retry, the
      // message is no longer waiting on a window.
      deferredUntil: null,
      extraMetadata: shadowed ? { shadowSuppressionReason: shadowed } : undefined,
    });

    const enqueued = await this.deps.queue.enqueue(
      {
        messageId,
        tenantId: msg.tenantId,
        subTenantId: msg.subTenantId,
        channel: msg.channel,
        recipientId: msg.recipientId,
        senderId: msg.senderId,
        to: msg.to,
        rendered,
        priority,
        playbookId: msg.playbookId,
        correlationId,
      },
      msg.sendAt ? { delayMs: Math.max(0, msg.sendAt.getTime() - Date.now()) } : undefined,
    );
    const row = { id: messageId };

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
