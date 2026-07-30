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
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { deprecate } from './index.js';
import {
  fromLegacyChannel,
  legacyPagination,
  toLegacyChannel,
  toLegacyDirection,
  toLegacyMessage,
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

/** The path's medspa id must be the caller's tenant. */
function assertPathTenant(req: Request, pathTenantId: string | undefined): { tenantId: string } {
  const scope = requireTenant(req);
  if (pathTenantId && pathTenantId !== scope.tenantId) {
    throw new ForbiddenError(
      'Access denied: You can only access communications for your own medspa',
    );
  }
  return scope;
}

/** `:1327` — a 100-character preview, ellipsised. */
function preview(content: string): string {
  return content.length > 100 ? `${content.slice(0, 100)}...` : content;
}

export function createLegacyCommunicationsRouter(deps: CommunicationsCompatDeps): Router {
  const router = Router();
  router.use(deprecate('/communications', '/v1/messages'));

  function filtersFrom(req: Request) {
    return {
      channel: req.query.channel ? fromLegacyChannel(req.query.channel as string) : undefined,
      status: req.query.status as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
      eventType: req.query.eventType as string | undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Math.min(Number(req.query.limit), 200) : 50,
      sort: (req.query.sort as string | undefined) ?? 'sentAt:desc',
    };
  }

  async function legacyPage(
    scope: { tenantId: string },
    page: Awaited<ReturnType<MessagingApiDeps['messages']['list']>>,
  ) {
    const patientIds = await deps.identity.patientIds(
      scope,
      page.data.map((m) => m.recipientId),
    );
    return {
      data: page.data.map((m) => toLegacyMessage(m, patientIds)),
      pagination: legacyPagination(page.page, page.limit, page.total),
    };
  }

  // ── lists ─────────────────────────────────────────────────────────────────

  router.get(
    '/medspa/:medspaId',
    handle(async (req, res) => {
      const scope = assertPathTenant(req, req.params.medspaId);
      const page = await deps.messages.list(scope, filtersFrom(req));
      res.json({ success: true, ...(await legacyPage(scope, page)) });
    }),
  );

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

  // Declared after `/provider/:providerId/inbox`, which is a longer path and
  // would otherwise never match.
  router.get(
    '/provider/:providerId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const page = await deps.messages.list(scope, {
        ...filtersFrom(req),
        senderId: req.params.providerId as string,
        // `:242` hides AI drafts from this list.
        excludeAiGenerated: true,
      });
      // Double-nested, deliberately — see the file header.
      res.status(200).json({ success: true, data: await legacyPage(scope, page) });
    }),
  );

  router.get(
    '/patient/:patientId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipientId = await deps.identity.lookup(scope, req.params.patientId as string);
      if (!recipientId) {
        res.json({ success: true, data: [], pagination: legacyPagination(1, 50, 0) });
        return;
      }
      const page = await deps.messages.list(scope, { ...filtersFrom(req), recipientId });
      res.json({ success: true, ...(await legacyPage(scope, page)) });
    }),
  );

  router.get(
    '/patient/:patientId/conversation',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const senderId = (req.query.providerId as string) ?? req.identity?.senderId;
      if (!senderId) throw new ValidationError('providerId is required');

      const recipientId = await deps.identity.lookup(scope, req.params.patientId as string);
      if (!recipientId) throw new NotFoundError('Patient not found');
      res.json({ success: true, data: await thread(scope, senderId, recipientId) });
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
        queuedMessage: m.queuedMessage
          ? { ...m.queuedMessage, isQueue: m.status === 'QUEUED' }
          : null,
        timestamp: m.sentAt,
        avatar: m.direction === 'inbound' ? null : 'provider-avatar.png',
        messageClass: m.direction === 'inbound' ? 'message-received' : 'message-sent',
        isPendingApproval:
          (m.queuedMessage as { approvalStatus?: string } | null)?.approvalStatus ===
          'PENDING_APPROVAL',
        isApproved:
          (m.queuedMessage as { approvalStatus?: string } | null)?.approvalStatus === 'APPROVED',
        isDeclined:
          (m.queuedMessage as { approvalStatus?: string } | null)?.approvalStatus === 'DECLINED',
      })),
      summary: { ...t.summary, conversationStarted: t.summary.firstMessage },
      pagination: legacyPagination(t.page, t.limit, t.total),
    };
  }

  router.get(
    '/analytics/medspa/:medspaId',
    handle(async (req, res) => {
      const scope = assertPathTenant(req, req.params.medspaId);
      res.json({
        success: true,
        data: await deps.analytics.summary(scope, {
          // Optional again — the source 500s when both are omitted (D63).
          dateFrom: req.query.dateFrom as string | undefined,
          dateTo: req.query.dateTo as string | undefined,
        }),
      });
    }),
  );

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
    '/:messageId/read',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const isRead = req.body?.isRead === undefined ? true : Boolean(req.body.isRead);
      const result = await deps.messages.markRead(
        scope,
        req.params.messageId as string,
        isRead,
      );
      res.json({
        success: true,
        message: `Message marked as ${isRead ? 'read' : 'unread'}`,
        data: result,
      });
    }),
  );

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

  /**
   * Record an inbound reply. Same shape as `/messages/webhook/*`, reached from
   * the FE rather than from an integration.
   */
  router.post(
    '/response',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const { patientId, providerId, content, channel } = (req.body ?? {}) as Record<
        string,
        string | undefined
      >;
      if (!patientId || !content) throw new ValidationError('patientId and content are required');

      const recipientId = await deps.identity.ensure(scope, patientId);
      const result = await deps.receipts.recordInboundFor({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        recipientId,
        senderId: providerId ?? req.identity?.senderId,
        channel: channel ?? 'EMAIL',
        content,
        at: new Date(),
      });
      res.status(201).json({ success: true, data: { id: result.messageId, patientId } });
    }),
  );

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

  /**
   * The conversation roll-up. The source asks a model to summarise the thread
   * (`getConversationSummary`, :1922-2175, including a `analyzeSentiment` call);
   * this returns the counted facts and leaves the prose to
   * `POST /v1/content/generate` with the thread as context. A summary that is
   * generated on every page load costs a model call per render and cannot be
   * cited — the numbers can.
   */
  router.get(
    '/patient/:patientId/conversation/summary',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const senderId = (req.query.providerId as string) ?? req.identity?.senderId;
      if (!senderId) throw new ValidationError('providerId is required');

      const recipientId = await deps.identity.lookup(scope, req.params.patientId as string);
      if (!recipientId) throw new NotFoundError('Patient not found');

      const thread = await deps.conversations.thread(scope, senderId, recipientId, { limit: 1 });
      res.json({
        success: true,
        data: {
          patientId: req.params.patientId,
          providerId: senderId,
          patientName: thread.displayName ?? 'Unknown Patient',
          summary: { ...thread.summary, conversationStarted: thread.summary.firstMessage },
        },
      });
    }),
  );

  router.get(
    '/patient/:patientId/info',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      // Read-through the pack-gated context registry, replacing the raw
      // `SELECT ... FROM patients` at :1669 (Seam C).
      const recipient = await deps.recipients.getOrResolve(scope, {
        kind: 'mentera-patient',
        id: req.params.patientId as string,
      });
      if (!recipient) throw new NotFoundError('Patient not found');

      res.json({
        success: true,
        data: {
          patientId: req.params.patientId,
          patientName: recipient.displayName ?? 'Unknown Patient',
          firstName: recipient.firstName,
          lastName: recipient.lastName,
          timezone: recipient.timezone,
          locale: recipient.locale,
          contactPoints: recipient.contactPoints,
          status: recipient.status,
        },
      });
    }),
  );

  // Declared last: `/:id` would otherwise swallow every path above it.
  router.get(
    '/:id',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const message = await deps.messages.getById(scope, req.params.id as string);
      if (!message) throw new NotFoundError('Communication not found');
      const patientIds = await deps.identity.patientIds(scope, [message.recipientId]);
      res.json({ success: true, data: toLegacyMessage(message, patientIds) });
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
