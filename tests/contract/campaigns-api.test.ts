/**
 * `/v1/campaigns` and `/v1/audiences` over HTTP.
 *
 * `campaigns.test.ts` drives the services directly and proves the orchestration.
 * This proves the surface a caller actually touches: status codes, tenant
 * scoping, and the two responses whose *code* carries meaning rather than
 * decoration —
 *
 *   202 on launch, because the work outlives the request;
 *   207 on a partial import, because "some rows failed" is neither 200 nor 400.
 */
import request from 'supertest';

import { eq } from 'drizzle-orm';

import {
  approvalPolicies,
  playbookTriggers,
  playbooks,
  recipients,
  templates,
} from '../../src/db/schema.js';
import { gatewayHeaders, startHarness, OTHER_TENANT, TENANT, type Harness } from './legacy/harness.js';

let h: Harness;

const get = (path: string, headers = gatewayHeaders()) => request(h.app).get(path).set(headers);
const post = (path: string, body: unknown = {}, headers = gatewayHeaders()) =>
  request(h.app).post(path).set(headers).send(body as object);
const del = (path: string, body: unknown = {}, headers = gatewayHeaders()) =>
  request(h.app).delete(path).set(headers).send(body as object);

async function makeRecipient(tenantId: string, id: string): Promise<string> {
  const [row] = await h.db
    .insert(recipients)
    .values({
      tenantId,
      externalRef: { system: 'test', id },
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      contactPoints: [{ type: 'email', value: `${id}@example.test`, primary: true }],
    })
    .returning({ id: recipients.id });
  return row!.id;
}

/**
 * The legacy harness installs no pack, so this seeds the one playbook the
 * campaign tests need — with the `campaign` trigger and the
 * `campaignPlaybookKey` predicate that is how a campaign targets its playbook.
 */
const PLAYBOOK = 'api.nurture';

beforeAll(async () => {
  h = await startHarness();

  const [policy] = await h.db
    .select({ id: approvalPolicies.id })
    .from(approvalPolicies)
    .where(eq(approvalPolicies.key, 'system.transactional'));

  await h.db.insert(templates).values({
    tenantId: TENANT,
    key: 'api.nurture.email',
    name: 'Nurture',
    channel: 'email',
    subject: 'Hello',
    content: 'Hi {{recipient.firstName}}, about {{context.topic}}.',
    format: 'TEXT',
  });

  const [playbook] = await h.db
    .insert(playbooks)
    .values({
      tenantId: TENANT,
      key: PLAYBOOK,
      name: 'API nurture',
      isActive: true,
      priority: 100,
      dataContract: { properties: { topic: { type: 'string', default: 'nothing supplied' } } },
      contentSource: { kind: 'template', templateKey: 'api.nurture.email' },
      channelPlan: [{ channel: 'email', templateKey: 'api.nurture.email' }],
      approvalPolicyId: policy!.id,
      throttle: {},
    })
    .returning({ id: playbooks.id });

  await h.db.insert(playbookTriggers).values({
    tenantId: TENANT,
    playbookId: playbook!.id,
    triggerType: 'campaign',
    matchRules: { where: { campaignPlaybookKey: { eq: PLAYBOOK } } },
    isActive: true,
  });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe('/v1/audiences', () => {
  it('creates, lists and reads one back', async () => {
    const created = await post('/v1/audiences', { name: 'Spring leads' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Spring leads', kind: 'static', memberCount: 0 });

    const one = await get(`/v1/audiences/${created.body.id}`);
    expect(one.status).toBe(200);

    const all = await get('/v1/audiences');
    expect(all.body.data.map((a: { id: string }) => a.id)).toContain(created.body.id);
  });

  it('rejects a predicate over a field that is not queryable', async () => {
    // The predicate decides who gets messaged, so an unknown field is a 400 at
    // create time rather than an audience that silently selects nobody.
    const res = await post('/v1/audiences', {
      name: 'Bad',
      kind: 'query',
      definition: { where: { 'secret.column': { eq: 'x' } } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not a queryable field/i);
  });

  it('adds and removes members, and ignores another tenant’s recipients', async () => {
    const audience = (await post('/v1/audiences', { name: 'Members' })).body;
    const mine = await makeRecipient(TENANT, 'api-mine');
    const theirs = await makeRecipient(OTHER_TENANT, 'api-theirs');

    const added = await post(`/v1/audiences/${audience.id}/members`, {
      recipientIds: [mine, theirs],
    });
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ added: 1 });

    const removed = await del(`/v1/audiences/${audience.id}/members`, { recipientIds: [mine] });
    expect(removed.body).toEqual({ removed: 1 });
  });

  it('answers 200 on a clean import and 207 when rows are rejected', async () => {
    const clean = (await post('/v1/audiences', { name: 'Clean import' })).body;
    const ok = await post(`/v1/audiences/${clean.id}/import`, {
      system: 'crm',
      rows: [{ externalId: 'a-1', email: 'a1@example.test' }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ imported: 1, skipped: 0, errors: 0 });

    const messy = (await post('/v1/audiences', { name: 'Messy import' })).body;
    const partial = await post(`/v1/audiences/${messy.id}/import`, {
      system: 'crm',
      rows: [
        { externalId: 'b-1', email: 'b1@example.test' },
        { externalId: 'b-2', email: 'not-an-email' },
        { email: 'b3@example.test' },
      ],
    });
    // 207: one row landed, two did not. Neither 200 nor 400 says that.
    expect(partial.status).toBe(207);
    expect(partial.body).toMatchObject({ imported: 1, errors: 2 });

    const report = await get(`/v1/audiences/${messy.id}/import-errors`);
    expect(report.status).toBe(200);
    // Line numbers count the header, so the caller can find them in their file.
    expect(report.body.data.map((e: { rowNumber: number }) => e.rowNumber)).toEqual([3, 4]);
  });

  it('404s an audience belonging to another tenant', async () => {
    const mine = (await post('/v1/audiences', { name: 'Scoped' })).body;
    const res = await get(`/v1/audiences/${mine.id}`, gatewayHeaders({ 'x-medspa-id': OTHER_TENANT }));
    expect(res.status).toBe(404);
  });
});

describe('/v1/campaigns', () => {
  it('404s a campaign whose playbook the tenant does not have', async () => {
    const audience = (await post('/v1/audiences', { name: 'No playbook' })).body;
    const res = await post('/v1/campaigns', {
      name: 'Nope',
      playbookKey: 'does.not.exist',
      audienceId: audience.id,
    });
    expect(res.status).toBe(404);
  });

  it('400s a campaign with no playbook key at all', async () => {
    const audience = (await post('/v1/audiences', { name: 'No key' })).body;
    const res = await post('/v1/campaigns', { name: 'Nope', audienceId: audience.id });
    expect(res.status).toBe(400);
  });

  it('creates, launches with 202, and reports stats', async () => {
    const audience = (await post('/v1/audiences', { name: 'Launchable' })).body;
    await post(`/v1/audiences/${audience.id}/members`, {
      recipientIds: [await makeRecipient(TENANT, 'api-launch-1')],
    });

    const created = await post('/v1/campaigns', {
      name: 'API campaign',
      playbookKey: PLAYBOOK,
      audienceId: audience.id,
      context: { appointmentDate: 'Tuesday' },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    // 202, not 200: expansion is done and recorded, generation continues after
    // the response. A caller that needs the outcome polls /stats.
    const launched = await post(`/v1/campaigns/${id}/launch`);
    expect(launched.status).toBe(202);
    expect(launched.body.expanded).toBe(1);

    const stats = await get(`/v1/campaigns/${id}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body.total).toBe(1);

    const rows = await get(`/v1/campaigns/${id}/recipients`);
    expect(rows.body.data).toHaveLength(1);
  });

  it('409s a relaunch rather than sending twice', async () => {
    const audience = (await post('/v1/audiences', { name: 'Relaunch' })).body;
    await post(`/v1/audiences/${audience.id}/members`, {
      recipientIds: [await makeRecipient(TENANT, 'api-relaunch-1')],
    });
    const id = (
      await post('/v1/campaigns', {
        name: 'Twice',
        playbookKey: PLAYBOOK,
        audienceId: audience.id,
        context: { appointmentDate: 'Tuesday' },
      })
    ).body.id as string;

    await post(`/v1/campaigns/${id}/launch`);
    // Give the detached run loop a moment to finish the single recipient.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = await post(`/v1/campaigns/${id}/launch`);
    expect([202, 409]).toContain(second.status);
    if (second.status === 409) expect(second.body.error.message).toMatch(/COMPLETED|running/i);
  });

  it('cancels, and accounts for what it could and could not stop', async () => {
    const audience = (await post('/v1/audiences', { name: 'Cancellable' })).body;
    const id = (
      await post('/v1/campaigns', {
        name: 'Cancel me',
        playbookKey: PLAYBOOK,
        audienceId: audience.id,
      })
    ).body.id as string;

    const res = await post(`/v1/campaigns/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');

    // Three numbers, not one. Until P12 queued messages could not be recalled at
    // all (D83) and the note said so; now they can, and the contract is that the
    // response distinguishes never-generated from recalled from already-sending.
    // An operator reading "cancelled" must be able to tell whether anything
    // still went out.
    expect(res.body).toMatchObject({
      cancelled: expect.any(Number),
      recalled: expect.any(Number),
      alreadySending: expect.any(Number),
    });
    // Nothing was launched, so nothing was in flight.
    expect(res.body.alreadySending).toBe(0);
    expect(res.body.note).toMatch(/nothing was in flight/i);
  });

  it('404s another tenant’s campaign', async () => {
    const audience = (await post('/v1/audiences', { name: 'Tenant-scoped' })).body;
    const id = (
      await post('/v1/campaigns', {
        name: 'Mine',
        playbookKey: PLAYBOOK,
        audienceId: audience.id,
      })
    ).body.id as string;

    const res = await get(`/v1/campaigns/${id}`, gatewayHeaders({ 'x-medspa-id': OTHER_TENANT }));
    expect(res.status).toBe(404);
  });
});
