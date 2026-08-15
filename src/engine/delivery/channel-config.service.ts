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
import {
  TENANT_SECRET_COLUMNS,
  type CredentialCipher,
} from '../tenancy/credential-cipher.js';
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
    /**
     * P12. Absent means credentials stay in the flat plaintext columns, which
     * is the P3 behaviour and remains the default: turning encryption on is an
     * operator decision that has to be sequenced with the backfill script, and
     * a service that started sealing credentials on its own would produce rows
     * only it could read.
     */
    private readonly cipher?: CredentialCipher,
  ) {}

  /**
   * Open a row's sealed credentials, if any. Reads go through this so a caller
   * sees usable values whether the row is sealed or still plaintext — see the
   * header of `credential-cipher.ts` for why both have to work at once.
   */
  private decrypt(row: TenantChannelConfig): TenantChannelConfig {
    return this.cipher ? this.cipher.decryptRow(row) : row;
  }

  private tenantKey(tenantId: string): string {
    return this.cache.key('config:tenant', tenantId);
  }

  private agentKey(tenantId: string, senderId: string): string {
    return this.cache.key('config:agent', `${tenantId}:${senderId}`);
  }

  async getTenantConfig(tenantId: string): Promise<TenantChannelConfig | null> {
    const key = this.tenantKey(tenantId);
    // Decrypted AFTER the cache, never before: what goes into Redis is the row
    // as stored, so sealing a credential in Postgres does not put the cleartext
    // into a second store that has its own access rules.
    const cached = await this.cache.get<TenantChannelConfig>(key);
    if (cached) return this.decrypt(cached);

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
    return this.decrypt(row);
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

  /**
   * Reverse lookup for an inbound Twilio callback (P8b).
   *
   * A webhook carries no tenant — only the account sid Twilio signed it with,
   * which is what identifies whose auth token verifies the signature. Not
   * cached: it runs once per callback and a stale hit here would reject real
   * traffic after a credential rotation.
   */
  async getTenantConfigByTwilioAccount(accountSid: string): Promise<TenantChannelConfig | null> {
    const [row] = await this.db
      .select()
      .from(tenantChannelConfigs)
      .where(
        and(
          eq(tenantChannelConfigs.twilioAccountSid, accountSid),
          eq(tenantChannelConfigs.isActive, true),
        ),
      )
      .limit(1);
    return row ?? null;
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
    // Seal on write when a cipher is configured, so a credential set through the
    // API never lands as plaintext even while the backfill is still working
    // through the rows that arrived before it.
    const sealed = this.cipher ? await this.sealCredentials(tenantId, values) : values;

    const [row] = await this.db
      .insert(tenantChannelConfigs)
      .values({
        tenantId,
        name: values.name ?? tenantId,
        ...sealed,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: tenantChannelConfigs.tenantId,
        // Only what the caller supplied. A PUT that names two SendGrid fields
        // must not null out the Twilio credentials it did not mention.
        set: { ...definedOnly(sealed), updatedBy: actor, updatedAt: sql`now()` },
      })
      .returning();

    await this.invalidate(tenantId);
    return this.decrypt(row!);
  }

  /**
   * Move any supplied secret out of its flat column and into the sealed bundle.
   *
   * **The flat column is nulled in the same write.** Leaving it — the first cut
   * of this — meant a credential set through the API *after* encryption was
   * turned on still landed in cleartext, and then into the config cache, which
   * is the exact thing encryption is for. The value is recoverable from the
   * bundle in the same row, so nothing is lost.
   *
   * This nulls only the columns this request supplied. Rows the service never
   * writes — the ones `9003_channel_configs.sql` inserts during the parallel
   * run — keep their plaintext until `0013_encrypt_credentials.sql` clears them,
   * and the read path resolves both shapes until then.
   */
  private async sealCredentials(
    tenantId: string,
    values: Partial<TenantChannelConfigInput>,
  ): Promise<Partial<TenantChannelConfigInput>> {
    if (!this.cipher) return values;

    const supplied = TENANT_SECRET_COLUMNS.filter((column) => values[column]);
    if (supplied.length === 0) return values;

    // The stored bundle, not the caller's: `credentials_encrypted` is one jsonb
    // column, so writing only the newly-sealed entries would drop every
    // credential this request did not mention — the same class of bug as the
    // pack-config replace in D95.
    const [current] = await this.db
      .select({ credentialsEncrypted: tenantChannelConfigs.credentialsEncrypted })
      .from(tenantChannelConfigs)
      .where(eq(tenantChannelConfigs.tenantId, tenantId))
      .limit(1);

    const existing = (current?.credentialsEncrypted ?? {}) as Record<string, unknown>;
    const bundle = this.cipher.seal(
      Object.fromEntries(supplied.map((column) => [column, values[column]])),
    );

    return {
      ...values,
      // Sealed, so the cleartext does not stay in the column beside it.
      ...Object.fromEntries(supplied.map((column) => [column, null])),
      credentialsEncrypted: { ...existing, ...bundle },
      encryptionKeyId: this.cipher.activeKeyId,
    };
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
