/**
 * TEMPORARY smoke-test route. **Deleted in P8** when the real v1 surface lands.
 * It exists so P3 can be verified end to end without waiting for the API phase.
 */
import { Router } from 'express';
import { z } from 'zod';

import type { Dispatcher } from '../engine/delivery/dispatcher.js';
import { requireTenant } from '../platform/http/auth.middleware.js';
import { CHANNEL_TYPES } from '../ports/channel.js';

const dispatchTestSchema = z.object({
  channel: z.enum(CHANNEL_TYPES),
  to: z.object({
    type: z.string(),
    value: z.string().min(1),
  }),
  rendered: z.object({
    subject: z.string().optional(),
    body: z.string().min(1),
    html: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  senderId: z.string().optional(),
});

export function createInternalRouter(dispatcher: Dispatcher): Router {
  const router = Router();

  router.post('/dispatch-test', (req, res, next) => {
    void (async () => {
      try {
        const scope = requireTenant(req);
        const body = dispatchTestSchema.parse(req.body);
        const result = await dispatcher.dispatch({
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId,
          channel: body.channel,
          to: body.to,
          rendered: body.rendered,
          priority: body.priority,
          senderId: body.senderId ?? req.identity?.senderId,
        });
        res.status(result.queued ? 202 : 200).json(result);
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
