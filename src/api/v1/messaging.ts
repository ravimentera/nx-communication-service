/**
 * `/v1/messages`, `/v1/conversations` and `/v1/analytics/messages` — the read
 * side of the messaging plane, plus the one write that is not a send
 * (read state).
 *
 * `POST /v1/messages` is the single send entry point that replaces
 * `POST /email/send`, `POST /sms/send`, `POST /slack/message` and
 * `POST /communications/message`: one body with a `channel` discriminator,
 * dispatched through the same `Dispatcher` as everything else. `?sync=true`
 * bypasses the queue, which is what `/sms/send-direct` did.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { Dispatcher } from '../../engine/delivery/dispatcher.js';
import type { AnalyticsService } from '../../engine/messaging/analytics.service.js';
import type { ConversationService } from '../../engine/messaging/conversation.service.js';
import type { MessageService } from '../../engine/messaging/message.service.js';
import type { RecipientService } from '../../engine/recipients/recipient.service.js';
import { Permission, requirePermissions, requireTenant } from '../../platform/http/auth.middleware.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { CHANNEL_TYPES } from '../../ports/channel.js';

const sendSchema = z.object({
  channel: z.enum(CHANNEL_TYPES),
  to: z.object({ type: z.string().min(1), value: z.string().min(1) }),
  subject: z.string().optional(),
  body: z.string().min(1),
  html: z.string().optional(),
  recipientId: z.string().uuid().optional(),
  senderId: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  playbookKey: z.string().optional(),
  templateId: z.string().uuid().optional(),
  correlationId: z.string().optional(),
  transactional: z.boolean().optional(),
  sendAt: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const listSchema = z.object({
  channel: z.string().optional(),
  status: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  eventType: z.string().optional(),
  senderId: z.string().optional(),
  recipientId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
  sort: z.string().optional(),
});

export interface MessagingApiDeps {
  messages: MessageService;
  conversations: ConversationService;
  analytics: AnalyticsService;
  recipients: RecipientService;
  dispatcher: Dispatcher;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createMessagingRouter(deps: MessagingApiDeps): Router {
  const router = Router();

  // ── messages ──────────────────────────────────────────────────────────────

  router.get(
    '/messages',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const filters = listSchema.parse(req.query);
      res.json(await deps.messages.list(scope, filters));
    }),
  );

  router.post(
    '/messages',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = sendSchema.parse(req.body);

      const result = await deps.dispatcher.dispatch({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        channel: body.channel,
        to: body.to,
        rendered: { subject: body.subject, body: body.body, html: body.html },
        priority: body.priority,
        recipientId: body.recipientId,
        senderId: body.senderId,
        playbookKey: body.playbookKey,
        templateId: body.templateId,
        correlationId: body.correlationId,
        transactional: body.transactional,
        sendAt: body.sendAt,
      });

      // A suppressed message is a 200 with `queued: false` and a reason, not an
      // error: the caller asked correctly and the engine decided not to send.
      res.status(result.queued ? 202 : 200).json(result);
    }),
  );

  router.get(
    '/messages/:id',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const message = await deps.messages.getById(scope, req.params.id as string);
      if (!message) throw new NotFoundError(`Message '${req.params.id}' not found`);
      res.json(message);
    }),
  );

  router.put(
    '/messages/:id/read',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const isRead = req.body?.isRead === undefined ? true : Boolean(req.body.isRead);
      res.json(await deps.messages.markRead(scope, req.params.id as string, isRead));
    }),
  );

  // ── conversations ─────────────────────────────────────────────────────────

  /**
   * The inbox. `senderId` is a query parameter rather than a path segment
   * because a tenant with no per-agent concept still has an inbox; the legacy
   * path `/communications/provider/:providerId/inbox` bakes the opposite
   * assumption in.
   */
  router.get(
    '/conversations',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const senderId = (req.query.senderId as string) ?? req.identity?.senderId;
      if (!senderId) throw new ValidationError('senderId is required');

      const page = await deps.conversations.inbox(scope, senderId, {
        page: req.query.page ? Number(req.query.page) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        search: req.query.search as string | undefined,
      });

      res.json({
        data: page.conversations,
        pagination: {
          page: page.page,
          limit: page.limit,
          total: page.total,
          totalPages: page.totalPages,
          hasNext: page.page < page.totalPages,
          hasPrev: page.page > 1,
        },
        // Computed over the current page, matching the source (:1373-1375).
        // Totals over the whole result set would be more useful and would
        // change every number the FE renders.
        summary: {
          totalConversations: page.total,
          totalUnread: page.conversations.reduce((n, c) => n + c.messageStats.unreadCount, 0),
          adverseAlerts: page.conversations.filter((c) => c.alerts.hasAdverse).length,
          followupRequired: page.conversations.filter((c) => c.alerts.requiresFollowup).length,
        },
      });
    }),
  );

  router.get(
    '/conversations/:senderId/:recipientId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json(
        await deps.conversations.thread(
          scope,
          req.params.senderId as string,
          req.params.recipientId as string,
          {
            page: req.query.page ? Number(req.query.page) : undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
          },
        ),
      );
    }),
  );

  router.put(
    '/conversations/:senderId/:recipientId/read-all',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json(
        await deps.messages.markConversationRead(
          scope,
          req.params.senderId as string,
          req.params.recipientId as string,
        ),
      );
    }),
  );

  // ── analytics ─────────────────────────────────────────────────────────────

  router.get(
    '/analytics/messages',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json(
        await deps.analytics.summary(scope, {
          dateFrom: req.query.dateFrom as string | undefined,
          dateTo: req.query.dateTo as string | undefined,
        }),
      );
    }),
  );

  return router;
}
