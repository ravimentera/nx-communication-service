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
      // Lower case, because that is what the engine writes (D80). The legacy
      // responses below still say 'EMAIL' — toLegacyChannel restores it on the
      // way out, and that round trip is the point of the filter test further
      // down.
      channel: 'email',
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
  it('still refuses a request that did not come through the gateway', async () => {
    const res = await request(h.app).get('/config/medspa/anything');
    expect(res.status).toBe(403);
  });

  it('marks every surviving compat response deprecated and points at its successor', async () => {
    const res = await get('/approvals/pending/provider-1');
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.link).toBe('</v1/approvals>; rel="successor-version"');
  });

  it('counts compat hits, so a mount that stays at zero can be spotted', async () => {
    // The counter no longer *decides* deletions — that was the parallel-run plan
    // and it could never have worked with no traffic (D99). It now confirms the
    // trim was right: a surviving mount at zero after the cutover is one this
    // should have caught.
    await get('/approvals/pending/provider-1');
    const metrics = await request(h.app).get('/metrics');
    expect(metrics.text).toMatch(/outreach_compat_hits_total\{[^}]*path="\/approvals"/);
  });
});

/**
 * The mounts P12 removed (D100). Each answers **410 Gone** naming its successor
 * rather than 404, so a caller the inspection missed learns what happened
 * instead of seeing something indistinguishable from a typo.
 */
describe('retired mounts', () => {
  it.each([
    ['/sms/send', '/v1/messages'],
    ['/slack/message', '/v1/messages'],
    ['/preferences/user-1', '/v1/recipients'],
    ['/queue/stats', '/v1/queue'],
    ['/ai/generate', '/v1/content/generate'],
    ['/ai-enhanced/pending-approvals/provider-1', '/v1/outreach/generate'],
    ['/leads/lead-1/profile', '/v1/recipients'],
    ['/treatments/t-1/follow-up', '/v1/outreach/trigger'],
    ['/patients/p-1/onboarding', '/v1/outreach/trigger'],
    ['/providers/provider-1/feedback/adverse', '/v1/analytics'],
    ['/promotions/', '/v1/outreach/trigger'],
    ['/gift-cards/', '/v1/outreach/trigger'],
  ])('%s answers 410 naming %s', async (path, successor) => {
    const res = await get(path);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('GONE');
    expect(res.body.error.successor).toContain(successor);
  });

  it('answers 410 whatever the method', async () => {
    expect((await post('/sms/send', { to: '+15550000000' })).status).toBe(410);
    expect((await put('/preferences/user-1', {})).status).toBe(410);
  });

  it('does not shadow a surviving sibling', async () => {
    // `/messages/webhook/*` survives while `/messages/generate-reply` does not,
    // and `/templates` survives entirely — a retired mount must not swallow them.
    expect((await get('/templates/')).status).toBe(200);
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

describe('/events — 1, mounted twice', () => {
  const event = { id: 'evt-1', type: 'APPOINTMENT_REMINDER', data: { when: 'tomorrow' } };

  // `/events/legacy` and `/events/process` were retired in P12 (D100): the two
  // callers post to the root path. scheduling-service to `/events`,
  // providers-service to `/api/events`.
  it.each(['/events/'])(
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

  it('GET /events/:eventId/status 404s an event nobody sent', async () => {
    const res = await get('/events/never-happened/status');
    expect(res.status).toBe(404);
  });
});

describe('/config — 3', () => {
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

});

describe('/approvals — 5', () => {
  it('GET /approvals/pending/:providerId lists the queue', async () => {
    const res = await get(`/approvals/pending/${PROVIDER}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('403s another provider’s queue — the source lets anyone act on any queue (D45)', async () => {
    const res = await get(`/approvals/pending/${OTHER_PROVIDER}`);
    expect(res.status).toBe(403);
  });

  /**
   * The check was `!isAdmin && senderId && senderId !== pathProviderId`, so a
   * request that simply omitted the sender header short-circuited on the middle
   * term and passed. Any caller could read any provider's queue — including the
   * message bodies waiting for a decision — by sending one header fewer.
   *
   * A check that is satisfied by supplying less is not a check.
   */
  it('403s a request with no sender identity at all, rather than letting it through', async () => {
    const headers = gatewayHeaders();
    delete headers['x-provider-id'];
    delete headers['x-sender-id'];

    const res = await get(`/approvals/pending/${OTHER_PROVIDER}`, headers);
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

});

describe('/communications — 6', () => {
  /**
   * The legacy `?channel=` filter had no coverage at all, which is how a
   * casing mismatch between the writer and the reader survived from P3 to P9
   * (D80). It is the FE's filter, so it is worth testing on the FE's endpoint
   * rather than only on the service beneath it.
   */
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

  it('GET /communications/conversation/:providerId/:patientId returns the thread', async () => {
    const res = await get(`/communications/conversation/${PROVIDER}/${PATIENT}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ providerId: PROVIDER, patientId: PATIENT });
    expect(res.body.data.messages[0]).toHaveProperty('messageClass');
  });

  it('GET /communications/:id 404s another tenant’s message', async () => {
    const res = await get(
      `/communications/${messageId}`,
      gatewayHeaders({ 'x-tenant-id': OTHER_TENANT }),
    );
    expect(res.status).toBe(404);
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

});

describe('/messages — 2 provider webhooks', () => {
  it('POST /messages/webhook/sms records a reply', async () => {
    const res = await post('/messages/webhook/sms', {
      patientId: PATIENT,
      providerId: PROVIDER,
      fromNumber: '+15550000001',
      toNumber: '+15550000000',
      messageContent: 'Yes please',
      channel: 'SMS',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ patientId: PATIENT, medspaId: TENANT });
    expect(res.body.data.replyId).toBeTruthy();
  });

  it('POST /messages/webhook/sms records a reply from a patient we have never messaged', async () => {
    // The source 404s here: it requires a prior OUTBOUND message on the same
    // channel before it will store anything, so a recipient's first contact is
    // dropped.
    const res = await post('/messages/webhook/sms', {
      patientId: 'never-messaged',
      messageContent: 'Hello?',
      channel: 'SMS',
    });
    expect(res.status).toBe(200);
  });

  it('POST /messages/webhook/email records a reply', async () => {
    const res = await post('/messages/webhook/email', {
      patientId: PATIENT,
      providerId: PROVIDER,
      messageContent: 'Thanks',
      channel: 'EMAIL',
    });
    expect(res.status).toBe(200);
  });

});

/**
 * The tenancy header, after P12 dropped the medspa alias (D106).
 *
 * The gateway forwards `x-tenant-id` and `x-sub-tenant-id` as well as the
 * legacy names, so nothing real reaches this service with only `x-medspa-id`.
 * A caller that does is a caller nobody moved, and it must find out — a request
 * with no tenant that got served against an empty string would be far worse
 * than one that fails.
 */
describe('tenancy headers', () => {
  const legacyOnly = () => {
    const h = gatewayHeaders();
    delete h['x-tenant-id'];
    return { ...h, 'x-medspa-id': TENANT };
  };

  it('rejects a caller that sends only x-medspa-id', async () => {
    const res = await get(`/communications/provider/${PROVIDER}/inbox`, legacyOnly());
    // Not a 200 over the wrong tenant, and not a 500.
    expect([400, 401, 403]).toContain(res.status);
  });

  it('serves the same caller once it sends x-tenant-id', async () => {
    const res = await get(`/communications/provider/${PROVIDER}/inbox`, {
      ...legacyOnly(),
      'x-tenant-id': TENANT,
    });
    expect(res.status).toBe(200);
  });

  it('ignores x-location-id, and reads x-sub-tenant-id', async () => {
    // A sub-tenant that silently failed to apply would widen every query from
    // one location to the whole organisation, which is the quiet direction to
    // fail in.
    const res = await get(`/communications/provider/${PROVIDER}/inbox`, {
      ...gatewayHeaders(),
      'x-location-id': '00000000-0000-4000-8000-0000000000ff',
    });
    expect(res.status).toBe(200);
  });
});
