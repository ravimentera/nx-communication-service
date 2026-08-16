/**
 * MCP, against the real app.
 *
 * Two behaviours tera-orchestrator depends on, and one it depends on not
 * happening:
 *
 *  1. `GET /mcp/tools` answers with no gateway headers. The orchestrator calls
 *     it at its own startup to build its tool registry; behind auth it would
 *     403 and the registry would be empty.
 *  2. The tool names are exactly what the orchestrator registers, and **every
 *     mutating one is declared as such**. The orchestrator prefixes them
 *     `comm_` and confirms the names in its `mutationTools` list. That list
 *     used to be maintained by hand in the other repository and named
 *     `sendSlack`, which is not a tool — so two Slack sends ran unconfirmed
 *     until P12 (D102). The assertion below is the thing that would have
 *     caught it: a name in the gate that matches nothing fails open.
 *  3. A body-supplied tenant is **ignored**. The source's comment at
 *     `mcp/index.ts:70-80` documents a real cross-tenant send that this fixed;
 *     the regression would be silent and would send another tenant's patients
 *     email.
 */
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  approvalPolicies,
  approvals as approvalsTable,
  messages,
  playbookTriggers,
  playbooks,
  recipients,
  templates,
} from '../../src/db/schema.js';
import { MCP_MUTATION_TOOL_NAMES, MCP_TOOLS, MCP_TOOL_NAMES } from '../../src/mcp/tools.js';
import {
  gatewayHeaders,
  startHarness,
  OTHER_PROVIDER,
  OTHER_TENANT,
  TENANT,
  type Harness,
} from '../contract/legacy/harness.js';

let h: Harness;

/** The recipient the P12 review tools draft for. */
const MCP_PATIENT = 'patient-mcp-1';
/** The playbook `createCampaign` targets. The legacy harness installs no pack. */
const MCP_PLAYBOOK = 'mcp.nurture';

beforeAll(async () => {
  h = await startHarness();

  // `DraftService` resolves a recipient through the context provider but will
  // not invent one, and this harness registers only the inline provider — so
  // the recipient is seeded, contact point included. A draft for someone with
  // no email is a 400 by design, which is not what these tests are about.
  await h.db.insert(recipients).values({
    tenantId: TENANT,
    externalRef: { system: 'mentera-patient', id: MCP_PATIENT },
    displayName: 'Ada Lovelace',
    firstName: 'Ada',
    contactPoints: [{ type: 'email', value: 'ada@example.test', primary: true }],
  });

  const [policy] = await h.db
    .select({ id: approvalPolicies.id })
    .from(approvalPolicies)
    .where(eq(approvalPolicies.key, 'system.transactional'));

  await h.db.insert(templates).values({
    tenantId: TENANT,
    key: 'mcp.nurture.email',
    name: 'Nurture',
    channel: 'email',
    subject: 'Hello',
    content: 'Hi {{recipient.firstName}}.',
    format: 'TEXT',
  });

  const [playbook] = await h.db
    .insert(playbooks)
    .values({
      tenantId: TENANT,
      key: MCP_PLAYBOOK,
      name: 'MCP nurture',
      isActive: true,
      priority: 100,
      dataContract: {},
      contentSource: { kind: 'template', templateKey: 'mcp.nurture.email' },
      channelPlan: [{ channel: 'email', templateKey: 'mcp.nurture.email' }],
      approvalPolicyId: policy!.id,
      throttle: {},
    })
    .returning({ id: playbooks.id });

  await h.db.insert(playbookTriggers).values({
    tenantId: TENANT,
    playbookId: playbook!.id,
    triggerType: 'campaign',
    matchRules: { where: { campaignPlaybookKey: { eq: MCP_PLAYBOOK } } },
    isActive: true,
  });
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('discovery', () => {
  it('GET /mcp/tools answers with no headers at all', async () => {
    const res = await request(h.app).get('/mcp/tools');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(12);
  });

  it('advertises exactly the names the orchestrator registers', async () => {
    const res = await request(h.app).get('/mcp/tools');
    expect(res.body.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      [
        // The source's seven.
        'addNotificationToQueue',
        'clearFailedJobs',
        'getQueueStatus',
        'sendEmail',
        'sendSMS',
        'sendSlackMessage',
        'sendUrgentSlackAlert',
        // P12 workstream 5.
        'approveMessage',
        'createCampaign',
        'generateDraft',
        'listConversations',
        'listPendingApprovals',
      ].sort(),
    );
    expect(MCP_TOOL_NAMES).toHaveLength(12);
  });

  it('publishes the mutation set, and every name in it is a real tool', async () => {
    // The bug this exists to prevent (D102): the orchestrator's hand-kept list
    // named `sendSlack`, which matches nothing, so the confirmation gate simply
    // did not apply to Slack sends. A name that matches nothing fails open.
    const res = await request(h.app).get('/mcp/tools');
    expect(res.body.mutationTools).toEqual(MCP_MUTATION_TOOL_NAMES);
    for (const name of res.body.mutationTools as string[]) {
      expect(MCP_TOOL_NAMES).toContain(name);
    }
  });

  it('declares every tool that sends, decides or queues as a mutation', async () => {
    const mutating = new Set(MCP_MUTATION_TOOL_NAMES);
    for (const name of [
      'sendEmail',
      'sendSMS',
      'sendSlackMessage',
      'sendUrgentSlackAlert',
      'addNotificationToQueue',
      'generateDraft',
      'approveMessage',
      'createCampaign',
    ]) {
      expect(mutating).toContain(name);
    }
    // Reads are not gated: confirming a list is friction with no safety value.
    for (const name of ['getQueueStatus', 'listPendingApprovals', 'listConversations']) {
      expect(mutating).not.toContain(name);
    }
    // And the inline flag agrees with the published list.
    expect(MCP_TOOLS.filter((t) => t.mutation).map((t) => t.name)).toEqual(
      MCP_MUTATION_TOOL_NAMES,
    );
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
    expect(res.body).toMatchObject({ status: 'healthy', toolCount: 12 });
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

/**
 * P12 workstream 5. Tera's half of the surface.
 *
 * The point of each assertion is the *boundary*, not the happy path — these
 * tools are reachable by anything the orchestrator decides to call, so what
 * matters is that none of them is a way around a check the HTTP surface makes.
 */
describe('the review tools', () => {
  async function draft(over: Record<string, unknown> = {}) {
    return request(h.app)
      .post('/mcp/tools/generateDraft')
      .set(gatewayHeaders())
      .send({
        patientId: MCP_PATIENT,
        channel: 'email',
        goal: 'check in after last week',
        ...over,
      });
  }

  it('generateDraft writes a draft and leaves it PENDING_APPROVAL', async () => {
    const res = await draft();

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      status: 'PENDING_APPROVAL',
      content: expect.any(String),
      approvalId: expect.any(String),
      messageId: expect.any(String),
    });
  });

  it('generateDraft does NOT dispatch — the message waits', async () => {
    const res = await draft();
    const [row] = await h.db
      .select({ status: messages.status })
      .from(messages)
      .where(eq(messages.id, res.body.result.messageId as string));

    // The whole reason Tera may call this without a confirmation on the *send*:
    // there is no send. A human decides.
    expect(row!.status).not.toBe('SENT');
  });

  it('generateDraft refuses both identifiers at once', async () => {
    const res = await draft({ recipientId: '00000000-0000-4000-8000-0000000000ff' });
    expect(res.status).toBe(400);
  });

  it('listPendingApprovals returns the draft that was just written', async () => {
    const created = await draft();
    const res = await request(h.app)
      .post('/mcp/tools/listPendingApprovals')
      .set(gatewayHeaders())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.result.approvals.map((a: { id: string }) => a.id)).toContain(
      created.body.result.approvalId,
    );
  });

  it("listPendingApprovals will not read another approver's queue without the permission", async () => {
    const res = await request(h.app)
      .post('/mcp/tools/listPendingApprovals')
      .set(
        gatewayHeaders({
          'x-user-permissions': JSON.stringify(['outreach:send']),
        }),
      )
      .send({ approverRef: OTHER_PROVIDER });

    expect(res.status).toBe(400);
  });

  /**
   * These assert the **audit trail** as well as the status, because this
   * harness runs with `SKIP_QUEUE=true`: the decision is recorded and the
   * delivery that should follow it does not happen.
   *
   * That used to cancel the approval — a queue outage looked identical to a
   * compliance refusal, so the human's decision was thrown away by the
   * infrastructure being unavailable. It does not any more (D105). The trail is
   * the thing that matters either way: who decided, and what they decided.
   */
  it('approveMessage decides the approval, and records who', async () => {
    const created = await draft();
    const approvalId = created.body.result.approvalId as string;

    const res = await request(h.app)
      .post('/mcp/tools/approveMessage')
      .set(gatewayHeaders())
      .send({ approvalId });

    expect(res.status).toBe(200);
    const [row] = await h.db
      .select({
        status: approvalsTable.status,
        decidedBy: approvalsTable.decidedBy,
        trail: approvalsTable.auditTrail,
      })
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approvalId));

    // An approval attributed to nobody is worse than one that did not happen.
    expect(row!.decidedBy).toBe('user-1');
    expect(row!.trail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'APPROVED', actorType: 'user', actorRef: 'user-1' }),
      ]),
    );
    // And the decision survived the queue being unavailable (D105).
    expect(row!.status).toBe('APPROVED');
  });

  it('approveMessage with content edits before approving', async () => {
    const created = await draft();
    const approvalId = created.body.result.approvalId as string;

    const res = await request(h.app)
      .post('/mcp/tools/approveMessage')
      .set(gatewayHeaders())
      .send({ approvalId, content: 'Rewritten by a person.' });

    expect(res.status).toBe(200);
    const [row] = await h.db
      .select({
        status: approvalsTable.status,
        edited: approvalsTable.editedContent,
        trail: approvalsTable.auditTrail,
      })
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approvalId));

    expect(row!.edited).toBe('Rewritten by a person.');
    expect(row!.status).toBe('EDITED_APPROVED');
    expect(row!.trail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'EDITED_APPROVED', actorRef: 'user-1' }),
      ]),
    );
  });

  it('approveMessage will not act on another tenant’s approval', async () => {
    const created = await draft();
    const res = await request(h.app)
      .post('/mcp/tools/approveMessage')
      .set(gatewayHeaders({ 'x-medspa-id': OTHER_TENANT }))
      .send({ approvalId: created.body.result.approvalId });

    expect(res.status).toBe(404);
  });

  it('listConversations reads the caller’s own inbox', async () => {
    const res = await request(h.app)
      .post('/mcp/tools/listConversations')
      .set(gatewayHeaders())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      conversations: expect.any(Array),
      page: 1,
    });
  });

  it('createCampaign creates a DRAFT and sends nothing', async () => {
    const audience = await request(h.app)
      .post('/v1/audiences')
      .set(gatewayHeaders())
      .send({ name: 'MCP audience', definition: { kind: 'all' } });
    expect(audience.status).toBe(201);

    const res = await request(h.app)
      .post('/mcp/tools/createCampaign')
      .set(gatewayHeaders())
      .send({
        name: 'From Tera',
        playbookKey: MCP_PLAYBOOK,
        audienceId: audience.body.id,
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ id: expect.any(String), status: 'DRAFT' });
  });

  it('createCampaign rejects an audience that does not exist', async () => {
    const res = await request(h.app)
      .post('/mcp/tools/createCampaign')
      .set(gatewayHeaders())
      .send({
        name: 'Nowhere',
        playbookKey: MCP_PLAYBOOK,
        audienceId: '00000000-0000-4000-8000-0000000000aa',
      });

    expect(res.status).toBe(404);
  });

  it('every review tool is still authenticated', async () => {
    for (const tool of [
      'generateDraft',
      'listPendingApprovals',
      'approveMessage',
      'listConversations',
      'createCampaign',
    ]) {
      const res = await request(h.app).post(`/mcp/tools/${tool}`).send({});
      expect(res.status).toBe(403);
    }
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
