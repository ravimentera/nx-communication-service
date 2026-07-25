/**
 * Composition root. Everything that touches I/O is constructed here and passed
 * down — §0.9: no module-scope singletons, because the adapters need per-tenant
 * credentials injected.
 */
import { join } from 'node:path';

import { createCredentialMappers } from './adapters/channels/credentials.js';
import { createChannelRegistry } from './adapters/channels/index.js';
import { BedrockProvider } from './adapters/llm/bedrock.provider.js';
import { RecordingLlmProvider } from './adapters/llm/recording.provider.js';
import { ContentGenerator } from './engine/content/generator.js';
import { PromptAssembler } from './engine/content/prompt-assembler.js';
import { Renderer } from './engine/content/renderer.js';
import { DrizzleTemplateStore } from './engine/content/store.js';
import { loadPacks } from './packs/loader.js';
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createDb } from './db/index.js';
import { ChannelConfigService } from './engine/delivery/channel-config.service.js';
import { CredentialResolver } from './engine/delivery/credential-resolver.js';
import { Dispatcher } from './engine/delivery/dispatcher.js';
import {
  BullEventQueue,
  createStubEventProcessor,
  DisabledEventQueue,
  type EventQueue,
} from './engine/delivery/event-processing-queue.js';
import {
  BullNotificationQueue,
  DisabledNotificationQueue,
  type NotificationQueue,
} from './engine/delivery/notification-queue.js';
import { createResultRecorder } from './engine/delivery/record-result.js';
import { closeDb } from './platform/db/client.js';
import { createServiceLogger } from './platform/observability/logger.js';
import { initMetrics } from './platform/observability/metrics.js';
import { Cache, createRedis } from './platform/redis/index.js';

async function main(): Promise<void> {
  // Throws with a readable list of problems if the environment is wrong.
  const config = loadConfig();

  const logger = createServiceLogger(config.observability.serviceName, {
    level: config.observability.logLevel,
    logDir: config.observability.logDir,
    fileTransport: config.observability.logToFile,
  });

  initMetrics();

  const { db, pool } = createDb(config.db, logger);

  // Never throws: degrades to an in-memory store when Redis is unreachable, so
  // the service still boots and serves HTTP.
  const redis = await createRedis(config.redis, logger);
  const cache = new Cache(redis, logger);

  // ── delivery plane ────────────────────────────────────────────────────────
  const channelConfigs = new ChannelConfigService(db, cache, logger);
  const credentials = new CredentialResolver(
    channelConfigs,
    createCredentialMappers(),
    {
      sendgrid: config.channels.sendgrid,
      smtp: config.channels.smtp,
      twilio: config.channels.twilio,
      slack: config.channels.slack,
    },
    cache,
    logger,
  );

  const registry = createChannelRegistry({
    logger,
    db,
    dryRun: config.channels.dryRun,
    preferSmtp: !config.channels.sendgrid.apiKey && Boolean(config.channels.smtp.host),
  });

  // BullMQ needs a real connection. Without one the queues degrade to no-ops
  // and HTTP keeps serving — feature-level degradation, not a failed boot.
  const queueDisabledReason = config.queue.skip
    ? 'SKIP_QUEUE=true'
    : !redis.connection
      ? 'redis unavailable'
      : undefined;

  const queue: NotificationQueue =
    queueDisabledReason || config.queue.disableNotificationQueue
      ? new DisabledNotificationQueue(
          logger,
          queueDisabledReason ?? 'DISABLE_NOTIFICATION_QUEUE=true',
        )
      : new BullNotificationQueue({
          connection: redis.connection,
          registry,
          logger,
          retry: {
            attempts: config.queue.defaultAttempts,
            urgentAttempts: config.queue.urgentAttempts,
            backoffDelayMs: 5_000,
            concurrency: config.queue.notificationConcurrency,
          },
          resolveCredentials: (channel, scope) => credentials.resolve(channel, scope),
          onResult: createResultRecorder(db, logger),
        });

  const eventQueue: EventQueue = queueDisabledReason
    ? new DisabledEventQueue(logger, queueDisabledReason)
    : new BullEventQueue({
        connection: redis.connection,
        logger,
        concurrency: config.queue.eventConcurrency,
        attempts: config.queue.defaultAttempts,
        backoffDelayMs: 5_000,
        queueName: config.queue.eventQueueName,
        // P7 replaces this stub with the playbook runtime.
        process: createStubEventProcessor(logger),
      });

  const dispatcher = new Dispatcher({ db, registry, credentials, queue, logger });

  // ── content plane ─────────────────────────────────────────────────────────
  const packs = loadPacks(join(process.cwd(), 'packs'), logger);
  const renderer = new Renderer({ logger, aliases: packs.aliasMaps() });
  const templateStore = new DrizzleTemplateStore(db, logger);
  const llm = new RecordingLlmProvider(
    new BedrockProvider({
      config: {
        region: config.llm.region,
        defaultModel: config.llm.defaultModel,
        maxRetries: config.llm.maxRetries,
        timeoutMs: config.llm.timeoutMs,
      },
      logger,
    }),
    db,
    logger,
  );
  const generator = new ContentGenerator({
    llm,
    assembler: new PromptAssembler(renderer),
    logger,
    // P5 supplies the real ruleset via this hook.
  });

  const app = createApp({
    config,
    logger,
    pool,
    redis,
    dispatcher,
    queue,
    content: { renderer, store: templateStore, generator, packs },
  });

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info('service started', {
      host: config.server.host,
      port: config.server.port,
      env: config.server.env,
      authMode: config.auth.mode,
      redis: redis.connection ? 'connected' : 'degraded (in-memory)',
      channels: registry.list(),
      dryRun: config.channels.dryRun,
      queue: queueDisabledReason ?? 'active',
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });

    server.close(() => {
      void (async () => {
        // Drain the workers before dropping the connections they use.
        await queue.close();
        await eventQueue.close();
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
