/**
 * `POST /v1/outreach/generate` — draft a message for a recipient and open an
 * approval on it.
 *
 * Written in P12 to close a gap the compat trim exposed: `createRetiredMounts()`
 * answers `/ai-enhanced` and `/automated-messages` with a `410` naming this
 * path, and it did not exist. See `engine/outreach/draft.service.ts` and D101.
 *
 * Its sibling `POST /v1/outreach/trigger` lives in `playbooks.ts`, because that
 * one is the playbook runtime's entry point and this one is not. Two routers on
 * the same prefix is how Express is meant to be used; merging them would drag
 * the playbook registry into a route that has no use for it.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { DraftService } from '../../engine/outreach/draft.service.js';
import { Permission, requirePermissions, requireTenant } from '../../platform/http/auth.middleware.js';
import { CHANNEL_TYPES } from '../../ports/channel.js';

const generateSchema = z
  .object({
    channel: z.enum(CHANNEL_TYPES),
    recipientId: z.string().uuid().optional(),
    externalRef: z.object({ system: z.string().min(1), id: z.string().min(1) }).optional(),
    senderId: z.string().optional(),
    promptPackKey: z.string().min(1).optional(),
    goal: z.string().optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
    overrides: z
      .object({
        tone: z.string().optional(),
        language: z.string().optional(),
        model: z.string().optional(),
      })
      .optional(),
    policyKey: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.recipientId) !== Boolean(v.externalRef), {
    message: 'Exactly one of recipientId or externalRef is required',
  });

export interface OutreachApiDeps {
  drafts: DraftService;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createOutreachRouter(deps: OutreachApiDeps): Router {
  const router = Router();

  router.post(
    '/outreach/generate',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = generateSchema.parse(req.body);

      const draft = await deps.drafts.draft(scope, {
        ...body,
        senderId: body.senderId ?? req.identity?.senderId,
      });

      // 201: this created an approval and a message row, not just a string.
      res.status(201).json(draft);
    }),
  );

  return router;
}
