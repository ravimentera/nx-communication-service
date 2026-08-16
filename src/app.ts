import cors from 'cors';
import express, { type Express, type Request } from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import type { Logger } from 'winston';

import { createHealthRouter } from './api/health.js';
import {
  createCompatMounts,
  createRetiredMounts,
  type CompatDeps,
} from './api/compat/index.js';
import { createWebhookRouter, type WebhookDeps } from './api/webhooks/index.js';
import { createMcpRouter, type McpDeps } from './mcp/index.js';
import { createApprovalRouter, type ApprovalApiDeps } from './api/v1/approvals.js';
import { createAssetRouter, type AssetApiDeps } from './api/v1/assets.js';
import { createCampaignRouter, type CampaignApiDeps } from './api/v1/campaigns.js';
import { createChannelRouter, type ChannelApiDeps } from './api/v1/channels.js';
import { createContentRouter, type ContentApiDeps } from './api/v1/content.js';
import { createMessagingRouter, type MessagingApiDeps } from './api/v1/messaging.js';
import { createOutreachRouter, type OutreachApiDeps } from './api/v1/outreach.js';
import { createPlaybookRouter, type PlaybookApiDeps } from './api/v1/playbooks.js';
import {
  createRecipientRouter,
  createUnsubscribeRouter,
  type RecipientApiDeps,
} from './api/v1/recipients.js';
import { createTenancyRouter, type TenancyApiDeps } from './api/v1/tenancy.js';
import type { Config } from './config/index.js';
import type { Dispatcher } from './engine/delivery/dispatcher.js';
import type { NotificationQueue } from './engine/delivery/notification-queue.js';
import { createAuthMiddleware } from './platform/http/auth.middleware.js';
import { createErrorHandler, notFoundHandler } from './platform/http/error-handler.js';
import { createObservabilityMiddleware } from './platform/observability/middleware.js';
import { metricsHandler } from './platform/observability/metrics.js';
import type { RedisHandle } from './platform/redis/index.js';

export const VERSION = '0.1.0';

/**
 * A fixed window per key. The bucket is part of the key, so it expires on its
 * own and there is nothing to sweep — the alternative, one counter reset by a
 * timer, needs a process that owns the reset and gets it wrong across replicas.
 */
function rateLimitKey(keyId: string, windowSeconds: number): string {
  return `apikey:rl:${keyId}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
}

export interface AppDeps {
  config: Config;
  logger: Logger;
  pool: pg.Pool;
  redis: RedisHandle;
  /** Present from P3 onward. Absent only in the platform-only boot test. */
  dispatcher?: Dispatcher;
  queue?: NotificationQueue;
  /** Present from P4 onward. */
  content?: ContentApiDeps;
  /** Present from P12 onward — needs a storage adapter. */
  assets?: AssetApiDeps;
  /** Present from P12 onward — API keys and per-tenant usage. */
  tenancy?: TenancyApiDeps;
  /** Present from P5 onward. */
  recipients?: RecipientApiDeps;
  /** Present from P6 onward. */
  approvals?: ApprovalApiDeps;
  /** Present from P7 onward. */
  playbooks?: PlaybookApiDeps;
  /** Present from P12 onward — `POST /v1/outreach/generate` (D101). */
  outreach?: OutreachApiDeps;
  /** Present from P8 onward. */
  messaging?: MessagingApiDeps;
  /** Present from P11 onward. */
  campaigns?: CampaignApiDeps;
  channels?: ChannelApiDeps;
  /** The legacy surface (D60: 110 endpoints, not 77). Absent in /v1-only tests. */
  compat?: CompatDeps;
  /** Provider callbacks. Mounted pre-auth and pre-body-parser (P8b). */
  webhooks?: WebhookDeps;
  /** MCP. Discovery is pre-auth; execution is not (P8b). */
  mcp?: McpDeps;
}

/**
 * Wire the HTTP surface. FOUR ORDERING SUBTLETIES ARE LOAD-BEARING — do not
 * "tidy" them:
 *
 *   1. `/metrics` is mounted BEFORE auth. Prometheus scrapes with no gateway
 *      headers; behind auth every scrape would 403.
 *   2. `/v1/webhooks` is mounted BEFORE auth **and before the JSON parser**.
 *      Twilio and SendGrid carry no gateway headers, and signature verification
 *      needs the raw bytes a shared parser would have discarded.
 *   3. `/mcp` is mounted BEFORE auth. tera-orchestrator hits GET /mcp/tools at
 *      its own startup with no per-user headers. Discovery is schema-only;
 *      individual tool executions still validate their input.
 *   4. The legacy compat surface is mounted LAST, so a root-mounted legacy
 *      router can never shadow a `/v1` path.
 */
/**
 * The socket's own peer address.
 *
 * Deliberately NOT `req.ip`, which honours `X-Forwarded-For` once
 * `trust proxy` is set — and a header any caller can send is not an access
 * control. The metrics allow-list has to be about who actually connected.
 */
function callerIp(req: Request): string {
  const raw = req.socket.remoteAddress ?? '';
  // Node reports IPv4 peers over a dual-stack socket as ::ffff:127.0.0.1.
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');

  // First, so every request downstream is measured and correlated.
  app.use(
    createObservabilityMiddleware({
      serviceName: config.observability.serviceName,
      logger,
    }),
  );

  // (1) Pre-auth: Prometheus has no gateway headers.
  //
  // ALLOW-LISTED BY SOURCE ADDRESS, because pre-auth and tenant-labelled is a
  // bad pair. Eight metric families carry a `tenant` label, so one
  // unauthenticated GET returns the tenant roster along with each one's send
  // volume and model spend. Defaults to loopback — a sidecar scrape keeps
  // working, an exposed pod stops answering — and `METRICS_ALLOWED_IPS=*`
  // restores the old behaviour where the network perimeter already handles it.
  const metricsAllowed = new Set(config.observability.metricsAllowedIps);
  const metricsOpen = metricsAllowed.has('*');

  app.get('/metrics', (req, res) => {
    if (!metricsOpen && !metricsAllowed.has(callerIp(req))) {
      // 404, not 403: whether this deployment exposes metrics at all is not
      // something an unauthorized caller needs confirmed.
      res.status(404).end();
      return;
    }
    void metricsHandler(req, res);
  });

  app.use(helmet());
  app.use(cors());

  // (2) Pre-auth AND pre-body-parser: a provider callback carries no gateway
  //     headers — the signature is the credential — and verifying it needs the
  //     exact bytes, which a shared JSON parser has already thrown away. Each
  //     webhook route installs its own parser. Mounted before `express.json`
  //     for that reason, not by accident.
  if (deps.webhooks) {
    app.use('/v1/webhooks', createWebhookRouter(deps.webhooks));
  }

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  app.get('/', (_req, res) => {
    res.json({
      service: config.observability.serviceName,
      version: VERSION,
      env: config.server.env,
      health: '/health',
      metrics: '/metrics',
    });
  });

  app.use(
    '/health',
    createHealthRouter({
      serviceName: config.observability.serviceName,
      version: VERSION,
      pool: deps.pool,
      redis: deps.redis,
      logger,
      queueStats: deps.queue ? () => deps.queue!.stats() : undefined,
    }),
  );

  // (3) Pre-auth: tera-orchestrator calls GET /mcp/tools at its own startup,
  //     before any user exists, to build its tool registry. Discovery is
  //     schema-only. Every tool that touches data calls `requireTenant`, so
  //     execution is still authenticated — see mcp/index.ts.
  if (deps.mcp) {
    app.use('/mcp', createMcpRouter(deps.mcp));
  }

  // (4) Pre-auth: an unsubscribe link is clicked from an email client, which
  //     carries no gateway headers and no session. The 24-byte token in the
  //     URL is the credential, and the route is rate-limited. CAN-SPAM
  //     requires the link to work for anyone who received the message.
  if (deps.recipients) {
    app.use(
      '/unsubscribe',
      createUnsubscribeRouter({
        preferences: deps.recipients.preferences,
        recipients: deps.recipients.recipients,
      }),
    );
  }

  app.use(
    createAuthMiddleware({
      config: config.auth,
      logger,
      // Both are unused in `gateway` mode, which is every Mentera deployment.
      // They are what makes `apikey` mode work for a vendor with no gateway.
      verifyApiKey: deps.tenancy ? (key) => deps.tenancy!.apiKeys.verify(key) : undefined,
      countRequest: (keyId, windowSeconds) =>
        deps.redis.store.incrWithTtl(rateLimitKey(keyId, windowSeconds), windowSeconds),
    }),
  );

  // P3 onward mount the business routers here.
  if (deps.content) {
    app.use('/v1', createContentRouter(deps.content));
  }
  if (deps.assets) {
    app.use('/v1', createAssetRouter(deps.assets));
  }
  if (deps.tenancy) {
    app.use('/v1', createTenancyRouter(deps.tenancy));
  }
  if (deps.recipients) {
    app.use('/v1', createRecipientRouter(deps.recipients));
  }
  if (deps.approvals) {
    app.use('/v1', createApprovalRouter(deps.approvals));
  }
  if (deps.playbooks) {
    app.use('/v1', createPlaybookRouter(deps.playbooks));
  }
  if (deps.outreach) {
    app.use('/v1', createOutreachRouter(deps.outreach));
  }
  if (deps.messaging) {
    app.use('/v1', createMessagingRouter(deps.messaging));
  }
  if (deps.channels) {
    app.use('/v1', createChannelRouter(deps.channels));
  }
  if (deps.campaigns) {
    app.use('/v1', createCampaignRouter(deps.campaigns));
  }

  // (5) The legacy surface, LAST — so a `/v1` path can never be shadowed by a
  //     root-mounted legacy router, and so `notFoundHandler` still sees
  //     anything neither surface claims. Deleted in P12.
  if (deps.compat) {
    for (const { path, router } of createCompatMounts(deps.compat)) {
      app.use(path, router);
    }
    // The legacy mounts that were retired in P12 (D100), answering 410 with the
    // successor named. After the live ones, so a surviving path is never
    // shadowed by the tombstone of a retired sibling.
    for (const { path, router } of createRetiredMounts()) {
      app.use(path, router);
    }
  }

  app.use(notFoundHandler());
  app.use(createErrorHandler({ logger, production: config.server.isProduction }));

  return app;
}
