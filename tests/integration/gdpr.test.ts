/**
 * GDPR erasure (article 17) and export (article 20).
 *
 * The properties worth pinning are the ones that are easy to get wrong in a way
 * nobody notices: that erasure removes the person without removing the record
 * that a send happened, that it keeps the consent evidence on purpose, and that
 * it does not reach into another tenant.
 */
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  consentRecords,
  messageAnalytics,
  messages,
  recipientContext,
  recipientMemories,
  recipientPreferences,
  recipients,
  tenants,
} from '../../src/db/schema.js';
import {
  gatewayHeaders,
  startHarness,
  OTHER_TENANT,
  TENANT,
  type Harness,
} from '../contract/legacy/harness.js';

let h: Harness;
let subjectId: string;
let otherTenantRecipientId: string;

const adminHeaders = (over: Record<string, string> = {}) =>
  gatewayHeaders({
    'x-user-permissions': JSON.stringify(['outreach:admin']),
    ...over,
  });

async function makeRecipient(tenantId: string, externalId: string): Promise<string> {
  const [row] = await h.db
    .insert(recipients)
    .values({
      tenantId,
      externalRef: { system: 'test', id: externalId },
      displayName: 'Grace Hopper',
      firstName: 'Grace',
      lastName: 'Hopper',
      timezone: 'America/New_York',
      contactPoints: [{ type: 'email', value: 'grace@example.test', primary: true }],
      attributes: { source: 'instagram' },
    })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  h = await startHarness();

  // The medspa tenant carries gdpr; the other one deliberately does not.
  await h.db
    .update(tenants)
    .set({ complianceProfile: { gdpr: true } })
    .where(eq(tenants.id, TENANT));

  subjectId = await makeRecipient(TENANT, 'gdpr-subject');
  otherTenantRecipientId = await makeRecipient(OTHER_TENANT, 'gdpr-other');

  await h.db.insert(messages).values([
    {
      tenantId: TENANT,
      recipientId: subjectId,
      channel: 'email',
      status: 'SENT',
      content: 'Hi Grace, your appointment is on Tuesday.',
      metadata: { correlationId: 'corr-1', playbookKey: 'medspa.reminder', to: 'grace@example.test' },
    },
    {
      tenantId: TENANT,
      recipientId: subjectId,
      channel: 'sms',
      status: 'SENT',
      content: 'See you Tuesday!',
      metadata: { to: '+15550000001' },
    },
  ]);

  await h.db.insert(recipientPreferences).values({
    tenantId: TENANT,
    recipientId: subjectId,
    allowCommunications: true,
  });

  await h.db.insert(consentRecords).values({
    tenantId: TENANT,
    recipientId: subjectId,
    channel: 'email',
    granted: true,
    source: 'web-form',
  });

  await h.db.insert(recipientMemories).values({
    tenantId: TENANT,
    recipientId: subjectId,
    memoryType: 'preference',
    content: 'Prefers morning appointments.',
  });

  await h.db.insert(recipientContext).values({
    tenantId: TENANT,
    recipientId: subjectId,
    kind: 'mentera-patient',
    source: 'patient-service',
    payload: { allergies: ['latex'] },
  });
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('GET /v1/recipients/:id/export', () => {
  it('returns everything held about the recipient', async () => {
    const res = await request(h.app)
      .get(`/v1/recipients/${subjectId}/export`)
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      recipientId: subjectId,
      truncated: false,
      recipient: { displayName: 'Grace Hopper' },
    });
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.consent).toHaveLength(1);
    expect(res.body.memories).toHaveLength(1);
    expect(res.body.context).toHaveLength(1);
    expect(res.body.preferences).toBeTruthy();
  });

  it('is offered as a file, because it is one someone sends onward', async () => {
    const res = await request(h.app)
      .get(`/v1/recipients/${subjectId}/export`)
      .set(adminHeaders());
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('says when it truncated rather than silently stopping', async () => {
    const res = await request(h.app)
      .get(`/v1/recipients/${subjectId}/export?limit=1`)
      .set(adminHeaders());
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.truncated).toBe(true);
  });

  it('needs outreach:admin', async () => {
    const res = await request(h.app).get(`/v1/recipients/${subjectId}/export`).set(gatewayHeaders());
    expect(res.status).toBe(403);
  });

  it('403s a tenant without the gdpr profile, naming it', async () => {
    const res = await request(h.app)
      .get(`/v1/recipients/${otherTenantRecipientId}/export`)
      .set(adminHeaders({ 'x-tenant-id': OTHER_TENANT }));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/gdpr compliance profile/);
  });

  it('404s a recipient belonging to another tenant', async () => {
    const res = await request(h.app)
      .get(`/v1/recipients/${otherTenantRecipientId}/export`)
      .set(adminHeaders());
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/recipients/:id/erase', () => {
  it('reports what it erased and what it kept', async () => {
    const res = await request(h.app)
      .post(`/v1/recipients/${subjectId}/erase`)
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      messages: 2,
      analytics: 0,
      context: 1,
      memories: 1,
      preferences: 1,
    });
    // The answer to "why are the consent records still there" ships with the
    // response rather than living in someone's memory.
    expect(res.body.retained).toMatchObject({ consentRecords: 1 });
    expect(res.body.retained.reason).toMatch(/lawful/);
  });

  it('removes the person from the message without removing the message', async () => {
    // A message row is also the record that a send happened, which every count,
    // rate-limit window and audit answer depends on.
    const rows = await h.db
      .select()
      .from(messages)
      .where(eq(messages.recipientId, subjectId));

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'SENT')).toBe(true);
    expect(rows.every((r) => !r.content.includes('Grace'))).toBe(true);
    expect(rows.every((r) => r.content.includes('erased'))).toBe(true);
    // The address is gone; the trace is not.
    expect(JSON.stringify(rows)).not.toContain('grace@example.test');
    expect(JSON.stringify(rows)).not.toContain('+15550000001');
    expect(rows[0]!.metadata).toMatchObject({ correlationId: 'corr-1', playbookKey: 'medspa.reminder' });
  });

  it('tombstones the recipient rather than deleting the row', async () => {
    // `messages.recipient_id` is a foreign key, and the gate's first check
    // already refuses every send to a `deleted` recipient.
    const [row] = await h.db
      .select()
      .from(recipients)
      .where(eq(recipients.id, subjectId));

    expect(row).toBeTruthy();
    expect(row!.status).toBe('deleted');
    expect(row!.firstName).toBeNull();
    expect(row!.contactPoints).toEqual([]);
    expect(row!.attributes).toEqual({});
    expect(row!.externalRef).toEqual({ system: 'erased', id: subjectId });
    expect(JSON.stringify(row)).not.toContain('Hopper');
    expect(JSON.stringify(row)).not.toContain('instagram');
  });

  it('deletes the tables that exist only to describe the person', async () => {
    expect(
      await h.db.select().from(recipientContext).where(eq(recipientContext.recipientId, subjectId)),
    ).toHaveLength(0);
    expect(
      await h.db
        .select()
        .from(recipientMemories)
        .where(eq(recipientMemories.recipientId, subjectId)),
    ).toHaveLength(0);
    expect(
      await h.db
        .select()
        .from(recipientPreferences)
        .where(eq(recipientPreferences.recipientId, subjectId)),
    ).toHaveLength(0);
  });

  it('keeps the consent records, which are the evidence a send was lawful', async () => {
    const rows = await h.db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.recipientId, subjectId));
    expect(rows).toHaveLength(1);
  });

  it('needs outreach:admin', async () => {
    const res = await request(h.app)
      .post(`/v1/recipients/${subjectId}/erase`)
      .set(gatewayHeaders());
    expect(res.status).toBe(403);
  });

  it('403s a tenant without the gdpr profile', async () => {
    const res = await request(h.app)
      .post(`/v1/recipients/${otherTenantRecipientId}/erase`)
      .set(adminHeaders({ 'x-tenant-id': OTHER_TENANT }));
    expect(res.status).toBe(403);

    // And it really did nothing.
    const [row] = await h.db
      .select()
      .from(recipients)
      .where(eq(recipients.id, otherTenantRecipientId));
    expect(row!.status).not.toBe('deleted');
  });

  it('404s a recipient belonging to another tenant', async () => {
    const res = await request(h.app)
      .post(`/v1/recipients/${otherTenantRecipientId}/erase`)
      .set(adminHeaders());
    expect(res.status).toBe(404);
  });

  it('leaves the other tenant’s analytics alone', async () => {
    const rows = await h.db.select().from(messageAnalytics);
    expect(rows.every((r) => r.tenantId === TENANT || r.metadata !== null)).toBe(true);
  });
});
