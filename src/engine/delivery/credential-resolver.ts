/**
 * Per-tenant credential resolution for every channel.
 *
 * Today only Twilio has a fallback chain (`twilio.ts:38-88`). SendGrid reads
 * `process.env.SENDGRID_API_KEY` in its constructor (`sendgrid.ts:30`) and Slack
 * reads `process.env.SLACK_BOT_TOKEN` in its (`slack.service.ts:18`) — so those
 * two channels are single-tenant by construction, no matter what
 * `medspa_configurations` holds. This generalizes Twilio's chain to all of them.
 *
 * The chain, in order:
 *
 *   1. agent_channel_configs  — the agent's own `from`, with account-level
 *                               secrets INHERITED from the tenant row
 *   2. tenant_channel_configs — full credentials for the tenant
 *   3. env                    — last-resort global fallback
 *   4. nothing                — throw. Never silently no-op: the source returns
 *                               `false` from sendSMS when config is missing
 *                               (twilio.ts:116-122), which is indistinguishable
 *                               from a send failure and produces no alert.
 *
 * There is no per-channel branching in this file. Which columns a channel reads
 * is the channel's business — see `CredentialMapper`.
 */
import type { Logger } from 'winston';

import { AppError } from '../../platform/http/errors.js';
import type { Cache } from '../../platform/redis/index.js';
import type { ChannelCredentials, ChannelType } from '../../ports/channel.js';
import type { ChannelConfigService } from './channel-config.service.js';
import type {
  CredentialMappers,
  EnvChannelCredentials,
  MappedCredential,
} from './credential-mapper.js';

export type { EnvChannelCredentials } from './credential-mapper.js';

export class ChannelNotConfiguredError extends AppError {
  constructor(channel: ChannelType, tenantId: string) {
    super(
      `No credentials for channel '${channel}' on tenant '${tenantId}'`,
      503,
      'CHANNEL_NOT_CONFIGURED',
      { channel, tenantId },
    );
  }
}

export interface ResolveScope {
  tenantId: string;
  senderId?: string;
}


export class CredentialResolver {
  constructor(
    private readonly configs: ChannelConfigService,
    private readonly mappers: CredentialMappers,
    private readonly env: EnvChannelCredentials,
    private readonly cache: Cache,
    private readonly logger: Logger,
  ) {}

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * NO CACHE HERE, DELIBERATELY. THE ROWS BENEATH IT ARE CACHED INSTEAD.
   *
   * This used to write the RESOLVED credential to Redis — decrypted, ready to
   * use, TTL'd. `0013` seals credentials at rest in Postgres, and this quietly
   * put the cleartext into a second store with its own access rules and its own
   * backups. Sealing one copy while caching another is not encryption at rest;
   * it is encryption at rest of the copy nobody reads.
   *
   * Removing it costs almost nothing, which is the point.
   * `ChannelConfigService` already caches both config rows — as stored, so
   * still sealed — and decrypts after the cache. So a resolve is a Redis GET
   * plus a decrypt rather than a Redis GET, and the plaintext exists only for
   * the life of one send.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async resolve(channel: ChannelType, scope: ResolveScope): Promise<ChannelCredentials> {
    return this.resolveUncached(channel, scope);
  }

  private async resolveUncached(
    channel: ChannelType,
    scope: ResolveScope,
  ): Promise<ChannelCredentials> {
    const mapper = this.mappers.get(channel);
    if (!mapper) {
      this.logger.error('no credential mapper registered for channel', { channel });
      throw new ChannelNotConfiguredError(channel, scope.tenantId);
    }

    const [tenant, agent] = await Promise.all([
      this.configs.getTenantConfig(scope.tenantId),
      scope.senderId
        ? this.configs.getAgentConfig(scope.tenantId, scope.senderId)
        : Promise.resolve(null),
    ]);

    const levels: Array<{ source: ChannelCredentials['source']; mapped: MappedCredential | null }> =
      [
        { source: 'agent', mapped: agent ? mapper.fromAgent(agent, tenant) : null },
        { source: 'tenant', mapped: tenant ? mapper.fromTenant(tenant) : null },
        { source: 'env', mapped: mapper.fromEnv(this.env) },
      ];

    for (const level of levels) {
      if (!level.mapped) continue;
      this.logger.debug('credentials resolved', {
        channel,
        tenantId: scope.tenantId,
        source: level.source,
      });
      return {
        tenantId: scope.tenantId,
        senderId: scope.senderId,
        source: level.source,
        values: level.mapped.values,
        from: level.mapped.from,
      };
    }

    this.logger.error('no credentials for channel', {
      channel,
      tenantId: scope.tenantId,
      senderId: scope.senderId,
    });
    throw new ChannelNotConfiguredError(channel, scope.tenantId);
  }
}
