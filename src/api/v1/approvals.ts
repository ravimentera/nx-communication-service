/**
 * `/v1/approvals` and `/v1/approval-policies`.
 *
 * The source's two overlapping surfaces — `approvals.routes.ts` (9 endpoints)
 * and `ai-enhanced-communication.routes.ts` (3 more, in a different state
 * vocabulary) — collapse into this one. The legacy paths keep working through
 * the P8 compat shim; `ai-enhanced`'s duplicates are retired at P12, not before,
 * because the FE may still be calling them.
 *
 * ONE SHAPE CHANGE WORTH KNOWING ABOUT: the approver is no longer a path
 * parameter. The source routes every read as `/pending/:providerId` and then
 * checks `req.user.providerId === providerId` (`approvals.controller.ts:65–71`)
 * — a check it applies to the list and forgets on every mutation. Here the
 * approver comes off the resolved identity by default (§0.9: never read scope
 * from the path or the body), and `?approverRef=` is an explicit override that
 * only an admin or an `outreach:approve` holder can widen to someone else.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ApprovalService } from '../../engine/approvals/approval.service.js';
import type { PolicyService } from '../../engine/approvals/policy.service.js';
import { APPROVER_KINDS } from '../../engine/approvals/policy.service.js';
import type { Actor } from '../../engine/approvals/state-machine.js';
import { APPROVAL_STATUSES } from '../../engine/approvals/state-machine.js';
import {
  Permission,
  requirePermissions,
  requireTenant,
} from '../../platform/http/auth.middleware.js';
import { AuthError, ForbiddenError, NotFoundError } from '../../platform/http/errors.js';

const listQuerySchema = z.object({
  approverRef: z.string().optional(),
  status: z
    .union([z.enum(APPROVAL_STATUSES), z.array(z.enum(APPROVAL_STATUSES))])
    .optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  channel: z.string().optional(),
  playbook: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  sortBy: z.enum(['requestedAt', 'slaDeadline']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

const contentSchema = z.object({
  content: z.string().min(1, 'Content is required for an edit'),
  subject: z.string().optional(),
});

const declineSchema = z.object({ reason: z.string().max(2000).optional() });

const scheduleSchema = z.object({
  sendAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
});

const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(['approve', 'decline', 'cancel']),
  reason: z.string().max(2000).optional(),
});

const policySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(['always', 'threshold', 'sample', 'none']),
  confidenceThreshold: z.number().min(0).max(1).nullable().optional(),
  sampleRate: z.number().min(0).max(1).nullable().optional(),
  approverResolution: z
    .object({ kind: z.enum(APPROVER_KINDS) })
    .passthrough()
    .optional(),
  rights: z
    .object({
      approve: z.boolean().optional(),
      edit: z.boolean().optional(),
      decline: z.boolean().optional(),
      reschedule: z.boolean().optional(),
      bulk: z.boolean().optional(),
    })
    .optional(),
  sla: z
    .object({
      deadlineMs: z.number().int().positive().optional(),
      onExpiry: z.enum(['escalate', 'decline', 'approve']).optional(),
      fallbackApproverRef: z.string().optional(),
    })
    .optional(),
  packId: z.string().optional(),
});

export interface ApprovalApiDeps {
  approvals: ApprovalService;
  policies: PolicyService;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** The acting identity, carried into the service so authorization is per row. */
export function actorOf(req: Request): Actor {
  const identity = req.identity;
  if (!identity) throw new AuthError();
  return {
    type: 'user',
    ref: identity.userId,
    senderId: identity.senderId,
    role: identity.role,
    permissions: identity.permissions,
  };
}

/**
 * Whose inbox is being read.
 *
 * Defaults to the caller's own agent id. Asking for someone else's queue is
 * allowed only for an admin or an `outreach:approve` holder — the generalized
 * form of the source's provider check, applied here to reads and (in the
 * service) to every write as well.
 */
function approverRefFor(req: Request, requested: string | undefined): string | undefined {
  const identity = req.identity;
  if (!identity) throw new AuthError();

  if (!requested) return identity.senderId;
  if (requested === identity.senderId) return requested;

  const privileged =
    identity.role === 'admin' ||
    identity.permissions.includes(Permission.ADMIN) ||
    identity.permissions.includes(Permission.APPROVE);

  if (!privileged) {
    throw new ForbiddenError('Access denied: you can only view your own approvals');
  }
  return requested;
}

export function createApprovalRouter(deps: ApprovalApiDeps): Router {
  const router = Router();

  // ── approvals ─────────────────────────────────────────────────────────────

  router.get(
    '/approvals',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const query = listQuerySchema.parse(req.query);

      const page = await deps.approvals.list(scope, {
        approverRef: approverRefFor(req, query.approverRef),
        // No status filter means the inbox: what is waiting on someone.
        status: query.status ?? 'PENDING_APPROVAL',
        priority: query.priority,
        channel: query.channel,
        playbookKey: query.playbook,
        page: query.page,
        pageSize: query.pageSize,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      });

      res.json(page);
    }),
  );

  router.get(
    '/approvals/dashboard',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const query = listQuerySchema.parse(req.query);
      res.json(await deps.approvals.dashboard(scope, approverRefFor(req, query.approverRef)));
    }),
  );

  router.get(
    '/approvals/history',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const query = listQuerySchema.parse(req.query);

      res.json(
        await deps.approvals.history(scope, {
          approverRef: approverRefFor(req, query.approverRef),
          ...(query.status ? { status: query.status } : {}),
          priority: query.priority,
          channel: query.channel,
          playbookKey: query.playbook,
          page: query.page,
          pageSize: query.pageSize,
        }),
      );
    }),
  );

  // Declared AFTER /dashboard and /history so those words are not swallowed as ids.
  router.get(
    '/approvals/:id',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const approval = await deps.approvals.getById(scope, req.params.id as string);
      if (!approval) throw new NotFoundError(`Approval '${req.params.id}' not found`);
      res.json(approval);
    }),
  );

  router.post(
    '/approvals/bulk',
    requirePermissions(Permission.APPROVE_BULK),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = bulkSchema.parse(req.body);
      res.json(
        await deps.approvals.bulk(scope, body.ids, body.action, actorOf(req), body.reason),
      );
    }),
  );

  router.post(
    '/approvals/:id/approve',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const result = await deps.approvals.approve(scope, req.params.id as string, actorOf(req));
      // 200 either way — a repeated approve is a no-op, not an error. The source
      // returns 400 "Message is not pending approval" for the same double-click.
      res.json(result);
    }),
  );

  router.post(
    '/approvals/:id/edit-approve',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = contentSchema.parse(req.body);
      res.json(
        await deps.approvals.editThenApprove(
          scope,
          req.params.id as string,
          actorOf(req),
          body.content,
          body.subject,
        ),
      );
    }),
  );

  /** Save an edit without deciding — the row stays PENDING_APPROVAL. */
  router.put(
    '/approvals/:id/content',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = contentSchema.parse(req.body);
      res.json(
        await deps.approvals.edit(
          scope,
          req.params.id as string,
          actorOf(req),
          body.content,
          body.subject,
        ),
      );
    }),
  );

  router.post(
    '/approvals/:id/decline',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = declineSchema.parse(req.body);
      res.json(
        await deps.approvals.decline(scope, req.params.id as string, actorOf(req), body.reason),
      );
    }),
  );

  router.post(
    '/approvals/:id/schedule',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = scheduleSchema.parse(req.body);
      res.json(
        await deps.approvals.schedule(
          scope,
          req.params.id as string,
          actorOf(req),
          new Date(body.sendAt),
        ),
      );
    }),
  );

  router.post(
    '/approvals/:id/cancel',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = declineSchema.parse(req.body);
      res.json(
        await deps.approvals.cancel(scope, req.params.id as string, actorOf(req), body.reason),
      );
    }),
  );

  // ── policies ──────────────────────────────────────────────────────────────

  router.get(
    '/approval-policies',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json({ policies: await deps.policies.list(scope) });
    }),
  );

  router.post(
    '/approval-policies',
    requirePermissions(Permission.CONFIG_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = policySchema.parse(req.body);
      res.status(201).json(await deps.policies.create(scope, body));
    }),
  );

  router.put(
    '/approval-policies/:id',
    requirePermissions(Permission.CONFIG_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = policySchema.partial().parse(req.body);
      res.json(await deps.policies.update(scope, req.params.id as string, body));
    }),
  );

  return router;
}
