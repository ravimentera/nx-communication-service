import express, { type Express, type Request } from 'express';
import request from 'supertest';
import winston from 'winston';

import {
  createAuthMiddleware,
  Permission,
  requirePermissions,
  type AuthConfig,
  type RequestIdentity,
} from '../../../src/platform/http/auth.middleware.js';
import { createErrorHandler } from '../../../src/platform/http/error-handler.js';

const logger = winston.createLogger({ silent: true });

function buildApp(config: Partial<AuthConfig> = {}): Express {
  const app = express();
  app.use(createAuthMiddleware({ config: { mode: 'gateway', ...config }, logger }));
  app.get('/health', (_req, res) => void res.json({ status: 'ok' }));
  app.get('/whoami', (req: Request, res) => void res.json(req.identity ?? null));
  app.get('/admin', requirePermissions(Permission.CONFIG_WRITE), (_req, res) =>
    void res.json({ ok: true }),
  );
  app.use(createErrorHandler({ logger, production: true }));
  return app;
}

const GATEWAY = { 'x-gateway-request': 'true', 'x-user-id': 'u1', 'x-user-role': 'staff' };

describe('createAuthMiddleware — gateway mode', () => {
  it('rejects a non-gateway request with 403', async () => {
    const res = await request(buildApp()).get('/whoami');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('accepts x-internal-request: gateway as an alternative gate', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ 'x-internal-request': 'gateway', 'x-user-id': 'u1', 'x-user-role': 'staff' });
    expect(res.status).toBe(200);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ 'x-gateway-request': 'true', 'x-user-role': 'staff' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 when x-user-role is missing', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ 'x-gateway-request': 'true', 'x-user-id': 'u1' });
    expect(res.status).toBe(401);
  });

  it('skips auth for /health', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.status).toBe(200);
  });

  it('skips auth for OPTIONS', async () => {
    const res = await request(buildApp()).options('/whoami');
    expect(res.status).not.toBe(403);
  });
});

/**
 * The tenancy headers, after P12 dropped the medspa aliases (D106).
 *
 * These tests used to assert the opposite — that `x-medspa-id` alone populated
 * the tenant. That was correct for the extraction window and is exactly the
 * behaviour being removed, so they are inverted rather than deleted: the alias
 * being *gone* is the property worth pinning, and a test that merely stopped
 * mentioning it would not catch someone helpfully adding the fallback back.
 */
describe('createAuthMiddleware — tenancy headers', () => {
  it('populates tenantId from x-tenant-id', async () => {
    const res = await request(buildApp()).get('/whoami').set({ ...GATEWAY, 'x-tenant-id': 't1' });
    expect((res.body as RequestIdentity).tenantId).toBe('t1');
  });

  it('does NOT accept x-medspa-id — the alias is gone', async () => {
    // The gateway forwards both spellings, so nothing real sends only this one.
    // A request that does has no tenant, and fails at `requireTenant` rather
    // than being served against an empty string.
    const res = await request(buildApp()).get('/whoami').set({ ...GATEWAY, 'x-medspa-id': 'm1' });
    expect((res.body as RequestIdentity).tenantId).toBe('');
  });

  it('ignores x-medspa-id entirely when both are present', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ ...GATEWAY, 'x-medspa-id': 'm1', 'x-tenant-id': 't1' });
    expect((res.body as RequestIdentity).tenantId).toBe('t1');
  });

  it('does NOT accept x-location-id for subTenantId', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ ...GATEWAY, 'x-location-id': 'l1' });
    expect((res.body as RequestIdentity).subTenantId).toBeUndefined();
  });

  it('reads subTenantId from x-sub-tenant-id', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ ...GATEWAY, 'x-location-id': 'l1', 'x-sub-tenant-id': 's1' });
    expect((res.body as RequestIdentity).subTenantId).toBe('s1');
  });

  it('still accepts x-provider-id for senderId, which was NOT dropped', async () => {
    // Deliberately untouched: a sender identity is not the tenancy boundary,
    // and this phase did not establish that its callers had moved.
    const res = await request(buildApp())
      .get('/whoami')
      .set({ ...GATEWAY, 'x-provider-id': 'p1' });
    expect((res.body as RequestIdentity).senderId).toBe('p1');
  });

  it('lets x-sender-id win over x-provider-id', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ ...GATEWAY, 'x-provider-id': 'p1', 'x-sender-id': 'snd1' });
    expect((res.body as RequestIdentity).senderId).toBe('snd1');
  });
});

describe('createAuthMiddleware — permissions parsing', () => {
  it('parses a JSON array', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ ...GATEWAY, 'x-user-permissions': JSON.stringify(['outreach:send']) });
    expect((res.body as RequestIdentity).permissions).toEqual(['outreach:send']);
  });

  it('falls back to [] on malformed JSON without throwing', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ ...GATEWAY, 'x-user-permissions': '{not json' });
    expect(res.status).toBe(200);
    expect((res.body as RequestIdentity).permissions).toEqual([]);
  });

  it('falls back to [] when the JSON is valid but not an array', async () => {
    const res = await request(buildApp())
      .get('/whoami')
      .set({ ...GATEWAY, 'x-user-permissions': '{"a":1}' });
    expect((res.body as RequestIdentity).permissions).toEqual([]);
  });
});

describe('createAuthMiddleware — AUTH_MODE seam', () => {
  it('returns 501 for apikey mode', async () => {
    const res = await request(buildApp({ mode: 'apikey' })).get('/whoami').set(GATEWAY);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('returns 501 for jwt mode', async () => {
    const res = await request(buildApp({ mode: 'jwt' })).get('/whoami').set(GATEWAY);
    expect(res.status).toBe(501);
  });

  it('gatewayOnly=false accepts a direct request', async () => {
    const res = await request(buildApp({ gatewayOnly: false }))
      .get('/whoami')
      .set({ 'x-user-id': 'u1', 'x-user-role': 'staff' });
    expect(res.status).toBe(200);
  });
});

describe('requirePermissions', () => {
  it('403s when the permission is absent', async () => {
    const res = await request(buildApp()).get('/admin').set(GATEWAY);
    expect(res.status).toBe(403);
  });

  it('passes when the permission is present', async () => {
    const res = await request(buildApp())
      .get('/admin')
      .set({ ...GATEWAY, 'x-user-permissions': JSON.stringify([Permission.CONFIG_WRITE]) });
    expect(res.status).toBe(200);
  });

  it('short-circuits for the admin role', async () => {
    const res = await request(buildApp())
      .get('/admin')
      .set({ ...GATEWAY, 'x-user-role': 'admin' });
    expect(res.status).toBe(200);
  });

  it('short-circuits for the admin permission', async () => {
    const res = await request(buildApp())
      .get('/admin')
      .set({ ...GATEWAY, 'x-user-permissions': JSON.stringify([Permission.ADMIN]) });
    expect(res.status).toBe(200);
  });
});

/**
 * Two bypass rules on one path.
 *
 * `bypassRules` was `Record<path, rule>`, so declaring an unauthenticated
 * `GET /x` and a separate rule for `POST /x` kept only whichever was written
 * second — and the loser was either unreachable or unprotected depending on the
 * order. A security control whose shape cannot express its own domain is one
 * waiting to be got wrong.
 *
 * Nothing in the service passes `bypassRules` today: the unsubscribe link is
 * served by mounting its router before the auth middleware. These pin the
 * option's contract so the next caller gets a working one.
 */
describe('createAuthMiddleware — bypass rules', () => {
  function appWithBypasses(): Express {
    const app = express();
    app.use(
      createAuthMiddleware({
        config: { mode: 'gateway' },
        logger,
        bypassRules: [
          { method: 'GET', path: '/thing', param: 'token', value: 'abc' },
          { method: 'POST', path: '/thing', param: 'token', value: 'xyz' },
        ],
      }),
    );
    app.get('/thing', (_req, res) => void res.json({ via: 'get' }));
    app.post('/thing', (_req, res) => void res.json({ via: 'post' }));
    app.use(createErrorHandler({ logger, production: true }));
    return app;
  }

  it('honours BOTH rules on the same path — the collision', async () => {
    const app = appWithBypasses();

    // Under the old shape one of these was 403, and which one depended purely
    // on declaration order.
    expect((await request(app).get('/thing?token=abc')).status).toBe(200);
    expect((await request(app).post('/thing?token=xyz')).status).toBe(200);
  });

  it('does not let one method’s token open another method', async () => {
    const app = appWithBypasses();
    expect((await request(app).get('/thing?token=xyz')).status).toBe(403);
    expect((await request(app).post('/thing?token=abc')).status).toBe(403);
  });

  it('still requires the parameter to match', async () => {
    const app = appWithBypasses();
    expect((await request(app).get('/thing')).status).toBe(403);
    expect((await request(app).get('/thing?token=wrong')).status).toBe(403);
  });

  it('leaves every other path authenticated', async () => {
    const app = appWithBypasses();
    expect((await request(app).get('/other?token=abc')).status).toBe(403);
  });
});
