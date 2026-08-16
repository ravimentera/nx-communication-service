/**
 * Twilio SMS adapter. Ports `services/sms/twilio.ts`.
 *
 * The 3-level credential chain that lived here has moved out to
 * `CredentialResolver` and now serves every channel. What stays is the client
 * cache keyed on `accountSid:authToken` — a good pattern, kept, but **bounded**:
 * the source's `Map` (twilio.ts:22) grows without limit, one entry per distinct
 * tenant credential pair, for the life of the process.
 *
 * `message.sid` is returned as `providerMessageId`; the source logs it and drops
 * it (twilio.ts:161).
 */
import twilio, { type Twilio } from 'twilio';

import type {
  Channel,
  ChannelCapabilities,
  ChannelCredentials,
  ChannelType,
  ContactPoint,
  DeliveryResult,
  RenderedMessage,
  ValidationOutcome,
} from '../../ports/channel.js';
import { maskDestination, dryRunResult, failure, retryableForStatus, type ChannelDeps } from './base.js';

/**
 * Twilio error codes that will never succeed on retry, however many times we
 * try. Retrying 21610 in particular re-sends to someone who has opted out.
 * https://www.twilio.com/docs/api/errors
 */
const PERMANENT_TWILIO_CODES = new Set([
  21211, // invalid 'To' number
  21212, // invalid 'From' number
  21214, // 'To' number is not a valid mobile number
  21408, // permission to send to this region is not enabled
  21610, // recipient has unsubscribed (STOP)
  21614, // 'To' number is not SMS-capable
  30006, // landline or unreachable carrier
]);

export class TwilioChannel implements Channel {
  readonly type: ChannelType = 'sms';
  readonly capabilities: ChannelCapabilities = {
    subject: false,
    html: false,
    attachments: false,
    // Twilio segments beyond 160 chars; 1600 is the hard ceiling per message.
    maxLength: 1600,
    supportsDeliveryReceipts: true,
  };

  private readonly clients = new Map<string, Twilio>();
  private static readonly MAX_CLIENTS = 50;

  constructor(private readonly deps: ChannelDeps) {}

  validate(msg: RenderedMessage, to: ContactPoint): ValidationOutcome {
    if (!to.value) return { ok: false, reason: 'no recipient number' };
    if (!/^\+?[1-9]\d{6,14}$/.test(to.value.replace(/[\s()-]/g, ''))) {
      return { ok: false, reason: `'${to.value}' is not a valid E.164 phone number` };
    }
    if (!msg.body) return { ok: false, reason: 'sms requires a body' };
    if (msg.body.length > (this.capabilities.maxLength ?? Infinity)) {
      return {
        ok: false,
        reason: `sms body is ${msg.body.length} chars, max ${this.capabilities.maxLength}`,
      };
    }
    return { ok: true };
  }

  private client(accountSid: string, authToken: string): Twilio {
    const key = `${accountSid}:${authToken}`;
    const existing = this.clients.get(key);
    if (existing) return existing;

    if (this.clients.size >= TwilioChannel.MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }

    const client = twilio(accountSid, authToken);
    this.clients.set(key, client);
    this.deps.logger.debug('created twilio client', {
      accountSid: `${accountSid.slice(0, 10)}...`,
    });
    return client;
  }

  async send(
    msg: RenderedMessage,
    to: ContactPoint,
    creds: ChannelCredentials,
  ): Promise<DeliveryResult> {
    if (this.deps.dryRun) return dryRunResult(this.deps.logger, this.type, to, msg, creds);

    const { accountSid, authToken } = creds.values;
    if (!accountSid || !authToken) {
      return failure({
        code: 'MISSING_CREDENTIALS',
        message: 'Twilio credentials carry no accountSid/authToken',
        retryable: false,
      });
    }
    if (!creds.from) {
      return failure({
        code: 'MISSING_FROM',
        message: 'Twilio requires a from number',
        retryable: false,
      });
    }

    try {
      const message = await this.client(accountSid, authToken).messages.create({
        to: maskDestination(to.value),
        from: creds.from,
        body: msg.body,
      });

      this.deps.logger.info('sms sent', {
        to: maskDestination(to.value),
        providerMessageId: message.sid,
        credentialSource: creds.source,
      });

      return { success: true, dispatched: true, providerMessageId: message.sid };
    } catch (error) {
      const twilioCode = (error as { code?: number }).code;
      const status = (error as { status?: number }).status;
      const retryable =
        twilioCode !== undefined
          ? !PERMANENT_TWILIO_CODES.has(twilioCode)
          : retryableForStatus(status);

      return failure(
        {
          code: `TWILIO_${twilioCode ?? status ?? 'ERROR'}`,
          message: error instanceof Error ? error.message : String(error),
          retryable,
        },
        error,
      );
    }
  }
}
