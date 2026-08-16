// DELETE IN P12
/**
 * `/config` — nine endpoints, and the second of the five call sites P10
 * repoints: providers-service' `integration-settings.service.ts` calls
 * `GET|POST|PUT /config/medspa/:medspaId` directly.
 *
 * `:medspaId` in the path is **checked against the scope, not trusted**. The
 * source's `validateMedspaAccess` compares the caller's own medspa to the path
 * and lets a role named `super_admin` through; here the tenant comes from the
 * gateway headers and a mismatched path segment is a 403 with no exception,
 * because a config write is where a tenant's Twilio credentials live.
 *
 * Secrets are masked on the way out by the same helper the v1 router uses.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';

import type { ChannelApiDeps } from '../v1/channels.js';
import { Permission, requirePermissions, requireTenant } from '../../platform/http/auth.middleware.js';
import { ForbiddenError, NotFoundError } from '../../platform/http/errors.js';
import { maskTenantConfig } from '../v1/channels.js';
import { deprecate } from './index.js';

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** The path's medspa id must be the caller's tenant. No super-admin escape. */
function assertPathTenant(req: Request, pathTenantId: string | undefined): { tenantId: string } {
  const scope = requireTenant(req);
  if (pathTenantId && pathTenantId !== scope.tenantId) {
    throw new ForbiddenError('Access denied: you can only access your own configuration');
  }
  return scope;
}

export function createLegacyConfigRouter(deps: ChannelApiDeps): Router {
  const router = Router();
  router.use(deprecate('/config', '/v1/channels/configs'));

  // ── tenant ("medspa") config ──────────────────────────────────────────────

  router.get(
    '/medspa/:medspaId',
    handle(async (req, res) => {
      const scope = assertPathTenant(req, req.params.medspaId);
      const config = await deps.configs.getTenantConfig(scope.tenantId);
      if (!config) throw new NotFoundError('Medspa configuration not found');
      res.json({ success: true, data: maskTenantConfig(config) });
    }),
  );

  router.post(
    '/medspa',
    requirePermissions(Permission.CONFIG_WRITE),
    handle(async (req, res) => {
      const scope = assertPathTenant(req, req.body?.medspaId);
      const config = await deps.configs.upsertTenantConfig(
        scope.tenantId,
        req.body ?? {},
        req.identity?.userId,
      );
      res.status(201).json({
        success: true,
        message: 'Medspa configuration created successfully',
        data: { id: config.id, medspaId: config.tenantId },
      });
    }),
  );

  router.put(
    '/medspa/:medspaId',
    requirePermissions(Permission.CONFIG_WRITE),
    handle(async (req, res) => {
      const scope = assertPathTenant(req, req.params.medspaId);
      const config = await deps.configs.upsertTenantConfig(
        scope.tenantId,
        req.body ?? {},
        req.identity?.userId,
      );
      res.json({
        success: true,
        message: 'Medspa configuration updated successfully',
        data: maskTenantConfig(config),
      });
    }),
  );

  return router;
}
