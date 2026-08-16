/**
 * `POST /v1/outreach/generate` — the route two retired legacy mounts have been
 * naming as their successor since the P12 compat trim, and which did not exist
 * until now (D101).
 *
 * What is worth asserting here is not that generation works — the generator has
 * its own tests — but the three properties that make this a *safe* front door:
 *
 *  1. it does not send;
 *  2. it will not invent a recipient, or a contact point for one;
 *  3. the compat path and this one produce the same thing, because they are now
 *     the same code with a vocabulary bridge in front of one of them.
 */
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { approvals, messages, recipients } from '../../src/db/schema.js';
import { gatewayHeaders, startHarness, TENANT, type Harness } from './legacy/harness.js';

let h: Harness;
let recipientId: string;

const PATIENT = 'outreach-generate-patient';

beforeAll(async () => {
  h = await startHarness();

  const [row] = await h.db
    .insert(recipients)
    .values({
      tenantId: TENANT,
      externalRef: { system: 'mentera-patient', id: PATIENT },
      displayName: 'Grace Hopper',
      firstName: 'Grace',
      contactPoints: [{ type: 'email', value: 'grace@example.test', primary: true }],
    })
    .returning({ id: recipients.id });
  recipientId = row!.id;
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

function post(body: Record<string, unknown>, headers = gatewayHeaders()) {
  return request(h.app).post('/v1/outreach/generate').set(headers).send(body);
}

describe('POST /v1/outreach/generate', () => {
  it('drafts for a known recipient and opens an approval', async () => {
    const res = await post({ recipientId, channel: 'email', goal: 'follow up' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'PENDING_APPROVAL',
      content: expect.any(String),
      approvalId: expect.any(String),
      messageId: expect.any(String),
      promptPackKey: 'core.content-generate',
      recipientId,
    });
  });

  it('does not send — the message waits for a decision', async () => {
    const res = await post({ recipientId, channel: 'email' });

    const [msg] = await h.db
      .select({ status: messages.status })
      .from(messages)
      .where(eq(messages.id, res.body.messageId as string));
    const [approval] = await h.db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, res.body.approvalId as string));

    expect(msg!.status).not.toBe('SENT');
    expect(approval!.status).toBe('PENDING_APPROVAL');
  });

  it('resolves a recipient by the vertical’s own id', async () => {
    const res = await post({
      externalRef: { system: 'mentera-patient', id: PATIENT },
      channel: 'email',
    });

    expect(res.status).toBe(201);
    expect(res.body.recipientId).toBe(recipientId);
  });

  it('requires exactly one identifier', async () => {
    expect((await post({ channel: 'email' })).status).toBe(400);
    expect(
      (
        await post({
          recipientId,
          externalRef: { system: 'mentera-patient', id: PATIENT },
          channel: 'email',
        })
      ).status,
    ).toBe(400);
  });

  it('404s a recipient nothing can resolve rather than inventing one', async () => {
    const before = await h.db
      .select({ id: recipients.id })
      .from(recipients)
      .where(eq(recipients.tenantId, TENANT));

    const res = await post({
      externalRef: { system: 'mentera-patient', id: 'nobody-has-ever-heard-of-this' },
      channel: 'email',
    });
    expect(res.status).toBe(404);

    // And it created nothing on the way to saying so. An empty recipient would
    // only move the failure to "no contact point" one call later.
    const after = await h.db
      .select({ id: recipients.id })
      .from(recipients)
      .where(eq(recipients.tenantId, TENANT));
    expect(after).toHaveLength(before.length);
  });

  it('400s a channel the recipient has no contact point for', async () => {
    // Grace has an email and no phone. Refusing here beats an approval a
    // reviewer approves and then watches fail at dispatch.
    const res = await post({ recipientId, channel: 'sms' });
    expect(res.status).toBe(400);
  });

  it('404s a prompt pack that is not installed', async () => {
    const res = await post({ recipientId, channel: 'email', promptPackKey: 'nope.not-a-pack' });
    expect(res.status).toBe(404);
  });

  it('is tenant-scoped — another tenant cannot draft for this recipient', async () => {
    const res = await post(
      { recipientId, channel: 'email' },
      gatewayHeaders({ 'x-tenant-id': '00000000-0000-4000-8000-00000000c002' }),
    );
    expect(res.status).toBe(404);
  });

  it('requires outreach:send', async () => {
    const res = await post(
      { recipientId, channel: 'email' },
      gatewayHeaders({ 'x-user-permissions': JSON.stringify(['outreach:approve']) }),
    );
    expect(res.status).toBe(403);
  });

  it('produces what the legacy path produces, because it is the same code', async () => {
    const legacy = await request(h.app)
      .post('/automated-messages/generate')
      .set(gatewayHeaders())
      .send({ patientId: PATIENT, channel: 'EMAIL', promptPackKey: 'core.content-generate' });
    const v1 = await post({
      externalRef: { system: 'mentera-patient', id: PATIENT },
      channel: 'email',
      promptPackKey: 'core.content-generate',
    });

    expect(legacy.status).toBe(201);
    expect(v1.status).toBe(201);
    expect(legacy.body.data.content).toBe(v1.body.content);
    expect(legacy.body.data.status).toBe(v1.body.status);
  });
});
