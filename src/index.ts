/**
 * Composition root. Everything that touches I/O is constructed here and passed
 * down — §0.9: no module-scope singletons, because the adapters need per-tenant
 * credentials injected.
 */
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';

import { createCredentialMappers } from './adapters/channels/credentials.js';
import { createChannelRegistry } from './adapters/channels/index.js';
import { InlineContextProvider } from './adapters/context/inline.provider.js';
import { MenteraContextProvider } from './adapters/context/mentera.provider.js';
import { BedrockProvider } from './adapters/llm/bedrock.provider.js';
import { RecordingLlmProvider } from './adapters/llm/recording.provider.js';
import { tenantPacks } from './db/schema.js';
import { ApprovalService } from './engine/approvals/approval.service.js';
import { PolicyService } from './engine/approvals/policy.service.js';
import { ApprovalSlaWorker } from './engine/approvals/sla.worker.js';
import { ComplianceGate } from './engine/compliance/gate.js';
import { lintContent, mergeRules } from './engine/compliance/lint.js';
import { PreferenceService } from './engine/compliance/preference.service.js';
import { CORE_PACK, ContextRegistry } from './engine/context/registry.js';
import { RecipientService } from './engine/recipients/recipient.service.js';
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

  // The queue's result recorder closes the approval that produced the message,
  // and the approval service needs the dispatcher, which needs the queue. One
  // mutable cell breaks the cycle, rather than giving anything a back-reference
  // it would otherwise not need.
  const approvalsRef: { current?: ApprovalService } = {};

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
          onResult: createResultRecorder(db, logger, {
            onSent: async (job) => {
              await approvalsRef.current?.markSent(
                { tenantId: job.tenantId, subTenantId: job.subTenantId },
                job.messageId,
              );
            },
          }),
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

  // ── compliance plane ──────────────────────────────────────────────────────
  const preferences = new PreferenceService({
    db,
    logger,
    defaultTimezone: config.compliance.defaultTimezone,
    unsubscribeBaseUrl: config.compliance.unsubscribeBaseUrl,
  });
  const complianceGate = new ComplianceGate({
    db,
    logger,
    preferences,
    // Defaults to true. See gate.ts — today's effective gate is an in-memory
    // Map that is empty after every restart, so enforcing on day one is the
    // change most likely to silently stop messages that currently ship.
    shadowMode: config.compliance.shadowMode,
    unsubscribeUrl: (scope, recipientId) => preferences.unsubscribeUrl(scope, recipientId),
  });

  const dispatcher = new Dispatcher({
    db,
    registry,
    credentials,
    queue,
    logger,
    compliance: complianceGate,
  });

  // ── approvals plane ───────────────────────────────────────────────────────
  const policies = new PolicyService({
    db,
    logger,
    rotation: {
      // Redis INCR when it is up; the in-memory store when it is not, which
      // makes the rotation per-replica rather than global. Round-robin is a
      // fairness heuristic, so uneven spread while degraded is acceptable.
      next: (key) => redis.store.incr(cache.key('rr', key)),
    },
  });

  const approvals = new ApprovalService({ db, logger, policies, dispatcher });
  approvalsRef.current = approvals;

  const slaWorker = new ApprovalSlaWorker({
    db,
    logger,
    approvals,
    policies,
    connection: redis.connection,
    // P7 wires the `system.approval_escalation` playbook here. Until then an
    // escalation reassigns and logs, but sends nothing.
  });
  await slaWorker.start();

  // ── context plane ─────────────────────────────────────────────────────────
  const contextRegistry = new ContextRegistry({
    installedPacks: async (tenantId) => {
      const rows = await db
        .select({ packId: tenantPacks.packId })
        .from(tenantPacks)
        .where(and(eq(tenantPacks.tenantId, tenantId), eq(tenantPacks.isActive, true)));
      return rows.map((r) => r.packId);
    },
  });
  // Available to every tenant: the caller supplied the data themselves.
  contextRegistry.register(new InlineContextProvider(), CORE_PACK);
  // Pack-gated: reaching patient-service requires the medspa pack. A tenant
  // without it cannot resolve this kind even by crafting a ContextRef.
  contextRegistry.register(
    new MenteraContextProvider({
      config: {
        patientServiceUrl: config.context.patientServiceUrl,
        providerServiceUrl: config.context.providerServiceUrl,
      },
      logger,
    }),
    'medspa',
  );

  const recipientService = new RecipientService({ db, logger, context: contextRegistry });

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
  // The P5 ruleset, finally wired. Until now the hook was unpassed, so
  // `lintWarnings` was always empty — which silently made `aiConfidence` (D35)
  // pure context-completeness and P6's `threshold` mode's lint condition
  // vacuously true.
  const lintRules = mergeRules(...packs.compliance());
  const generator = new ContentGenerator({
    llm,
    assembler: new PromptAssembler(renderer),
    logger,
    lint: async ({ content, channel, tenantId }) =>
      lintContent({ content, channel, tenantId }, lintRules),
  });

  const app = createApp({
    config,
    logger,
    pool,
    redis,
    dispatcher,
    queue,
    content: { renderer, store: templateStore, generator, packs },
    recipients: {
      recipients: recipientService,
      preferences,
      gate: complianceGate,
    },
    approvals: { approvals, policies },
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
        await slaWorker.close();
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
