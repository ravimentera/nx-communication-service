import pg from 'pg';
import request from 'supertest';
import winston from 'winston';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createRedis } from '../../src/platform/redis/index.js';

const logger = winston.createLogger({ silent: true });

// A pool that is never asked to connect: pg does not dial until a client is
// requested, so /health and /metrics work without a live database.
const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/outreach',
  SKIP_REDIS: 'true',
  PG_CONNECTION_TIMEOUT: '250',
});

describe('service boot', () => {
  let app: ReturnType<typeof createApp>;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: config.db.url, connectionTimeoutMillis: 250 });
    pool.on('error', () => {});
    const redis = await createRedis(config.redis, logger);
    app = createApp({ config, logger, pool, redis });
  });

  afterAll(async () => {
    await pool.end().catch(() => {});
  });

  it('serves GET /health with no headers', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'outreach-server' });
  });

  it('serves GET /metrics with no headers — Prometheus has no gateway headers', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total');
  });

  it('serves GET / with service info', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('outreach-server');
  });

  it('403s any other path without x-gateway-request', async () => {
    const res = await request(app).get('/anything');
    expect(res.status).toBe(403);
  });

  it('404s an unknown path that did come through the gateway', async () => {
    const res = await request(app)
      .get('/anything')
      .set({ 'x-gateway-request': 'true', 'x-user-id': 'u1', 'x-user-role': 'staff' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('reports 503 from /health/detailed when the database is unreachable', async () => {
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(503);
    expect(res.body.checks.database.status).toBe('down');
    // Redis down is a degradation, not an outage.
    expect(res.body.checks.redis.status).toBe('degraded');
  });

  it('echoes x-request-id back to the caller', async () => {
    const res = await request(app).get('/health').set('x-request-id', 'req-abc');
    expect(res.headers['x-request-id']).toBe('req-abc');
  });
});
