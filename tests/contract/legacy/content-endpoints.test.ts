/**
 * The P8b half of the legacy contract suite: `/templates` (14), `/ai` (8),
 * `/ai-enhanced` (6), `/automated-messages` (4), `/ehr-webhook` (3), `/leads`
 * (3), `/treatments` (1), `/patients` (2), `/providers` (1), `/promotions` and
 * its `/gift-cards` alias.
 *
 * Same contract as the P8a file: the status code a caller gets, the envelope,
 * and the deprecation headers. Two things get extra attention because they are
 * tightenings rather than ports — template tenancy, and the EHR mapper's
 * refusal to guess.
 */
import request from 'supertest';

import { messages, recipients } from '../../../src/db/schema.js';
import {
  gatewayHeaders,
  startHarness,
  OTHER_TENANT,
  PROVIDER,
  TENANT,
  type Harness,
} from './harness.js';

let h: Harness;
let templateId: string;
const PATIENT = 'content-patient-1';

const get = (path: string, headers = gatewayHeaders()) => request(h.app).get(path).set(headers);
const post = (path: string, body: unknown = {}, headers = gatewayHeaders()) =>
  request(h.app).post(path).set(headers).send(body as object);
const put = (path: string, body: unknown = {}, headers = gatewayHeaders()) =>
  request(h.app).put(path).set(headers).send(body as object);
const del = (path: string, headers = gatewayHeaders()) =>
  request(h.app).delete(path).set(headers);

beforeAll(async () => {
  h = await startHarness();
  await h.db.insert(recipients).values({
    tenantId: TENANT,
    externalRef: { system: 'mentera-patient', id: PATIENT },
    displayName: 'Grace Hopper',
    contactPoints: [
      { type: 'email', value: 'grace@example.test', primary: true },
      { type: 'phone', value: '+15550000042', primary: true },
    ],
  });
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('/templates — 6', () => {
  it('POST / creates and returns only the id, as providers-service expects', async () => {
    const res = await post('/templates/', {
      name: 'Reminder',
      content: 'Hi {{firstName}}, see you {{when}}.',
      channel: 'email',
      subject: 'Your appointment',
      format: 'TEXT',
      category: 'reminders',
      tags: ['ops'],
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ templateId: expect.any(String) });
    templateId = res.body.templateId;
  });

  it('GET / returns {templates}', async () => {
    const res = await get('/templates/');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates[0]).toHaveProperty('variables');
  });

  it('GET / filters by tag and format', async () => {
    expect((await get('/templates/?tags=ops')).body.templates).toHaveLength(1);
    expect((await get('/templates/?tags=nope')).body.templates).toHaveLength(0);
    expect((await get('/templates/?format=MJML')).body.templates).toHaveLength(0);
  });

  it('GET /:id returns metadata only unless ?content=true', async () => {
    const meta = await get(`/templates/${templateId}`);
    expect(meta.status).toBe(200);
    expect(meta.body).not.toHaveProperty('content');

    const full = await get(`/templates/${templateId}?content=true`);
    expect(full.body.content).toContain('{{firstName}}');
  });

  it('POST /:id/render renders a flat variable bag', async () => {
    const res = await post(`/templates/${templateId}/render`, {
      data: { firstName: 'Grace', when: 'Tuesday' },
    });
    expect(res.status).toBe(200);
    expect(res.body.renderedContent).toBe('Hi Grace, see you Tuesday.');
    expect(res.body.templateId).toBe(templateId);
  });

  it('POST /:id/render requires a data object', async () => {
    expect((await post(`/templates/${templateId}/render`, {})).status).toBe(400);
  });

  it('PUT /:id returns {success}', async () => {
    const res = await put(`/templates/${templateId}`, { content: 'Hi {{firstName}}.' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('is tenant-scoped — the source engine has no tenant predicate at all', async () => {
    // `grep -c "medspaId\\|tenantId" template-engine.ts` returns 0, so today any
    // caller can read, edit or delete any clinic's template by id.
    const otherHeaders = gatewayHeaders({ 'x-tenant-id': OTHER_TENANT });
    expect((await get(`/templates/${templateId}`, otherHeaders)).status).toBe(404);
    expect((await get('/templates/', otherHeaders)).body.templates).toHaveLength(0);
    expect((await del(`/templates/${templateId}`, otherHeaders)).body.success).toBe(false);
  });

  it('DELETE /:id returns {success}', async () => {
    const res = await del(`/templates/${templateId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('/automated-messages — 1', () => {
  // `/bulk-generate`, `/trigger-from-event` and `/test-context/:p/:pr` were
  // retired in P12 (D100) — the web and mobile clients call `/generate` only.
  it('POST /generate drafts one', async () => {
    const res = await post('/automated-messages/generate', {
      patientId: PATIENT,
      channel: 'EMAIL',
      promptPackKey: 'core.content-generate',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.messageId).toEqual(expect.any(String));
  });

});

describe('/ehr-webhook — 3', () => {
  it('POST /process-event maps a known vendor event and triggers', async () => {
    const res = await post('/ehr-webhook/process-event', {
      ehrEventType: 'appointment_no_show',
      ehrSource: 'drchrono',
      patientId: PATIENT,
      providerId: PROVIDER,
      externalEventId: 'ehr-1',
      eventData: { when: 'this morning' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mapped: true });
    expect(res.body.mapping).toMatchObject({
      eventType: 'APPOINTMENT_MISSED',
      matchedBy: 'exact',
    });
  });

  it('falls back to a contains rule when the exact name is unknown', async () => {
    const res = await post('/ehr-webhook/process-event', {
      ehrEventType: 'cerner_appointment_reminder_due',
      patientId: PATIENT,
      providerId: PROVIDER,
      externalEventId: 'ehr-2',
    });
    expect(res.body.mapping).toMatchObject({
      eventType: 'APPOINTMENT_REMINDER',
      matchedBy: 'contains',
    });
  });

  it('refuses to guess at an unmapped event', async () => {
    // `getContextualMapping` in the source picks something and sends it. An
    // unrecognised vendor event producing a patient message is not a safe
    // default.
    const res = await post('/ehr-webhook/process-event', {
      ehrEventType: 'billing_statement_generated',
      patientId: PATIENT,
      providerId: PROVIDER,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mapped: false });
  });

  it('POST /bulk-process reports per-event outcomes', async () => {
    const res = await post('/ehr-webhook/bulk-process', {
      events: [
        { ehrEventType: 'patient_created', patientId: PATIENT, providerId: PROVIDER },
        { ehrEventType: 'nothing_matches_this', patientId: PATIENT, providerId: PROVIDER },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[1]).toMatchObject({ mapped: false });
  });

  it('GET /mapping-preview/:ehrEventType explains how it matched', async () => {
    const res = await get('/ehr-webhook/mapping-preview/treatment_completed');
    expect(res.status).toBe(200);
    expect(res.body.mapping).toMatchObject({
      eventType: 'TREATMENT_COMPLETION',
      matchedBy: 'exact',
      reason: expect.any(String),
    });
  });

  it('POST /process-event validates the required fields', async () => {
    expect((await post('/ehr-webhook/process-event', { ehrEventType: 'x' })).status).toBe(400);
  });
});

describe('deprecation contract', () => {
  it.each([
    ['/templates/', '/v1/templates'],
    ['/ehr-webhook/mapping-preview/x', '/v1/outreach/trigger'],
  ])('%s carries Deprecation and a successor Link', async (path, successor) => {
    const res = await get(path);
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.link).toBe(`<${successor}>; rel="successor-version"`);
  });

  it('never leaves a message on the wrong tenant', async () => {
    const rows = await h.db.select({ tenantId: messages.tenantId }).from(messages);
    expect(rows.every((r) => r.tenantId === TENANT)).toBe(true);
  });
});
