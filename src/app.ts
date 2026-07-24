import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import type { Logger } from 'winston';

import { createHealthRouter } from './api/health.js';
import { createInternalRouter } from './api/internal.js';
import type { Config } from './config/index.js';
import type { Dispatcher } from './engine/delivery/dispatcher.js';
import type { NotificationQueue } from './engine/delivery/notification-queue.js';
import { createAuthMiddleware } from './platform/http/auth.middleware.js';
import { createErrorHandler, notFoundHandler } from './platform/http/error-handler.js';
import { createObservabilityMiddleware } from './platform/observability/middleware.js';
import { metricsHandler } from './platform/observability/metrics.js';
import type { RedisHandle } from './platform/redis/index.js';

export const VERSION = '0.1.0';

export interface AppDeps {
  config: Config;
  logger: Logger;
  pool: pg.Pool;
  redis: RedisHandle;
  /** Present from P3 onward. Absent only in the platform-only boot test. */
  dispatcher?: Dispatcher;
  queue?: NotificationQueue;
}

/**
 * Wire the HTTP surface. TWO ORDERING SUBTLETIES ARE LOAD-BEARING, both
 * inherited from the source service — do not "tidy" them:
 *
 *   1. `/metrics` is mounted BEFORE auth. Prometheus scrapes with no gateway
 *      headers; behind auth every scrape would 403.
 *   2. `/mcp` is mounted BEFORE auth (P8). tera-orchestrator hits GET /mcp/tools
 *      at its own startup with no per-user headers. Discovery is schema-only;
 *      individual tool executions still validate their input.
 */
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
  app.get('/metrics', (req, res) => {
    void metricsHandler(req, res);
  });

  app.use(helmet());
  app.use(cors());
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

  // (2) P8 mounts the MCP router here, pre-auth.

  app.use(createAuthMiddleware({ config: config.auth, logger }));

  // P3 onward mount the business routers here.
  if (deps.dispatcher) {
    // Temporary — deleted in P8 when the real v1 surface lands.
    app.use('/internal', createInternalRouter(deps.dispatcher));
  }

  app.use(notFoundHandler());
  app.use(createErrorHandler({ logger, production: config.server.isProduction }));

  return app;
}
