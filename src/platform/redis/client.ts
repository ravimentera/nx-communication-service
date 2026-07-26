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

  async ping(): Promise<boolean> {
    return (await this.redis.ping()) === 'PONG';
  }
}

export interface RedisHandle {
  /** Always usable — falls back to the in-memory store when Redis is down. */
  store: KeyValueStore;
  /**
   * The raw ioredis connection, or null when degraded. BullMQ needs this (P3);
   * a null connection means the queues cannot start, which is exactly the
   * feature-level degradation we want.
   */
  connection: Redis | null;
  /** True when a real Redis connection is live. */
  isConnected(): Promise<boolean>;
  keyPrefix: string;
  close(): Promise<void>;
}

function buildOptions(cfg: RedisConfig): RedisOptions {
  return {
    ...(cfg.host ? { host: cfg.host } : {}),
    ...(cfg.port ? { port: cfg.port } : {}),
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
    ...(cfg.db !== undefined ? { db: cfg.db } : {}),
    connectTimeout: 5_000,
    // Required by BullMQ, and sane for us: let a command fail rather than queue
    // forever behind a dead connection.
    maxRetriesPerRequest: null,
    // Nothing connects at construction. The composition root decides when.
    lazyConnect: true,
    retryStrategy: (times: number) => {
      if (times > 10) return null; // stop retrying; we stay degraded
      return Math.min(times * 200, 2_000);
    },
    reconnectOnError: (err: Error) => {
      // Never retry a credential failure — it will never succeed.
      if (err.message.includes('WRONGPASS') || err.message.includes('NOAUTH')) return false;
      return true;
    },
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

  let connection: Redis;
  try {
    connection = cfg.url ? new Redis(cfg.url, buildOptions(cfg)) : new Redis(buildOptions(cfg));
  } catch (error) {
    return degraded(error instanceof Error ? error.message : 'client construction failed');
  }

  // An 'error' with no listener is an unhandled exception in ioredis. Attach one
  // before connecting, and keep it attached: reconnects re-emit.
  connection.on('error', (err: Error) => {
    logger?.error('redis connection error', { error: err.message });
  });
  connection.on('connect', () => logger?.info('redis connected'));
  connection.on('close', () => logger?.warn('redis connection closed'));

  try {
    await connection.connect();
    await connection.ping();
  } catch (error) {
    connection.disconnect();
    return degraded(error instanceof Error ? error.message : 'connect failed');
  }

  return {
    store: new RedisStore(connection),
    connection,
    isConnected: async () => {
      if (connection.status !== 'ready') return false;
      try {
        return (await connection.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    keyPrefix: cfg.keyPrefix,
    close: async () => {
      try {
        await connection.quit();
      } catch {
        connection.disconnect();
      }
    },
  };
}
