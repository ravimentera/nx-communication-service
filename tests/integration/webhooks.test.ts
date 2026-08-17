/**
 * Provider callbacks, end to end through the real app.
 *
 * The unit suite proves the crypto agrees with each provider's documented
 * algorithm. This proves the parts that only exist once everything is wired:
 *
 *  - the routes are reachable **without gateway headers** (a provider has none)
 *  - a bad signature writes **nothing** — the plan's requirement, and the whole
 *    reason to have this endpoint verified at all
 *  - the raw body survives the mount order. `/v1/webhooks` sits before
 *    `express.json`, and if that ever moves, every signature check silently
 *    starts failing on an undefined body — which this catches, because a valid
 *    signature would stop verifying.
 *  - a receipt finds its message through `provider_message_id`, which nothing
 *    in the source ever populated or read (D22)
 */
import { createHmac } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

import winston from 'winston';

import {
  messageAnalytics,
  messages,
  recipients,
  tenantChannelConfigs,
  tenants,
} from '../../src/db/schema.js';
import { MessageService } from '../../src/engine/messaging/message.service.js';
import { startHarness, TENANT, PROVIDER, type Harness } from '../contract/legacy/harness.js';

let h: Harness;
let recipientId: string;
let messageId: string;

const logger = winston.createLogger({ silent: true });

const TWILIO_TOKEN = 'contract-test'; // matches TWILIO_AUTH_TOKEN in the harness
const PUBLIC_URL = 'https://webhooks.example.test';
const OUR_NUMBER = '+15550000000';
const THEIR_NUMBER = '+15559999999';

function twilioSignature(path: string, params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], `${PUBLIC_URL}${path}`);
  return createHmac('sha1', TWILIO_TOKEN).update(payload, 'utf8').digest('base64');
}

const postTwilio = (params: Record<string, string>, signature?: string) =>
  request(h.app)
    .post('/v1/webhooks/twilio')
    .set('x-twilio-signature', signature ?? twilioSignature('/v1/webhooks/twilio', params))
    .type('form')
    .send(params);

beforeAll(async () => {
  h = await startHarness();

  await h.db.insert(tenantChannelConfigs).values({
    tenantId: TENANT,
    name: 'Webhook tenant',
    twilioAccountSid: 'ACcontracttest',
    twilioAuthToken: TWILIO_TOKEN,
    twilioPhoneNumber: OUR_NUMBER,
    twilioEnabled: true,
  });

  const [recipient] = await h.db
    .insert(recipients)
    .values({
      tenantId: TENANT,
      externalRef: { system: 'mentera-patient', id: 'wh-patient' },
      displayName: 'Grace Hopper',
      contactPoints: [{ type: 'phone', value: THEIR_NUMBER, primary: true }],
    })
    .returning({ id: recipients.id });
  recipientId = recipient!.id;

  const [message] = await h.db
    .insert(messages)
    .values({
      tenantId: TENANT,
      senderId: PROVIDER,
      recipientId,
      channel: 'SMS',
      content: 'Your appointment is tomorrow',
      status: 'SENT',
      direction: 'outbound',
      sentAt: new Date(),
      providerMessageId: 'SMtest0001',
      metadata: { playbookKey: 'medspa.appointment-reminder' },
    })
    .returning({ id: messages.id });
  messageId = message!.id;
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('mount order and reachability', () => {
  it('is reachable with no gateway headers — a provider has none', async () => {
    const params = { MessageSid: 'SMtest0001', MessageStatus: 'delivered', AccountSid: 'ACcontracttest' };
    const res = await postTwilio(params);
    // Not 403. The rest of the app requires x-gateway-request.
    expect(res.status).toBe(204);
  });

  it('still refuses an ordinary path without gateway headers', async () => {
    expect((await request(h.app).get('/v1/messages')).status).toBe(403);
  });
});

describe('signature enforcement', () => {
  it('rejects a bad signature and writes nothing', async () => {
    const params = {
      MessageSid: 'SMtest0001',
      MessageStatus: 'failed',
      AccountSid: 'ACcontracttest',
    };
    const res = await postTwilio(params, 'obviously-not-a-signature');

    expect(res.status).toBe(401);

    const [row] = await h.db
      .select({ status: messages.status })
      .from(messages)
      .where(eq(messages.id, messageId));
    // Unchanged. A forged callback must not be able to mark a message failed.
    expect(row!.status).not.toBe('FAILED');
  });

  it('rejects a forged inbound message and creates no row', async () => {
    const before = await h.db.select({ id: messages.id }).from(messages);
    const res = await postTwilio(
      {
        MessageSid: 'SMforged',
        From: THEIR_NUMBER,
        To: OUR_NUMBER,
        Body: 'inject me',
        AccountSid: 'ACcontracttest',
      },
      'forged',
    );

    expect(res.status).toBe(401);
    const after = await h.db.select({ id: messages.id }).from(messages);
    expect(after).toHaveLength(before.length);
  });

  it('verifies against the tenant’s own auth token, found by account sid', async () => {
    // The callback carries no tenant. The account sid is what identifies whose
    // token signs it — a body-supplied tenant id would be forgeable.
    const params = { MessageSid: 'SMtest0001', MessageStatus: 'sent', AccountSid: 'ACcontracttest' };
    expect((await postTwilio(params)).status).toBe(204);
  });
});

describe('delivery receipts', () => {
  it('joins a receipt to its message through provider_message_id', async () => {
    await postTwilio({
      MessageSid: 'SMtest0001',
      MessageStatus: 'delivered',
      AccountSid: 'ACcontracttest',
    });

    const [row] = await h.db
      .select({
        status: messages.status,
        deliveredAt: messages.deliveredAt,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(eq(messages.id, messageId));

    expect(row!.status).toBe('DELIVERED');
    expect(row!.deliveredAt).not.toBeNull();
    // The metadata is merged, not replaced — `playbookKey` is what the
    // compliance gate's cooldown reads, and D49 was exactly this bug.
    expect(row!.metadata).toMatchObject({
      playbookKey: 'medspa.appointment-reminder',
      lastReceipt: 'delivered',
    });
  });

  it('keeps ONE analytics row per message, however many receipts arrive', async () => {
    // Three read paths LEFT JOIN message_analytics. A second row per message
    // makes that message appear twice in a list while `total` counts it once,
    // so `data.length !== total` and the legacy pagination envelope stops being
    // coherent. Before 0008 this produced 2 rows and a 2-row page for 1 message.
    await postTwilio({
      MessageSid: 'SMtest0001',
      MessageStatus: 'read',
      AccountSid: 'ACcontracttest',
    });
    await h.receipts.apply({
      providerMessageId: 'SMtest0001',
      event: 'clicked',
      at: new Date(),
      clickedLink: 'https://example.test/book',
    });

    const analytics = await h.db
      .select({ id: messageAnalytics.id, openedAt: messageAnalytics.openedAt })
      .from(messageAnalytics)
      .where(eq(messageAnalytics.messageId, messageId));
    expect(analytics).toHaveLength(1);

    const page = await new MessageService({ db: h.db, logger }).list(
      { tenantId: TENANT },
      { recipientId },
    );
    expect(page.data.filter((m) => m.id === messageId)).toHaveLength(1);
    expect(page.data.length).toBe(page.total);
  });

  it('keeps the FIRST open, not the most recent', async () => {
    // `opened_at` answers "how long did it take them to open it". Last-write
    // -wins would quietly turn that into "when did they last look at it".
    const [msg] = await h.db
      .insert(messages)
      .values({
        tenantId: TENANT,
        senderId: PROVIDER,
        recipientId,
        channel: 'EMAIL',
        content: 'opened twice',
        status: 'SENT',
        sentAt: new Date(),
        providerMessageId: 'sg-open-order',
      })
      .returning({ id: messages.id });

    const first = new Date('2026-01-01T10:00:00Z');
    const later = new Date('2026-01-05T10:00:00Z');
    await h.receipts.apply({ providerMessageId: 'sg-open-order', event: 'opened', at: first });
    await h.receipts.apply({ providerMessageId: 'sg-open-order', event: 'opened', at: later });

    const [row] = await h.db
      .select({ openedAt: messageAnalytics.openedAt })
      .from(messageAnalytics)
      .where(eq(messageAnalytics.messageId, msg!.id));
    expect(row!.openedAt?.toISOString()).toBe(first.toISOString());
  });

  it('answers 204 for a receipt about a message it never sent', async () => {
    // A provider replays receipts, and during a parallel run some belong to the
    // other deployment. A 404 would have Twilio retrying it for a day.
    const res = await postTwilio({
      MessageSid: 'SMnothinghere',
      MessageStatus: 'delivered',
      AccountSid: 'ACcontracttest',
    });
    expect(res.status).toBe(204);
  });

  it('marks the recipient bounced on a failure that says the address is bad', async () => {
    const [msg] = await h.db
      .insert(messages)
      .values({
        tenantId: TENANT,
        senderId: PROVIDER,
        recipientId,
        channel: 'EMAIL',
        content: 'bounces',
        status: 'SENT',
        sentAt: new Date(),
        providerMessageId: 'sg-bounce-1',
      })
      .returning({ id: messages.id });

    await h.receipts.apply({
      providerMessageId: 'sg-bounce-1',
      event: 'bounced',
      at: new Date(),
      reason: 'mailbox does not exist',
    });

    const [message] = await h.db
      .select({ status: messages.status })
      .from(messages)
      .where(eq(messages.id, msg!.id));
    expect(message!.status).toBe('BOUNCED');

    const [person] = await h.db
      .select({ status: recipients.status })
      .from(recipients)
      .where(eq(recipients.id, recipientId));
    // The compliance gate refuses a bounced recipient; recording it here is
    // what stops the next message repeating the mistake.
    expect(person!.status).toBe('bounced');

    await h.db.update(recipients).set({ status: 'active' }).where(eq(recipients.id, recipientId));
  });
});

/**
 * A validly-signed callback acts on its own tenant's messages and nobody
 * else's.
 *
 * `apply()` looked the message up by `provider_message_id` alone, globally.
 * Provider message ids are the provider's namespace, not ours — and a tenant
 * running its own Twilio account can put any id it likes into a callback it
 * signs correctly with its own token. So tenant A could flip tenant B's message
 * to FAILED and, through the bounce path, set B's recipient to `bounced`: a
 * permanent send block on a real person, caused from another tenant's webhook
 * traffic, where nobody would think to look for it.
 */
describe('receipts cannot cross a tenant boundary', () => {
  it('leaves another tenant’s message alone even with a valid signature', async () => {
    const OTHER = 'other-tenant-wh';
    await h.db
      .insert(tenants)
      .values({ id: OTHER, name: 'Other clinic' })
      .onConflictDoNothing();

    // Same provider message id, different tenant. Nothing stops a provider
    // reusing an id across accounts, and nothing stops a tenant claiming one.
    const [victim] = await h.db
      .insert(messages)
      .values({
        tenantId: OTHER,
        channel: 'sms',
        content: 'Another tenant’s message',
        status: 'SENT',
        direction: 'outbound',
        sentAt: new Date(),
        providerMessageId: 'SMcrosstenant',
      })
      .returning({ id: messages.id });

    const res = await postTwilio({
      MessageSid: 'SMcrosstenant',
      MessageStatus: 'failed',
      AccountSid: 'ACcontracttest',
      ErrorCode: '30003',
    });
    expect(res.status).toBe(204);

    const [after] = await h.db
      .select({ status: messages.status })
      .from(messages)
      .where(eq(messages.id, victim!.id));
    expect(after!.status).toBe('SENT');
  });
});

describe('inbound messages', () => {
  it('records a reply, resolving the tenant from our number and the sender from theirs', async () => {
    const res = await postTwilio({
      MessageSid: 'SMinbound1',
      From: THEIR_NUMBER,
      To: OUR_NUMBER,
      Body: 'Yes, tomorrow works',
      AccountSid: 'ACcontracttest',
    });

    // Twilio renders a TwiML reply from the body; empty means "nothing to say".
    expect(res.status).toBe(200);
    expect(res.text).toBe('<Response></Response>');

    const [row] = await h.db
      .select({
        tenantId: messages.tenantId,
        recipientId: messages.recipientId,
        direction: messages.direction,
        content: messages.content,
        senderName: messages.senderName,
      })
      .from(messages)
      .where(eq(messages.providerMessageId, 'SMinbound1'));

    expect(row).toMatchObject({
      tenantId: TENANT,
      recipientId,
      direction: 'inbound',
      content: 'Yes, tomorrow works',
      senderName: 'Grace Hopper',
    });
  });

  /**
   * Twilio retries any callback it does not get a 2xx for, and its payload
   * carries no timestamp — so unlike SendGrid and Slack there is nothing to
   * reject a replay against at the signature layer. Before `0017` this insert
   * was unguarded and every retry put a second copy of the same patient reply
   * into the thread a provider reads.
   */
  it('records a retried reply once, not twice', async () => {
    const params = {
      MessageSid: 'SMinboundDup',
      From: THEIR_NUMBER,
      To: OUR_NUMBER,
      Body: 'Confirming, see you then',
      AccountSid: 'ACcontracttest',
    };

    expect((await postTwilio(params)).status).toBe(200);
    expect((await postTwilio(params)).status).toBe(200);

    const rows = await h.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.providerMessageId, 'SMinboundDup'));
    expect(rows).toHaveLength(1);
  });

  it('drops a reply to a number no tenant owns rather than 500ing', async () => {
    const res = await postTwilio({
      MessageSid: 'SMinbound2',
      From: THEIR_NUMBER,
      To: '+15551110000',
      Body: 'wrong number',
      AccountSid: 'ACcontracttest',
    });
    expect(res.status).toBe(200);

    const rows = await h.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.providerMessageId, 'SMinbound2'));
    expect(rows).toHaveLength(0);
  });
});

describe('SendGrid', () => {
  it('rejects an unsigned batch when no public key is configured', async () => {
    // Fail closed. The harness sets no SENDGRID_WEBHOOK_PUBLIC_KEY, so there is
    // no way to verify and therefore no way to accept.
    const res = await request(h.app)
      .post('/v1/webhooks/sendgrid')
      .send([{ event: 'delivered', sg_message_id: 'sg-1.filterdrecv' }]);
    expect(res.status).toBe(401);
  });
});

describe('Slack', () => {
  const secret = 'slack-signing-secret';

  it('echoes the url_verification challenge, so the subscription can be enabled', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;

    const res = await request(h.app)
      .post('/v1/webhooks/slack')
      .set('x-slack-signature', signature)
      .set('x-slack-request-timestamp', timestamp)
      .type('json')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('abc123');
  });

  it('rejects a challenge with no signature', async () => {
    const res = await request(h.app)
      .post('/v1/webhooks/slack')
      .send({ type: 'url_verification', challenge: 'abc123' });
    expect(res.status).toBe(401);
  });
});

/**
 * One tenant owns a Twilio account.
 *
 * `getTenantConfigByTwilioAccount` resolves an inbound callback to a tenant by
 * Account SID with `LIMIT 1` and no ORDER BY, and nothing stopped two rows
 * carrying the same SID — so the answer was whichever row the planner returned.
 *
 * The routing bug is the smaller half. `twilio_account_sid` is settable through
 * `PUT /v1/channels/config`, which a tenant may call for itself, so tenant B
 * could enter tenant A's SID and be resolved as the owner of A's callbacks.
 * Ownership cannot be verified against Twilio from here; first-registrant-wins
 * is the honest approximation and `0021` is what makes it true.
 */
describe('a Twilio account belongs to one tenant', () => {
  it('refuses a second tenant claiming an account already configured', async () => {
    const OTHER = 'twilio-claimant';
    await h.db.insert(tenants).values({ id: OTHER, name: 'Claimant' }).onConflictDoNothing();

    await expect(
      h.channelConfigs.upsertTenantConfig(OTHER, {
        name: 'claimant',
        // The SID the suite's own tenant registered in `beforeAll`.
        twilioAccountSid: 'ACcontracttest',
      }),
    ).rejects.toThrow(/already configured by another tenant/);
  });

  it('lets the owning tenant re-save its own account', async () => {
    // Idempotent: a PUT that re-sends the same config must not trip the check
    // against the row it is itself updating.
    await expect(
      h.channelConfigs.upsertTenantConfig(TENANT, {
        name: 'Webhook tenant',
        twilioAccountSid: 'ACcontracttest',
      }),
    ).resolves.toMatchObject({ tenantId: TENANT });
  });

  it('is enforced by the database, not only by the check', async () => {
    // The check is for the message; the constraint is the guarantee. A path
    // that bypassed the service would otherwise reintroduce the ambiguity.
    await expect(
      h.db.execute(
        sql`INSERT INTO tenant_channel_configs (tenant_id, name, twilio_account_sid)
            VALUES ('twilio-direct', 'direct', 'ACcontracttest')`,
      ),
    ).rejects.toThrow(/unique/i);
  });
});
