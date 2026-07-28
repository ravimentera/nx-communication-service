/**
 * `/v1/channels/*` and `/v1/queue/*` — per-tenant and per-agent channel
 * credentials, a send test, and queue visibility.
 *
 * The config half is one of the five call sites P10 repoints:
 * providers-service' `integration-settings.service.ts` calls
 * `GET|POST|PUT /config/medspa/:medspaId` directly.
 *
 * **Secrets are masked on the way out, always.** `config.routes.ts:60-67` does
 * this and it is the one thing in that file that must not be lost: without it
 * the endpoint hands a tenant's Twilio auth token and SendGrid key to anyone
 * who can read its config. Masking lives in the router rather than the service
 * because the credential resolver needs the real values.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ChannelConfigService } from '../../engine/delivery/channel-config.service.js';
import type { Dispatcher } from '../../engine/delivery/dispatcher.js';
import type { NotificationQueue } from '../../engine/delivery/notification-queue.js';
import {
  Permission,
  requirePermissions,
  requireTenant,
} from '../../platform/http/auth.middleware.js';
import { NotFoundError } from '../../platform/http/errors.js';
import { CHANNEL_TYPES } from '../../ports/channel.js';

const rateLimitSchema = z
  .object({
    maxPerHour: z.number().int().nonnegative().optional(),
    maxPerDay: z.number().int().nonnegative().optional(),
    burstLimit: z.number().int().nonnegative().optional(),
  })
  .optional();

const tenantConfigSchema = z.object({
  name: z.string().min(1).optional(),
  twilioAccountSid: z.string().nullable().optional(),
  twilioAuthToken: z.string().nullable().optional(),
  twilioPhoneNumber: z.string().nullable().optional(),
  twilioEnabled: z.boolean().optional(),
  sendgridApiKey: z.string().nullable().optional(),
  sendgridFromEmail: z.string().email().nullable().optional(),
  sendgridFromName: z.string().nullable().optional(),
  sendgridEnabled: z.boolean().optional(),
  slackBotToken: z.string().nullable().optional(),
  slackDefaultChannel: z.string().nullable().optional(),
  slackEnabled: z.boolean().optional(),
  timezone: z.string().optional(),
  defaultLanguage: z.string().optional(),
  businessHoursStart: z.string().nullable().optional(),
  businessHoursEnd: z.string().nullable().optional(),
  businessDays: z.array(z.string()).optional(),
  smsRateLimit: rateLimitSchema,
  emailRateLimit: rateLimitSchema,
  requireOptIn: z.boolean().optional(),
  retentionDays: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

const agentConfigSchema = z.object({
  name: z.string().min(1).optional(),
  twilioPhoneNumber: z.string().nullable().optional(),
  twilioEnabled: z.boolean().optional(),
  emailFromAddress: z.string().email().nullable().optional(),
  emailFromName: z.string().nullable().optional(),
  emailEnabled: z.boolean().optional(),
  slackUserId: z.string().nullable().optional(),
  slackEnabled: z.boolean().optional(),
  preferredChannel: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  workingHoursStart: z.string().nullable().optional(),
  workingHoursEnd: z.string().nullable().optional(),
  workingDays: z.array(z.string()).optional(),
  receiveRecipientNotifications: z.boolean().optional(),
  receiveSystemNotifications: z.boolean().optional(),
  receiveMarketingNotifications: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const testSchema = z.object({
  channel: z.enum(CHANNEL_TYPES).default('sms'),
  to: z.string().min(1),
  message: z.string().min(1).default('Outreach test message'),
  senderId: z.string().optional(),
});

/**
 * Never return a secret. The account SID keeps its last four characters so an
 * operator can tell two accounts apart; everything else is opaque.
 */
export function maskTenantConfig<T extends Record<string, unknown>>(config: T): T {
  const sid = config.twilioAccountSid as string | null | undefined;
  return {
    ...config,
    twilioAccountSid: sid ? `***${sid.slice(-4)}` : sid,
    twilioAuthToken: config.twilioAuthToken ? '***' : config.twilioAuthToken,
    sendgridApiKey: config.sendgridApiKey ? '***' : config.sendgridApiKey,
    slackBotToken: config.slackBotToken ? '***' : config.slackBotToken,
  };
}

export interface ChannelApiDeps {
  configs: ChannelConfigService;
  dispatcher: Dispatcher;
  queue: NotificationQueue;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createChannelRouter(deps: ChannelApiDeps): Router {
  const router = Router();

  // ── tenant config ─────────────────────────────────────────────────────────

  router.get(
    '/channels/configs',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const config = await deps.configs.getTenantConfig(scope.tenantId);
      if (!config) throw new NotFoundError('No channel configuration for this tenant');
      res.json(maskTenantConfig(config));
    }),
  );

  /**
   * Upsert, deliberately. `tenant_channel_configs` has UNIQUE(tenant_id), so
   * "create" and "update" address the same row; the source's split pair returns
   * 409 on a second POST and 404 on a PUT before the first one, which makes an
   * idempotent deploy script impossible to write.
   */
  router.put(
    '/channels/configs',
    requirePermissions(Permission.CONFIG_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = tenantConfigSchema.parse(req.body);
      const config = await deps.configs.upsertTenantConfig(
        scope.tenantId,
        body,
        req.identity?.userId,
      );
      res.json(maskTenantConfig(config));
    }),
  );

  // ── agent config ──────────────────────────────────────────────────────────

  router.get(
    '/channels/configs/agents',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const agents = await deps.configs.getAgentsByTenant(scope.tenantId);
      res.json({ agents, count: agents.length });
    }),
  );

  router.get(
    '/channels/configs/agents/:senderId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const config = await deps.configs.getAgentConfig(
        scope.tenantId,
        req.params.senderId as string,
      );
      if (!config) throw new NotFoundError(`No channel configuration for '${req.params.senderId}'`);
      // Agent configs hold no secrets — a `from` address and a phone number are
      // not credentials. Nothing to mask.
      res.json(config);
    }),
  );

  router.put(
    '/channels/configs/agents/:senderId',
    requirePermissions(Permission.CONFIG_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = agentConfigSchema.parse(req.body);
      res.json(
        await deps.configs.upsertAgentConfig(
          scope.tenantId,
          req.params.senderId as string,
          body,
          req.identity?.userId,
        ),
      );
    }),
  );

  router.get(
    '/channels/numbers',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json(await deps.configs.getSenderNumbers(scope.tenantId));
    }),
  );

  // ── test send ─────────────────────────────────────────────────────────────

  /**
   * Goes through the normal `Dispatcher`, so a test exercises the real
   * credential chain and the real gate. `CHANNEL_DRY_RUN` still applies (D23) —
   * a test send on a dry-run deploy reports queued and delivers nothing, which
   * is the honest answer about what that deploy would do.
   */
  router.post(
    '/channels/test',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = testSchema.parse(req.body);
      const result = await deps.dispatcher.dispatch({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        channel: body.channel,
        to: { type: body.channel === 'sms' ? 'phone' : body.channel, value: body.to },
        rendered: { subject: 'Outreach test', body: body.message },
        senderId: body.senderId,
        priority: 'HIGH',
        // A test must never be held by a rate limit or a quiet-hours window —
        // the operator is asking whether the credentials work.
        transactional: true,
      });
      res.json(result);
    }),
  );

  // ── queue ─────────────────────────────────────────────────────────────────

  router.get(
    '/queue/stats',
    handle(async (_req, res) => {
      res.json(await deps.queue.stats());
    }),
  );

  router.post(
    '/queue/maintenance',
    requirePermissions(Permission.ADMIN),
    handle(async (_req, res) => {
      // The source advertises maintenance and then does nothing: it probes for
      // `cleanQueue`/`clearQueue` on the queue service (`queue.routes.ts:66-70`),
      // neither exists, the miss is swallowed, and it reports success. BullMQ's
      // own `removeOnComplete`/`removeOnFail` retention already does the work
      // this endpoint claimed, so it reports the truth instead.
      res.json({
        performed: [],
        note: 'Completed and failed jobs are retained by the queue policy (24h / 7d) and expire on their own.',
        stats: await deps.queue.stats(),
      });
    }),
  );

  return router;
}
