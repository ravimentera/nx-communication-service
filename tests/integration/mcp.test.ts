/**
 * MCP, against the real app.
 *
 * Two behaviours tera-orchestrator depends on, and one it depends on not
 * happening:
 *
 *  1. `GET /mcp/tools` answers with no gateway headers. The orchestrator calls
 *     it at its own startup to build its tool registry; behind auth it would
 *     403 and the registry would be empty.
 *  2. The seven tool names are exactly what `service-mcp-tools.ts:116` expects.
 *     It prefixes them `comm_` and treats `sendEmail`/`sendSMS`/`sendSlack` as
 *     mutation tools — a rename silently removes that confirmation gate.
 *  3. A body-supplied tenant is **ignored**. The source's comment at
 *     `mcp/index.ts:70-80` documents a real cross-tenant send that this fixed;
 *     the regression would be silent and would send another tenant's patients
 *     email.
 */
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { messages } from '../../src/db/schema.js';
import { MCP_TOOL_NAMES } from '../../src/mcp/tools.js';
import {
  gatewayHeaders,
  startHarness,
  OTHER_TENANT,
  TENANT,
  type Harness,
} from '../contract/legacy/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('discovery', () => {
  it('GET /mcp/tools answers with no headers at all', async () => {
    const res = await request(h.app).get('/mcp/tools');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(7);
  });

  it('advertises exactly the seven names the orchestrator registers', async () => {
    const res = await request(h.app).get('/mcp/tools');
    expect(res.body.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      [
        'addNotificationToQueue',
        'clearFailedJobs',
        'getQueueStatus',
        'sendEmail',
        'sendSMS',
        'sendSlackMessage',
        'sendUrgentSlackAlert',
      ].sort(),
    );
    expect(MCP_TOOL_NAMES).toHaveLength(7);
  });

  it('advertises no tenant parameter on any tool', async () => {
    // The source declares `medspaId` on four schemas and then overrides
    // whatever the caller sends. Advertising an ignored parameter invites a
    // caller to depend on it.
    const res = await request(h.app).get('/mcp/tools');
    for (const tool of res.body.tools as Array<{ inputSchema: { properties: object } }>) {
      expect(Object.keys(tool.inputSchema.properties)).not.toContain('medspaId');
      expect(Object.keys(tool.inputSchema.properties)).not.toContain('tenantId');
    }
  });

  it('GET /mcp/health answers with no headers', async () => {
    const res = await request(h.app).get('/mcp/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'healthy', toolCount: 7 });
  });
});

describe('execution', () => {
  it('is NOT open — discovery being pre-auth does not make sending pre-auth', async () => {
    const res = await request(h.app)
      .post('/mcp/tools/sendEmail')
      .send({ to: 'ada@example.test', message: 'hello' });
    expect(res.status).toBe(403);
  });

  it('sends an email for an authenticated caller', async () => {
    const res = await request(h.app)
      .post('/mcp/tools/sendEmail')
      .set(gatewayHeaders())
      .send({ to: 'ada@example.test', subject: 'Hi', message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, toolName: 'sendEmail' });
    expect(res.body.result.messageId).toBeTruthy();
  });

  it('reports a channel capability failure in the result rather than throwing', async () => {
    // The email channel requires a subject. Reporting `queued: false` with the
    // reason beats a 500, which is what the orchestrator would otherwise retry.
    const res = await request(h.app)
      .post('/mcp/tools/sendEmail')
      .set(gatewayHeaders())
      .send({ to: 'ada@example.test', message: 'no subject' });

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ queued: false, skipped: expect.any(String) });
  });

  it('404s an unknown tool rather than 500ing', async () => {
    const res = await request(h.app)
      .post('/mcp/tools/dropDatabase')
      .set(gatewayHeaders())
      .send({});
    expect(res.status).toBe(404);
  });

  it('ignores a body-supplied tenant — the header wins', async () => {
    const res = await request(h.app)
      .post('/mcp/tools/sendEmail')
      .set(gatewayHeaders())
      .send({
        to: 'target@example.test',
        subject: 'Cross-tenant attempt',
        message: 'cross-tenant attempt',
        // A forged tenant. The source used to trust this when the header was
        // absent, which could send to another tenant's patients.
        medspaId: OTHER_TENANT,
      });

    expect(res.status).toBe(200);

    const [row] = await h.db
      .select({ tenantId: messages.tenantId })
      .from(messages)
      .where(eq(messages.id, res.body.result.messageId as string));
    expect(row!.tenantId).toBe(TENANT);
  });

  it('reports queue stats', async () => {
    const res = await request(h.app)
      .post('/mcp/tools/getQueueStatus')
      .set(gatewayHeaders())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveProperty('stats');
  });

  it('requires an explicit channel for an urgent alert', async () => {
    const res = await request(h.app)
      .post('/mcp/tools/sendUrgentSlackAlert')
      .set(gatewayHeaders())
      .send({ title: 'Down', message: 'everything is on fire' });
    // The source defaults to `urgent-alerts`, one channel for every tenant (D55).
    expect(res.status).toBe(400);
  });
});

describe('bedrock shim', () => {
  it('maps actionGroup to a tool and answers in the Bedrock envelope', async () => {
    const res = await request(h.app)
      .post('/mcp/bedrock')
      .set(gatewayHeaders())
      .send({ actionGroup: 'getQueueStatus', parameters: {} });

    expect(res.status).toBe(200);
    expect(res.body.response).toMatchObject({ actionGroup: 'getQueueStatus' });
    expect(res.body.response.functionResponse.responseBody).toHaveProperty('stats');
  });

  it('has the same tenant guarantee as its sibling', async () => {
    const res = await request(h.app)
      .post('/mcp/bedrock')
      .set(gatewayHeaders())
      .send({
        actionGroup: 'sendEmail',
        parameters: { to: 'x@example.test', subject: 'Hi', message: 'hi', medspaId: OTHER_TENANT },
      });

    expect(res.status).toBe(200);
    const messageId = res.body.response.functionResponse.responseBody.messageId as string;
    const [row] = await h.db
      .select({ tenantId: messages.tenantId })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(row!.tenantId).toBe(TENANT);
  });

  it('is still authenticated', async () => {
    const res = await request(h.app)
      .post('/mcp/bedrock')
      .send({ actionGroup: 'getQueueStatus', parameters: {} });
    expect(res.status).toBe(403);
  });
});
