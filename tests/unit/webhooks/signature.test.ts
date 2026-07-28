/**
 * Signature verification, per provider.
 *
 * The source has none of this, so there is nothing to port and nothing to
 * regress against — these assertions are the specification. Each provider's
 * expected signature is computed here with the documented algorithm rather than
 * pasted from a fixture, so a test that passes proves the implementation agrees
 * with the algorithm, not that it agrees with itself.
 */
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';

import { verifySendgrid, verifySlack, verifyTwilio } from '../../../src/api/webhooks/signature.js';

describe('Twilio', () => {
  const authToken = 'twilio-auth-token';
  const url = 'https://api.example.test/v1/webhooks/twilio';
  const params = { From: '+15550000001', To: '+15550000000', Body: 'hello', MessageSid: 'SM1' };

  /** HMAC-SHA1 over url + every param sorted by key, concatenated as key+value. */
  const sign = (u: string, p: Record<string, string>): string =>
    createHmac('sha1', authToken)
      .update(
        Object.keys(p)
          .sort()
          .reduce((acc, k) => acc + k + p[k], u),
        'utf8',
      )
      .digest('base64');

  it('accepts a correctly signed request', () => {
    expect(verifyTwilio({ signature: sign(url, params), url, params, authToken })).toBe(true);
  });

  it('rejects a missing signature', () => {
    expect(verifyTwilio({ signature: undefined, url, params, authToken })).toBe(false);
  });

  it('rejects a tampered parameter', () => {
    const signature = sign(url, params);
    const tampered = { ...params, Body: 'transfer the money' };
    expect(verifyTwilio({ signature, url, params: tampered, authToken })).toBe(false);
  });

  it('rejects a signature made with a different account’s token', () => {
    // This is the cross-tenant case: tenant B's Twilio account cannot post a
    // callback that verifies against tenant A's token.
    const other = createHmac('sha1', 'someone-elses-token')
      .update(url + 'BodyhelloFrom+15550000001MessageSidSM1To+15550000000')
      .digest('base64');
    expect(verifyTwilio({ signature: other, url, params, authToken })).toBe(false);
  });

  it('rejects when the URL differs — the URL is part of what is signed', () => {
    // The failure mode in production: behind a gateway that rewrites the path,
    // a reconstructed URL does not match the one Twilio requested. That is what
    // WEBHOOK_PUBLIC_URL exists for.
    const signature = sign('https://api.example.test/api/communication/messages/webhook/sms', params);
    expect(verifyTwilio({ signature, url, params, authToken })).toBe(false);
  });

  it('is order-independent — parameters are sorted before signing', () => {
    const signature = sign(url, params);
    const reordered = { MessageSid: 'SM1', Body: 'hello', To: '+15550000000', From: '+15550000001' };
    expect(verifyTwilio({ signature, url, params: reordered, authToken })).toBe(true);
  });
});

describe('SendGrid', () => {
  // A real EC key pair, generated per run: the algorithm is ECDSA over
  // `timestamp + rawBody`, and the point is that a real signature verifies.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const derPublicKey = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString()
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');

  const rawBody = Buffer.from(JSON.stringify([{ event: 'delivered', sg_message_id: 'sg-1' }]));

  const sign = (timestamp: string, body: Buffer): string => {
    const signer = createSign('sha256');
    signer.update(timestamp);
    signer.update(body);
    signer.end();
    return signer.sign(privateKey, 'base64');
  };

  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));

  it('accepts a correctly signed batch', () => {
    expect(
      verifySendgrid({
        signature: sign(timestamp, rawBody),
        timestamp,
        rawBody,
        publicKey: derPublicKey,
        now,
      }),
    ).toBe(true);
  });

  it('rejects a body edited after signing', () => {
    const signature = sign(timestamp, rawBody);
    const tampered = Buffer.from(JSON.stringify([{ event: 'delivered', sg_message_id: 'sg-2' }]));
    expect(
      verifySendgrid({ signature, timestamp, rawBody: tampered, publicKey: derPublicKey, now }),
    ).toBe(false);
  });

  it('rejects a replayed callback outside the window', () => {
    // The signature is still valid — that is the point. Only the timestamp
    // stops someone re-posting a captured request forever.
    const old = String(Math.floor(now / 1000) - 3600);
    expect(
      verifySendgrid({
        signature: sign(old, rawBody),
        timestamp: old,
        rawBody,
        publicKey: derPublicKey,
        now,
      }),
    ).toBe(false);
  });

  it('rejects a malformed key without throwing', () => {
    expect(
      verifySendgrid({
        signature: sign(timestamp, rawBody),
        timestamp,
        rawBody,
        publicKey: 'not-a-key',
        now,
      }),
    ).toBe(false);
  });

  it('rejects when the raw body was never captured', () => {
    // Guards the mount order: if the shared JSON parser ran first, `rawBody` is
    // undefined and every callback must fail rather than be waved through.
    expect(
      verifySendgrid({
        signature: sign(timestamp, rawBody),
        timestamp,
        rawBody: undefined,
        publicKey: derPublicKey,
        now,
      }),
    ).toBe(false);
  });
});

describe('Slack', () => {
  const signingSecret = 'slack-signing-secret';
  const rawBody = Buffer.from(JSON.stringify({ type: 'event_callback' }));
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));

  const sign = (ts: string, body: Buffer): string =>
    `v0=${createHmac('sha256', signingSecret).update(`v0:${ts}:${body.toString('utf8')}`).digest('hex')}`;

  it('accepts a correctly signed request', () => {
    expect(
      verifySlack({ signature: sign(timestamp, rawBody), timestamp, rawBody, signingSecret, now }),
    ).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const forged = `v0=${createHmac('sha256', 'wrong').update(`v0:${timestamp}:${rawBody.toString()}`).digest('hex')}`;
    expect(verifySlack({ signature: forged, timestamp, rawBody, signingSecret, now })).toBe(false);
  });

  it('rejects a replay', () => {
    const old = String(Math.floor(now / 1000) - 600);
    expect(
      verifySlack({ signature: sign(old, rawBody), timestamp: old, rawBody, signingSecret, now }),
    ).toBe(false);
  });

  it('rejects a non-numeric timestamp instead of treating it as zero', () => {
    expect(
      verifySlack({ signature: sign('abc', rawBody), timestamp: 'abc', rawBody, signingSecret, now }),
    ).toBe(false);
  });
});
