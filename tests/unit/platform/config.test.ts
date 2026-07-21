import { ConfigError, loadConfig } from '../../../src/config/index.js';

const minimal = { DATABASE_URL: 'postgres://u:p@localhost:5432/outreach' };

describe('loadConfig', () => {
  it('throws a readable error when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/);
  });

  it('applies defaults for everything else', () => {
    const config = loadConfig(minimal);
    expect(config.server.port).toBe(5007);
    expect(config.server.isProduction).toBe(false);
    expect(config.auth.mode).toBe('gateway');
    expect(config.auth.gatewayOnly).toBe(true);
    expect(config.redis.keyPrefix).toBe('outreach:');
    expect(config.observability.serviceName).toBe('outreach-server');
  });

  it('defaults CHANNEL_DRY_RUN on, so a misconfigured deploy cannot send', () => {
    expect(loadConfig(minimal).channels.dryRun).toBe(true);
    expect(loadConfig({ ...minimal, CHANNEL_DRY_RUN: 'false' }).channels.dryRun).toBe(false);
  });

  it('coerces numeric and boolean vars', () => {
    const config = loadConfig({ ...minimal, PORT: '6000', DB_SSL: 'true', SKIP_REDIS: 'true' });
    expect(config.server.port).toBe(6000);
    expect(config.db.ssl).toBe(true);
    expect(config.redis.skip).toBe(true);
  });

  it('treats an empty string as unset', () => {
    expect(loadConfig({ ...minimal, REDIS_URL: '  ' }).redis.url).toBeUndefined();
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ ...minimal, PORT: 'abc' })).toThrow(/expected a number/);
  });

  it('rejects an unknown AUTH_MODE', () => {
    expect(() => loadConfig({ ...minimal, AUTH_MODE: 'oauth' })).toThrow(ConfigError);
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({ PORT: 'abc', AUTH_MODE: 'nope' });
      fail('expected loadConfig to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('PORT');
      expect(message).toContain('AUTH_MODE');
    }
  });

  it('prefers AWS_BEDROCK_REGION over AWS_REGION for the llm client', () => {
    expect(loadConfig({ ...minimal, AWS_REGION: 'us-west-2' }).llm.region).toBe('us-west-2');
    expect(
      loadConfig({ ...minimal, AWS_REGION: 'us-west-2', AWS_BEDROCK_REGION: 'us-east-1' }).llm
        .region,
    ).toBe('us-east-1');
  });
});
