/**
 * Provider callback signature verification.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SOURCE HAS NONE OF THIS, AND ALSO HAS NO REAL PROVIDER WEBHOOKS.
 *
 * The plan says "check whether the source verifies signatures; if it does not,
 * add it — an unauthenticated inbound webhook that writes to `message_history`
 * is a data-integrity hole." It does not. But the hole is not the one the plan
 * describes, because `POST /messages/webhook/sms` is not a Twilio endpoint:
 *
 *   - It reads `{fromNumber, messageContent, patientId, providerId, medspaId}`
 *     from a JSON body. Twilio posts `application/x-www-form-urlencoded` with
 *     `From`, `To`, `Body`, `MessageSid`, `AccountSid`; SendGrid posts a JSON
 *     *array* of events keyed by `sg_message_id`. Neither would parse.
 *   - It sits **behind** the global gateway auth, so a real callback — which
 *     carries no `x-gateway-request` header — gets a 403 before reaching it.
 *
 * So the source has an internal reply-ingestion API that nothing external can
 * reach, and **no delivery-receipt handling at all**: nothing ever joins a
 * provider's message id back to a row, which is why `provider_message_id` had
 * to be added in P2 and populated in P3 (D22).
 *
 * P8b therefore ships two different things: real provider webhooks at
 * `/v1/webhooks/*`, mounted pre-auth and signature-verified, and the legacy
 * internal envelope at `/messages/webhook/*`, unchanged and still behind auth.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Verification needs the **raw bytes**, not the parsed body: re-serialising
 * JSON reorders keys and changes whitespace, and the signature is over what was
 * actually sent. `rawBodySaver` captures them; the webhook routes are mounted
 * before the ordinary JSON parser.
 */
import { createHmac, createVerify, timingSafeEqual } from 'node:crypto';

import type { Request, Response } from 'express';

/** Reject a callback older than this, so a captured request cannot be replayed. */
const REPLAY_WINDOW_SECONDS = 300;

/**
 * How far ahead of us a caller's clock may legitimately be. Seconds, not
 * minutes: NTP-synced hosts differ by milliseconds, and every second of slack
 * here is a second of extra life for a captured signature.
 */
const CLOCK_SKEW_SECONDS = 30;

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * `express.json({ verify })` hook. Stores the exact bytes on the request.
 * Cheap enough to apply to the webhook mounts only — it doubles the memory a
 * body occupies, which is irrelevant at webhook sizes and is not on any hot path.
 */
export function rawBodySaver(req: RawBodyRequest, _res: Response, buf: Buffer): void {
  if (buf.length) req.rawBody = Buffer.from(buf);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // `timingSafeEqual` throws on a length mismatch, which is itself a leak of
  // one bit; compare lengths first and return the same way either way.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Is this timestamp recent enough to be a live callback rather than a replay?
 *
 * The window is asymmetric on purpose. A timestamp in the **past** is normal —
 * network latency, a provider's retry queue — and gets the full window. A
 * timestamp in the **future** is not: the only innocent cause is clock skew,
 * which is seconds, and an attacker replaying a captured callback can date it
 * whenever they like. `Math.abs` treated a callback stamped four minutes from
 * now as fresh, which extends any captured signature's usable life by the whole
 * window in the direction an attacker controls.
 */
function withinReplayWindow(timestamp: string | undefined, now: number): boolean {
  if (!timestamp) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;

  const ageSeconds = now / 1000 - seconds;
  if (ageSeconds < -CLOCK_SKEW_SECONDS) return false;
  return ageSeconds <= REPLAY_WINDOW_SECONDS;
}

/**
 * Twilio: HMAC-SHA1, base64, over the **full request URL** followed by every
 * POST parameter sorted by key and concatenated as `key + value`.
 *
 * The URL is the part that breaks in production. Twilio signs the URL it
 * requested; behind a gateway that strips `/api/communication` and a load
 * balancer that terminates TLS, `req.protocol` and `req.originalUrl` reconstruct
 * something else entirely. `config.webhooks.publicUrl` states the real one.
 *
 * NO REPLAY WINDOW, AND THERE CANNOT BE ONE. Twilio's callback carries no
 * timestamp — it is not part of the protocol — so there is nothing to compare a
 * clock against, unlike SendGrid and Slack which both sign one. Inventing a
 * check against `Date.now()` here would reject nothing and imply a protection
 * that does not exist.
 *
 * The defence against a replayed Twilio callback is idempotency at the other
 * end instead: an inbound message is uniquely keyed on
 * (tenant, provider_message_id) and upserted, and a status receipt cannot move
 * a message out of a terminal state. A replay is therefore a no-op rather than
 * a duplicate patient reply or a resurrected status.
 *
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function verifyTwilio(input: {
  signature: string | undefined;
  url: string;
  params: Record<string, unknown>;
  authToken: string;
}): boolean {
  if (!input.signature) return false;

  const payload = Object.keys(input.params)
    .sort()
    .reduce((acc, key) => acc + key + String(input.params[key] ?? ''), input.url);

  const expected = createHmac('sha1', input.authToken).update(payload, 'utf8').digest('base64');
  return safeEqual(input.signature, expected);
}

/**
 * SendGrid's Event Webhook: ECDSA over `timestamp + rawBody`, with the public
 * key supplied by SendGrid as base64 DER.
 *
 * Note this is a **signature**, not an HMAC — there is no shared secret, so a
 * leaked verification key cannot be used to forge callbacks. It also means the
 * key is per SendGrid account rather than per tenant; a tenant bringing its own
 * SendGrid account needs its own key, which is a P12 concern alongside
 * `credentials_encrypted`.
 *
 * https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features
 */
export function verifySendgrid(input: {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | undefined;
  publicKey: string;
  now?: number;
}): boolean {
  if (!input.signature || !input.timestamp || !input.rawBody) return false;
  if (!withinReplayWindow(input.timestamp, input.now ?? Date.now())) return false;

  try {
    const verifier = createVerify('sha256');
    verifier.update(input.timestamp);
    verifier.update(input.rawBody);
    verifier.end();

    const key = `-----BEGIN PUBLIC KEY-----\n${input.publicKey}\n-----END PUBLIC KEY-----`;
    return verifier.verify(key, input.signature, 'base64');
  } catch {
    // A malformed key or signature is a failed verification, not a 500. Saying
    // which it was would help someone probing the endpoint.
    return false;
  }
}

/**
 * Slack: HMAC-SHA256 over `v0:{timestamp}:{rawBody}`, compared against
 * `X-Slack-Signature`, with the timestamp checked against a replay window.
 *
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlack(input: {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | undefined;
  signingSecret: string;
  now?: number;
}): boolean {
  if (!input.signature || !input.timestamp || !input.rawBody) return false;
  if (!withinReplayWindow(input.timestamp, input.now ?? Date.now())) return false;

  const base = `v0:${input.timestamp}:${input.rawBody.toString('utf8')}`;
  const expected = `v0=${createHmac('sha256', input.signingSecret).update(base).digest('hex')}`;
  return safeEqual(input.signature, expected);
}

/**
 * The URL Twilio signed.
 *
 * Prefers the configured public origin; falls back to reconstructing from the
 * request, which is correct only when nothing between the internet and this
 * process rewrites the path. `x-forwarded-proto` is honoured because TLS is
 * terminated upstream and `req.protocol` would otherwise report `http`.
 */
export function callbackUrl(req: Request, publicUrl: string | undefined): string {
  if (publicUrl) return `${publicUrl.replace(/\/$/, '')}${req.originalUrl}`;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
  return `${proto}://${req.get('host') ?? ''}${req.originalUrl}`;
}
