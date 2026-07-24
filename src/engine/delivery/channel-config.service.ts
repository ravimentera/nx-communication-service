/**
 * Reads per-tenant and per-agent channel configuration.
 * Ports `services/config/medspa-config.service.ts` (414L) and
 * `provider-config.service.ts` (464L) onto `tenant_channel_configs` /
 * `agent_channel_configs`.
 *
 * Only the read surface the credential resolver needs is ported here. The CRUD
 * surface those services also carried belongs with the config API in P8.
 *
 * Divergence: the source keeps two in-process `Map` caches with a 5-minute TTL
 * (`medspa-config.service.ts:135-137`), which means N service instances hold N
 * divergent views and a config write only invalidates the instance that served
 * it. Caching moves to Redis, shared, with explicit invalidation.
 */
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { agentChannelConfigs, tenantChannelConfigs } from '../../db/schema.js';
import type { Cache } from '../../platform/redis/index.js';

export type TenantChannelConfig = typeof tenantChannelConfigs.$inferSelect;
export type AgentChannelConfig = typeof agentChannelConfigs.$inferSelect;

const CACHE_TTL_SECONDS = 300;

export class ChannelConfigService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly logger: Logger,
  ) {}

  private tenantKey(tenantId: string): string {
    return this.cache.key('config:tenant', tenantId);
  }

  private agentKey(tenantId: string, senderId: string): string {
    return this.cache.key('config:agent', `${tenantId}:${senderId}`);
  }

  async getTenantConfig(tenantId: string): Promise<TenantChannelConfig | null> {
    const key = this.tenantKey(tenantId);
    const cached = await this.cache.get<TenantChannelConfig>(key);
    if (cached) return cached;

    const [row] = await this.db
      .select()
      .from(tenantChannelConfigs)
      .where(
        and(
          eq(tenantChannelConfigs.tenantId, tenantId),
          eq(tenantChannelConfigs.isActive, true),
        ),
      )
      .limit(1);

    if (!row) {
      this.logger.debug('no channel config for tenant', { tenantId });
      return null;
    }

    await this.cache.set(key, row, CACHE_TTL_SECONDS);
    return row;
  }

  async getAgentConfig(tenantId: string, senderId: string): Promise<AgentChannelConfig | null> {
    const key = this.agentKey(tenantId, senderId);
    const cached = await this.cache.get<AgentChannelConfig>(key);
    if (cached) return cached;

    const [row] = await this.db
      .select()
      .from(agentChannelConfigs)
      .where(
        and(
          eq(agentChannelConfigs.tenantId, tenantId),
          eq(agentChannelConfigs.senderId, senderId),
          eq(agentChannelConfigs.isActive, true),
        ),
      )
      .limit(1);

    if (!row) return null;

    await this.cache.set(key, row, CACHE_TTL_SECONDS);
    return row;
  }

  /** ← `provider-config.service.ts:333 getProvidersByMedspa`. */
  async getAgentsByTenant(tenantId: string): Promise<AgentChannelConfig[]> {
    return this.db
      .select()
      .from(agentChannelConfigs)
      .where(
        and(
          eq(agentChannelConfigs.tenantId, tenantId),
          eq(agentChannelConfigs.isActive, true),
        ),
      );
  }

  /**
   * Every sending number available to a tenant.
   * ← `twilio.ts:193 getAvailableNumbers`.
   */
  async getSenderNumbers(tenantId: string): Promise<{
    tenantNumber?: string;
    agentNumbers: Array<{ senderId: string; phoneNumber: string; name: string }>;
  }> {
    const [tenant, agents] = await Promise.all([
      this.getTenantConfig(tenantId),
      this.getAgentsByTenant(tenantId),
    ]);

    return {
      tenantNumber: tenant?.twilioPhoneNumber ?? undefined,
      agentNumbers: agents
        .filter((a) => a.twilioEnabled && a.twilioPhoneNumber)
        .map((a) => ({
          senderId: a.senderId,
          phoneNumber: a.twilioPhoneNumber as string,
          name: a.name,
        })),
    };
  }

  /**
   * Call after ANY write to either config table. The source's per-instance Map
   * cache could not do this correctly across replicas.
   */
  async invalidate(tenantId: string, senderId?: string): Promise<void> {
    await this.cache.invalidate(this.tenantKey(tenantId));
    if (senderId) {
      await this.cache.invalidate(this.agentKey(tenantId, senderId));
    } else {
      await this.cache.invalidatePattern(this.cache.key('config:agent', `${tenantId}:*`));
    }
    await this.cache.invalidatePattern(this.cache.key('creds', `${tenantId}:*`));
    this.logger.info('channel config cache invalidated', { tenantId, senderId });
  }
}
