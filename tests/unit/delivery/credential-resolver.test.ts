/**
 * The four levels of the fallback chain, including the case the source gets
 * subtly right and everything else gets wrong: an agent supplies the `from`, the
 * tenant supplies the secrets (`twilio.ts:44-56`).
 */
import winston from 'winston';

import { createCredentialMappers } from '../../../src/adapters/channels/credentials.js';
import type {
  AgentChannelConfig,
  ChannelConfigService,
  TenantChannelConfig,
} from '../../../src/engine/delivery/channel-config.service.js';
import type { EnvChannelCredentials } from '../../../src/engine/delivery/credential-mapper.js';
import {
  ChannelNotConfiguredError,
  CredentialResolver,
} from '../../../src/engine/delivery/credential-resolver.js';
import { Cache, createRedis } from '../../../src/platform/redis/index.js';

const logger = winston.createLogger({ silent: true });

const EMPTY_ENV: EnvChannelCredentials = {
  sendgrid: {},
  smtp: { port: 587, secure: false },
  twilio: {},
  slack: {},
};

function tenantConfig(overrides: Partial<TenantChannelConfig> = {}): TenantChannelConfig {
  return {
    twilioAccountSid: null,
    twilioAuthToken: null,
    twilioPhoneNumber: null,
    twilioEnabled: false,
    sendgridApiKey: null,
    sendgridFromEmail: null,
    sendgridFromName: null,
    sendgridEnabled: false,
    slackBotToken: null,
    slackDefaultChannel: null,
    slackEnabled: false,
    ...overrides,
  } as TenantChannelConfig;
}

function agentConfig(overrides: Partial<AgentChannelConfig> = {}): AgentChannelConfig {
  return {
    twilioPhoneNumber: null,
    twilioEnabled: false,
    emailFromAddress: null,
    emailFromName: null,
    emailEnabled: false,
    slackUserId: null,
    slackEnabled: false,
    ...overrides,
  } as AgentChannelConfig;
}

function configs(
  tenant: TenantChannelConfig | null,
  agent: AgentChannelConfig | null = null,
): ChannelConfigService {
  return {
    getTenantConfig: async () => tenant,
    getAgentConfig: async () => agent,
  } as unknown as ChannelConfigService;
}

async function resolverFor(
  service: ChannelConfigService,
  env: EnvChannelCredentials = EMPTY_ENV,
): Promise<CredentialResolver> {
  // skip:true gives the in-memory store, so each test gets a fresh cache.
  const redis = await createRedis({ keyPrefix: 'outreach:', skip: true, port: 6379 }, logger);
  return new CredentialResolver(
    service,
    createCredentialMappers(),
    env,
    new Cache(redis, logger),
    logger,
  );
}

describe('level 1 — agent supplies `from`, tenant supplies the secrets', () => {
  it('combines the agent number with the tenant twilio account', async () => {
    const resolver = await resolverFor(
      configs(
        tenantConfig({
          twilioEnabled: true,
          twilioAccountSid: 'AC-tenant',
          twilioAuthToken: 'tok-tenant',
          twilioPhoneNumber: '+15550000000',
        }),
        agentConfig({ twilioEnabled: true, twilioPhoneNumber: '+15551111111' }),
      ),
    );

    const creds = await resolver.resolve('sms', { tenantId: 't1', senderId: 's1' });
    expect(creds.source).toBe('agent');
    expect(creds.from).toBe('+15551111111');
    expect(creds.values.accountSid).toBe('AC-tenant');
    expect(creds.values.authToken).toBe('tok-tenant');
  });

  it('falls through to the tenant when the agent has a number but the tenant has no account', async () => {
    const resolver = await resolverFor(
      configs(tenantConfig(), agentConfig({ twilioEnabled: true, twilioPhoneNumber: '+1555' })),
    );
    await expect(resolver.resolve('sms', { tenantId: 't1', senderId: 's1' })).rejects.toThrow(
      ChannelNotConfiguredError,
    );
  });

  it('ignores an agent row whose channel is disabled', async () => {
    const resolver = await resolverFor(
      configs(
        tenantConfig({
          twilioEnabled: true,
          twilioAccountSid: 'AC',
          twilioAuthToken: 'tok',
          twilioPhoneNumber: '+15550000000',
        }),
        agentConfig({ twilioEnabled: false, twilioPhoneNumber: '+15551111111' }),
      ),
    );
    const creds = await resolver.resolve('sms', { tenantId: 't1', senderId: 's1' });
    expect(creds.source).toBe('tenant');
    expect(creds.from).toBe('+15550000000');
  });
});

describe('level 2 — tenant credentials', () => {
  it('resolves sms from the tenant row', async () => {
    const resolver = await resolverFor(
      configs(
        tenantConfig({
          twilioEnabled: true,
          twilioAccountSid: 'AC',
          twilioAuthToken: 'tok',
          twilioPhoneNumber: '+1555',
        }),
      ),
    );
    const creds = await resolver.resolve('sms', { tenantId: 't1' });
    expect(creds.source).toBe('tenant');
    expect(creds.values).toEqual({ accountSid: 'AC', authToken: 'tok' });
  });

  it('resolves email from the tenant row', async () => {
    const resolver = await resolverFor(
      configs(
        tenantConfig({
          sendgridEnabled: true,
          sendgridApiKey: 'SG.key',
          sendgridFromEmail: 'a@b.c',
          sendgridFromName: 'Clinic',
        }),
      ),
    );
    const creds = await resolver.resolve('email', { tenantId: 't1' });
    expect(creds.source).toBe('tenant');
    expect(creds.from).toBe('a@b.c');
    expect(creds.values.fromName).toBe('Clinic');
  });

  it('skips a tenant row whose channel is disabled', async () => {
    const resolver = await resolverFor(
      configs(tenantConfig({ sendgridEnabled: false, sendgridApiKey: 'SG.key' })),
      { ...EMPTY_ENV, sendgrid: { apiKey: 'SG.env', fromEmail: 'env@x.y' } },
    );
    const creds = await resolver.resolve('email', { tenantId: 't1' });
    expect(creds.source).toBe('env');
  });
});

describe('level 3 — environment fallback', () => {
  it('falls back to env when no rows exist', async () => {
    const resolver = await resolverFor(configs(null), {
      ...EMPTY_ENV,
      twilio: { accountSid: 'AC-env', authToken: 'tok-env', phoneNumber: '+1999' },
    });
    const creds = await resolver.resolve('sms', { tenantId: 't1' });
    expect(creds.source).toBe('env');
    expect(creds.from).toBe('+1999');
  });

  it('uses SMTP for email when SendGrid is absent', async () => {
    const resolver = await resolverFor(configs(null), {
      ...EMPTY_ENV,
      smtp: { host: 'smtp.x.y', port: 587, user: 'u', pass: 'p', secure: false },
      sendgrid: { fromEmail: 'from@x.y' },
    });
    const creds = await resolver.resolve('email', { tenantId: 't1' });
    expect(creds.source).toBe('env');
    expect(creds.values.transport).toBe('smtp');
    expect(creds.values.host).toBe('smtp.x.y');
  });

  it('resolves trivially for channels that carry no shared secret', async () => {
    const resolver = await resolverFor(configs(null));
    for (const channel of ['push', 'webhook', 'in_app'] as const) {
      const creds = await resolver.resolve(channel, { tenantId: 't1' });
      expect(creds.source).toBe('env');
      expect(creds.values).toEqual({});
    }
  });
});

describe('level 4 — nothing configured', () => {
  it('throws rather than silently no-opping', async () => {
    const resolver = await resolverFor(configs(null));
    await expect(resolver.resolve('sms', { tenantId: 't1' })).rejects.toThrow(
      ChannelNotConfiguredError,
    );
  });

  it('reports 503 with the channel and tenant in the details', async () => {
    const resolver = await resolverFor(configs(null));
    try {
      await resolver.resolve('slack', { tenantId: 't9' });
      fail('expected a throw');
    } catch (error) {
      const err = error as ChannelNotConfiguredError;
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe('CHANNEL_NOT_CONFIGURED');
      expect(err.details).toEqual({ channel: 'slack', tenantId: 't9' });
    }
  });
});

describe('caching', () => {
  /**
   * The resolver deliberately does NOT cache.
   *
   * It used to write the resolved credential — decrypted and ready to use — to
   * Redis. `0013` seals credentials at rest in Postgres, and this put the
   * cleartext into a second store with its own access rules and backups.
   * Sealing one copy while caching another is not encryption at rest.
   *
   * The cost of removing it is one Redis GET plus a decrypt instead of one
   * Redis GET: `ChannelConfigService` caches both config rows AS STORED, so the
   * rows are still cached and still sealed. This test now pins the read
   * reaching the config service, which is where the caching belongs.
   */
  it('delegates to the config service on every resolve, so no plaintext is cached', async () => {
    let tenantReads = 0;
    const service = {
      getTenantConfig: async () => {
        tenantReads += 1;
        return tenantConfig({
          twilioEnabled: true,
          twilioAccountSid: 'AC',
          twilioAuthToken: 'tok',
          twilioPhoneNumber: '+1555',
        });
      },
      getAgentConfig: async () => null,
    } as unknown as ChannelConfigService;

    const resolver = await resolverFor(service);
    await resolver.resolve('sms', { tenantId: 't1' });
    await resolver.resolve('sms', { tenantId: 't1' });
    // Two calls, two reads — of the config service, whose own cache is what
    // makes that cheap and which stores the row still encrypted.
    expect(tenantReads).toBe(2);
  });

  it('resolves per sender, so two agents do not share a from', async () => {
    const resolver = await resolverFor(
      configs(
        tenantConfig({
          twilioEnabled: true,
          twilioAccountSid: 'AC',
          twilioAuthToken: 'tok',
          twilioPhoneNumber: '+1555',
        }),
        agentConfig({ twilioEnabled: true, twilioPhoneNumber: '+15551111111' }),
      ),
    );
    const withAgent = await resolver.resolve('sms', { tenantId: 't1', senderId: 's1' });
    const withoutAgent = await resolver.resolve('sms', { tenantId: 't1' });
    expect(withAgent.from).toBe('+15551111111');
    expect(withoutAgent.from).toBe('+1555');
  });
});
