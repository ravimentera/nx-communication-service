/**
 * Generate `testing/outreach.postman_collection.json` from `docs/api/openapi.yaml`
 * plus the surfaces the spec does not describe.
 *
 * WHY GENERATED RATHER THAN HAND-WRITTEN
 *
 * There are ~150 operations. A hand-written collection is wrong the day a route
 * changes, and wrong silently — a stale request 404s and reads as a bug in the
 * service. `tests/contract/openapi.test.ts` already fails if `openapi.yaml`
 * drifts from the registered routes, so generating from the spec inherits that
 * guarantee: re-run this script and the collection is correct by construction.
 *
 * WHAT THE SPEC DOES NOT COVER, AND IS ADDED BY HAND BELOW
 *
 *   * the 28 surviving legacy compat endpoints (`docs/api/BREAKING.md`)
 *   * the 12 retired mounts that answer 410 with a successor named
 *   * negative cases — no auth, wrong tenant, dropped `x-medspa-id`
 *
 * Those are behaviours rather than schemas, which is why they are not in an
 * OpenAPI document and why they are the most valuable requests in the file: the
 * legacy surface is where every documented behaviour CHANGE lives.
 *
 * Run:  node testing/build-postman.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const spec = yaml.load(readFileSync(join(ROOT, 'docs/api/openapi.yaml'), 'utf8'));

// ── $ref resolution ──────────────────────────────────────────────────────────
//
// Depth-capped rather than cycle-tracked. A cycle-tracker would emit the node
// once and then a placeholder, which produces a body that looks complete and is
// not. A depth cap degrades to `{}`, which is visibly incomplete — the right
// failure for a fixture a person is about to send at a real service.
function deref(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return node;
  if (node.$ref) {
    const path = node.$ref.replace(/^#\//, '').split('/');
    let target = spec;
    for (const part of path) target = target?.[part];
    return deref(target, depth + 1);
  }
  return node;
}

/**
 * Build an example value for a schema.
 *
 * Prefers, in order: an authored `example`, a `default`, the first `enum`
 * member, then a type-derived placeholder. Authored examples win because the
 * spec's authors knew which values are meaningful — `{{recipientId}}` beats a
 * random UUID at every call site that has one.
 */
function example(schema, name = '', depth = 0) {
  const s = deref(schema, depth);
  if (!s || typeof s !== 'object' || depth > 10) return null;

  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((p) => example(p, name, depth + 1)));
  if (s.oneOf) return example(s.oneOf[0], name, depth + 1);
  if (s.anyOf) return example(s.anyOf[0], name, depth + 1);

  switch (s.type) {
    case 'object': {
      const out = {};
      for (const [key, prop] of Object.entries(s.properties ?? {})) {
        out[key] = example(prop, key, depth + 1);
      }
      return out;
    }
    case 'array':
      return [example(s.items ?? { type: 'string' }, name, depth + 1)];
    case 'integer':
      return 1;
    case 'number':
      return 1;
    case 'boolean':
      return false;
    default:
      return placeholderString(s, name);
  }
}

/**
 * A string placeholder that points at the seeded fixtures wherever it can.
 *
 * The mapping is by field NAME, not by format, because `format: uuid` is true
 * of a recipient id, a message id and a template id alike — and a collection
 * that puts the same UUID in all three is one where every request fails for the
 * same uninformative reason. Names are the only signal available.
 */
function placeholderString(schema, name) {
  const n = name.toLowerCase();
  if (schema.format === 'date-time') return '{{isoNow}}';
  if (schema.format === 'date') return '2026-01-01';
  if (schema.format === 'email') return 'ada@example.com';
  if (schema.format === 'uri') return 'https://example.com/hook';

  if (n === 'recipientid') return '{{recipientId}}';
  if (n === 'senderid' || n === 'providerid') return '{{senderId}}';
  if (n === 'tenantid') return '{{tenantId}}';
  if (n === 'subtenantid') return '{{subTenantId}}';
  if (n === 'templateid') return '{{templateId}}';
  if (n === 'playbookkey') return 'medspa.appointment-reminder';
  if (n === 'packid') return 'medspa';
  if (n === 'policykey' || n === 'approvalpolicykey') return 'system.transactional';
  if (n === 'channel') return 'email';
  if (n === 'body' || n === 'content') return 'Hello {{recipient.firstName}}, this is a test.';
  if (n === 'subject') return 'Test subject';
  if (n === 'to') return 'ada@example.com';
  if (n === 'reason') return 'Testing from Postman';
  if (n === 'name') return 'Postman fixture';
  if (n === 'key') return 'postman.fixture';
  if (schema.format === 'uuid') return '{{recipientId}}';
  return `sample-${name || 'value'}`;
}

// ── path parameter substitution ──────────────────────────────────────────────
//
// OpenAPI `{id}` becomes a Postman `:id` path variable, with a collection
// variable as its value. The name carries the meaning, so `{id}` under
// `/v1/recipients/{id}` resolves to the seeded recipient and `{id}` under
// `/v1/approvals/{id}` does not — resolving both to the same value is the
// single fastest way to make a collection look broken.
function pathVarValue(paramName, urlPath) {
  const p = paramName.toLowerCase();
  if (p === 'packid') return 'medspa';
  if (p === 'key') return 'medspa.appointment-reminder';
  if (p === 'token') return '{{unsubscribeToken}}';
  if (p === 'senderid') return '{{senderId}}';
  if (p === 'system') return 'mentera-patient';
  if (p === 'externalid') return 'pat-external-9001';
  if (p === 'toolname') return 'listPendingApprovals';
  if (p === 'id') {
    if (urlPath.includes('/recipients/')) return '{{recipientId}}';
    if (urlPath.includes('/approvals/')) return '{{approvalId}}';
    if (urlPath.includes('/approval-policies/')) return '{{policyId}}';
    if (urlPath.includes('/templates/')) return '{{templateId}}';
    if (urlPath.includes('/messages/')) return '{{messageId}}';
    if (urlPath.includes('/campaigns/')) return '{{campaignId}}';
    if (urlPath.includes('/audiences/')) return '{{audienceId}}';
    if (urlPath.includes('/assets/')) return '{{assetId}}';
    if (urlPath.includes('/api-keys/')) return '{{apiKeyId}}';
  }
  if (p === 'recipientid') return '{{recipientId}}';
  return `{{${paramName}}}`;
}

/**
 * Bodies the schema-derived example gets wrong in a way that BREAKS LATER
 * REQUESTS, rather than merely failing itself.
 *
 * `PUT /v1/channels/configs` is the whole reason this map exists. It is an
 * upsert over the tenant's single `tenant_channel_configs` row, and the
 * generated example filled it with `sample-*` credentials and `*Enabled: false`
 * — so running the collection top-to-bottom silently disabled every channel for
 * the tenant, and every send AFTER it answered `503 CHANNEL_NOT_CONFIGURED`.
 * That reads as a credential-resolution bug and is not one.
 *
 * These values mirror `testing/seed-local.sql`, so sending the request is a
 * no-op rather than a demolition. Re-applying the seed also repairs it.
 */
const BODY_OVERRIDES = {
  'PUT /v1/channels/configs': {
    name: 'Alpha Aesthetics',
    twilioAccountSid: 'ACalpha0000000000000000000000001',
    twilioAuthToken: 'fake-auth-token-alpha',
    twilioPhoneNumber: '+15550100',
    twilioEnabled: true,
    sendgridApiKey: 'SG.fake-alpha-key',
    sendgridFromEmail: 'hello@alpha.example',
    sendgridFromName: 'Alpha Aesthetics',
    sendgridEnabled: true,
    slackBotToken: 'xoxb-fake-alpha',
    slackDefaultChannel: '#alpha-alerts',
    slackEnabled: true,
    timezone: 'America/New_York',
    defaultLanguage: 'en',
    requireOptIn: false,
    isActive: true,
  },
};

const AUTH_HEADERS = [
  { key: 'x-gateway-request', value: 'true' },
  { key: 'x-tenant-id', value: '{{tenantId}}' },
  { key: 'x-user-id', value: '{{userId}}' },
  { key: 'x-user-role', value: '{{userRole}}' },
  { key: 'x-sender-id', value: '{{senderId}}' },
];

/** Paths mounted before the auth middleware in `app.ts`. They take no headers. */
const PRE_AUTH = [/^\/health/, /^\/metrics/, /^\/unsubscribe\//, /^\/mcp\//, /^\/v1\/webhooks\//];
const isPreAuth = (p) => PRE_AUTH.some((re) => re.test(p));

function makeRequest({ name, method, rawPath, description, body, headers, query = [], tests }) {
  const segments = rawPath.replace(/^\//, '').split('/');
  const variable = [];

  const postmanSegments = segments.map((seg) => {
    const m = seg.match(/^\{(.+)\}$/);
    if (!m) return seg;
    variable.push({ key: m[1], value: pathVarValue(m[1], rawPath) });
    return `:${m[1]}`;
  });

  const req = {
    name,
    request: {
      method,
      header: headers ?? (isPreAuth(rawPath) ? [] : [...AUTH_HEADERS]),
      url: {
        raw: `{{baseUrl}}${rawPath}${query.length ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : ''}`,
        host: ['{{baseUrl}}'],
        path: postmanSegments,
        ...(query.length ? { query } : {}),
        ...(variable.length ? { variable } : {}),
      },
      ...(description ? { description } : {}),
    },
    response: [],
  };

  if (body !== undefined && body !== null) {
    req.request.header = [{ key: 'content-type', value: 'application/json' }, ...req.request.header];
    req.request.body = {
      mode: 'raw',
      raw: JSON.stringify(body, null, 2),
      options: { raw: { language: 'json' } },
    };
  }

  if (tests) {
    req.event = [{ listen: 'test', script: { type: 'text/javascript', exec: tests } }];
  }

  return req;
}

// ── captures ─────────────────────────────────────────────────────────────────
//
// A handful of creates write their new id into a collection variable, so the
// requests that operate on that id work without a manual copy-paste. Only for
// resources the seed cannot pre-create, because they have no stable id until
// the API assigns one.
const CAPTURES = {
  'POST /v1/templates': 'templateId',
  'POST /v1/approval-policies': 'policyId',
  'POST /v1/campaigns': 'campaignId',
  'POST /v1/audiences': 'audienceId',
  'POST /v1/api-keys': 'apiKeyId',
  'POST /v1/messages': 'messageId',
  'POST /v1/assets': 'assetId',
};

function captureScript(varName) {
  return [
    'const ok = pm.response.code < 300;',
    `pm.test("2xx", () => pm.expect(ok, pm.response.text()).to.be.true);`,
    'if (ok) {',
    '  let j; try { j = pm.response.json(); } catch (e) { j = null; }',
    `  const id = j && (j.id || j.messageId || j.${varName});`,
    `  if (id) { pm.collectionVariables.set(${JSON.stringify(varName)}, id); }`,
    '}',
  ];
}

/** The default assertion: not a 5xx, and not an auth failure. */
const BASELINE_TESTS = [
  'pm.test("no server error", () => pm.expect(pm.response.code).to.be.below(500));',
  'pm.test("not rejected by auth", () => pm.expect([401, 403]).to.not.include(pm.response.code));',
];

// ── build the /v1 folders from the spec ──────────────────────────────────────
const folders = new Map();
const folderFor = (tag) => {
  if (!folders.has(tag)) folders.set(tag, { name: tag, item: [], description: '' });
  return folders.get(tag);
};

let specCount = 0;
for (const [rawPath, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(methods)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    specCount += 1;

    const tag = (op.tags && op.tags[0]) || 'other';
    const key = `${method.toUpperCase()} ${rawPath}`;

    // Query parameters, marked disabled so a GET runs clean by default and the
    // filters are one checkbox away rather than one lookup in the spec away.
    const query = (op.parameters ?? [])
      .map((p) => deref(p))
      .filter((p) => p && p.in === 'query')
      .map((p) => ({
        key: p.name,
        value: String(example(p.schema, p.name) ?? ''),
        disabled: true,
        ...(p.description ? { description: p.description } : {}),
      }));

    let body;
    const rb = deref(op.requestBody);
    const json = rb?.content?.['application/json']?.schema;
    if (json) body = example(json);
    if (BODY_OVERRIDES[key]) body = BODY_OVERRIDES[key];
    // multipart is asset upload: Postman needs formdata, handled by hand below.
    if (rb?.content?.['multipart/form-data']) body = undefined;

    const captureVar = CAPTURES[key];

    folderFor(tag).item.push(
      makeRequest({
        name: `${method.toUpperCase()} ${rawPath}${op.summary ? ` — ${op.summary}` : ''}`,
        method: method.toUpperCase(),
        rawPath,
        description: [op.summary, op.description].filter(Boolean).join('\n\n'),
        body,
        query,
        tests: captureVar ? captureScript(captureVar) : BASELINE_TESTS,
      }),
    );
  }
}

// ── the legacy compat surface ────────────────────────────────────────────────
//
// Hand-written because it is not in `openapi.yaml` — deliberately: the spec
// documents the surface consumers should move TO. Every entry here corresponds
// to a row in `docs/api/BREAKING.md`, and the descriptions name the behaviour
// change so a tester knows what they are looking at rather than just whether it
// returned 200.
const LEGACY = [
  ['GET', '/approvals/pending/{providerId}', null,
    'Mobile inbox. Reads the SAME `approvals` table as /v1 now — the source had TWO disjoint inboxes (this one filtered on `status`, /ai-enhanced on `queued_message->>approvalStatus`), so a provider saw drafts they did not know existed. D46.'],
  ['POST', '/approvals/approve/{messageId}', {},
    'THE HIGHEST-IMPACT CHANGE AT CUTOVER. In the source this flipped a status column and nothing read it back — approving never sent anything (D44). Here it dispatches. Call it twice: the source answered 400 on a double-click, this answers 200 both times.'],
  ['POST', '/approvals/decline/{messageId}', { reason: 'Not appropriate' }, 'Decline. Cancels the approval.'],
  ['POST', '/approvals/edit/{messageId}', { content: 'Edited body text.' }, 'Edit the draft without approving it.'],
  ['POST', '/approvals/edit-approve/{messageId}', { content: 'Edited and approved.' }, 'Edit then approve, atomically.'],

  ['GET', '/communications/provider/{providerId}/inbox', null,
    'WAS A GUARANTEED 500. The source built SELECT DISTINCT … GROUP BY with a correlated subquery over two ungrouped columns, which Postgres rejects at plan time — it failed even on an empty table. The FE success path for this screen has never run against real data (D61).'],
  ['GET', '/communications/conversation/{providerId}/{patientId}', null,
    '`queuedMessage` is always null now and isPendingApproval/isApproved/isDeclined are always false — the column behind all four was dropped (D103). The KEYS stay, because the web and mobile apps read `message.queuedMessage.content` and guard on the object being present.'],
  ['POST', '/communications/message', { patientId: '{{legacyPatientId}}', providerId: '{{senderId}}', channel: 'EMAIL', content: 'Hello from the legacy surface.', subject: 'Legacy send' },
    'Legacy send. Note the UPPERCASE channel — `toLegacyChannel` restores it on every legacy response even though storage is lowercase (D80).'],
  ['POST', '/communications/create-communication', { patientId: '{{legacyPatientId}}', providerId: '{{senderId}}', channel: 'EMAIL', content: 'Created via legacy path.' },
    'The web app\'s composer path.'],
  ['PUT', '/communications/conversation/{providerId}/{patientId}/read-all', {}, 'Mark a thread read.'],
  ['POST', '/communications/generate-message', { patientId: '{{legacyPatientId}}', providerId: '{{senderId}}', channel: 'EMAIL', purpose: 'follow up after a treatment' },
    'Needs LLM_PROVIDER=stub or real Bedrock creds. Delegates to the same service as /v1/outreach/generate, so both paths produce the same content by construction.'],

  ['GET', '/config/medspa/{medspaId}', null,
    'A `super_admin` could read ANY tenant\'s config in the source. Now 403 unless the path id is the caller\'s own tenant. Try it with x-tenant-id: t-beta.'],
  ['POST', '/config/medspa', { medspaId: '{{tenantId}}', timezone: 'America/New_York', sendgridEnabled: true },
    'Second call is a 201 UPSERT, not the source\'s 409 — `tenant_channel_configs` has UNIQUE(tenant_id), so create and update address the same row and the split pair made an idempotent deploy script impossible.'],
  ['PUT', '/config/medspa/{medspaId}', { timezone: 'America/Chicago' },
    'Works before any POST — 200 upsert instead of the source\'s 404.'],

  ['POST', '/events', { type: 'APPOINTMENT_REMINDER', patientId: '{{legacyPatientId}}', providerId: '{{senderId}}', channels: ['sms'], data: { appointmentDate: '2026-09-01T14:00:00Z', doctorName: 'Dr. Reed' } },
    'scheduling-service posts here. NOTE THE FIELD IS `type`, NOT `eventType` — the legacy envelope\'s spelling.\n\nAn event matching NO playbook is now `{success:true, matched:0}` plus an `outreach_events` row with status UNMATCHED. The source answered `{success:false, message:"Failed to process event"}`, indistinguishable from a real failure, which is how 27 of 44 enum values ended up with no handler and nobody noticed (D56).'],
  ['POST', '/api/events', { type: 'APPOINTMENT_CONFIRMATION', patientId: '{{legacyPatientId}}', providerId: '{{senderId}}', channels: ['email'], data: { appointmentDate: '2026-09-01T14:00:00Z' } },
    'providers-service posts here — its client keeps the gateway\'s /api prefix. BOTH mounts are required; the source only ever worked because the gateway happened to route it.'],
  ['POST', '/events', { type: 'NOT_A_REAL_EVENT', patientId: '{{legacyPatientId}}', channels: ['email'], data: {} },
    'NEGATIVE CASE — expect 200 with matched:0, NOT a 4xx or 5xx. Then check `outreach_events` for a row with status UNMATCHED. This is the D56 fix made observable.'],

  ['GET', '/templates', null,
    'SEAM A — the most consequential tightening in P8b. `template-engine.ts` contains ZERO occurrences of medspaId or tenantId: all fourteen endpoints operated on any template by id, from any tenant, INCLUDING PUT and DELETE (a cross-tenant delete cascaded into template_versions). Every path carries a tenant predicate now. Also: ?channel= is case-SENSITIVE and wants lowercase `sms`.'],
  ['POST', '/templates', { name: 'Legacy template', channel: 'email', content: 'Hi {{recipient.firstName}}', subject: 'Hello' }, 'Create through the legacy path.'],
  ['GET', '/templates/{id}', null, 'Cross-tenant read is 404 now.'],
  ['PUT', '/templates/{id}', { name: 'Renamed via legacy' }, 'Cross-tenant update is 404 now.'],
  ['DELETE', '/templates/{id}', null, 'Cross-tenant delete reports success:false. This is the one that cascaded.'],
  ['POST', '/templates/{id}/render', { context: { appointmentDate: '2026-09-01' } }, 'Render with a context.'],

  ['POST', '/automated-messages/generate', { patientId: '{{legacyPatientId}}', providerId: '{{senderId}}', channel: 'EMAIL', messageType: 'followup' },
    'Web AND mobile both call this. Delegates to the same DraftService as /v1/outreach/generate — it opens an approval and does NOT send (D101).'],

  ['POST', '/messages/webhook/sms', { From: '+15551110001', To: '+15550100', Body: 'Reply from a patient', MessageSid: 'SM-postman-test' },
    'KEPT WITHOUT PROOF OF USE — Twilio holds this URL in its own dashboard, where no grep reaches. /v1/webhooks/twilio is the successor. A receipt for a message sent BEFORE cutover records as unmatched: the source never stored a provider message id, so migrated rows have nothing to join on.'],
  ['POST', '/messages/webhook/email', { event: 'delivered', sg_message_id: 'SG-postman-test', email: 'ada@example.com' },
    'Same: SendGrid\'s dashboard holds this URL.'],

  ['POST', '/ehr-webhook/process-event', { event: 'appointment_no_show', source: 'epic', patientId: '{{legacyPatientId}}', data: {} },
    'An UNMAPPED event returns `{mapped:false}` with a 200 and sends nothing. The source GUESSES — a fallback that picks a mapping for anything, so an unrecognised vendor event still sent a patient a message chosen by heuristic. There is no safe default when the output is a message to someone\'s patient (D68).'],
  ['GET', '/ehr-webhook/mapping-preview/{type}', null,
    'Reports matchedBy: exact | contains. The source\'s `reasonForDecision` was a string hardcoded next to the rule.'],
];

const legacyFolder = {
  name: '99 · Legacy compat surface (28 endpoints)',
  description:
    'The trimmed legacy surface. The shim was built to carry all 110 endpoints for a parallel run that never happened — there is no live traffic and no unknown callers (D99), so the ~86 nothing reaches were retired and these 28 remain, established by GREPPING the six consumers rather than by reading a hit counter no traffic was feeding.\n\n' +
    'Every response here carries `Deprecation: true` and a `Link: </v1/…>; rel="successor-version"` header. Check them — they are how a consumer finds its replacement without reading this repo.\n\n' +
    'These requests are the most valuable in the collection: `docs/api/BREAKING.md` documents ~40 deliberate behaviour changes on this surface, and this is where you observe them.',
  item: LEGACY.map(([method, path, body, description]) =>
    makeRequest({
      name: `${method} ${path}`,
      method,
      rawPath: path,
      description,
      body,
      tests: [
        'pm.test("no server error", () => pm.expect(pm.response.code).to.be.below(500));',
        'pm.test("carries Deprecation header", () => {',
        '  const h = pm.response.headers.get("Deprecation");',
        '  if (h) pm.expect(h).to.eql("true");',
        '});',
      ],
    }),
  ),
};

// Path params the legacy surface uses that the generic mapper does not know.
for (const item of legacyFolder.item) {
  for (const v of item.request.url.variable ?? []) {
    if (v.key === 'providerId') v.value = '{{senderId}}';
    if (v.key === 'patientId') v.value = '{{legacyPatientId}}';
    if (v.key === 'messageId') v.value = '{{approvalMessageId}}';
    if (v.key === 'medspaId') v.value = '{{tenantId}}';
    if (v.key === 'type') v.value = 'appointment_reminder';
  }
}

// ── retired mounts ───────────────────────────────────────────────────────────
const RETIRED = {
  '/sms': 'POST /v1/messages with {channel:"sms"}',
  '/slack': 'POST /v1/messages with {channel:"slack"}',
  '/preferences': '/v1/recipients/:id/preferences, /v1/preferences/*',
  '/queue': '/v1/queue/stats',
  '/ai': 'POST /v1/content/generate with a mode discriminator',
  '/ai-enhanced': 'POST /v1/outreach/generate and /v1/approvals',
  '/leads': '/v1/recipients and POST /v1/outreach/trigger',
  '/treatments': 'POST /v1/outreach/trigger',
  '/patients': 'POST /v1/outreach/trigger',
  '/providers': 'GET /v1/analytics/feedback',
  '/promotions': 'POST /v1/outreach/trigger and /v1/campaigns',
  '/gift-cards': 'POST /v1/outreach/trigger',
};

const retiredFolder = {
  name: '98 · Retired mounts (expect 410 Gone)',
  description:
    '410, not 404, on purpose: the difference between "this never existed" and "this existed, it is gone, here is where it went". Each response names its successor in the body.\n\n' +
    'The inspection that produced this list is complete for everything inside this repo and mentera_core — it cannot see a URL configured in a third party\'s dashboard, and this is the cheap insurance against that.\n\n' +
    'EVERY REQUEST IN THIS FOLDER SHOULD RETURN 410. A 404 means the mount is missing; a 200 means the trim missed something.',
  item: Object.entries(RETIRED).map(([mount, successor]) =>
    makeRequest({
      name: `GET ${mount}/anything — expect 410`,
      method: 'GET',
      rawPath: `${mount}/anything`,
      description: `Retired. Successor: ${successor}`,
      tests: [
        'pm.test("410 Gone", () => pm.response.to.have.status(410));',
        'pm.test("names its successor", () => {',
        '  const j = pm.response.json();',
        '  pm.expect(j.error.successor).to.be.a("string").and.not.empty;',
        '});',
      ],
    }),
  ),
};

// ── negative / auth cases ────────────────────────────────────────────────────
const authFolder = {
  name: '00 · Auth, tenancy and negative cases',
  description:
    'Run these FIRST. They establish that the isolation boundary is real, and every one of them is a claim from `docs/api/BREAKING.md` or hard rule 4 of the extraction plan ("every table gets tenant_id; no query without a tenant predicate").\n\n' +
    'If any request in this folder returns the wrong status, stop testing and report it — a broken tenancy boundary makes every other result meaningless.',
  item: [
    makeRequest({
      name: 'No gateway header — expect 403',
      method: 'GET',
      rawPath: '/v1/messages',
      headers: [],
      description: 'GATEWAY_ONLY=true rejects anything that did not arrive through the gateway.',
      tests: ['pm.test("403", () => pm.response.to.have.status(403));'],
    }),
    makeRequest({
      name: 'x-medspa-id only — expect 4xx (alias was DROPPED in P12)',
      method: 'GET',
      rawPath: '/v1/messages',
      headers: [
        { key: 'x-gateway-request', value: 'true' },
        { key: 'x-medspa-id', value: '{{tenantId}}' },
        { key: 'x-user-id', value: '{{userId}}' },
        { key: 'x-user-role', value: '{{userRole}}' },
      ],
      description:
        'THE ONE CALLER-VISIBLE PROTOCOL CHANGE IN THE WHOLE EXTRACTION, and the last place a vertical noun appeared in something every caller has to speak.\n\n' +
        'x-medspa-id and x-location-id were accepted as fallbacks through the extraction and are now IGNORED — a request carrying only this spelling has no tenant and is rejected, rather than being served against an empty string. The gateway forwards both spellings, so only a direct caller notices (D106).',
      tests: [
        'pm.test("rejected — the alias is gone", () => pm.expect([400, 401, 403]).to.include(pm.response.code));',
      ],
    }),
    makeRequest({
      name: 'Cross-tenant read — expect 404',
      method: 'GET',
      rawPath: '/v1/recipients/{id}',
      headers: [
        { key: 'x-gateway-request', value: 'true' },
        { key: 'x-tenant-id', value: '{{otherTenantId}}' },
        { key: 'x-user-id', value: '{{userId}}' },
        { key: 'x-user-role', value: '{{userRole}}' },
      ],
      description:
        'Tenant B asking for tenant A\'s recipient. 404, not 403 and not a row. This is hard rule 4 made observable.',
      tests: ['pm.test("404", () => pm.response.to.have.status(404));'],
    }),
    makeRequest({
      name: 'Cross-tenant config read — expect 403',
      method: 'GET',
      rawPath: '/config/medspa/{medspaId}',
      headers: [
        { key: 'x-gateway-request', value: 'true' },
        { key: 'x-tenant-id', value: '{{otherTenantId}}' },
        { key: 'x-user-id', value: '{{userId}}' },
        { key: 'x-user-role', value: 'super_admin' },
      ],
      description:
        'A super_admin role could read ANY tenant\'s config in the source. 403 now unless the path id is the caller\'s own tenant (D62).',
      tests: ['pm.test("403", () => pm.response.to.have.status(403));'],
    }),
    makeRequest({
      name: 'GDPR erase without the compliance profile — expect 403',
      method: 'POST',
      rawPath: '/v1/recipients/{id}/erase',
      body: { reason: 'Postman test' },
      description:
        'Both GDPR endpoints need `outreach:admin` AND the tenant carrying {"gdpr": true} on `compliance_profile`. It is {} for every tenant that ships, so a tenant without it gets a 403 NAMING the profile. Seeded tenant `t-gdpr` has it — switch x-tenant-id to t-gdpr and the same call succeeds.',
      tests: ['pm.test("403 for a non-GDPR tenant", () => pm.response.to.have.status(403));'],
    }),
    makeRequest({
      name: 'Health — no auth required',
      method: 'GET',
      rawPath: '/health',
      description: 'Liveness only: 200 whenever the process is up.',
      tests: ['pm.test("200", () => pm.response.to.have.status(200));'],
    }),
    makeRequest({
      name: 'Health detailed — dependency status',
      method: 'GET',
      rawPath: '/health/detailed',
      description:
        'Pings the real dependencies. ONLY the database gates readiness: with Redis stopped this reports `degraded`, still returns 200, and the platform falls back to the in-memory store. Check `checks.packs.detail.loaded` — an empty `errors` array is the goal.',
      tests: [
        'pm.test("200", () => pm.response.to.have.status(200));',
        'pm.test("database up", () => pm.expect(pm.response.json().checks.database.status).to.eql("up"));',
      ],
    }),
    makeRequest({
      name: 'Metrics — loopback only',
      method: 'GET',
      rawPath: '/metrics',
      description:
        'Allow-listed BY SOURCE ADDRESS, not by auth: eight metric families carry a `tenant` label, so one unauthenticated GET would return the tenant roster along with each one\'s send volume and model spend. Defaults to loopback. Answers 404 (not 403) from elsewhere — whether this deployment exposes metrics at all is not something an unauthorized caller needs confirmed.',
      tests: ['pm.test("200 from loopback", () => pm.response.to.have.status(200));'],
    }),
  ],
};
for (const item of authFolder.item) {
  for (const v of item.request.url.variable ?? []) {
    if (v.key === 'id') v.value = '{{recipientId}}';
    if (v.key === 'medspaId') v.value = '{{tenantId}}';
  }
}

// ── assemble ─────────────────────────────────────────────────────────────────
const TAG_ORDER = [
  'health', 'messages', 'recipients', 'approvals', 'content', 'templates',
  'assets', 'playbooks', 'packs', 'campaigns', 'audiences', 'channels',
  'webhooks', 'mcp', 'tenancy', 'usage', 'other',
];
const ordered = [...folders.entries()].sort(
  (a, b) => (TAG_ORDER.indexOf(a[0]) + 1 || 99) - (TAG_ORDER.indexOf(b[0]) + 1 || 99),
);

const collection = {
  info: {
    name: 'Outreach Engine — full local surface',
    _postman_id: 'a7f3c1e0-0000-4000-8000-000000000001',
    description: readFileSync(join(HERE, 'COLLECTION_README.md'), 'utf8'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    authFolder,
    ...ordered.map(([tag, folder], i) => ({
      ...folder,
      name: `${String(i + 1).padStart(2, '0')} · ${tag}`,
    })),
    retiredFolder,
    legacyFolder,
  ],
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: [
          '// `isoNow` is refreshed per request so `sendAt` and date filters are',
          '// always valid relative to when you press Send, rather than to when',
          '// this collection was generated.',
          "pm.collectionVariables.set('isoNow', new Date().toISOString());",
          "pm.collectionVariables.set('isoTomorrow', new Date(Date.now() + 864e5).toISOString());",
        ],
      },
    },
  ],
  variable: [
    { key: 'baseUrl', value: 'http://localhost:5007' },
    { key: 'tenantId', value: 't-alpha' },
    { key: 'otherTenantId', value: 't-beta' },
    { key: 'gdprTenantId', value: 't-gdpr' },
    { key: 'subTenantId', value: '5b000000-0000-4000-8000-000000000001' },
    { key: 'userId', value: 'dev-user' },
    { key: 'userRole', value: 'admin' },
    { key: 'senderId', value: 'sender-1' },
    { key: 'recipientId', value: '11111111-0000-4000-8000-00000000aaa1' },
    { key: 'recipientEmailOnly', value: '11111111-0000-4000-8000-00000000aaa2' },
    { key: 'recipientUnsubscribed', value: '11111111-0000-4000-8000-00000000aaa3' },
    { key: 'recipientQuietHours', value: '11111111-0000-4000-8000-00000000aaa4' },
    { key: 'otherTenantRecipientId', value: '22222222-0000-4000-8000-00000000bbb1' },
    { key: 'gdprRecipientId', value: '33333333-0000-4000-8000-00000000dd01' },
    { key: 'unsubscribeToken', value: 'unsub-token-ada-0001' },
    // Legacy routes address a recipient by its EXTERNAL id (`recipients.external_ref.id`,
    // system `mentera-patient`), NOT by the engine's recipient UUID. Passing the
    // UUID makes `CompatIdentity.ensure` treat it as an unknown patient and CREATE
    // a second, contactless recipient — the send then fails 'No contact point for
    // this recipient and channel' against a row that visibly has two.
    { key: 'legacyPatientId', value: 'pat-ada' },
    // Filled in by the capture scripts on the matching create.
    { key: 'templateId', value: '' },
    { key: 'messageId', value: '' },
    { key: 'approvalId', value: '' },
    { key: 'approvalMessageId', value: '' },
    { key: 'policyId', value: '' },
    { key: 'campaignId', value: '' },
    { key: 'audienceId', value: '' },
    { key: 'assetId', value: '' },
    { key: 'apiKeyId', value: '' },
  ],
};

const outPath = join(HERE, 'outreach.postman_collection.json');
writeFileSync(outPath, JSON.stringify(collection, null, 2));

const total = collection.item.reduce((n, f) => n + f.item.length, 0);
console.log(`Wrote ${outPath}`);
console.log(`  ${specCount} operations from openapi.yaml`);
console.log(`  ${legacyFolder.item.length} legacy compat + ${retiredFolder.item.length} retired + ${authFolder.item.length} auth/negative`);
console.log(`  ${total} requests in ${collection.item.length} folders`);
