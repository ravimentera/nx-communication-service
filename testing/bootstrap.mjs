/**
 * Create the fixtures that have no stable id until the API assigns one, and
 * write them into `testing/outreach.postman_environment.json`.
 *
 * WHY NOT JUST PUT THESE IN THE SEED SQL
 *
 * An approval cannot be seeded honestly. It is the *output* of a policy
 * decision — `DraftService` generates content, `PolicyService` resolves an
 * approver, and the row records who must decide and by when. An INSERT that
 * fabricates one produces a row the state machine never made, and the first
 * thing you test against it (approve → dispatch) is then testing a state the
 * engine cannot actually reach. Same for a campaign, which materializes an
 * audience on launch.
 *
 * So: SQL seeds what is genuinely static (tenants, recipients, preferences,
 * consent), and this creates what must come from the code paths under test.
 *
 * WHY AN ENVIRONMENT FILE RATHER THAN COLLECTION CAPTURES
 *
 * Postman capture scripts make every request depend on the request that ran
 * before it, so the collection only works top-to-bottom and one failure
 * cascades. With an environment file, `POST /v1/approvals/{id}/approve` is
 * runnable on its own, immediately, which is what manual testing needs.
 *
 * Re-run this whenever you have consumed the fixtures — approving an approval
 * spends it, and this mints fresh ones.
 *
 * Usage:
 *   node testing/bootstrap.mjs
 *   BASE_URL=http://localhost:5007 node testing/bootstrap.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://localhost:5007';

const TENANT = 't-alpha';
const OTHER_TENANT = 't-beta';
const GDPR_TENANT = 't-gdpr';
const SENDER = 'sender-1';
const RECIPIENT = '11111111-0000-4000-8000-00000000aaa1';

function headers(tenant = TENANT) {
  return {
    'content-type': 'application/json',
    'x-gateway-request': 'true',
    'x-tenant-id': tenant,
    'x-user-id': 'bootstrap',
    'x-user-role': 'admin',
    'x-sender-id': SENDER,
  };
}

const created = {};
let failures = 0;

async function call(label, method, path, body, tenant = TENANT) {
  process.stdout.write(`  ${label.padEnd(34)}`);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: headers(tenant),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not all responses are JSON */
    }

    if (res.status >= 300) {
      console.log(`\x1b[33m${res.status}\x1b[0m ${text.slice(0, 160)}`);
      failures += 1;
      return null;
    }
    console.log(`\x1b[32m${res.status}\x1b[0m`);
    return json;
  } catch (err) {
    console.log(`\x1b[31mERR\x1b[0m ${err.message}`);
    failures += 1;
    return null;
  }
}

console.log(`Bootstrapping fixtures against ${BASE}\n`);

// ── a template ───────────────────────────────────────────────────────────────
//
// Channel is lower-case. `templates.channel` is compared exactly and every pack
// feeds it lower-case, which is why `GET /templates?channel=SMS` returns nothing
// and `?channel=sms` works (D80). Seeding an upper-case one here would make that
// asymmetry look like a bug in the filter.
/**
 * Create a keyed resource, or reuse the one already there.
 *
 * This script is meant to be re-run, and both `templates` and
 * `approval_policies` carry UNIQUE(tenant_id, key). Creating over an existing
 * key is a **409** (it used to be a 500 — D109), and a
 * fixture script wants the existing row rather than an error either way.
 */
async function findOrCreate(label, listPath, collectionKey, key, body) {
  const list = await call(`${label} (look up)`, 'GET', listPath);
  const items = list?.[collectionKey] ?? list?.items ?? [];
  const hit = Array.isArray(items) ? items.find((x) => x.key === key) : null;
  if (hit) {
    console.log(`  ${`${label} (reused)`.padEnd(34)}\x1b[32mok\x1b[0m`);
    return hit;
  }
  return call(`${label} (create)`, 'POST', listPath.split('?')[0], body);
}

const template = await findOrCreate(
  'template',
  '/v1/templates?pageSize=200',
  'templates',
  'postman.fixture.email',
  {
    key: 'postman.fixture.email',
    name: 'Postman fixture (email)',
    channel: 'email',
    subject: 'Hello {{recipient.firstName}}',
    content: 'Hi {{recipient.firstName}}, this is a fixture rendered at {{now}}.',
    format: 'TEXT',
    category: 'testing',
  },
);
if (template?.id) created.templateId = template.id;

// ── an approval, via the real draft path ─────────────────────────────────────
//
// Needs LLM_PROVIDER=stub or real Bedrock credentials. This is the single most
// valuable fixture in the file: approving it is the highest-impact behaviour
// change at cutover (D44 — in the source, approving flipped a status column
// that nothing read back, so approving never sent anything).
const draft = await call('draft + approval', 'POST', '/v1/outreach/generate', {
  recipientId: RECIPIENT,
  channel: 'email',
  promptPackKey: 'core.content-generate',
  context: { purpose: 'post-treatment follow-up' },
});
if (draft?.approvalId) {
  created.approvalId = draft.approvalId;
  // The legacy `/approvals/*` routes key on the MESSAGE id, not the approval id.
  // Two different identifiers for one decision, and mixing them up produces a
  // 404 that looks like a tenancy failure.
  created.approvalMessageId = draft.messageId;
  created.messageId = draft.messageId;
}

// A second one, so there is still an open approval after you spend the first.
const draft2 = await call('spare draft + approval', 'POST', '/v1/outreach/generate', {
  recipientId: RECIPIENT,
  channel: 'sms',
  promptPackKey: 'core.content-generate',
  context: { purpose: 'appointment reminder' },
});
if (draft2?.approvalId) created.spareApprovalId = draft2.approvalId;

// ── an approval policy ───────────────────────────────────────────────────────
// `kind` is one of agent | role | group | round_robin — there is no `sender`.
// The agent IS the sender in this engine's vocabulary (the rename from
// `providerId` to `senderId` did not reach the approver kinds), and `agent`
// resolves the approver to the message's sender.
//
// `rights.bulk: false` on purpose. It is required IN ADDITION to the
// `outreach:approve:bulk` permission, and the two are not redundant: the
// permission is granted per user, usually broadly, while the right is authored
// per policy by the tenant. A clinic that decides messages under one policy
// must be read one at a time is not overridden by an admin holding a broad
// permission — so a bulk action against this policy must be refused even for
// the admin identity this script uses.
const policy = await findOrCreate(
  'approval policy',
  '/v1/approval-policies',
  'policies',
  'postman.fixture-policy',
  {
    key: 'postman.fixture-policy',
    name: 'Postman fixture policy',
    mode: 'always',
    approverResolution: { kind: 'agent', fallbackApproverRef: SENDER },
    rights: { approve: true, edit: true, decline: true, bulk: false },
  },
);
if (policy?.id) created.policyId = policy.id;

// ── an audience, and a campaign over it ──────────────────────────────────────
const audience = await call('audience', 'POST', '/v1/audiences', {
  name: 'Postman fixture audience',
  kind: 'static',
  description: 'Seeded recipients for campaign testing',
});
if (audience?.id) {
  created.audienceId = audience.id;
  await call('audience members', 'POST', `/v1/audiences/${audience.id}/members`, {
    recipientIds: [RECIPIENT, '11111111-0000-4000-8000-00000000aaa2'],
  });
}

if (created.audienceId) {
  // `playbookKey` is REQUIRED and there is no `channel` or `templateId` here —
  // the playbook owns both. A campaign does not choose a channel; it names a
  // playbook, and the playbook's `channelPlan` decides.
  //
  // `lead.followup` comes from the lead-generation pack, the only one shipping
  // playbooks with a `campaign` trigger. Campaigns target their playbook
  // through a PREDICATE rather than a field: the orchestrator puts
  // `campaignPlaybookKey` in the payload and the playbook declares
  // `where: { campaignPlaybookKey: { eq: 'lead.followup' } }`. The schema now
  // rejects a campaign trigger without that predicate, because a pack author
  // who omitted it got a playbook that fired on EVERY campaign the tenant ran,
  // with nothing warning them (D82).
  const campaign = await call('campaign', 'POST', '/v1/campaigns', {
    name: 'Postman fixture campaign',
    audienceId: created.audienceId,
    playbookKey: 'lead.followup',
    senderId: SENDER,
    context: { purpose: 'fixture campaign for manual testing' },
  });
  if (campaign?.id) created.campaignId = campaign.id;
}

// ── a sent message, so the read paths have something to return ───────────────
//
// CHANNEL_DRY_RUN=true, so this goes through resolve → render → compliance gate
// → queue and stops before the wire.
const sent = await call('message (dry-run send)', 'POST', '/v1/messages', {
  channel: 'email',
  to: { type: 'email', value: 'ada@example.com' },
  recipientId: RECIPIENT,
  senderId: SENDER,
  subject: 'Postman fixture message',
  body: 'This is a fixture message sent in dry-run mode.',
  transactional: true,
});
if (sent?.messageId) created.sentMessageId = sent.messageId;

// ── an API key ───────────────────────────────────────────────────────────────
//
// The plaintext key is returned ONCE and never stored, so it is captured here
// or not at all. It only authenticates anything under AUTH_MODE=apikey; with
// the default AUTH_MODE=gateway this exists to be listed, rotated and revoked.
const apiKey = await call('api key', 'POST', '/v1/api-keys', {
  name: 'Postman fixture key',
  scopes: ['outreach:send', 'outreach:approve'],
});
if (apiKey?.id) {
  created.apiKeyId = apiKey.id;
  if (apiKey.key) created.apiKeyPlaintext = apiKey.key;
}

// ── write the Postman environment ────────────────────────────────────────────
const values = [
  { key: 'baseUrl', value: BASE },
  { key: 'tenantId', value: TENANT },
  { key: 'otherTenantId', value: OTHER_TENANT },
  { key: 'gdprTenantId', value: GDPR_TENANT },
  { key: 'subTenantId', value: '5b000000-0000-4000-8000-000000000001' },
  { key: 'userId', value: 'dev-user' },
  { key: 'userRole', value: 'admin' },
  { key: 'senderId', value: SENDER },
  { key: 'recipientId', value: RECIPIENT },
  { key: 'recipientEmailOnly', value: '11111111-0000-4000-8000-00000000aaa2' },
  { key: 'recipientUnsubscribed', value: '11111111-0000-4000-8000-00000000aaa3' },
  { key: 'recipientQuietHours', value: '11111111-0000-4000-8000-00000000aaa4' },
  { key: 'otherTenantRecipientId', value: '22222222-0000-4000-8000-00000000bbb1' },
  { key: 'gdprRecipientId', value: '33333333-0000-4000-8000-00000000dd01' },
  { key: 'unsubscribeToken', value: 'unsub-token-ada-0001' },
  ...Object.entries(created).map(([key, value]) => ({ key, value: String(value) })),
].map((v) => ({ ...v, type: 'default', enabled: true }));

const envPath = join(HERE, 'outreach.postman_environment.json');
writeFileSync(
  envPath,
  JSON.stringify(
    {
      id: 'b8e4d2f1-0000-4000-8000-000000000002',
      name: 'Outreach — local',
      values,
      _postman_variable_scope: 'environment',
    },
    null,
    2,
  ),
);

console.log(`\nWrote ${envPath}`);
console.log(`  ${Object.keys(created).length} fixtures created, ${values.length} variables`);
if (failures) {
  console.log(`\n\x1b[33m${failures} request(s) did not succeed.\x1b[0m Their variables are absent`);
  console.log('from the environment, so the requests that need them will show an');
  console.log('unresolved {{variable}} rather than failing for a misleading reason.');
}
console.log('\nImport BOTH files into Postman:');
console.log('  testing/outreach.postman_collection.json');
console.log('  testing/outreach.postman_environment.json   <- select it as the active environment');
