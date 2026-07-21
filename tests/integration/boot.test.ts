import request from 'supertest';

import { createApp } from '../../src/app.js';

describe('service boot', () => {
  const app = createApp();

  it('serves GET /health without auth headers', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('serves service info at GET /', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('outreach-server');
  });
});
