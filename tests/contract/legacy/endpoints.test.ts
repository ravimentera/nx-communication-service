/**
 * The legacy contract suite — P8's exit criterion.
 *
 * One assertion per legacy endpoint: the status code a caller gets, the shape
 * of the envelope, and the deprecation headers. This is the suite P10 gates the
 * cutover on, so it asserts what a **caller** can observe and nothing about how
 * the answer is produced.
 *
 * Two shapes deserve their own note, because they look like typos and are not:
 *
 *  - `/communications/medspa/:id` returns `{success, data:[…], pagination}`.
 *  - `/communications/provider/:id` returns `{success, data:{data:[…],
 *    pagination}}` — double-nested, because the controller returns its response
 *    object instead of writing it and the route wraps whatever comes back.
 *
 * Covers the routers that land in P8a: /email, /sms, /slack, /events (+
 * /api/events), /preferences, /config, /approvals, /communications, /queue.
 * The remaining legacy routers land in P8b.
 */
import request from 'supertest';

import { messages, recipients, templates } from '../../../src/db/schema.js';
import {
  gatewayHeaders,
  startHarness,
  OTHER_PROVIDER,
  OTHER_TENANT,
  PROVIDER,
  TENANT,
  type Harness,
} from './harness.js';

let h: Harness;
let recipientId: string;
let messageId: string;
const PATIENT = 'patient-42';

const get = (path: string, headers = gatewayHeaders()) =>
  request(h.app).get(path).set(headers);
const post = (path: string, body: unknown = {}, headers = gatewayHeaders()) =>
  request(h.app).post(path).set(headers).send(body as object);
const put = (path: string, body: unknown = {}, headers = gatewayHeaders()) =>
  request(h.app).put(path).set(headers).send(body as object);

beforeAll(async () => {
  h = await startHarness();

  const [recipient] = await h.db
    .insert(recipients)
    .values({
      tenantId: TENANT,
      externalRef: { system: 'mentera-patient', id: PATIENT },
      displayName: 'Ada Lovelace',
      contactPoints: [
        { type: 'email', value: 'ada@example.test', primary: true },
        { type: 'phone', value: '+15550000001', primary: true },
      ],
    })
    .returning({ id: recipients.id });
  recipientId = recipient!.id;

  const [message] = await h.db
    .insert(messages)
    .values({
      tenantId: TENANT,
      senderId: PROVIDER,
      recipientId,
      channel: 'EMAIL',
      content: 'Your appointment is confirmed',
      status: 'SENT',
      direction: 'outbound',
      sentAt: new Date(),
    })
    .returning({ id: messages.id });
  messageId = message!.id;

  await h.db.insert(templates).values({
    tenantId: TENANT,
    key: 'password-reset',
    name: 'Password reset',
    channel: 'email',
    subject: 'Reset your password',
    content: 'Hello {{firstName}}, reset here: {{link}}',
    format: 'TEXT',
  });
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('deprecation contract', () => {
  it('marks every compat response deprecated and points at its successor', async () => {
    const res = await get('/queue/stats');
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.link).toBe('</v1/queue/stats>; rel="successor-version"');
  });

  it('counts compat hits, so P12 can tell what is still in use', async () => {
    await get('/queue/stats');
    const metrics = await request(h.app).get('/metrics');
    expect(metrics.text).toContain('outreach_compat_hits_total');
    expect(metrics.text).toMatch(/outreach_compat_hits_total\{[^}]*path="\/queue"/);
  });

  it('still refuses a request that did not come through the gateway', async () => {
    const res = await request(h.app).get('/queue/stats');
    expect(res.status).toBe(403);
  });
});

describe('/email — 1', () => {
  it('POST /email/send renders a template key and reports success', async () => {
    const res = await post('/email/send', {
      to: 'ada@example.test',
      templateId: 'password-reset',
      variables: { firstName: 'Ada', link: 'https://example.test/r/abc' },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /email/send 404s an unknown template rather than sending an empty mail', async () => {
    const res = await post('/email/send', { to: 'ada@example.test', templateId: 'nope' });
    expect(res.status).toBe(404);
  });
});

describe('/sms — 2', () => {
  it('POST /sms/send accepts a plain message', async () => {
    const res = await post('/sms/send', { to: '+15550000001', message: 'See you at 3' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, messageType: 'plain', medspaId: TENANT });
  });

  it('POST /sms/send rejects a body with neither message nor templateId', async () => {
    const res = await post('/sms/send', { to: '+15550000001' });
    expect(res.status).toBe(400);
  });

  it('POST /sms/send rejects a templateId with no variables', async () => {
    const res = await post('/sms/send', { to: '+15550000001', templateId: 'password-reset' });
    expect(res.status).toBe(400);
  });

  it('POST /sms/send-direct answers the same shape', async () => {
    const res = await post('/sms/send-direct', { to: '+15550000001', message: 'now' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('/slack — 2', () => {
  it('POST /slack/message requires an explicit channel', async () => {
    // The source defaults to a hardcoded channel name shared across tenants (D55).
    const res = await post('/slack/message', { text: 'hello' });
    expect(res.status).toBe(400);
  });

  it('POST /slack/message accepts a channel', async () => {
    const res = await post('/slack/message', { channel: '#ops', text: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /slack/urgent sends without a channel', async () => {
    const res = await post('/slack/urgent', { message: 'page someone' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/urgent/i);
  });
});

describe('/events — 5, mounted twice', () => {
  const event = { id: 'evt-1', type: 'APPOINTMENT_REMINDER', data: { when: 'tomorrow' } };

  it.each(['/events/', '/events/legacy', '/events/process'])(
    'POST %s accepts an event',
    async (path) => {
      const res = await post(path, { ...event, id: `evt-${path}` });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    },
  );

  it('POST /api/events is mounted too — providers-service posts there', async () => {
    const res = await post('/api/events', { ...event, id: 'evt-api' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /events/batch rejects a non-array body', async () => {
    const res = await post('/events/batch', { not: 'an array' });
    expect(res.status).toBe(400);
  });

  it('POST /events/batch reports per-event outcomes', async () => {
    const res = await post('/events/batch', [
      { ...event, id: 'evt-b1' },
      { ...event, id: 'evt-b2' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it('GET /events/:eventId/status 404s an event nobody sent', async () => {
    const res = await get('/events/never-happened/status');
    expect(res.status).toBe(404);
  });
});

describe('/preferences — 9', () => {
  it('POST /preferences creates a row keyed by the legacy patient id', async () => {
    const res = await post('/preferences/', { userId: PATIENT, allowCommunications: true });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('GET /preferences/:userId returns them without the unsubscribe token', async () => {
    const res = await get(`/preferences/${PATIENT}`);
    expect(res.status).toBe(200);
    // The token is a credential — it is what makes the unauthenticated
    // unsubscribe route safe (D43) — and must never appear in a plain read.
    expect(res.body.preferences).not.toHaveProperty('unsubscribeToken');
  });

  it('PUT /preferences/:userId updates them', async () => {
    const res = await put(`/preferences/${PATIENT}`, { preferredLanguage: 'fr' });
    expect(res.status).toBe(200);
    expect(res.body.preferences.preferredLanguage).toBe('fr');
  });

  it('GET /preferences/:userId 404s an unknown patient', async () => {
    const res = await get('/preferences/nobody');
    expect(res.status).toBe(404);
  });

  it('GET /preferences/:userId/unsubscribe-url returns a URL', async () => {
    const res = await get(`/preferences/${PATIENT}/unsubscribe-url`);
    expect(res.status).toBe(200);
    expect(res.body.unsubscribeUrl).toMatch(/^https:\/\//);
  });

  it('GET /preferences/quiet-hours is not swallowed by /:userId', async () => {
    const res = await get('/preferences/quiet-hours');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('quietHours');
  });

  it('PUT /preferences/quiet-hours stores them per tenant, not globally', async () => {
    const quietHours = { startTime: '22:00', endTime: '06:00', timezone: 'America/New_York' };
    const res = await put('/preferences/quiet-hours', quietHours);
    expect(res.status).toBe(200);
    expect(res.body.quietHours).toEqual(quietHours);

    // A second tenant sees its own window, not this one. The source's was a
    // single process-wide value any caller could overwrite.
    const other = await get(
      '/preferences/quiet-hours',
      gatewayHeaders({ 'x-medspa-id': OTHER_TENANT }),
    );
    expect(other.body.quietHours).toBeNull();
  });

  it('PUT /preferences/quiet-hours rejects an incomplete window', async () => {
    const res = await put('/preferences/quiet-hours', { startTime: '22:00' });
    expect(res.status).toBe(400);
  });

  it('POST /preferences/check reports whether a send is allowed', async () => {
    const res = await post('/preferences/check', {
      userId: PATIENT,
      channels: ['EMAIL'],
      priority: 'MEDIUM',
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('allowed');
  });

  it('POST /preferences/check allows an unknown recipient', async () => {
    const res = await post('/preferences/check', { userId: 'unknown-person' });
    expect(res.body).toMatchObject({ allowed: true });
  });

  it('GET /preferences/unsubscribe does not mutate — mail clients prefetch links', async () => {
    const res = await get('/preferences/unsubscribe?token=whatever');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/POST/);
  });

  it('POST /preferences/unsubscribe by userId unsubscribes', async () => {
    const res = await post('/preferences/unsubscribe', { userId: PATIENT });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('/config — 9', () => {
  it('POST /config/medspa creates the tenant config', async () => {
    const res = await post('/config/medspa', {
      medspaId: TENANT,
      name: 'Legacy Clinic',
      twilioAccountSid: 'ACxxxxxxxxxxxxxxxxxx1234',
      twilioAuthToken: 'super-secret',
      sendgridApiKey: 'SG.secret',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ medspaId: TENANT });
  });

  it('GET /config/medspa/:medspaId masks every secret', async () => {
    const res = await get(`/config/medspa/${TENANT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.twilioAccountSid).toBe('***1234');
    expect(res.body.data.twilioAuthToken).toBe('***');
    expect(res.body.data.sendgridApiKey).toBe('***');
  });

  it('PUT /config/medspa/:medspaId leaves fields it was not given alone', async () => {
    const res = await put(`/config/medspa/${TENANT}`, { sendgridFromName: 'Legacy Clinic' });
    expect(res.status).toBe(200);
    // A partial update must not blank the Twilio credentials it never mentioned.
    expect(res.body.data.twilioAuthToken).toBe('***');
  });

  it('403s a path medspa id that is not the caller’s tenant', async () => {
    const res = await get(`/config/medspa/${OTHER_TENANT}`);
    expect(res.status).toBe(403);
  });

  it('POST /config/provider creates an agent config', async () => {
    const res = await post('/config/provider', {
      medspaId: TENANT,
      providerId: PROVIDER,
      name: 'Dr Ada',
      twilioPhoneNumber: '+15550000009',
      twilioEnabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ providerId: PROVIDER, medspaId: TENANT });
  });

  it('GET /config/provider/:providerId/medspa/:medspaId returns it', async () => {
    const res = await get(`/config/provider/${PROVIDER}/medspa/${TENANT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.senderId).toBe(PROVIDER);
  });

  it('PUT /config/provider/:providerId/medspa/:medspaId updates it', async () => {
    const res = await put(`/config/provider/${PROVIDER}/medspa/${TENANT}`, {
      emailFromName: 'Ada L',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.emailFromName).toBe('Ada L');
  });

  it('GET /config/medspa/:medspaId/providers lists agents', async () => {
    const res = await get(`/config/medspa/${TENANT}/providers`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /config/medspa/:medspaId/phone-numbers lists sending numbers', async () => {
    const res = await get(`/config/medspa/${TENANT}/phone-numbers`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('agentNumbers');
  });

  it('POST /config/test-sms requires a destination', async () => {
    expect((await post('/config/test-sms', { medspaId: TENANT })).status).toBe(400);
    const res = await post('/config/test-sms', { medspaId: TENANT, to: '+15550000001' });
    expect(res.status).toBe(200);
  });
});

describe('/approvals — 9', () => {
  it('GET /approvals/pending/:providerId lists the queue', async () => {
    const res = await get(`/approvals/pending/${PROVIDER}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /approvals/dashboard/:providerId returns counts', async () => {
    const res = await get(`/approvals/dashboard/${PROVIDER}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /approvals/history/:providerId returns a page', async () => {
    const res = await get(`/approvals/history/${PROVIDER}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('403s another provider’s queue — the source lets anyone act on any queue (D45)', async () => {
    const res = await get(`/approvals/pending/${OTHER_PROVIDER}`);
    expect(res.status).toBe(403);
  });

  it.each([
    ['post', '/approvals/approve/'],
    ['post', '/approvals/decline/'],
    ['post', '/approvals/edit-approve/'],
    ['post', '/approvals/schedule/'],
    ['put', '/approvals/edit/'],
  ])('%s %s:messageId 404s a message with no approval', async (method, path) => {
    const body = { content: 'edited', scheduledFor: new Date().toISOString() };
    const res =
      method === 'put' ? await put(`${path}${messageId}`, body) : await post(`${path}${messageId}`, body);
    expect(res.status).toBe(404);
  });

  it('POST /approvals/bulk-action reports per-row outcomes without aborting', async () => {
    const res = await post('/approvals/bulk-action', {
      messageIds: [messageId],
      action: 'approve',
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ messageId, success: false });
  });
});

describe('/communications — 16', () => {
  it('GET /communications/medspa/:medspaId returns {success, data[], pagination}', async () => {
    const res = await get(`/communications/medspa/${TENANT}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toMatchObject({ page: 1, hasPrev: false });

    // The legacy vocabulary, both ways. Located by id rather than by position:
    // earlier tests in this file send messages of their own, so the top of a
    // sentAt-desc page is not stable.
    const seeded = res.body.data.find((m: { id: string }) => m.id === messageId);
    expect(seeded).toMatchObject({ patientId: PATIENT, providerId: PROVIDER, medspaId: TENANT });
    expect(seeded).not.toHaveProperty('recipientId');
    expect(seeded).not.toHaveProperty('senderId');
  });

  it('GET /communications/provider/:providerId is double-nested', async () => {
    const res = await get(`/communications/provider/${PROVIDER}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.data)).toBe(true);
    expect(res.body.data.pagination).toMatchObject({ page: 1 });
  });

  it('GET /communications/provider/:providerId/inbox is not shadowed by /provider/:providerId', async () => {
    const res = await get(`/communications/provider/${PROVIDER}/inbox`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ totalConversations: 1 });
    expect(res.body.data[0]).toMatchObject({ patientId: PATIENT, patientName: 'Ada Lovelace' });
    expect(res.body.data[0].latestMessage.direction).toBe('OUTBOUND');
  });

  it('the inbox truncates the latest message to a 100-character preview', async () => {
    const long = 'x'.repeat(250);
    await h.db.insert(messages).values({
      tenantId: TENANT,
      senderId: PROVIDER,
      recipientId,
      channel: 'EMAIL',
      content: long,
      status: 'SENT',
      sentAt: new Date(Date.now() + 60_000),
    });
    const res = await get(`/communications/provider/${PROVIDER}/inbox`);
    expect(res.body.data[0].latestMessage.content).toHaveLength(103);
    expect(res.body.data[0].latestMessage.content.endsWith('...')).toBe(true);
  });

  it('GET /communications/patient/:patientId resolves the legacy id', async () => {
    const res = await get(`/communications/patient/${PATIENT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('GET /communications/patient/:patientId returns an empty page for an unknown patient', async () => {
    // Not a 404: "no messages yet" is the normal state for a new patient.
    const res = await get('/communications/patient/who-dis');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('GET /communications/conversation/:providerId/:patientId returns the thread', async () => {
    const res = await get(`/communications/conversation/${PROVIDER}/${PATIENT}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ providerId: PROVIDER, patientId: PATIENT });
    expect(res.body.data.messages[0]).toHaveProperty('messageClass');
  });

  it('GET /communications/patient/:patientId/conversation falls back to the header sender', async () => {
    // `?providerId=` wins; absent it, `x-provider-id` from the gateway is used.
    // 400 only when neither is present, which the gateway makes unlikely.
    const explicit = await get(
      `/communications/patient/${PATIENT}/conversation?providerId=${PROVIDER}`,
    );
    expect(explicit.status).toBe(200);

    const implicit = await get(`/communications/patient/${PATIENT}/conversation`);
    expect(implicit.status).toBe(200);
    expect(implicit.body.data.providerId).toBe(PROVIDER);

    const neither = await get(
      `/communications/patient/${PATIENT}/conversation`,
      gatewayHeaders({ 'x-provider-id': '' }),
    );
    expect(neither.status).toBe(400);
  });

  it('GET /communications/analytics/medspa/:medspaId works with no date range', async () => {
    // The source 500s here: it builds "undefined 00:00:00" and casts it (D63).
    const res = await get(`/communications/analytics/medspa/${TENANT}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ byChannel: expect.any(Object) });
  });

  it('GET /communications/analytics/medspa/:medspaId accepts a date range', async () => {
    const res = await get(
      `/communications/analytics/medspa/${TENANT}?dateFrom=2020-01-01&dateTo=2030-01-01`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.totalCommunications).toBeGreaterThan(0);
  });

  it('GET /communications/:id returns one message, last so it shadows nothing', async () => {
    const res = await get(`/communications/${messageId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: messageId, patientId: PATIENT });
  });

  it('GET /communications/:id 404s another tenant’s message', async () => {
    const res = await get(
      `/communications/${messageId}`,
      gatewayHeaders({ 'x-medspa-id': OTHER_TENANT }),
    );
    expect(res.status).toBe(404);
  });

  it('PUT /communications/:messageId/read marks it read, twice without failing', async () => {
    const first = await put(`/communications/${messageId}/read`, {});
    expect(first.status).toBe(200);
    expect(first.body.data.isRead).toBe(true);

    const second = await put(`/communications/${messageId}/read`, {});
    expect(second.status).toBe(200);
    expect(second.body.data.isRead).toBe(true);
  });

  it('PUT /communications/conversation/:providerId/:patientId/read-all', async () => {
    const res = await put(`/communications/conversation/${PROVIDER}/${PATIENT}/read-all`, {});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ providerId: PROVIDER, patientId: PATIENT });
  });

  it.each(['/communications/message', '/communications/create-communication'])(
    'POST %s creates a message',
    async (path) => {
      const res = await post(path, {
        patientId: PATIENT,
        providerId: PROVIDER,
        channel: 'EMAIL',
        content: 'hand-written note',
      });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    },
  );

  it.each([
    ['post', '/communications/response'],
    ['post', '/communications/generate-message'],
    ['get', `/communications/patient/${PATIENT}/conversation/summary`],
    ['get', `/communications/patient/${PATIENT}/info`],
  ])('%s %s answers 501 until P8b, naming its successor', async (method, path) => {
    const res = method === 'get' ? await get(path) : await post(path, {});
    expect(res.status).toBe(501);
    expect(res.body.error.message).toMatch(/v1\//);
  });
});

describe('/queue — 2', () => {
  it('GET /queue/stats keeps the {stats:{notification,event}} shape', async () => {
    const res = await get('/queue/stats');
    expect(res.status).toBe(200);
    expect(res.body.stats).toHaveProperty('notification');
    expect(res.body.stats).toHaveProperty('event');
  });

  it('POST /queue/maintenance needs the admin permission', async () => {
    expect((await post('/queue/maintenance')).status).toBe(403);
  });

  it('POST /queue/maintenance reports what it actually did', async () => {
    const res = await post(
      '/queue/maintenance',
      {},
      gatewayHeaders({ 'x-user-permissions': JSON.stringify(['outreach:admin']) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, performed: [] });
  });
});
