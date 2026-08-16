/**
 * `GET /v1/usage` — the metering behind whatever the pricing model turns out to
 * be (the plan's Open Question 5).
 *
 * The properties that matter for a number someone might invoice against: it is
 * tenant-scoped, the period bounds do what they say, and `to` is exclusive so
 * two consecutive reports across a boundary do not double-count.
 */
import request from 'supertest';

import { aiInteractions, messages, recipients } from '../../src/db/schema.js';
import { gatewayHeaders, startHarness, OTHER_TENANT, TENANT, type Harness } from '../contract/legacy/harness.js';

let h: Harness;
let recipientId: string;

const get = (path: string, headers = gatewayHeaders()) => request(h.app).get(path).set(headers);

/** Fixed instants, so the assertions do not depend on when the suite runs. */
const JANUARY = new Date('2026-01-15T12:00:00Z');
const FEBRUARY = new Date('2026-02-15T12:00:00Z');

beforeAll(async () => {
  h = await startHarness();

  const [recipient] = await h.db
    .insert(recipients)
    .values({
      tenantId: TENANT,
      externalRef: { system: 'test', id: 'usage-1' },
      displayName: 'Ada Lovelace',
      contactPoints: [{ type: 'email', value: 'ada@example.test', primary: true }],
    })
    .returning();
  recipientId = recipient!.id;

  await h.db.insert(aiInteractions).values([
    {
      tenantId: TENANT,
      modelId: 'amazon.nova-pro-v1:0',
      tokensUsed: 300,
      costUsd: '0.001200',
      success: true,
      metadata: { tokensIn: 200, tokensOut: 100 },
      createdAt: JANUARY,
    },
    {
      tenantId: TENANT,
      modelId: 'amazon.nova-pro-v1:0',
      tokensUsed: 150,
      costUsd: '0.000600',
      success: false,
      metadata: { tokensIn: 100, tokensOut: 50 },
      createdAt: JANUARY,
    },
    {
      tenantId: TENANT,
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      tokensUsed: 90,
      costUsd: '0.000075',
      success: true,
      // No metadata: the shape rows written before P12 have. `tokensTotal` must
      // still be right; only the split reads 0.
      createdAt: JANUARY,
    },
    // February, and another tenant — neither should reach a January report.
    {
      tenantId: TENANT,
      modelId: 'amazon.nova-pro-v1:0',
      tokensUsed: 999,
      costUsd: '9.000000',
      success: true,
      createdAt: FEBRUARY,
    },
    {
      tenantId: OTHER_TENANT,
      modelId: 'amazon.nova-pro-v1:0',
      tokensUsed: 500,
      costUsd: '5.000000',
      success: true,
      createdAt: JANUARY,
    },
  ]);

  await h.db.insert(messages).values([
    { tenantId: TENANT, recipientId, channel: 'email', status: 'SENT', content: 'body', createdAt: JANUARY },
    { tenantId: TENANT, recipientId, channel: 'email', status: 'SENT', content: 'body', createdAt: JANUARY },
    { tenantId: TENANT, recipientId, channel: 'sms', status: 'FAILED', content: 'body', createdAt: JANUARY },
    { tenantId: TENANT, recipientId, channel: 'sms', status: 'SENT', content: 'body', createdAt: FEBRUARY },
    { tenantId: OTHER_TENANT, channel: 'email', status: 'SENT', content: 'body', createdAt: JANUARY },
  ]);
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

const january = '?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z';

describe('GET /v1/usage', () => {
  it('reports model spend for the period', async () => {
    const res = await get(`/v1/usage${january}`);
    expect(res.status).toBe(200);
    expect(res.body.ai).toMatchObject({
      calls: 3,
      failedCalls: 1,
      tokensTotal: 540,
      // The third January row predates the split, so it contributes to the
      // total and not to in/out. That asymmetry is the honest answer.
      tokensIn: 300,
      tokensOut: 150,
      costUsd: 0.001875,
    });
  });

  it('breaks spend down by model, busiest first', async () => {
    const { body } = await get(`/v1/usage${january}`);
    expect(body.ai.byModel).toEqual([
      { model: 'amazon.nova-pro-v1:0', calls: 2, tokensTotal: 450, costUsd: 0.0018 },
      {
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        calls: 1,
        tokensTotal: 90,
        costUsd: 0.000075,
      },
    ]);
  });

  it('counts failed calls as calls — a refused generation still costs tokens', async () => {
    const { body } = await get(`/v1/usage${january}`);
    expect(body.ai.calls).toBe(3);
    expect(body.ai.failedCalls).toBe(1);
  });

  it('reports message volume by channel and by status', async () => {
    const { body } = await get(`/v1/usage${january}`);
    expect(body.messages.total).toBe(3);
    expect(body.messages.byChannel).toEqual([
      { channel: 'email', count: 2 },
      { channel: 'sms', count: 1 },
    ]);
    expect(body.messages.byStatus).toEqual(
      expect.arrayContaining([
        { status: 'SENT', count: 2 },
        { status: 'FAILED', count: 1 },
      ]),
    );
  });

  it('excludes another tenant entirely', async () => {
    const { body } = await get(`/v1/usage${january}`);
    // The other tenant's single January call is 500 tokens at $5.
    expect(body.ai.tokensTotal).toBe(540);
    expect(body.ai.costUsd).toBeLessThan(1);

    const other = await get(`/v1/usage${january}`, gatewayHeaders({ 'x-tenant-id': OTHER_TENANT }));
    expect(other.body.ai).toMatchObject({ calls: 1, tokensTotal: 500, costUsd: 5 });
  });

  it('treats `to` as exclusive, so a boundary is not counted twice', async () => {
    const jan = await get('/v1/usage?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z');
    const feb = await get('/v1/usage?from=2026-02-01T00:00:00Z&to=2026-03-01T00:00:00Z');
    const both = await get('/v1/usage?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z');

    expect(jan.body.ai.calls + feb.body.ai.calls).toBe(both.body.ai.calls);
    expect(both.body.ai.calls).toBe(4);
  });

  it('reports zeroes for a period with nothing in it, not an error', async () => {
    const res = await get('/v1/usage?from=2020-01-01T00:00:00Z&to=2020-02-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body.ai).toMatchObject({ calls: 0, tokensTotal: 0, costUsd: 0, byModel: [] });
    expect(res.body.messages).toMatchObject({ total: 0, byChannel: [], byStatus: [] });
  });

  it('rejects a period that runs backwards', async () => {
    const res = await get('/v1/usage?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z');
    expect(res.status).toBe(400);
  });

  it('defaults to the current calendar month', async () => {
    const res = await get('/v1/usage');
    expect(res.status).toBe(200);
    const from = new Date(res.body.period.from);
    expect(from.getUTCDate()).toBe(1);
    expect(from.getUTCHours()).toBe(0);
  });
});
