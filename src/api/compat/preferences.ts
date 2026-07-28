// DELETE IN P12
/**
 * `/preferences` — nine endpoints over what was an **in-memory `Map`**.
 *
 * `preference.service.ts:30` is `private userPreferences = new Map(...)`, so
 * every preference this API ever stored was lost on the next restart and the
 * `communication_preferences` table it shadowed was never read. The compat
 * surface is unchanged; what it writes to is not.
 *
 * `:userId` is the legacy patient id, so every path resolves through
 * `external_ref` like the rest of the shim.
 *
 * Two of the nine were **global**, not per user: `GET|PUT /quiet-hours` set a
 * single process-wide window (`preference.service.ts` `setGlobalQuietHours`)
 * shared by every tenant in the deployment. There is no such thing here — quiet
 * hours belong to a tenant — so they read and write
 * `tenant_channel_configs.metadata.quietHours` for the calling tenant. A second
 * tenant can no longer change the first one's window by calling this endpoint.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ComplianceGate } from '../../engine/compliance/gate.js';
import type { PreferenceService } from '../../engine/compliance/preference.service.js';
import type { ChannelConfigService } from '../../engine/delivery/channel-config.service.js';
import type { RecipientService } from '../../engine/recipients/recipient.service.js';
import { requireTenant } from '../../platform/http/auth.middleware.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { toChannelType } from '../../ports/channel.js';
import { deprecate } from './index.js';
import type { CompatIdentity } from './translate.js';

const preferenceBody = z.object({
  userId: z.string().optional(),
  patientId: z.string().optional(),
  allowCommunications: z.boolean().optional(),
  preferredChannels: z.array(z.string()).optional(),
  preferredLanguage: z.string().optional(),
  preferredFrequency: z.string().optional(),
  preferredTimeOfDay: z.string().optional(),
  quietHoursStart: z.string().nullable().optional(),
  quietHoursEnd: z.string().nullable().optional(),
  quietHoursTimezone: z.string().nullable().optional(),
  eventOptOuts: z.array(z.string()).optional(),
});

const quietHoursBody = z.object({
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  timezone: z.string().min(1),
});

const checkBody = z.object({
  userId: z.string().min(1),
  eventType: z.string().optional(),
  channels: z.array(z.string()).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
});

export interface PreferenceCompatDeps {
  preferences: PreferenceService;
  recipients: RecipientService;
  gate: ComplianceGate;
  configs: ChannelConfigService;
  identity: CompatIdentity;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createLegacyPreferenceRouter(deps: PreferenceCompatDeps): Router {
  const router = Router();
  router.use(deprecate('/preferences', '/v1/recipients/:id/preferences'));

  /**
   * The unsubscribe pair is registered before `/:userId`, because Express
   * matches in declaration order and `/unsubscribe` would otherwise be read as
   * a user id. The source has the same ordering and the same reason.
   */
  router.post(
    '/unsubscribe',
    handle(async (req, res) => {
      const token = (req.body?.token ?? req.query.token) as string | undefined;
      if (token) {
        const { tenantId, recipientId } = await deps.preferences.unsubscribeByToken(token);
        await deps.recipients.setStatus({ tenantId }, recipientId, 'unsubscribed');
        res.json({ success: true, message: 'Successfully unsubscribed' });
        return;
      }

      const scope = requireTenant(req);
      const userId = (req.body?.userId ?? req.body?.patientId) as string | undefined;
      if (!userId) throw new ValidationError('Either token or userId is required');

      const recipientId = await deps.identity.lookup(scope, userId);
      if (!recipientId) throw new NotFoundError('User preferences not found');

      await deps.preferences.unsubscribe(scope, recipientId, req.body?.reason);
      await deps.recipients.setStatus(scope, recipientId, 'unsubscribed');
      res.json({ success: true, message: 'Successfully unsubscribed' });
    }),
  );

  /**
   * GET does **not** unsubscribe. The source renders an HTML confirmation page
   * here and mutates nothing (`:195-233`); mail clients and browsers prefetch
   * links, so a GET that unsubscribed would fire on preview (D43).
   */
  router.get(
    '/unsubscribe',
    handle(async (req, res) => {
      const token = req.query.token as string | undefined;
      if (!token) throw new ValidationError('Unsubscribe token is required');
      res.json({ success: true, message: 'Send POST to this URL to confirm unsubscribe.' });
    }),
  );

  router.get(
    '/quiet-hours',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const config = await deps.configs.getTenantConfig(scope.tenantId);
      const stored = (config?.metadata as { quietHours?: unknown } | null)?.quietHours;
      res.json({ success: true, quietHours: stored ?? null });
    }),
  );

  router.put(
    '/quiet-hours',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const quietHours = quietHoursBody.parse(req.body);
      const existing = await deps.configs.getTenantConfig(scope.tenantId);
      await deps.configs.upsertTenantConfig(
        scope.tenantId,
        {
          metadata: { ...((existing?.metadata as Record<string, unknown>) ?? {}), quietHours },
        },
        req.identity?.userId,
      );
      res.json({ success: true, message: 'Quiet hours updated successfully', quietHours });
    }),
  );

  router.post(
    '/check',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = checkBody.parse(req.body);
      const recipientId = await deps.identity.lookup(scope, body.userId);
      if (!recipientId) {
        // Unknown recipient means nothing has been expressed, which is
        // "allowed" — the source's `checkPreferences` returns the same for a
        // Map miss.
        res.json({ success: true, allowed: true, blockedReason: null, blockedChannels: [] });
        return;
      }

      // An unrecognised channel name is dropped rather than rejected: the
      // source accepts whatever string it is handed and the check simply
      // returns nothing for it.
      const channels = (body.channels ?? ['email'])
        .map((c) => toChannelType(c))
        .filter((c): c is NonNullable<typeof c> => Boolean(c));

      const verdicts = await Promise.all(
        channels.map(async (channel) => ({
          channel,
          verdict: await deps.gate.check({
            scope,
            channel,
            priority: body.priority,
            recipientId,
            playbookKey: body.eventType,
            rendered: { body: '' },
          }),
        })),
      );

      const blocked = verdicts.filter((v) => !v.verdict.allow);
      res.json({
        success: true,
        allowed: blocked.length === 0,
        // The source returns one `blockedReason` for the whole check; the
        // per-channel verdicts are additional, not a replacement.
        blockedReason: blocked[0] && !blocked[0].verdict.allow ? blocked[0].verdict.reason : null,
        blockedChannels: blocked.map((v) => v.channel),
        verdicts,
      });
    }),
  );

  router.post(
    '/',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = preferenceBody.parse(req.body);
      const userId = body.userId ?? body.patientId;
      if (!userId) throw new ValidationError('User ID is required');

      const recipientId = await deps.identity.ensure(scope, userId);
      const prefs = await deps.preferences.upsert(scope, recipientId, {
        ...body,
        updatedBy: req.identity?.userId,
      });
      res.status(201).json({ success: true, preferences: strip(prefs) });
    }),
  );

  router.get(
    '/:userId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipientId = await deps.identity.lookup(scope, req.params.userId as string);
      const prefs = recipientId ? await deps.preferences.get(scope, recipientId) : null;
      if (!prefs) throw new NotFoundError('User preferences not found');
      res.json({ success: true, preferences: strip(prefs) });
    }),
  );

  router.put(
    '/:userId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = preferenceBody.parse(req.body);
      const recipientId = await deps.identity.lookup(scope, req.params.userId as string);
      if (!recipientId) throw new NotFoundError('User preferences not found');

      const prefs = await deps.preferences.upsert(scope, recipientId, {
        ...body,
        updatedBy: req.identity?.userId,
      });
      res.json({ success: true, preferences: strip(prefs) });
    }),
  );

  router.get(
    '/:userId/unsubscribe-url',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipientId = await deps.identity.lookup(scope, req.params.userId as string);
      if (!recipientId) throw new NotFoundError('User preferences not found');
      res.json({
        success: true,
        unsubscribeUrl: await deps.preferences.unsubscribeUrl(scope, recipientId),
      });
    }),
  );

  return router;
}

/**
 * The unsubscribe token is a credential — it is what makes the unauthenticated
 * unsubscribe route safe (D43) — so it never appears in a preferences payload.
 * The source strips it at `:45`, `:77` and `:118`; losing that would put a
 * working unsubscribe link for any recipient into a plain read.
 */
function strip<T extends Record<string, unknown>>(prefs: T): Omit<T, 'unsubscribeToken'> {
  const { unsubscribeToken: _ignored, ...rest } = prefs;
  return rest;
}
