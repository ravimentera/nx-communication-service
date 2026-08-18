/**
 * `AUTH_MODE=apikey` end to end, against a real Postgres.
 *
 * This is the mode that makes the engine usable without a Mentera gateway, so
 * the properties under test are the ones that decide whether it is a tenant
 * boundary or a suggestion: a key cannot name its own tenant, cannot claim
 * permissions it was not granted, and cannot promote itself to admin with a
 * header.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { baselineMigrations } from '../helpers/migrations.js';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import express, { type Express } from 'express';
import { Client } from 'pg';
import request from 'supertest';
import winston from 'winston';

import { createDb, type Db } from '../../src/db/index.js';
import { tenants } from '../../src/db/schema.js';
import { ApiKeyService, hashKey } from '../../src/engine/tenancy/api-key.service.js';
import {
  createAuthMiddleware,
  Permission,
  requirePermissions,
  requireTenant,
} from '../../src/platform/http/auth.middleware.js';
import { createErrorHandler } from '../../src/platform/http/error-handler.js';
import { createRedis, type RedisHandle } from '../../src/platform/redis/index.js';

const logger = winston.createLogger({ silent: true });
const TENANT = 'tenant-keys-1';
const OTHER_TENANT = 'tenant-keys-2';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let redis: RedisHandle;
let service: ApiKeyService;

/**
 * A tiny app in `apikey` mode, so the middleware is exercised as mounted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WINDOW IS PINNED PER APP, NOT TO THE WALL CLOCK
 *
 * Production derives the window from `Math.floor(Date.now() / windowMs)` — a
 * FIXED window aligned to the minute, which is the right behaviour there and a
 * source of nondeterminism here: a test issuing five requests that happen to
 * straddle a minute boundary has its counter reset midway and sees
 * `[200,200,200,200,200]` where it expected two 429s. How often that happens
 * depends only on what second the suite starts at.
 *
 * Each app gets its own window id instead. The middleware's limiting logic is
 * what these tests are about; deriving the window is not.
 */
let windowSeq = 0;

function buildApp(rateLimitPerMinute = 0): Express {
  const windowId = `w${(windowSeq += 1)}`;
  const app = express();
  app.use(express.json());
  app.use(
    createAuthMiddleware({
      config: { mode: 'apikey', apiKeyRateLimitPerMinute: rateLimitPerMinute },
      logger,
      verifyApiKey: (key) => service.verify(key),
      countRequest: (keyId, windowSeconds) =>
        redis.store.incrWithTtl(`rl:${keyId}:${windowId}`, windowSeconds),
    }),
  );
  app.get('/whoami', (req, res) => {
    res.json({ ...requireTenant(req), identity: req.identity });
  });
  app.post('/send', requirePermissions(Permission.SEND), (_req, res) => {
    res.json({ sent: true });
  });
  app.use(createErrorHandler({ logger, production: false }));
  return app;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  for (const file of baselineMigrations(dir)) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.end();

  const created = createDb({ url: container.getConnectionUri() }, logger);
  db = created.db;
  pool = created.pool;

  await db
    .insert(tenants)
    .values([
      { id: TENANT, name: 'Keys One' },
      { id: OTHER_TENANT, name: 'Keys Two' },
    ])
    .onConflictDoNothing();

  redis = await createRedis({ skip: true, keyPrefix: 'test:' } as never, logger);
  service = new ApiKeyService({ db, logger, cache: redis.store });
}, 300_000);

afterAll(async () => {
  await redis?.close().catch(() => {});
  await pool?.end().catch(() => {});
  await container?.stop().catch(() => {});
});

describe('ApiKeyService', () => {
  it('returns the plaintext once and stores only its digest', async () => {
    const { key, record } = await service.create({
      tenantId: TENANT,
      name: 'ci',
      scopes: [Permission.SEND],
    });

    expect(key).toMatch(/^ork_[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({ tenantId: TENANT, name: 'ci', scopes: [Permission.SEND] });

    // The plaintext is nowhere in the row the list endpoint would return.
    const listed = await service.list(TENANT);
    expect(JSON.stringify(listed)).not.toContain(key);

    // What is stored is the digest, which is what makes the unique index and
    // the single-query lookup work — see D94.
    const [row] = await db.select().from((await import('../../src/db/schema.js')).tenantApiKeys);
    expect(row?.keyHash).toBe(hashKey(key));
  });

  it('refuses to mint a key with no scopes', async () => {
    await expect(
      service.create({ tenantId: TENANT, name: 'everything', scopes: [] }),
    ).rejects.toThrow(/at least one scope/);
  });

  it('verifies a key it issued', async () => {
    const { key, record } = await service.create({
      tenantId: TENANT,
      name: 'verify-me',
      scopes: [Permission.SEND, Permission.APPROVE],
    });
    await expect(service.verify(key)).resolves.toEqual({
      keyId: record.id,
      tenantId: TENANT,
      scopes: [Permission.SEND, Permission.APPROVE],
    });
  });

  it.each([
    ['an unknown key', 'ork_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['a key without the prefix', 'not-one-of-ours'],
    ['an empty string', ''],
  ])('rejects %s', async (_label, presented) => {
    await expect(service.verify(presented)).resolves.toBeNull();
  });

  it('stops accepting a revoked key', async () => {
    const { key, record } = await service.create({
      tenantId: TENANT,
      name: 'doomed',
      scopes: [Permission.SEND],
    });
    expect(await service.verify(key)).not.toBeNull();

    await service.revoke(TENANT, record.id);
    expect(await service.verify(key)).toBeNull();

    // Revoked, not deleted — the row survives for the incident review.
    expect((await service.list(TENANT)).find((k) => k.id === record.id)?.revokedAt).toBeInstanceOf(
      Date,
    );
  });

  it('stops accepting an expired key', async () => {
    const { key } = await service.create({
      tenantId: TENANT,
      name: 'past-it',
      scopes: [Permission.SEND],
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await service.verify(key)).toBeNull();
  });

  it('will not revoke another tenant’s key', async () => {
    const { record } = await service.create({
      tenantId: TENANT,
      name: 'mine',
      scopes: [Permission.SEND],
    });
    await expect(service.revoke(OTHER_TENANT, record.id)).rejects.toThrow(/not found/);
  });

  it('rotate keeps the old key alive for the grace window', async () => {
    const original = await service.create({
      tenantId: TENANT,
      name: 'rotating',
      scopes: [Permission.SEND],
    });

    const rotated = await service.rotate(TENANT, original.record.id, 3600);

    // Both work during the overlap — rotation without one is an outage.
    expect(await service.verify(original.key)).not.toBeNull();
    expect(await service.verify(rotated.key)).not.toBeNull();
    expect(rotated.record.id).not.toBe(original.record.id);
    expect(rotated.record.scopes).toEqual([Permission.SEND]);
    expect(rotated.previousExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rotate with no grace retires the old key immediately', async () => {
    const original = await service.create({
      tenantId: TENANT,
      name: 'hard-cut',
      scopes: [Permission.SEND],
    });
    await service.rotate(TENANT, original.record.id, 0);
    expect(await service.verify(original.key)).toBeNull();
  });
});

describe('AUTH_MODE=apikey', () => {
  let sendKey: string;

  beforeAll(async () => {
    sendKey = (
      await service.create({ tenantId: TENANT, name: 'http', scopes: [Permission.SEND] })
    ).key;
  });

  it('accepts the key as a bearer token', async () => {
    const res = await request(buildApp()).get('/whoami').set('authorization', `Bearer ${sendKey}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TENANT);
  });

  it('accepts the key in x-api-key', async () => {
    const res = await request(buildApp()).get('/whoami').set('x-api-key', sendKey);
    expect(res.status).toBe(200);
  });

  it('401s with no key at all', async () => {
    expect((await request(buildApp()).get('/whoami')).status).toBe(401);
  });

  it('401s an invalid key, saying nothing about why', async () => {
    const res = await request(buildApp()).get('/whoami').set('x-api-key', 'ork_nope');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid API key');
  });

  it('takes the tenant from the key, not from a header', async () => {
    // The whole security property. A key that could name its own tenant would
    // make every other tenant predicate in the service decorative.
    const res = await request(buildApp())
      .get('/whoami')
      .set('x-api-key', sendKey)
      .set('x-tenant-id', OTHER_TENANT)
      .set('x-medspa-id', OTHER_TENANT);

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TENANT);
  });

  it('takes permissions from the key’s scopes, not from a header', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set('x-api-key', sendKey)
      .set('x-user-permissions', JSON.stringify([Permission.ADMIN]));

    expect(res.body.identity.permissions).toEqual([Permission.SEND]);
  });

  it('cannot promote itself to admin with x-user-role', async () => {
    // `requirePermissions` short-circuits for role `admin`, so a key that could
    // set its own role would bypass every permission check in the service.
    const res = await request(buildApp())
      .get('/whoami')
      .set('x-api-key', sendKey)
      .set('x-user-role', 'admin');

    expect(res.body.identity.role).toBe('system');
  });

  it('enforces the scopes it does have', async () => {
    const app = buildApp();
    expect((await request(app).post('/send').set('x-api-key', sendKey)).status).toBe(200);

    const approveOnly = (
      await service.create({ tenantId: TENANT, name: 'approver', scopes: [Permission.APPROVE] })
    ).key;
    expect((await request(app).post('/send').set('x-api-key', approveOnly)).status).toBe(403);
  });

  it('accepts a sub-tenant from a header, because the key already fixes the tenant', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set('x-api-key', sendKey)
      .set('x-sub-tenant-id', 'branch-7');
    expect(res.body.subTenantId).toBe('branch-7');
  });

  it('rate-limits per key and reports Retry-After', async () => {
    const app = buildApp(3);
    const limited = (
      await service.create({ tenantId: TENANT, name: 'chatty', scopes: [Permission.SEND] })
    ).key;

    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await request(app).get('/whoami').set('x-api-key', limited)).status);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);

    const rejected = await request(app).get('/whoami').set('x-api-key', limited);
    expect(rejected.headers['retry-after']).toBe('60');
  });

  it('limits each key separately', async () => {
    const app = buildApp(2);
    const a = (await service.create({ tenantId: TENANT, name: 'a', scopes: [Permission.SEND] }))
      .key;
    const b = (await service.create({ tenantId: TENANT, name: 'b', scopes: [Permission.SEND] }))
      .key;

    for (let i = 0; i < 3; i += 1) await request(app).get('/whoami').set('x-api-key', a);

    expect((await request(app).get('/whoami').set('x-api-key', a)).status).toBe(429);
    expect((await request(app).get('/whoami').set('x-api-key', b)).status).toBe(200);
  });

  it('fails closed when no verifier was wired', async () => {
    const app = express();
    app.use(createAuthMiddleware({ config: { mode: 'apikey' }, logger }));
    app.get('/whoami', (_req, res) => res.json({ ok: true }));
    app.use(createErrorHandler({ logger, production: false }));

    const res = await request(app).get('/whoami').set('x-api-key', sendKey);
    expect(res.status).toBe(501);
  });
});
