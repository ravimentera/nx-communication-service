/**
 * Redis connection — vendored from `@mentera/shared-libs/utils/redis-client.ts`
 * and `redis-cache.ts`, consolidated into one module.
 *
 * The source had TWO overlapping implementations with different degradation
 * strategies: `redis-client.ts` swapped in a hand-rolled mock object, while
 * `redis-cache.ts` returned null from every operation. Both auto-connected at
 * module import. Here there is one store interface with two implementations, and
 * connection is started by the composition root, never at import time.
 *
 * GRACEFUL DEGRADATION IS LOAD-BEARING (P1 exit criteria): when Redis is
 * unreachable the service must still boot and serve HTTP. Queue features
 * degrade; request handling does not 500. Callers get the in-memory store and
 * never have to null-check.
 */
// Named import, not default: under NodeNext the default export of ioredis
// resolves to a namespace, which is neither constructable nor usable as a type.
import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from 'winston';

export interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  db?: number;
  /** Namespace for every key this service writes. Default 'outreach:'. */
  keyPrefix: string;
  /** Skip Redis entirely and run on the in-memory store. */
  skip: boolean;
}

/** The subset of Redis this service uses. Both backends implement it. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  /**
   * Atomic increment, returning the new value. Added in P6 for the round-robin
   * approver rotation, which needs a counter that two replicas cannot both read
   * as the same number. `get`-then-`set` would not do.
   */
  incr(key: string): Promise<number>;
  /**
   * Increment, and set the key to expire in `ttlSeconds` if it did not already
   * have an expiry. Added in P12 for the per-API-key rate limiter, which needs a
   * counter that expires on its own — plain `incr` leaves a key that grows
   * forever and a window that never resets.
   */
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
  ping(): Promise<boolean>;
}

class MemoryStore implements KeyValueStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.entries.delete(key)) deleted += 1;
    return deleted;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return [...this.entries.keys()].filter((key) => regex.test(key));
  }

  /**
   * Atomic by virtue of the single-threaded event loop — nothing awaits between
   * the read and the write, so no interleaving is possible within this process.
   * Across processes it is not atomic, but a degraded in-memory store is
   * per-process anyway and shares nothing to race over.
   */
  async incr(key: string): Promise<number> {
    const current = Number((await this.get(key)) ?? 0);
    const next = (Number.isFinite(current) ? current : 0) + 1;
    await this.set(key, String(next));
    return next;
  }

  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.entries.get(key);
    const expired = entry?.expiresAt !== null && (entry?.expiresAt ?? 0) < Date.now();
    const current = entry && !expired ? Number(entry.value) : 0;
    const next = (Number.isFinite(current) ? current : 0) + 1;
    // Keep the original expiry on a running window; start one on a new key.
    const expiresAt =
      entry && !expired && entry.expiresAt !== null
        ? entry.expiresAt
        : Date.now() + ttlSeconds * 1000;
    this.entries.set(key, { value: String(next), expiresAt });
    return next;
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

class RedisStore implements KeyValueStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) await this.redis.set(key, value, 'EX', ttlSeconds);
    else await this.redis.set(key, value);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.redis.del(...keys);
  }

  async keys(pattern: string): Promise<string[]> {
    return this.redis.keys(pattern);
  }

  async incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  /**
   * `INCR` then `EXPIRE … NX`, in one pipeline. `NX` is what makes the window
   * fixed rather than sliding-by-accident: refreshing the TTL on every hit would
   * let a caller at the limit hold the key alive indefinitely and never get a
   * fresh allowance.
   */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, ttlSeconds, 'NX')
      .exec();
    const value = results?.[0]?.[1];
    return typeof value === 'number' ? value : Number(value ?? 1);
  }

  async ping(): Promise<boolean> {
    return (await this.redis.ping()) === 'PONG';
  }
}

export interface RedisHandle {
  /**
   * Always usable — falls back to the in-memory store when Redis is down.
   *
   * Backed by its OWN connection, configured to fail a command fast rather than
   * queue it. Sharing BullMQ's connection meant inheriting
   * `maxRetriesPerRequest: null`, so a cache lookup during an outage blocked an
   * Express handler instead of degrading.
   */
  store: KeyValueStore;
  /**
   * The raw ioredis connection **for BullMQ**, or null when degraded. It is a
   * different socket from the one behind `store`, because the two want opposite
   * retry semantics — see the note above `baseOptions`.
   *
   * A null connection means the queues cannot start, which is exactly the
   * feature-level degradation we want.
   */
  connection: Redis | null;
  /** True when a real Redis connection is live. */
  isConnected(): Promise<boolean>;
  keyPrefix: string;
  close(): Promise<void>;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO CONNECTIONS, BECAUSE THEY WANT OPPOSITE THINGS
 *
 * BullMQ REQUIRES `maxRetriesPerRequest: null` — it manages its own blocking
 * reads and a bounded retry breaks them. That option means *unlimited retries*,
 * so a command issued while Redis is down waits instead of failing.
 *
 * One connection served both BullMQ and the general cache, so every
 * `store.get()` during an outage inherited that: an Express handler doing a
 * cache lookup blocked rather than degrading, which is the opposite of the
 * "HTTP keeps serving when Redis is down" property `MemoryStore` exists for.
 *
 * (The old comment on that option claimed it made a command "fail rather than
 * queue forever". It does exactly the reverse. Worth knowing, because the
 * option reads like a limit and is an opt-out of one.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND retryStrategy NO LONGER GIVES UP
 *
 * It returned `null` after ten attempts — roughly eleven seconds — which does
 * not merely stop retrying: ioredis ENDS the connection. Redis coming back
 * afterwards restored nothing, and the process served from the in-memory
 * fallback until somebody restarted it. A blip became an outage that outlived
 * its cause.
 *
 * Giving up is not needed for boot: `connect()` rejects on the first failure
 * regardless of the strategy (verified), so `createRedis` still degrades to
 * memory immediately when Redis is down at startup. What the strategy governs
 * is RECOVERY, and there the right answer is to keep trying with a capped
 * delay for ever.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function baseOptions(cfg: RedisConfig): RedisOptions {
  return {
    ...(cfg.host ? { host: cfg.host } : {}),
    ...(cfg.port ? { port: cfg.port } : {}),
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
    ...(cfg.db !== undefined ? { db: cfg.db } : {}),
    connectTimeout: 5_000,
    // Nothing connects at construction. The composition root decides when.
    lazyConnect: true,
    // Capped, and never null. See the note above.
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
    reconnectOnError: (err: Error) => {
      // Never retry a credential failure — it will never succeed.
      if (err.message.includes('WRONGPASS') || err.message.includes('NOAUTH')) return false;
      return true;
    },
  };
}

/** The cache connection: every command fails fast, so no request ever waits. */
function cacheOptions(cfg: RedisConfig): RedisOptions {
  return {
    ...baseOptions(cfg),
    // The two together are what make a lookup during an outage return in
    // microseconds: no queueing behind a dead socket, and one retry rather than
    // unlimited. `Cache` turns the rejection into a miss, which is exactly the
    // degradation the design asks for.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // A backstop for the case neither of the above covers: a connection that is
    // writeable but whose server has stopped answering.
    commandTimeout: 1_000,
  };
}

/** The queue connection: BullMQ's requirements, which are the opposite. */
function queueOptions(cfg: RedisConfig): RedisOptions {
  return {
    ...baseOptions(cfg),
    // Required by BullMQ. It manages its own blocking reads and a bounded
    // retry breaks them.
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  };
}

/**
 * Connect to Redis, degrading to the in-memory store on any failure.
 * Never throws.
 */
export async function createRedis(cfg: RedisConfig, logger?: Logger): Promise<RedisHandle> {
  const memory = new MemoryStore();

  const degraded = (reason: string): RedisHandle => {
    logger?.warn('redis unavailable — degrading to in-memory store', { reason });
    return {
      store: memory,
      connection: null,
      isConnected: async () => false,
      keyPrefix: cfg.keyPrefix,
      close: async () => {},
    };
  };

  if (cfg.skip) return degraded('SKIP_REDIS=true');
  if (!cfg.url && !cfg.host) return degraded('no REDIS_URL or REDIS_HOST configured');

  const build = (options: RedisOptions): Redis =>
    cfg.url ? new Redis(cfg.url, options) : new Redis(options);

  let cache: Redis;
  let queue: Redis;
  try {
    cache = build(cacheOptions(cfg));
    queue = build(queueOptions(cfg));
  } catch (error) {
    return degraded(error instanceof Error ? error.message : 'client construction failed');
  }

  // An 'error' with no listener is an unhandled exception in ioredis. Attach one
  // before connecting, and keep it attached: reconnects re-emit.
  for (const [name, conn] of [
    ['cache', cache],
    ['queue', queue],
  ] as const) {
    conn.on('error', (err: Error) => {
      logger?.error('redis connection error', { connection: name, error: err.message });
    });
    conn.on('connect', () => logger?.info('redis connected', { connection: name }));
    conn.on('close', () => logger?.warn('redis connection closed', { connection: name }));
  }

  const disconnectBoth = (): void => {
    cache.disconnect();
    queue.disconnect();
  };

  try {
    await Promise.all([cache.connect(), queue.connect()]);
    await cache.ping();
  } catch (error) {
    disconnectBoth();
    return degraded(error instanceof Error ? error.message : 'connect failed');
  }

  return {
    store: new RedisStore(cache),
    connection: queue,
    isConnected: async () => {
      if (cache.status !== 'ready') return false;
      try {
        return (await cache.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    keyPrefix: cfg.keyPrefix,
    close: async () => {
      await Promise.all(
        [cache, queue].map(async (conn) => {
          try {
            await conn.quit();
          } catch {
            conn.disconnect();
          }
        }),
      );
    },
  };
}
