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
import { createStorageProvider } from './adapters/storage/index.js';
import { tenantPacks } from './db/schema.js';
import { ApprovalService } from './engine/approvals/approval.service.js';
import { PolicyService } from './engine/approvals/policy.service.js';
import { ApprovalSlaWorker } from './engine/approvals/sla.worker.js';
import { DeferralWorker } from './engine/delivery/deferral.worker.js';
import { ComplianceGate } from './engine/compliance/gate.js';
import { lintContent, mergeRules } from './engine/compliance/lint.js';
import { ErasureService } from './engine/compliance/erasure.service.js';
import { PreferenceService } from './engine/compliance/preference.service.js';
import { CORE_PACK, ContextRegistry } from './engine/context/registry.js';
import { AnalyticsService } from './engine/messaging/analytics.service.js';
import { ConversationService } from './engine/messaging/conversation.service.js';
import { MessageService } from './engine/messaging/message.service.js';
import { ReceiptService } from './engine/messaging/receipt.service.js';
import { RecipientService } from './engine/recipients/recipient.service.js';
import { ApiKeyService } from './engine/tenancy/api-key.service.js';
import { CredentialCipher } from './engine/tenancy/credential-cipher.js';
import { UsageService } from './engine/tenancy/usage.service.js';
import { hasDuplicateKeys, parseKeyList, Sealer } from './platform/crypto/envelope.js';
import { AssetService } from './engine/content/asset.service.js';
import { ContentGenerator } from './engine/content/generator.js';
import { PromptAssembler } from './engine/content/prompt-assembler.js';
import { Renderer } from './engine/content/renderer.js';
import { DrizzleTemplateStore } from './engine/content/store.js';
import { createBodyResolver } from './api/compat/send.js';
import { loadPacks } from './packs/loader.js';
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createDb } from './db/index.js';
import { ChannelConfigService } from './engine/delivery/channel-config.service.js';
import { CredentialResolver } from './engine/delivery/credential-resolver.js';
import { Dispatcher } from './engine/delivery/dispatcher.js';
import {
  BullEventQueue,
  DisabledEventQueue,
  type EventProcessor,
  type EventQueue,
} from './engine/delivery/event-processing-queue.js';
import { createPlaybookEventProcessor } from './engine/playbooks/event-processor.js';
import { PlaybookMatcher } from './engine/playbooks/matcher.js';
import { AudienceService } from './engine/campaigns/audience.service.js';
import { CampaignOrchestrator } from './engine/campaigns/orchestrator.js';
import { PlaybookRegistry } from './engine/playbooks/registry.js';
import { PlaybookRuntime } from './engine/playbooks/runtime.js';
import {
  BullNotificationQueue,
  DisabledNotificationQueue,
  type NotificationQueue,
} from './engine/delivery/notification-queue.js';
import { createResultRecorder } from './engine/delivery/record-result.js';
import { createAuthMiddleware } from './platform/http/auth.middleware.js';
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

  // ── credential encryption (P12) ───────────────────────────────────────────
  // Off unless keys are configured. `credentials_encrypted` was reserved in P2
  // for exactly this, and turning it on is an operator step sequenced with
  // `scripts/encrypt-credentials.mjs` — see docs/MIGRATION_RUNBOOK.md.
  const credentialCipher = buildCredentialCipher(config, logger);

  // ── delivery plane ────────────────────────────────────────────────────────
  const channelConfigs = new ChannelConfigService(db, cache, logger, credentialCipher);
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

  // Same late-binding trick as the approvals service: the event queue's
  // consumer is the playbook runtime, and the runtime needs the dispatcher,
  // which needs the send queue.
  const runtimeRef: { current?: PlaybookRuntime } = {};
  const processEvent: EventProcessor = async (event) => {
    if (!runtimeRef.current) throw new Error('playbook runtime is not ready yet');
    await createPlaybookEventProcessor(runtimeRef.current, logger)(event);
  };

  const eventQueue: EventQueue = queueDisabledReason
    ? new DisabledEventQueue(logger, queueDisabledReason)
    : new BullEventQueue({
        connection: redis.connection,
        logger,
        concurrency: config.queue.eventConcurrency,
        attempts: config.queue.defaultAttempts,
        backoffDelayMs: 5_000,
        queueName: config.queue.eventQueueName,
        process: processEvent,
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
    // P12: the `hipaa` profile's PHI rule. Runs only for that profile, on the
    // channels it applies to — see engine/compliance/profiles.ts.
    lint: async ({ content, channel, tenantId }) =>
      lintContent({ content, channel, tenantId }, lintRules),
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
    // The engine notifies the fallback approver THROUGH ITSELF — a
    // `system.approval-escalation` playbook, not a private side channel. If the
    // abstraction did not hold for the engine's own notifications, it would not
    // hold for anyone else's.
    notify: async (notice) => {
      await runtimeRef.current?.run({
        type: 'event',
        tenantId: notice.scope.tenantId,
        subTenantId: notice.scope.subTenantId,
        eventType: 'APPROVAL_ESCALATION',
        correlationId: `sla-${notice.approvalId}`,
        // One escalation per approval, however many times the sweeper runs.
        idempotencyKey: `escalation:${notice.approvalId}`,
        payload: {
          context: {
            approvalId: notice.approvalId,
            originalApproverRef: notice.originalApproverRef ?? undefined,
            waitedHours: Math.round(notice.waitedMs / 3_600_000),
          },
        },
      });
    },
  });
  await slaWorker.start();

  // The other end of P5's deferral. The compliance gate holds a message back
  // with a `retryAt` rather than dropping it — quiet hours, a rate limit — and
  // until now nothing read that back, so a "deferred" message was simply lost
  // while its row claimed otherwise. This puts due messages through
  // `dispatcher.dispatch()` again, so the gate re-runs against the state of the
  // world now: somebody who unsubscribed during their own quiet hours does not
  // receive what was waiting for them.
  const deferralWorker = new DeferralWorker({
    db,
    logger,
    dispatcher,
    connection: redis.connection,
  });
  await deferralWorker.start();

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

  // ── messaging plane ───────────────────────────────────────────────────────
  const messageService = new MessageService({ db, logger });
  const conversationService = new ConversationService({ db, logger });
  const analyticsService = new AnalyticsService({ db, logger });
  // Provider callbacks. Nothing in the source consumes a delivery receipt at
  // all, so `provider_message_id` (P2/P3, D22) gets its first reader here.
  const receiptService = new ReceiptService({ db, logger });

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
  // P12. `config.storage` has been declared since P0 with nothing reading it,
  // which is why asset upload answered 501. No ImageProvider is constructed:
  // the port exists (`ports/image.ts`) and the engine ships no adapter, because
  // the source could not generate an image either (D92).
  const storage = createStorageProvider(
    {
      s3Bucket: config.storage.s3Bucket,
      useLocal: config.storage.useLocal,
      localPath: config.storage.localPath,
      publicBaseUrl: config.storage.publicBaseUrl,
      s3PublicBaseUrl: config.storage.s3PublicBaseUrl,
      s3Region: config.storage.s3Region,
    },
    logger,
  );
  const assetService = new AssetService({
    db,
    storage,
    logger,
    maxBytes: config.storage.maxBytes,
  });

  // P12. `tenant_api_keys` has existed since P2 with nothing reading it, and
  // AUTH_MODE=apikey answered 501. This is what a vendor with no Mentera
  // gateway in front of the service authenticates with.
  const apiKeys = new ApiKeyService({
    db,
    logger,
    cache: redis.store,
    keyPrefix: config.redis.keyPrefix,
  });

  // Metered now because the pricing model is undecided: whatever it turns out
  // to be will want to apply to a period that has already happened.
  const usageService = new UsageService({ db, logger });

  const lintRules = mergeRules(...packs.compliance());
  const generator = new ContentGenerator({
    llm,
    assembler: new PromptAssembler(renderer),
    logger,
    lint: async ({ content, channel, tenantId }) =>
      lintContent({ content, channel, tenantId }, lintRules),
  });

  // ── playbook plane ────────────────────────────────────────────────────────
  // Last, because it consumes almost everything above it. This is the
  // replacement for `enhanced-event-handler.ts`'s 17-case switch.
  const playbookRegistry = new PlaybookRegistry({ db, logger, packs });

  runtimeRef.current = new PlaybookRuntime({
    db,
    logger,
    matcher: new PlaybookMatcher({ db, logger }),
    recipients: recipientService,
    context: contextRegistry,
    templates: templateStore,
    renderer,
    generator,
    approvals,
    policies,
    dispatcher,
    preferences,
    packs,
    packConfig: async (scope, packId) => {
      const [row] = await db
        .select({ config: tenantPacks.config })
        .from(tenantPacks)
        .where(and(eq(tenantPacks.tenantId, scope.tenantId), eq(tenantPacks.packId, packId)))
        .limit(1);
      return (row?.config ?? {}) as Record<string, unknown>;
    },
  });

  // ── campaigns (P11) ────────────────────────────────────────────────────────
  // Constructed after the runtime, because the orchestrator drives generation
  // through it — the same path a single event takes, so approvals, the
  // compliance gate and per-recipient throttles apply per message.
  const audienceService = new AudienceService({
    db,
    logger,
    recipients: recipientService,
    defaultImportSystem: 'import',
  });
  const campaignOrchestrator = new CampaignOrchestrator({
    db,
    logger,
    runtime: runtimeRef.current,
    audiences: audienceService,
    concurrency: config.campaigns?.generateConcurrency,
    // Lets cancel recall queued-but-unsent jobs (P12). Without it, cancel is
    // the P11 behaviour: generation stops, anything already queued still sends.
    queue,
  });


  // A pack that failed validation means some playbook silently does not exist.
  // Say so at boot, once, with the paths — not at 3am when a reminder does not
  // arrive.
  const packErrors = packs.errors();
  if (packErrors.length > 0) {
    logger.error('PACK CONTENT FAILED VALIDATION — the affected playbooks are not installed', {
      count: packErrors.length,
      errors: packErrors,
    });
  }

  const app = createApp({
    config,
    logger,
    pool,
    redis,
    dispatcher,
    queue,
    content: { renderer, store: templateStore, generator, packs, assets: assetService, logger },
    assets: { assets: assetService },
    tenancy: { apiKeys, usage: usageService },
    recipients: {
      recipients: recipientService,
      preferences,
      gate: complianceGate,
      erasure: new ErasureService({ db, logger }),
    },
    approvals: { approvals, policies },
    playbooks: { runtime: runtimeRef.current, registry: playbookRegistry, packs },
    messaging: {
      messages: messageService,
      conversations: conversationService,
      analytics: analyticsService,
      recipients: recipientService,
      dispatcher,
    },
    channels: { configs: channelConfigs, dispatcher, queue },
    campaigns: { campaigns: campaignOrchestrator, audiences: audienceService },
    mcp: {
      dispatcher,
      queue,
      logger,
      authenticate: createAuthMiddleware({
        config: config.auth,
        logger,
        verifyApiKey: (key) => apiKeys.verify(key),
      }),
      render: createBodyResolver({ templates: templateStore, renderer }),
    },
    webhooks: {
      receipts: receiptService,
      configs: channelConfigs,
      logger,
      config: config.webhooks,
      twilioAuthToken: config.channels.twilio.authToken,
    },
    compat: {
      messaging: {
        messages: messageService,
        conversations: conversationService,
        analytics: analyticsService,
        recipients: recipientService,
        dispatcher,
      },
      channels: { configs: channelConfigs, dispatcher, queue },
      approvals: { approvals, policies },
      playbooks: { runtime: runtimeRef.current, registry: playbookRegistry, packs },
      recipients: { recipients: recipientService, preferences, gate: complianceGate },
      content: { renderer, store: templateStore, generator, packs, assets: assetService, logger },
      receipts: receiptService,
      context: contextRegistry,
    },
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
        await deferralWorker.close();
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

/**
 * Build the credential cipher, or return undefined when no keys are configured.
 *
 * A misconfigured key is a **boot failure**, not a silent fall back to
 * plaintext: an operator who set `CREDENTIAL_ENCRYPTION_KEYS` and got a typo
 * wrong must not end up with a service quietly writing unencrypted credentials
 * while believing otherwise.
 */
function buildCredentialCipher(
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createServiceLogger>,
): CredentialCipher | undefined {
  const raw = config.credentialEncryption.keys;
  if (!raw) {
    logger.info('credential encryption is off — channel credentials are stored in plaintext', {
      hint: 'set CREDENTIAL_ENCRYPTION_KEYS to enable; see docs/MIGRATION_RUNBOOK.md',
    });
    return undefined;
  }

  const keys = parseKeyList(raw);
  const keyIds = Object.keys(keys);
  const activeKeyId = config.credentialEncryption.activeKeyId ?? keyIds[0];

  if (!activeKeyId) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEYS is set but parsed to no keys');
  }
  if (hasDuplicateKeys(keys)) {
    // Two ids for one key defeats the point of naming them: retiring one would
    // not tell you whether anything still needed the other.
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEYS contains the same key material under more than one id',
    );
  }

  const sealer = new Sealer({ keys, activeKeyId });
  logger.info('credential encryption is on', { keyIds, activeKeyId });
  return new CredentialCipher({ sealer, logger });
}

main().catch((error: unknown) => {
  // The logger may not exist yet — a config failure happens before it is built.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fatal: failed to start outreach-server\n${message}\n`);
  process.exit(1);
});
