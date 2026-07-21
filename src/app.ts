import express, { type Express } from 'express';

import { loadConfig, type Config } from './config/index.js';

/**
 * P0 placeholder application.
 *
 * P1 turns this into the real composition root and adds — in this order, both
 * orderings load-bearing — observability middleware, `/metrics` BEFORE auth,
 * `/mcp` BEFORE auth, then the auth middleware, then the routers.
 */
export function createApp(config: Config = loadConfig()): Express {
  const app = express();

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: config.server.serviceName });
  });

  app.get('/', (_req, res) => {
    res.status(200).json({
      service: config.server.serviceName,
      version: '0.1.0',
      env: config.server.env,
    });
  });

  return app;
}
