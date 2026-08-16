/**
 * Shared harness for the legacy contract suites.
 *
 * These tests exercise the **whole app** — auth middleware, routers, services,
 * a real Postgres — through supertest with the exact headers the gateway sends.
 * Anything less would not catch the failures that matter here: a path that
 * shadows another, a tenant predicate that goes missing behind a router mount,
 * an envelope that changed shape.
 *
 * (Testcontainers, not a real database — see the header of schema.test.ts.)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baselineMigrations } from '../../helpers/migrations.js';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Express } from 'express';
import { Client } from 'pg';
import winston from 'winston';

import { createApp } from '../../../src/app.js';
import { AudienceService } from '../../../src/engine/campaigns/audience.service.js';
import { CampaignOrchestrator } from '../../../src/engine/campaigns/orchestrator.js';
import { loadConfig } from '../../../src/config/index.js';
import { createDb, type Db } from '../../../src/db/index.js';
import { ApprovalService } from '../../../src/engine/approvals/approval.service.js';
import { PolicyService } from '../../../src/engine/approvals/policy.service.js';
import { ComplianceGate } from '../../../src/engine/compliance/gate.js';
import { ErasureService } from '../../../src/engine/compliance/erasure.service.js';
import { PreferenceService } from '../../../src/engine/compliance/preference.service.js';
import { LocalStorageProvider } from '../../../src/adapters/storage/local.provider.js';
import { AssetService } from '../../../src/engine/content/asset.service.js';
import { ApiKeyService } from '../../../src/engine/tenancy/api-key.service.js';
import { UsageService } from '../../../src/engine/tenancy/usage.service.js';
import { ContentGenerator } from '../../../src/engine/content/generator.js';
import { DraftService } from '../../../src/engine/outreach/draft.service.js';
import { PromptAssembler } from '../../../src/engine/content/prompt-assembler.js';
import { Renderer } from '../../../src/engine/content/renderer.js';
import { DrizzleTemplateStore } from '../../../src/engine/content/store.js';
import { ContextRegistry, CORE_PACK } from '../../../src/engine/context/registry.js';
import { ChannelConfigService } from '../../../src/engine/delivery/channel-config.service.js';
import { CredentialResolver } from '../../../src/engine/delivery/credential-resolver.js';
import { Dispatcher } from '../../../src/engine/delivery/dispatcher.js';
import {
  DisabledNotificationQueue,
  type NotificationQueue,
} from '../../../src/engine/delivery/notification-queue.js';
import { AnalyticsService } from '../../../src/engine/messaging/analytics.service.js';
import { ConversationService } from '../../../src/engine/messaging/conversation.service.js';
import { MessageService } from '../../../src/engine/messaging/message.service.js';
import { ReceiptService } from '../../../src/engine/messaging/receipt.service.js';
import { PlaybookMatcher } from '../../../src/engine/playbooks/matcher.js';
import { PlaybookRegistry } from '../../../src/engine/playbooks/registry.js';
import { PlaybookRuntime } from '../../../src/engine/playbooks/runtime.js';
import { RecipientService } from '../../../src/engine/recipients/recipient.service.js';
import { createChannelRegistry } from '../../../src/adapters/channels/index.js';
import { createCredentialMappers } from '../../../src/adapters/channels/credentials.js';
import { InlineContextProvider } from '../../../src/adapters/context/inline.provider.js';
import { createBodyResolver } from '../../../src/api/compat/send.js';
import { IdentityResolver } from '../../../src/engine/content/identity.js';
import { loadPacks } from '../../../src/packs/loader.js';
import { createAuthMiddleware } from '../../../src/platform/http/auth.middleware.js';
import { Cache, createRedis } from '../../../src/platform/redis/index.js';

export const TENANT = '00000000-0000-4000-8000-00000000c001';
export const OTHER_TENANT = '00000000-0000-4000-8000-00000000c002';
export const PROVIDER = 'provider-1';
export const OTHER_PROVIDER = 'provider-2';

/** Exactly what `packages/gateway/src/index.ts` forwards. */
export function gatewayHeaders(
  over: Record<string, string> = {},
): Record<string, string> {
  return {
    'x-gateway-request': 'true',
    'x-user-id': 'user-1',
    'x-user-role': 'provider',
    // `x-tenant-id`, not `x-medspa-id`. The gateway forwards both spellings as
    // of P12 (D106) and this engine now reads only the generic one — a request
    // carrying just the medspa name has no tenant. `endpoints.test.ts` asserts
    // that directly; every other suite simply speaks the current protocol.
    'x-tenant-id': TENANT,
    // Still an accepted alias for `x-sender-id`: a sender identity, not the
    // tenancy boundary, and its callers were not established to have moved.
    'x-provider-id': PROVIDER,
    // JSON, not a comma-separated list — `parsePermissions` JSON.parses it.
    'x-user-permissions': JSON.stringify([
      'outreach:send',
      'outreach:approve',
      'outreach:approve:bulk',
      'outreach:config:write',
      'outreach:templates:write',
      'outreach:playbooks:write',
    ]),
    ...over,
  };
}

export interface Harness {
  app: Express;
  db: Db;
  receipts: ReceiptService;
  queue: NotificationQueue;
  stop: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const logger = winston.createLogger({ silent: true });
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();

  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  for (const file of baselineMigrations(dir)) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.query(
    `INSERT INTO tenants (id, name, timezone) VALUES ('${TENANT}','Legacy','UTC'), ('${OTHER_TENANT}','Other','UTC')`,
  );
  await client.end();

  const config = loadConfig({
    DATABASE_URL: container.getConnectionUri(),
    SKIP_REDIS: 'true',
    SKIP_QUEUE: 'true',
    // The gate stays in shadow so a contract test asserts the *shape* of a
    // response rather than the tenant's compliance posture (D41).
    COMPLIANCE_SHADOW_MODE: 'true',
    // Level 3 of the credential chain. Without *some* level resolving, every
    // send is a 503 `ChannelNotConfiguredError` — which is the correct answer
    // for an unconfigured tenant (D20) and the wrong thing to be asserting in
    // an envelope-shape test. Dry-run stays on, so nothing leaves the process.
    CHANNEL_DRY_RUN: 'true',
    SENDGRID_API_KEY: 'SG.contract-test',
    DEFAULT_EMAIL_SENDER: 'noreply@example.test',
    TWILIO_ACCOUNT_SID: 'ACcontracttest',
    TWILIO_AUTH_TOKEN: 'contract-test',
    TWILIO_PHONE_NUMBER: '+15550000000',
    SLACK_BOT_TOKEN: 'xoxb-contract-test',
    // Provider callbacks are signature-verified with these (P8b). The URL is
    // stated rather than reconstructed, because supertest's ephemeral port
    // would otherwise be part of what Twilio signed.
    WEBHOOK_PUBLIC_URL: 'https://webhooks.example.test',
    SLACK_SIGNING_SECRET: 'slack-signing-secret',
  });

  const { db, pool } = createDb(config.db, logger);
  const redis = await createRedis(config.redis, logger);
  const cache = new Cache(redis, logger);

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
  const registry = createChannelRegistry({ logger, db, dryRun: true, preferSmtp: false });
  const queue = new DisabledNotificationQueue(logger, 'contract tests');

  const preferences = new PreferenceService({
    db,
    logger,
    defaultTimezone: 'UTC',
    unsubscribeBaseUrl: 'https://example.test/unsubscribe',
  });
  const gate = new ComplianceGate({
    db,
    logger,
    preferences,
    shadowMode: true,
    unsubscribeUrl: async () => 'https://example.test/unsubscribe/tok',
  });
  const dispatcher = new Dispatcher({ db, registry, credentials, queue, logger, compliance: gate });

  const policies = new PolicyService({ db, logger, rotation: { next: async () => 0 } });
  const approvals = new ApprovalService({ db, logger, policies, dispatcher });

  const contextRegistry = new ContextRegistry({ installedPacks: async () => [CORE_PACK] });
  contextRegistry.register(new InlineContextProvider(), CORE_PACK);
  const recipients = new RecipientService({ db, logger, context: contextRegistry });

  const packs = loadPacks(join(process.cwd(), 'packs'), logger);
  const renderer = new Renderer({ logger, aliases: packs.aliasMaps() });
  const templateStore = new DrizzleTemplateStore(db, logger);
  /**
   * A stand-in model. It returns the shape `generator.draftSchema` requires —
   * a `content` string and an optional `subject` — because the generator
   * validates the model's JSON and a contract test asserting a 200 must not be
   * asserting that validation failed.
   *
   * Token counts are non-zero so the `/ai` contract test can assert they are
   * reported at all (D31: the source estimated them by word count).
   */
  const generator = new ContentGenerator({
    llm: {
      name: 'stub',
      listModels: () => ['stub-model'],
      generate: async () => ({
        content: 'generated body',
        model: 'stub-model',
        tokensIn: 12,
        tokensOut: 7,
        latencyMs: 1,
      }),
      /**
       * Branches on the caller's schema. P12 added `generateStructured`, which
       * asks for a shape that is not the draft contract — `/ai/multimodal` wants
       * `{textContent, images[]}` — so a stub that always returns
       * `{content, subject}` would make that endpoint's contract test assert
       * only that the handler passed something through.
       */
      generateJson: async (req: { jsonSchema?: { properties?: Record<string, unknown> } }) => ({
        content: req.jsonSchema?.properties?.textContent
          ? {
              textContent: 'generated body',
              images: [{ description: 'a photo of a thing', position: 'above the first paragraph' }],
            }
          : { content: 'generated body', subject: 'Generated subject' },
        model: 'stub-model',
        tokensIn: 12,
        tokensOut: 7,
        latencyMs: 1,
      }),
    } as never,
    assembler: new PromptAssembler(renderer),
    logger,
  });

  const identity = new IdentityResolver({ db, logger });

  const runtime = new PlaybookRuntime({
    db,
    logger,
    matcher: new PlaybookMatcher({ db, logger }),
    recipients,
    context: contextRegistry,
    templates: templateStore,
    renderer,
    generator,
    identity,
    approvals,
    policies,
    dispatcher,
    preferences,
    packs,
    packConfig: async () => ({}),
  });

  const receipts = new ReceiptService({ db, logger });
  const messaging = {
    messages: new MessageService({ db, logger }),
    conversations: new ConversationService({ db, logger }),
    analytics: new AnalyticsService({ db, logger }),
    recipients,
    dispatcher,
  };
  const channels = { configs: channelConfigs, dispatcher, queue };
  const playbookDeps = { runtime, registry: new PlaybookRegistry({ db, logger, packs }), packs };
  const recipientDeps = {
    recipients,
    preferences,
    gate,
    erasure: new ErasureService({ db, logger }),
  };
  // P12. A real `AssetService` over a throwaway directory, so the upload path
  // is exercised end to end rather than mocked. No `images` provider: the engine
  // ships no adapter (D92), and the contract is that the generate-image route
  // 501s in exactly that configuration.
  const assetRoot = await mkdtemp(join(tmpdir(), 'outreach-assets-'));
  const assets = new AssetService({
    db,
    logger,
    maxBytes: 1024 * 1024,
    storage: new LocalStorageProvider({
      config: { root: assetRoot, publicBaseUrl: 'http://test.local/assets' },
      logger,
    }),
  });

  const contentDeps = { renderer, store: templateStore, generator, identity, packs, assets, logger };

  // P11. Registered here so the OpenAPI contract test actually SEES the
  // campaign routes — a harness that omits a dep bundle makes
  // "documents every registered /v1 route" pass by having nothing to document.
  const audiences = new AudienceService({ db, logger, recipients });
  const campaigns = new CampaignOrchestrator({ db, logger, runtime, audiences });
  const campaignDeps = { audiences, campaigns };

  // P12 (D101). The compat shim's `/communications/generate-message` and
  // `/automated-messages/generate` both delegate here now, and so does
  // `POST /v1/outreach/generate` and the `generateDraft` MCP tool.
  const drafts = new DraftService({ generator, identity, packs, recipients, approvals });

  const app = createApp({
    config,
    logger,
    pool,
    redis,
    dispatcher,
    queue,
    content: contentDeps,
    // P12, registered for the same reason as the campaign bundle below.
    assets: { assets },
    tenancy: {
      apiKeys: new ApiKeyService({ db, logger, cache: redis.store }),
      usage: new UsageService({ db, logger }),
    },
    recipients: recipientDeps,
    approvals: { approvals, policies },
    playbooks: playbookDeps,
    outreach: { drafts },
    messaging,
    channels,
    campaigns: campaignDeps,
    mcp: {
      dispatcher,
      queue,
      logger,
      authenticate: createAuthMiddleware({ config: config.auth, logger }),
      render: createBodyResolver({ templates: templateStore, renderer, senderIdentity: identity }),
      drafts,
      approvals,
      conversations: messaging.conversations,
      campaigns,
    },
    webhooks: {
      receipts,
      configs: channelConfigs,
      logger,
      config: config.webhooks,
      twilioAuthToken: config.channels.twilio.authToken,
    },
    compat: {
      messaging,
      channels,
      approvals: { approvals, policies },
      playbooks: playbookDeps,
      recipients: recipientDeps,
      content: contentDeps,
      receipts,
      context: contextRegistry,
      drafts,
    },
  });

  return {
    app,
    db,
    receipts,
    queue,
    stop: async () => {
      await redis.close().catch(() => {});
      await pool.end().catch(() => {});
      await container.stop().catch(() => {});
      await rm(assetRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
