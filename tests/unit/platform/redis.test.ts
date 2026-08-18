/**
 * Graceful degradation is a P1 exit criterion: the service must boot and serve
 * when Redis is down.
 */
import winston from 'winston';

import { Cache } from '../../../src/platform/redis/cache.js';
import { createRedis } from '../../../src/platform/redis/index.js';

const logger = winston.createLogger({ silent: true });
const base = { keyPrefix: 'outreach:', skip: false, port: 6379 };

describe('createRedis degradation', () => {
  it('degrades to the in-memory store when SKIP_REDIS is set', async () => {
    const redis = await createRedis({ ...base, skip: true }, logger);
    expect(redis.connection).toBeNull();
    expect(await redis.isConnected()).toBe(false);
    await expect(redis.store.set('k', 'v')).resolves.toBeUndefined();
    await expect(redis.store.get('k')).resolves.toBe('v');
  });

  it('degrades when no url or host is configured', async () => {
    const redis = await createRedis(base, logger);
    expect(redis.connection).toBeNull();
  });

  it('degrades rather than throwing when the server is unreachable', async () => {
    const redis = await createRedis({ ...base, url: 'redis://127.0.0.1:1' }, logger);
    expect(redis.connection).toBeNull();
    expect(await redis.isConnected()).toBe(false);
    await redis.close();
  });

  /**
   * The degradation has to be FAST, not merely eventual.
   *
   * One connection served both BullMQ and the cache, and BullMQ requires
   * `maxRetriesPerRequest: null` — which means *unlimited retries*, not a limit.
   * So a `store.get()` while Redis was down waited instead of failing, and every
   * Express handler doing a cache lookup waited with it. The in-memory fallback
   * exists so HTTP keeps serving; a lookup that blocks defeats it.
   *
   * The bound here is deliberately loose. What is being asserted is "returns
   * promptly", not a latency figure — a tight threshold would be a flaky test
   * on a loaded CI box, and the defect this catches was measured in seconds.
   */
  it('degrades within a request budget rather than blocking on a dead server', async () => {
    const started = Date.now();
    const redis = await createRedis({ ...base, url: 'redis://127.0.0.1:1' }, logger);

    // Reads and writes both, since the hang was on either.
    await redis.store.set('k', 'v');
    await redis.store.get('k');
    await redis.close();

    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('in-memory store semantics', () => {
  it('expires keys past their TTL', async () => {
    const redis = await createRedis({ ...base, skip: true }, logger);
    await redis.store.set('k', 'v', -1);
    expect(await redis.store.get('k')).toBeNull();
  });

  it('matches globs in keys()', async () => {
    const redis = await createRedis({ ...base, skip: true }, logger);
    await redis.store.set('outreach:a:1', 'x');
    await redis.store.set('outreach:a:2', 'x');
    await redis.store.set('outreach:b:1', 'x');
    expect((await redis.store.keys('outreach:a:*')).sort()).toEqual([
      'outreach:a:1',
      'outreach:a:2',
    ]);
  });
});

describe('Cache', () => {
  it('namespaces keys with the configured prefix', async () => {
    const redis = await createRedis({ ...base, skip: true }, logger);
    const cache = new Cache(redis, logger);
    // The namespace stays in the clear so `KEYS outreach:recipient:*` still
    // works for an operator; the id is hashed because callers compose ids from
    // several values with `:` separators, and a tenant id containing a colon
    // would otherwise alias onto a different pair.
    const key = cache.key('recipient', 'r1');
    expect(key).toMatch(/^outreach:recipient:[0-9a-f]{32}$/);
    expect(cache.key('recipient', 'r1')).toBe(key);
    expect(cache.key('recipient', 'r2')).not.toBe(key);

    // The collision this closes: ('a:b','c') and ('a','b:c') used to produce
    // the same string.
    expect(cache.key('config', 'a:b:c')).not.toBe(cache.key('config:a', 'b:c'));
  });

  it('round-trips JSON', async () => {
    const redis = await createRedis({ ...base, skip: true }, logger);
    const cache = new Cache(redis, logger);
    await cache.set('k', { a: 1 });
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });
  });

  it('computes on miss and caches the result', async () => {
    const redis = await createRedis({ ...base, skip: true }, logger);
    const cache = new Cache(redis, logger);
    // The `jest` global is not injected under ESM; a counter is simpler than
    // pulling in @jest/globals for one call.
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { hit: false };
    };

    expect(await cache.wrap('k', compute)).toEqual({ hit: false });
    expect(await cache.wrap('k', compute)).toEqual({ hit: false });
    expect(calls).toBe(1);
  });

  it('invalidates by pattern', async () => {
    const redis = await createRedis({ ...base, skip: true }, logger);
    const cache = new Cache(redis, logger);
    await cache.set(cache.key('t', '1'), 1);
    await cache.set(cache.key('t', '2'), 2);
    expect(await cache.invalidatePattern('outreach:t:*')).toBe(2);
    expect(await cache.get(cache.key('t', '1'))).toBeNull();
  });
});
