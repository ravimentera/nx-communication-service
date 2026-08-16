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
import { ConflictError, NotFoundError } from '../../platform/http/errors.js';
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
  /**
   * True when the send failed for an **infrastructural** reason — the queue
   * would not take the job — rather than because anything decided it should not
   * go.
   *
   * The distinction is load-bearing for approvals. `ApprovalService.release()`
   * cancels an approval whose dispatch came back refused, which is right when
   * compliance said no or the channel rejected the content: those do not become
   * true later, and an approval left sitting approved-and-undelivered forever is
   * worse. A queue outage is the opposite — nothing decided anything, the
   * human's decision still stands, and cancelling it destroys a record of a
   * choice somebody actually made. See D105.
   */
  transient?: boolean;
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
        .where(
          and(
            // Tenant predicate on every write, without exception (Rule 4).
            eq(messages.tenantId, msg.tenantId),
            eq(messages.id, msg.messageId),
            // ─────────────────────────────────────────────────────────────────
            // A DELIVERED MESSAGE IS NOT A DRAFT AGAIN.
            //
            // This UPDATE named only (tenant, id), so any second dispatch of an
            // adopted row rewrote its status — including SENT back to QUEUED,
            // which is how the approve-then-schedule double-send stayed
            // invisible in the log: two sends, one row, reading QUEUED.
            //
            // The terminal states are the ones no further dispatch may
            // contradict: the message has left, or a person has been told it
            // never will. Everything before them is legitimately re-dispatched
            // — the deferral sweeper adopts a SUPPRESSED row on purpose, and an
            // approve retries a FAILED one (D105).
            // ─────────────────────────────────────────────────────────────────
            sql`${messages.status} NOT IN ('SENT', 'DELIVERED', 'CANCELLED')`,
          ),
        )
        .returning({ id: messages.id });

      if (!updated) {
        // Either the row is not this tenant's, or it has already been delivered
        // and nothing may move it. Distinguish the two, because the first is a
        // caller error and the second is a race this dispatch just lost.
        const [existing] = await this.deps.db
          .select({ status: messages.status })
          .from(messages)
          .where(and(eq(messages.tenantId, msg.tenantId), eq(messages.id, msg.messageId)))
          .limit(1);

        if (!existing) {
          throw new NotFoundError(`Message '${msg.messageId}' not found for this tenant`);
        }
        throw new ConflictError(
          `Message '${msg.messageId}' is ${existing.status} and cannot be dispatched again`,
          { status: existing.status },
        );
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
      // The row used to stay at QUEUED, which was a lie: nothing was going to
      // pick it up, and `QUEUED` is exactly the state that means something will.
      // A reader could not tell this row from one waiting its turn, and the
      // approvals plane could not tell this outcome from a compliance refusal —
      // so it cancelled the approval behind it (D105).
      //
      // FAILED is what actually happened: the send was attempted and did not
      // happen. `suppressionReason` is deliberately NOT set — that column means
      // "the compliance gate stopped this" and nothing stopped this.
      await this.persist(
        { ...msg, messageId },
        correlationId,
        {
          status: 'FAILED',
          rendered,
          extraMetadata: {
            dispatchFailure: { reason: enqueued.reason, at: new Date().toISOString() },
          },
        },
      );

      logger.error('message persisted but not queued', {
        messageId: row.id,
        reason: enqueued.reason,
      });
      return { queued: false, messageId: row.id, skipped: enqueued.reason, transient: true };
    }

    // Record the job id so the message can be recalled later (P12). BullMQ
    // generates it, so it cannot be derived: the obvious shortcut — passing
    // `jobId: messageId` — collides with the queue's own 24h completed-job
    // retention the moment the deferral sweeper retries the same message.
    //
    // A write per send, on a row that was inserted moments ago. Not free, but
    // the alternative is scanning the queue to find a job by payload, which is
    // O(depth) at exactly the moment somebody is cancelling a large campaign.
    //
    // The `- 'dispatchFailure'` is not incidental. That marker is what tells
    // `ApprovalService.approve()` to re-dispatch instead of reporting itself
    // idempotent (D105), so a stale one is a double-send waiting for the right
    // sequence: queue refuses, retry succeeds, the worker later marks the row
    // FAILED for a delivery reason, and a re-approval finds a FAILED row still
    // carrying the old marker. Cleared here, on the one path that proves the
    // queue took it. The update is unconditional for the same reason — a queue
    // that returns no job id still has to clear it.
    await this.deps.db
      .update(messages)
      .set({
        metadata: sql`(coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify(
          enqueued.jobId ? { jobId: enqueued.jobId } : {},
        )}::jsonb) - 'dispatchFailure'`,
      })
      .where(and(eq(messages.tenantId, msg.tenantId), eq(messages.id, messageId)));

    return { queued: true, messageId: row.id, jobId: enqueued.jobId };
  }
}
