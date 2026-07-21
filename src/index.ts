/**
 * Composition root. Everything that touches I/O is constructed here and passed
 * down — §0.9: no module-scope singletons, because P3's adapters need per-tenant
 * credentials injected.
 */
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { closeDb, createDb } from './platform/db/client.js';
import { createServiceLogger } from './platform/observability/logger.js';
import { initMetrics } from './platform/observability/metrics.js';
import { createRedis } from './platform/redis/index.js';

async function main(): Promise<void> {
  // Throws with a readable list of problems if the environment is wrong.
  const config = loadConfig();

  const logger = createServiceLogger(config.observability.serviceName, {
    level: config.observability.logLevel,
    logDir: config.observability.logDir,
    fileTransport: config.observability.logToFile,
  });

  initMetrics();

  const { pool } = createDb(config.db, { logger });

  // Never throws: degrades to an in-memory store when Redis is unreachable, so
  // the service still boots and serves HTTP.
  const redis = await createRedis(config.redis, logger);

  const app = createApp({ config, logger, pool, redis });

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info('service started', {
      host: config.server.host,
      port: config.server.port,
      env: config.server.env,
      authMode: config.auth.mode,
      redis: redis.connection ? 'connected' : 'degraded (in-memory)',
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });

    server.close(() => {
      void (async () => {
        await redis.close();
        await closeDb(pool, logger);
        process.exit(0);
      })();
    });

    // Don't hang forever on a stuck connection.
    setTimeout(() => {
      logger.error('forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((error: unknown) => {
  // The logger may not exist yet — a config failure happens before it is built.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fatal: failed to start outreach-server\n${message}\n`);
  process.exit(1);
});
