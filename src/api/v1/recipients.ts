/**
 * `/v1/recipients` and `/v1/preferences`.
 *
 * One route here is deliberately **unauthenticated**: `POST /unsubscribe/:token`
 * is reached from a link in an email, where no gateway headers exist. The token
 * is the credential — 24 random bytes — and the route is rate-limited. It is
 * mounted separately in `app.ts`, before the auth middleware.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import type { ComplianceGate } from '../../engine/compliance/gate.js';
import type { PreferenceService } from '../../engine/compliance/preference.service.js';
import type { RecipientService } from '../../engine/recipients/recipient.service.js';
import { requireTenant } from '../../platform/http/auth.middleware.js';
import { NotFoundError } from '../../platform/http/errors.js';
import { CHANNEL_TYPES } from '../../ports/channel.js';

const preferenceSchema = z.object({
  allowCommunications: z.boolean().optional(),
  preferredChannels: z.array(z.string()).optional(),
  preferredLanguage: z.string().optional(),
  preferredFrequency: z.string().optional(),
  preferredTimeOfDay: z.string().optional(),
  quietHoursStart: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  quietHoursEnd: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  quietHoursTimezone: z.string().nullable().optional(),
  eventOptOuts: z.array(z.string()).optional(),
});

const recipientSchema = z.object({
  externalRef: z.object({ system: z.string().min(1), id: z.string().min(1) }),
  displayName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  contactPoints: z
    .array(
      z.object({
        type: z.string(),
        value: z.string(),
        verified: z.boolean().optional(),
        primary: z.boolean().optional(),
      }),
    )
    .optional(),
});

const checkSchema = z.object({
  recipientId: z.string().uuid(),
  channel: z.enum(CHANNEL_TYPES),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  playbookKey: z.string().optional(),
  transactional: z.boolean().optional(),
});

export interface RecipientApiDeps {
  recipients: RecipientService;
  preferences: PreferenceService;
  gate: ComplianceGate;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createRecipientRouter(deps: RecipientApiDeps): Router {
  const router = Router();

  router.get(
    '/recipients',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const page = await deps.recipients.search(
        scope,
        (req.query.q as string) ?? '',
        req.query.page ? Number(req.query.page) : 1,
        req.query.pageSize ? Number(req.query.pageSize) : 25,
      );
      res.json(page);
    }),
  );

  router.post(
    '/recipients',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = recipientSchema.parse(req.body);
      const recipient = await deps.recipients.upsertByExternalRef(scope, body.externalRef, body);
      res.status(201).json(recipient);
    }),
  );

  router.get(
    '/recipients/:id',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipient = await deps.recipients.getById(scope, req.params.id as string);
      if (!recipient) throw new NotFoundError(`Recipient '${req.params.id}' not found`);
      res.json(recipient);
    }),
  );

  router.get(
    '/recipients/:id/preferences',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const prefs = await deps.preferences.get(scope, req.params.id as string);
      // An absent row is "no preferences expressed", not an error.
      res.json(prefs ?? { recipientId: req.params.id, allowCommunications: true });
    }),
  );

  router.put(
    '/recipients/:id/preferences',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = preferenceSchema.parse(req.body);
      const prefs = await deps.preferences.upsert(scope, req.params.id as string, {
        ...body,
        updatedBy: req.identity?.userId,
      });
      res.json(prefs);
    }),
  );

  router.get(
    '/recipients/:id/unsubscribe-url',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json({ url: await deps.preferences.unsubscribeUrl(scope, req.params.id as string) });
    }),
  );

  router.post(
    '/recipients/:id/unsubscribe',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const id = req.params.id as string;
      await deps.preferences.unsubscribe(scope, id, req.body?.reason);
      await deps.recipients.setStatus(scope, id, 'unsubscribed');
      res.status(204).end();
    }),
  );

  /**
   * Dry-run the gate. Lets a caller find out *why* a message would be
   * suppressed before sending it — the source offered no way to ask.
   */
  router.post(
    '/preferences/check',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = checkSchema.parse(req.body);
      const verdict = await deps.gate.check({
        scope,
        channel: body.channel,
        priority: body.priority,
        recipientId: body.recipientId,
        playbookKey: body.playbookKey,
        transactional: body.transactional,
        rendered: { body: '' },
      });
      res.json(verdict);
    }),
  );

  return router;
}

/**
 * The unauthenticated unsubscribe route. Mounted BEFORE auth in `app.ts`,
 * because a recipient clicking a link in an email has no gateway headers and
 * no session — the token is the whole credential.
 */
export function createUnsubscribeRouter(deps: {
  preferences: PreferenceService;
  recipients: RecipientService;
}): Router {
  const router = Router();

  // Tokens are 24 random bytes, so brute force is not a realistic threat — but
  // an open, unauthenticated, database-writing endpoint gets a limit anyway.
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post(
    '/:token',
    limiter,
    handle(async (req, res) => {
      const { tenantId, recipientId } = await deps.preferences.unsubscribeByToken(
        req.params.token as string,
      );
      await deps.recipients.setStatus({ tenantId }, recipientId, 'unsubscribed');
      res.json({ unsubscribed: true });
    }),
  );

  // Browsers and mail clients prefetch links, so GET must not mutate. It
  // reports whether the token is valid; the POST does the work.
  router.get(
    '/:token',
    limiter,
    handle(async (_req, res) => {
      res.json({ ok: true, message: 'Send POST to this URL to confirm unsubscribe.' });
    }),
  );

  return router;
}
