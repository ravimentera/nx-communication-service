/**
 * Adapter behaviour that the queue depends on:
 *  - dry-run never calls the provider
 *  - providerMessageId comes back (the source discards SendGrid's and Twilio's)
 *  - validate() rejects before anything is queued
 *  - errors are classified: a permanent failure must not be retried
 */
import winston from 'winston';

import { PushChannel } from '../../../src/adapters/channels/push.channel.js';
import { SendGridChannel } from '../../../src/adapters/channels/sendgrid.channel.js';
import { SlackChannel } from '../../../src/adapters/channels/slack.channel.js';
import { SmtpChannel } from '../../../src/adapters/channels/smtp.channel.js';
import { TwilioChannel } from '../../../src/adapters/channels/twilio.channel.js';
import { WebhookChannel } from '../../../src/adapters/channels/webhook.channel.js';
import type { ChannelCredentials, RenderedMessage } from '../../../src/ports/channel.js';

const logger = winston.createLogger({ silent: true });
const dry = { logger, dryRun: true };
const live = { logger, dryRun: false };

const creds = (values: Record<string, string>, from?: string): ChannelCredentials => ({
  tenantId: 't1',
  source: 'tenant',
  values,
  from,
});

const email: RenderedMessage = { subject: 'Hi', body: 'hello' };
const sms: RenderedMessage = { body: 'hello' };
import { maskDestination } from '../../../src/adapters/channels/base.js';

describe('dry run', () => {
  it.each([
    ['sendgrid', new SendGridChannel(dry), email, { type: 'email', value: 'a@b.c' }],
    ['twilio', new TwilioChannel(dry), sms, { type: 'phone', value: '+15551234567' }],
    ['slack', new SlackChannel(dry), sms, { type: 'slack', value: '#general' }],
    ['smtp', new SmtpChannel(dry), email, { type: 'email', value: 'a@b.c' }],
    ['webhook', new WebhookChannel(dry), sms, { type: 'url', value: 'https://x.y/hook' }],
    ['push', new PushChannel(dry), sms, { type: 'push', value: 'device-token' }],
  ])('%s reports success without dispatching', async (_name, channel, msg, to) => {
    const result = await channel.send(msg, to, creds({}, 'from@x.y'));
    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(false);
    expect(result.providerMessageId).toMatch(/^dryrun-/);
  });
});

describe('validation happens before any send', () => {
  it('twilio rejects a body over its 1600-char ceiling', () => {
    const channel = new TwilioChannel(live);
    const outcome = channel.validate(
      { body: 'x'.repeat(1601) },
      { type: 'phone', value: '+15551234567' },
    );
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('1601 chars') });
  });

  it('twilio accepts exactly 1600', () => {
    const channel = new TwilioChannel(live);
    expect(
      channel.validate({ body: 'x'.repeat(1600) }, { type: 'phone', value: '+15551234567' }).ok,
    ).toBe(true);
  });

  it('twilio rejects a non-E.164 number', () => {
    const channel = new TwilioChannel(live);
    expect(channel.validate(sms, { type: 'phone', value: 'not-a-number' }).ok).toBe(false);
  });

  it('twilio tolerates formatting in an otherwise valid number', () => {
    const channel = new TwilioChannel(live);
    expect(channel.validate(sms, { type: 'phone', value: '+1 (555) 123-4567' }).ok).toBe(true);
  });

  it('sendgrid requires a subject', () => {
    const channel = new SendGridChannel(live);
    expect(channel.validate({ body: 'x' }, { type: 'email', value: 'a@b.c' })).toEqual({
      ok: false,
      reason: 'email requires a subject',
    });
  });

  it('sendgrid rejects a recipient that is not an address', () => {
    const channel = new SendGridChannel(live);
    expect(channel.validate(email, { type: 'email', value: 'nope' }).ok).toBe(false);
  });

  it('webhook rejects a malformed url', () => {
    const channel = new WebhookChannel(live);
    expect(channel.validate(sms, { type: 'url', value: 'not a url' }).ok).toBe(false);
  });

  it('webhook rejects a non-http protocol', () => {
    const channel = new WebhookChannel(live);
    expect(channel.validate(sms, { type: 'url', value: 'ftp://x.y/z' }).ok).toBe(false);
  });
});

describe('missing credentials fail permanently, not on a retry loop', () => {
  it('sendgrid without an api key', async () => {
    const result = await new SendGridChannel(live).send(
      email,
      { type: 'email', value: 'a@b.c' },
      creds({}, 'from@x.y'),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'MISSING_API_KEY', retryable: false });
  });

  it('sendgrid without a from address', async () => {
    const result = await new SendGridChannel(live).send(
      email,
      { type: 'email', value: 'a@b.c' },
      creds({ apiKey: 'SG.x' }),
    );
    expect(result.error).toMatchObject({ code: 'MISSING_FROM', retryable: false });
  });

  it('twilio without account credentials', async () => {
    const result = await new TwilioChannel(live).send(
      sms,
      { type: 'phone', value: '+15551234567' },
      creds({}, '+15550000000'),
    );
    expect(result.error).toMatchObject({ code: 'MISSING_CREDENTIALS', retryable: false });
  });

  it('slack without a bot token', async () => {
    const result = await new SlackChannel(live).send(
      sms,
      { type: 'slack', value: '#general' },
      creds({}),
    );
    expect(result.error).toMatchObject({ code: 'MISSING_BOT_TOKEN', retryable: false });
  });

  it('push without an FCM key', async () => {
    const result = await new PushChannel(live).send(
      sms,
      { type: 'push', value: 'tok' },
      creds({}),
    );
    expect(result.error).toMatchObject({ code: 'MISSING_FCM_KEY', retryable: false });
  });
});

describe('capabilities describe what each channel can carry', () => {
  it('sms carries neither subject nor html', () => {
    const caps = new TwilioChannel(live).capabilities;
    expect(caps.subject).toBe(false);
    expect(caps.html).toBe(false);
    expect(caps.maxLength).toBe(1600);
    expect(caps.supportsDeliveryReceipts).toBe(true);
  });

  it('smtp cannot produce a correlatable receipt but sendgrid can', () => {
    expect(new SmtpChannel(live).capabilities.supportsDeliveryReceipts).toBe(false);
    expect(new SendGridChannel(live).capabilities.supportsDeliveryReceipts).toBe(true);
  });
});

/**
 * Destinations in logs.
 *
 * Every adapter logged `to.value` at info — a patient's phone number or email
 * address in plaintext, in a logger with no redaction and a file transport
 * available. Subjects went with them, and a subject line routinely names the
 * treatment.
 */
describe('maskDestination', () => {
  it('keeps an email diagnosable without carrying the address', () => {
    expect(maskDestination('ada.lovelace@example.com')).toBe('a***e@example.com');
    // The domain survives: it is the tenant's own mail provider far more often
    // than it is identifying, and it is what makes a bounce diagnosable.
    expect(maskDestination('a@example.com')).toBe('a***@example.com');
  });

  it('keeps the last four of a phone number, as a card receipt does', () => {
    expect(maskDestination('+15551234567')).toBe('+155***4567');
    expect(maskDestination('5551234567')).toBe('***4567');
  });

  it('does not leak a short or absent value', () => {
    expect(maskDestination('abc')).toBe('***');
    expect(maskDestination(undefined)).toBe('(none)');
    expect(maskDestination('')).toBe('(none)');
  });
});
