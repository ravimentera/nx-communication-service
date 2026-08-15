/**
 * `/v1/api-keys` — issuing and retiring the credentials `AUTH_MODE=apikey` uses.
 *
 * Every route requires `outreach:admin`. A key can mint another key only if its
 * own scopes include admin, which is the property that stops a send-only key
 * escalating itself into one that can do anything.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ApiKeyService } from '../../engine/tenancy/api-key.service.js';
import type { UsageService } from '../../engine/tenancy/usage.service.js';
import { Permission, requirePermissions, requireTenant } from '../../platform/http/auth.middleware.js';
import { ValidationError } from '../../platform/http/errors.js';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string().min(1)).min(1),
  expiresAt: z.string().datetime().optional(),
});

const rotateSchema = z.object({
  /** How long the old key keeps working. Default one hour. */
  graceSeconds: z.number().int().min(0).max(86_400).optional(),
});

/**
 * A key may only be granted scopes the engine actually recognises. A typo like
 * `outreach:sends` would otherwise produce a key that authenticates and then
 * fails every authorisation check, which reads as a service fault rather than a
 * mistake at creation time.
 */
const KNOWN_SCOPES = new Set<string>(Object.values(Permission));

/**
 * The reporting window. Defaults to the current calendar month, which is the
 * period a bill covers — and `to` is exclusive, so a month boundary is not
 * counted twice by two consecutive reports.
 */
const usageQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export interface TenancyApiDeps {
  apiKeys: ApiKeyService;
  usage: UsageService;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createTenancyRouter(deps: TenancyApiDeps): Router {
  const router = Router();

  /**
   * Readable by any authenticated caller in the tenant, not just an admin: a
   * tenant seeing its own consumption is the point, and gating it behind admin
   * is how a usage endpoint ends up unused and unnoticed when it drifts.
   */
  router.get(
    '/usage',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const query = usageQuerySchema.parse(req.query);

      const now = new Date();
      const from = query.from
        ? new Date(query.from)
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const to = query.to ? new Date(query.to) : now;

      if (to <= from) {
        throw new ValidationError('`to` must be after `from`', {
          from: from.toISOString(),
          to: to.toISOString(),
        });
      }

      res.json(await deps.usage.report(tenantId, { from, to }));
    }),
  );

  router.get(
    '/api-keys',
    requirePermissions(Permission.ADMIN),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const keys = await deps.apiKeys.list(tenantId);
      res.json({ keys, count: keys.length });
    }),
  );

  router.post(
    '/api-keys',
    requirePermissions(Permission.ADMIN),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const body = createSchema.parse(req.body);

      const unknown = body.scopes.filter((scope) => !KNOWN_SCOPES.has(scope));
      if (unknown.length > 0) {
        throw new ValidationError(`Unknown scopes: ${unknown.join(', ')}`, {
          unknown,
          known: [...KNOWN_SCOPES],
        });
      }

      const { key, record } = await deps.apiKeys.create({
        tenantId,
        name: body.name,
        scopes: body.scopes,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      });

      // The only time the plaintext exists outside the caller's hands.
      res.status(201).json({
        key,
        warning: 'This key is shown once and is not recoverable. Store it now.',
        ...record,
      });
    }),
  );

  router.post(
    '/api-keys/:id/rotate',
    requirePermissions(Permission.ADMIN),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const body = rotateSchema.parse(req.body ?? {});
      const result = await deps.apiKeys.rotate(
        tenantId,
        req.params.id as string,
        body.graceSeconds,
      );

      res.status(201).json({
        key: result.key,
        warning: 'This key is shown once and is not recoverable. Store it now.',
        previousExpiresAt: result.previousExpiresAt,
        ...result.record,
      });
    }),
  );

  router.delete(
    '/api-keys/:id',
    requirePermissions(Permission.ADMIN),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      // Revoked, not deleted: the row is the only record the key ever existed,
      // and that is what an incident review asks for after the key is gone.
      res.json(await deps.apiKeys.revoke(tenantId, req.params.id as string));
    }),
  );

  return router;
}
