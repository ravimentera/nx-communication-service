/**
 * `/v1/playbooks`, `/v1/packs` and `/v1/outreach/trigger`.
 *
 * `POST /v1/outreach/trigger` is the engine's front door — the replacement for
 * the source's `POST /events`, which handed straight to
 * `enhancedEventHandler.handleEvent()` and returned a bare boolean
 * (`routes/event.routes.ts:39`). A caller could not tell "no playbook matched"
 * from "the send failed"; both were `false`. Here the response carries a result
 * per matched playbook, each with a run id.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { PlaybookRegistry } from '../../engine/playbooks/registry.js';
import type { PlaybookRuntime } from '../../engine/playbooks/runtime.js';
import { TRIGGER_TYPES } from '../../engine/playbooks/trigger.js';
import type { PackRegistry } from '../../packs/loader.js';
import { playbookDefinitionSchema } from '../../packs/schema.js';
import { Permission, requirePermissions, requireTenant } from '../../platform/http/auth.middleware.js';
import { NotFoundError } from '../../platform/http/errors.js';
import { CHANNEL_TYPES } from '../../ports/channel.js';

const triggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES).default('event'),
  eventType: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  correlationId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  channels: z.array(z.enum(CHANNEL_TYPES)).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  recipientId: z.string().uuid().optional(),
  senderId: z.string().optional(),
});

const installSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  /**
   * Revert a tenant's own edits to the pack's shipped content. Off by default:
   * a clinic that reworded its appointment reminder must not lose that wording
   * because someone redeployed.
   */
  overwriteCustomized: z.boolean().optional(),
});

export interface PlaybookApiDeps {
  runtime: PlaybookRuntime;
  registry: PlaybookRegistry;
  packs: PackRegistry;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createPlaybookRouter(deps: PlaybookApiDeps): Router {
  const router = Router();

  router.post(
    '/outreach/trigger',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = triggerSchema.parse(req.body);

      const results = await deps.runtime.run({
        ...body,
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        correlationId: body.correlationId ?? crypto.randomUUID(),
      });

      // 200 with an empty list, not 404: "no playbook wanted this event" is a
      // legitimate outcome and the caller may not know the tenant's config.
      res.json({
        matched: results.length,
        results,
      });
    }),
  );

  router.get(
    '/playbooks',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const playbooks = await deps.registry.listPlaybooks(scope, {
        packId: req.query.packId as string | undefined,
        active: req.query.active === undefined ? undefined : req.query.active === 'true',
      });
      res.json({ playbooks, count: playbooks.length });
    }),
  );

  router.put(
    '/playbooks/:key',
    requirePermissions(Permission.PLAYBOOKS_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const definition = playbookDefinitionSchema.parse({
        ...req.body,
        key: req.params.key,
      });
      res.json(await deps.registry.upsertPlaybook(scope, definition));
    }),
  );

  router.post(
    '/playbooks/:key/activate',
    requirePermissions(Permission.PLAYBOOKS_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json(await deps.registry.setActive(scope, req.params.key as string, true));
    }),
  );

  router.post(
    '/playbooks/:key/deactivate',
    requirePermissions(Permission.PLAYBOOKS_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json(await deps.registry.setActive(scope, req.params.key as string, false));
    }),
  );

  // ── packs ─────────────────────────────────────────────────────────────────

  router.get(
    '/packs',
    handle(async (_req, res) => {
      // Any validation failure is surfaced here too, not only in the boot log —
      // an operator asking "why is this playbook missing?" should find out from
      // the API.
      res.json({ packs: deps.packs.list(), errors: deps.packs.errors() });
    }),
  );

  router.post(
    '/packs/:packId/install',
    requirePermissions(Permission.CONFIG_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = installSchema.parse(req.body ?? {});
      const packId = req.params.packId as string;

      if (!deps.packs.get(packId)) {
        throw new NotFoundError(`Pack '${packId}' is not loaded`, {
          available: deps.packs.list(),
        });
      }

      res.json(await deps.registry.installPack(scope, packId, body));
    }),
  );

  router.post(
    '/packs/:packId/uninstall',
    requirePermissions(Permission.CONFIG_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      // Deactivates; it does not delete. A message sent last week references a
      // playbook by id, and deleting it would break its provenance.
      await deps.registry.uninstallPack(scope, req.params.packId as string);
      res.status(204).end();
    }),
  );

  return router;
}
