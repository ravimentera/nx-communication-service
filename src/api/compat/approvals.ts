// DELETE IN P12
/**
 * `/approvals` — nine FE-critical endpoints.
 *
 * The path parameter is a **message** id, not an approval id: the source had no
 * approvals table, so a message id was the only handle a client could hold
 * (D46). Every mutation here resolves message → approval first. The FE keeps
 * passing the id it already has.
 *
 * Three behaviours change, all of them tightenings recorded in D45:
 *
 *  - Every lookup is tenant-scoped. The source's six mutation sites resolve
 *    their row with a bare `eq(messageHistory.id, messageId)`, so a user
 *    authenticated to one tenant can approve another tenant's message given its
 *    UUID — and approval is where clinical content is released.
 *  - `authorize()` runs per row on every action, not only on the pending list.
 *    A provider can no longer approve out of another provider's queue.
 *  - Bulk requires the `outreach:approve:bulk` permission **and** the policy's
 *    `bulk` right (D51). The source's `/bulk-action` has neither, no tenant
 *    predicate, and no `PENDING_APPROVAL` guard on the rows it updates.
 *
 * And one that is not a tightening: **approving now sends** (D44). Today it
 * writes two status columns nothing reads back.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { actorOf, type ApprovalApiDeps } from '../v1/approvals.js';
import { Permission, requireTenant } from '../../platform/http/auth.middleware.js';
import { ForbiddenError, NotFoundError } from '../../platform/http/errors.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { deprecate } from './index.js';

const contentSchema = z.object({
  content: z.string().min(1),
  subject: z.string().optional(),
  editedContent: z.string().optional(),
});

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * The source lets any authenticated caller act on any provider's queue; only
 * `getPendingApprovals` compares `req.user.providerId` to the path
 * (`approvals.controller.ts:66-73`). Applying that comparison to *every* path
 * is the point of D45, so it lives here rather than being left to the service.
 */
function assertOwnQueue(req: Request, pathProviderId: string): void {
  const senderId = req.identity?.senderId;
  const isAdmin = req.identity?.permissions?.includes(Permission.ADMIN);
  if (!isAdmin && senderId && senderId !== pathProviderId) {
    throw new ForbiddenError('Access denied: you can only access your own approval queue');
  }
}

export function createLegacyApprovalRouter(deps: ApprovalApiDeps): Router {
  const router = Router();
  router.use(deprecate('/approvals', '/v1/approvals'));

  /** message id in, approval id out. 404 when this tenant owns neither. */
  async function approvalIdFor(scope: TenantScope, messageId: string): Promise<string> {
    const approval = await deps.approvals.getByMessageId(scope, messageId);
    if (!approval) throw new NotFoundError(`No approval found for message '${messageId}'`);
    return approval.id;
  }

  router.get(
    '/pending/:providerId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const providerId = req.params.providerId as string;
      assertOwnQueue(req, providerId);

      const page = await deps.approvals.list(scope, {
        approverRef: providerId,
        status: 'PENDING_APPROVAL',
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.limit ? Number(req.query.limit) : 50,
      });

      res.json({ success: true, data: page.approvals, pagination: page });
    }),
  );

  router.post(
    '/approve/:messageId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const id = await approvalIdFor(scope, req.params.messageId as string);
      const result = await deps.approvals.approve(scope, id, actorOf(req));
      res.json({ success: true, message: 'Message approved successfully', data: result });
    }),
  );

  router.post(
    '/decline/:messageId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const id = await approvalIdFor(scope, req.params.messageId as string);
      const result = await deps.approvals.decline(
        scope,
        id,
        actorOf(req),
        req.body?.reason as string | undefined,
      );
      res.json({ success: true, message: 'Message declined successfully', data: result });
    }),
  );

  router.put(
    '/edit/:messageId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = contentSchema.parse(req.body);
      const id = await approvalIdFor(scope, req.params.messageId as string);
      const result = await deps.approvals.edit(
        scope,
        id,
        actorOf(req),
        body.editedContent ?? body.content,
        body.subject,
      );
      res.json({ success: true, message: 'Message updated successfully', data: result });
    }),
  );

  router.post(
    '/edit-approve/:messageId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = contentSchema.parse(req.body);
      const id = await approvalIdFor(scope, req.params.messageId as string);
      const result = await deps.approvals.editThenApprove(
        scope,
        id,
        actorOf(req),
        body.editedContent ?? body.content,
        body.subject,
      );
      res.json({ success: true, message: 'Message edited and approved', data: result });
    }),
  );

  return router;
}
