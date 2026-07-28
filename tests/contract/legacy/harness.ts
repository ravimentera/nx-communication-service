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
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Express } from 'express';
import { Client } from 'pg';
import winston from 'winston';

import { createApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/config/index.js';
import { createDb, type Db } from '../../../src/db/index.js';
import { ApprovalService } from '../../../src/engine/approvals/approval.service.js';
import { PolicyService } from '../../../src/engine/approvals/policy.service.js';
import { ComplianceGate } from '../../../src/engine/compliance/gate.js';
import { PreferenceService } from '../../../src/engine/compliance/preference.service.js';
import { ContentGenerator } from '../../../src/engine/content/generator.js';
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
import { loadPacks } from '../../../src/packs/loader.js';
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
    // Both spellings are accepted for the parallel-run window (§0.7); the
    // legacy one is what the gateway actually sends today.
    'x-medspa-id': TENANT,
    'x-provider-id': PROVIDER,
    // JSON, not a comma-separated list — `parsePermissions` JSON.parses it.
    'x-user-permissions': JSON.stringify([
      'outreach:send',
      'outreach:approve',
      'outreach:approve:bulk',
      'outreach:config:write',
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
  for (const file of readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
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
  const generator = new ContentGenerator({
    llm: {
      generate: async () => ({
        content: 'generated',
        model: 'test',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 1,
      }),
      generateJson: async () => ({
        value: {},
        model: 'test',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 1,
      }),
    } as never,
    assembler: new PromptAssembler(renderer),
    logger,
  });

  const runtime = new PlaybookRuntime({
    db,
    logger,
    matcher: new PlaybookMatcher({ db, logger }),
    recipients,
    context: contextRegistry,
    templates: templateStore,
    renderer,
    generator,
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
  const recipientDeps = { recipients, preferences, gate };
  const contentDeps = { renderer, store: templateStore, generator, packs };

  const app = createApp({
    config,
    logger,
    pool,
    redis,
    dispatcher,
    queue,
    content: contentDeps,
    recipients: recipientDeps,
    approvals: { approvals, policies },
    playbooks: playbookDeps,
    messaging,
    channels,
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
    },
  };
}
