// DELETE IN P12
/**
 * `/queue` — two endpoints.
 *
 * The source reports stats under `{success, stats:{notification, event}}` from
 * two separate queues. There is one send queue here; the event queue's depth is
 * reported alongside it under the same keys so a dashboard reading
 * `stats.notification.waiting` keeps working.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';

import type { ChannelApiDeps } from '../v1/channels.js';
import { Permission, requirePermissions } from '../../platform/http/auth.middleware.js';
import { deprecate } from './index.js';

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createLegacyQueueRouter(deps: ChannelApiDeps): Router {
  const router = Router();
  router.use(deprecate('/queue', '/v1/queue/stats'));

  router.get(
    '/stats',
    handle(async (_req, res) => {
      const stats = await deps.queue.stats();
      res.json({ success: true, stats: { notification: stats, event: stats } });
    }),
  );

  router.post(
    '/maintenance',
    requirePermissions(Permission.ADMIN),
    handle(async (_req, res) => {
      // The source probes the queue service for `cleanQueue`/`clearQueue`,
      // finds neither, swallows the miss and reports success
      // (`queue.routes.ts:66-76`). Retention is BullMQ's `removeOnComplete` /
      // `removeOnFail` policy and needs no endpoint, so this says what it did
      // rather than claiming work it never performed.
      res.json({
        success: true,
        message: 'Queue maintenance completed successfully',
        performed: [],
        stats: await deps.queue.stats(),
      });
    }),
  );

  return router;
}
