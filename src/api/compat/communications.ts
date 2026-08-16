// DELETE IN P12
/**
 * `/communications` — sixteen endpoints, the FE's main surface.
 *
 * Envelope quirks that are preserved because the FE reads them:
 *
 *  - `/medspa/:medspaId` returns `{success, data:[…], pagination}`.
 *  - `/provider/:providerId` returns `{success, data:{data:[…], pagination}}` —
 *    **double-nested**. The controller `return`s its response object instead of
 *    writing it (`communications.controller.ts:322-326` has the `res.json` call
 *    commented out) and the route wraps whatever comes back
 *    (`communications.routes.ts:113-116`). Two sibling endpoints, two shapes.
 *  - the inbox's `latestMessage.content` is truncated to 100 characters with a
 *    trailing `...` (`:1327`).
 *
 * Four of the sixteen needed the content plane and landed in P8b:
 * `/response` records an inbound reply, `/generate-message` drafts one through
 * the same path `/ai-enhanced` takes, `/patient/:id/conversation/summary`
 * returns counted facts rather than model prose, and `/patient/:id/info` reads
 * through the pack-gated context registry instead of `SELECT … FROM patients`.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';

import type { MessagingApiDeps } from '../v1/messaging.js';
import { Permission, requirePermissions, requireTenant } from '../../platform/http/auth.middleware.js';
import type { ReceiptService } from '../../engine/messaging/receipt.service.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { deprecate } from './index.js';
import {
  fromLegacyChannel,
  legacyPagination,
  toLegacyChannel,
  toLegacyDirection,
} from './translate.js';
import type { CompatIdentity } from './translate.js';

export interface CommunicationsCompatDeps extends MessagingApiDeps {
  identity: CompatIdentity;
  receipts: ReceiptService;
  /** Shared with `/ai-enhanced` — one drafting path, two URLs. */
  draft: (
    req: Request,
    input: {
      patientId: string;
      providerId?: string;
      channel: string;
      communicationType?: string;
      context?: Record<string, unknown>;
      priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
    },
  ) => Promise<{ approvalId?: string; messageId?: string; content: string; subject?: string; status: string }>;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** `:1327` — a 100-character preview, ellipsised. */
function preview(content: string): string {
  return content.length > 100 ? `${content.slice(0, 100)}...` : content;
}

export function createLegacyCommunicationsRouter(deps: CommunicationsCompatDeps): Router {
  const router = Router();
  router.use(deprecate('/communications', '/v1/messages'));

  router.get(
    '/provider/:providerId/inbox',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const senderId = req.params.providerId as string;
      const page = await deps.conversations.inbox(scope, senderId, {
        page: req.query.page ? Number(req.query.page) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        search: req.query.search as string | undefined,
      });

      const patientIds = await deps.identity.patientIds(
        scope,
        page.conversations.map((c) => c.recipientId),
      );

      const data = page.conversations.map((c) => {
        const name = c.displayName ?? 'Unknown Patient';
        return {
          patientId: c.recipientId ? (patientIds.get(c.recipientId) ?? null) : null,
          patientName: name,
          // Two name fields, both present in the source (:1323-1324): one
          // resolved from `patients`, one from message metadata. `recipients`
          // is now the single source, so they agree — kept so a consumer
          // reading either keeps working.
          patientNameDefault: name,
          latestMessage: c.latestMessage
            ? {
                id: c.latestMessage.id,
                content: preview(c.latestMessage.content),
                sentAt: c.latestMessage.sentAt,
                channel: toLegacyChannel(c.latestMessage.channel),
                status: c.latestMessage.status,
                direction: toLegacyDirection(c.latestMessage.direction),
                messageType: c.latestMessage.messageType,
                isAiGenerated: c.latestMessage.isAiGenerated,
                sender: c.latestMessage.direction === 'inbound' ? 'patient' : 'provider',
              }
            : null,
          messageStats: c.messageStats,
          hasUnread: c.hasUnread,
          alerts: c.alerts,
        };
      });

      res.json({
        success: true,
        data,
        pagination: legacyPagination(page.page, page.limit, page.total),
        summary: {
          totalConversations: page.total,
          totalUnread: data.reduce((n, c) => n + c.messageStats.unreadCount, 0),
          adverseAlerts: data.filter((c) => c.alerts.hasAdverse).length,
          followupRequired: data.filter((c) => c.alerts.requiresFollowup).length,
        },
      });
    }),
  );

  router.get(
    '/conversation/:providerId/:patientId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipientId = await deps.identity.lookup(scope, req.params.patientId as string);
      if (!recipientId) throw new NotFoundError('Patient not found');

      const data = await thread(
        scope,
        req.params.providerId as string,
        recipientId,
        req.query.page ? Number(req.query.page) : undefined,
        req.query.limit ? Number(req.query.limit) : undefined,
      );
      res.json({ success: true, data, pagination: data.pagination });
    }),
  );

  async function thread(
    scope: { tenantId: string },
    senderId: string,
    recipientId: string,
    page?: number,
    limit?: number,
  ) {
    const t = await deps.conversations.thread(scope, senderId, recipientId, { page, limit });
    const patientIds = await deps.identity.patientIds(scope, [recipientId]);
    const patientName = t.displayName ?? 'Unknown Patient';

    return {
      providerId: senderId,
      patientId: patientIds.get(recipientId) ?? recipientId,
      patientName,
      messages: t.messages.map((m) => ({
        id: m.id,
        content: m.content,
        channel: toLegacyChannel(m.channel),
        status: m.status,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt,
        readAt: m.readAt,
        direction: toLegacyDirection(m.direction),
        messageType:
          ((m.metadata as { messageType?: string } | null)?.messageType) ?? 'GENERAL',
        isAiGenerated: m.aiGenerated,
        sender: m.direction === 'inbound' ? 'patient' : 'provider',
        senderName: m.direction === 'inbound' ? patientName : 'Provider',
        createdAt: m.createdAt,
        isRead: Boolean(m.readAt),
        analytics: {
          engagementScore: m.engagementScore,
          openedAt: m.openedAt,
          clickedAt: m.clickedAt,
          repliedAt: m.repliedAt,
        },
        // ── the four fields `messages.queued_message` used to feed ──────────
        //
        // The column is dropped in P12 (D103, migration 0014). It was the
        // source's approval blob, this engine never wrote it, and every message
        // the new service creates has answered `null` here since P9 — so these
        // four have been constant for every non-migrated row for three phases.
        //
        // **The key stays, at null.** The web app reads
        // `message.queuedMessage.content` (`inbox.utils.ts:301`) and the mobile
        // app reads it too (`ApprovalsScreen.tsx:133`); both guard on the object
        // being present, so `null` is a path they already take and removing the
        // key is not. The migrated rows that did carry a value were all
        // cancelled by `mig.finalize_cutover()` (D99), so nothing renderable is
        // lost with it.
        //
        // Approval state for a live draft comes from `/approvals/*`, which reads
        // the `approvals` table — the same one both legacy inboxes have shared
        // since P6 (D46).
        queuedMessage: null,
        timestamp: m.sentAt,
        avatar: m.direction === 'inbound' ? null : 'provider-avatar.png',
        messageClass: m.direction === 'inbound' ? 'message-received' : 'message-sent',
        isPendingApproval: false,
        isApproved: false,
        isDeclined: false,
      })),
      summary: { ...t.summary, conversationStarted: t.summary.firstMessage },
      pagination: legacyPagination(t.page, t.limit, t.total),
    };
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /** `/message` and `/create-communication` are the same handler. */
  const createMessage = requirePermissions(Permission.SEND);
  const sendHandler = handle(async (req: Request, res: Response) => {
      const scope = requireTenant(req);
      const { patientId, providerId, channel, content, subject, priority, to } = req.body ?? {};
      if (!content) throw new ValidationError('content is required');
      if (!channel) throw new ValidationError('channel is required');

      const recipientId = patientId ? await deps.identity.ensure(scope, patientId) : undefined;
      const address =
        to ??
        (recipientId
          ? await primaryContactPoint(scope, recipientId, fromLegacyChannel(channel))
          : undefined);
      if (!address) throw new ValidationError('No contact point for this recipient and channel');

      const result = await deps.dispatcher.dispatch({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        channel: fromLegacyChannel(channel) as Parameters<
          MessagingApiDeps['dispatcher']['dispatch']
        >[0]['channel'],
        to: { type: fromLegacyChannel(channel), value: address },
        rendered: { subject, body: content },
        recipientId,
        senderId: providerId ?? req.identity?.senderId,
        priority: priority ?? 'MEDIUM',
      });

      res.status(201).json({ success: true, data: result });
  });

  router.post('/message', createMessage, sendHandler);
  router.post('/create-communication', createMessage, sendHandler);

  router.put(
    '/conversation/:providerId/:patientId/read-all',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipientId = await deps.identity.lookup(scope, req.params.patientId as string);
      if (!recipientId) throw new NotFoundError('Patient not found');

      const result = await deps.messages.markConversationRead(
        scope,
        req.params.providerId as string,
        recipientId,
      );
      res.json({
        success: true,
        message: 'Conversation marked as read',
        data: {
          providerId: req.params.providerId,
          patientId: req.params.patientId,
          ...result,
        },
      });
    }),
  );

  // ── the four that waited for the content plane ────────────────────────────

  /** Draft a message for a recipient. The same path `/ai-enhanced` takes. */
  router.post(
    '/generate-message',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const draft = await deps.draft(req, {
        patientId: (req.body?.patientId as string) ?? '',
        providerId: req.body?.providerId as string | undefined,
        channel: (req.body?.channel as string) ?? 'EMAIL',
        communicationType: req.body?.messageType as string | undefined,
        context: (req.body?.context ?? {}) as Record<string, unknown>,
        priority: 'MEDIUM',
      });
      res.status(201).json({ success: true, data: draft });
    }),
  );

  async function primaryContactPoint(
    scope: { tenantId: string },
    recipientId: string,
    channel: string,
  ): Promise<string | undefined> {
    const recipient = await deps.recipients.getById(scope, recipientId);
    const points = (recipient?.contactPoints ?? []) as Array<{
      type: string;
      value: string;
      primary?: boolean;
    }>;
    const wanted = channel === 'sms' ? 'phone' : channel;
    const match = points.find((p) => p.type === wanted && p.primary) ?? points.find((p) => p.type === wanted);
    return match?.value;
  }

  return router;
}
