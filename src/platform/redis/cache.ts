/**
 * JSON cache on top of the key-value store. Replaces the `redisCache` object
 * from `@mentera/shared-libs/utils/redis-cache.ts`.
 *
 * Divergences:
 *  - No module-scope singleton and no auto-connect on import. The composition
 *    root builds one and hands it to whoever needs it.
 *  - Keys are namespaced by a configurable prefix (default `outreach:`) instead
 *    of the hardcoded `mentera:` / bare `query:` prefixes the source used.
 *  - Every method is failure-tolerant: a cache miss and a cache error are the
 *    same thing to a caller. A cache must never be able to fail a request.
 */
import { createHash } from 'node:crypto';

import type { Logger } from 'winston';

import type { KeyValueStore, RedisHandle } from './client.js';

export const DEFAULT_TTL_SECONDS = 300;

export class Cache {
  private readonly store: KeyValueStore;
  private readonly prefix: string;

  constructor(
    handle: Pick<RedisHandle, 'store' | 'keyPrefix'>,
    private readonly logger?: Logger,
  ) {
    this.store = handle.store;
    this.prefix = handle.keyPrefix;
  }

  /**
   * A cache key, with the variable part hashed.
   *
   * The id is interpolated between `:` separators, and callers compose ids from
   * several values the same way — `config:agent` uses `${tenantId}:${senderId}`.
   * A tenant id containing a colon therefore aliases onto a different pair:
   * `('a:b', 'c')` and `('a', 'b:c')` produce the same string. Tenant ids come
   * from an upstream system and nothing here constrains their characters.
   *
   * Hashing removes the question. It also bounds the key length, which matters
   * for the agent keys that concatenate two ids.
   *
   * The namespace stays in the clear so `KEYS outreach:config:tenant:*` still
   * works for an operator.
   */
  key(namespace: string, id: string): string {
    const digest = createHash('sha256').update(id).digest('hex').slice(0, 32);
    return `${this.prefix}${namespace}:${digest}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.store.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      this.logger?.warn('cache get failed', { key, error: message(error) });
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<boolean> {
    if (ttlSeconds <= 0) return false;
    try {
      await this.store.set(key, JSON.stringify(value), ttlSeconds);
      return true;
    } catch (error) {
      this.logger?.warn('cache set failed', { key, error: message(error) });
      return false;
    }
  }

  async invalidate(key: string): Promise<boolean> {
    try {
      await this.store.del(key);
      return true;
    } catch (error) {
      this.logger?.warn('cache invalidate failed', { key, error: message(error) });
      return false;
    }
  }

  /** Delete every key matching a glob. Batched so a large sweep never blocks Redis. */
  async invalidatePattern(pattern: string): Promise<number> {
    try {
      const keys = await this.store.keys(pattern);
      let deleted = 0;
      for (let i = 0; i < keys.length; i += 100) {
        deleted += await this.store.del(...keys.slice(i, i + 100));
      }
      return deleted;
    } catch (error) {
      this.logger?.warn('cache pattern invalidate failed', { pattern, error: message(error) });
      return 0;
    }
  }

  /** Read through the cache, computing and storing on miss. */
  async wrap<T>(key: string, compute: () => Promise<T>, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const value = await compute();
    await this.set(key, value, ttlSeconds);
    return value;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
