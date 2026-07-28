/**
 * Reads per-tenant and per-agent channel configuration.
 * Ports `services/config/medspa-config.service.ts` (414L) and
 * `provider-config.service.ts` (464L) onto `tenant_channel_configs` /
 * `agent_channel_configs`.
 *
 * P3 ported only the read surface the credential resolver needs; P8 adds the
 * writes behind `/v1/channels/configs`, because providers-service calls
 * `GET|POST|PUT /config/medspa/:medspaId` and that is one of the five call sites
 * the P10 cutover repoints.
 *
 * Divergence: the source keeps two in-process `Map` caches with a 5-minute TTL
 * (`medspa-config.service.ts:135-137`), which means N service instances hold N
 * divergent views and a config write only invalidates the instance that served
 * it. Caching moves to Redis, shared, with explicit invalidation.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { agentChannelConfigs, tenantChannelConfigs } from '../../db/schema.js';
import type { Cache } from '../../platform/redis/index.js';

export type TenantChannelConfig = typeof tenantChannelConfigs.$inferSelect;
export type AgentChannelConfig = typeof agentChannelConfigs.$inferSelect;

/** Writable columns. `tenantId`/`senderId` come from the scope, never the body. */
export type TenantChannelConfigInput = Omit<
  typeof tenantChannelConfigs.$inferInsert,
  'id' | 'tenantId' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'
>;
export type AgentChannelConfigInput = Omit<
  typeof agentChannelConfigs.$inferInsert,
  'id' | 'tenantId' | 'senderId' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'
>;

const CACHE_TTL_SECONDS = 300;

/** Drop `undefined` so a partial update leaves untouched columns alone. */
function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<T>;
}

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
   * Create or replace a tenant's channel config.
   *
   * `tenant_channel_configs` has UNIQUE(tenant_id), matching
   * `medspa_configurations`' own constraint, so this is an upsert rather than
   * the source's separate create/update pair — which returns 409 on a second
   * POST and 404 on a PUT before the first one. Callers get one idempotent
   * verb and the compat router maps both legacy methods onto it.
   */
  async upsertTenantConfig(
    tenantId: string,
    values: Partial<TenantChannelConfigInput>,
    actor?: string,
  ): Promise<TenantChannelConfig> {
    const [row] = await this.db
      .insert(tenantChannelConfigs)
      .values({
        tenantId,
        name: values.name ?? tenantId,
        ...values,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: tenantChannelConfigs.tenantId,
        // Only what the caller supplied. A PUT that names two SendGrid fields
        // must not null out the Twilio credentials it did not mention.
        set: { ...definedOnly(values), updatedBy: actor, updatedAt: sql`now()` },
      })
      .returning();

    await this.invalidate(tenantId);
    return row!;
  }

  /** Same shape, per agent. UNIQUE(tenant_id, sender_id) backs the conflict target. */
  async upsertAgentConfig(
    tenantId: string,
    senderId: string,
    values: Partial<AgentChannelConfigInput>,
    actor?: string,
  ): Promise<AgentChannelConfig> {
    const [row] = await this.db
      .insert(agentChannelConfigs)
      .values({
        tenantId,
        senderId,
        name: values.name ?? senderId,
        ...values,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: [agentChannelConfigs.tenantId, agentChannelConfigs.senderId],
        set: { ...definedOnly(values), updatedBy: actor, updatedAt: sql`now()` },
      })
      .returning();

    await this.invalidate(tenantId, senderId);
    return row!;
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
