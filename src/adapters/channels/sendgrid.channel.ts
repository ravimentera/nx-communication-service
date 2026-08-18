/**
 * SendGrid email adapter. Ports `services/email/sendgrid.ts`.
 *
 * Two fixes over the source:
 *
 *  1. **The API key is per-tenant.** The source reads it once in the
 *     constructor (`sendgrid.ts:30`) and validates it with
 *     `apiKey.startsWith('SG.')`, so every tenant shares one SendGrid account
 *     regardless of what `medspa_configurations.sendgrid_api_key` says. Here the
 *     key arrives with the credentials and a client is built per key.
 *
 *  2. **`providerMessageId` is returned.** The source discards SendGrid's
 *     response entirely (`sendgrid.ts:99` — `await this.mailService.send(msg)`),
 *     so `x-message-id` is lost and the webhook controller has nothing to join
 *     delivery receipts against. That is why `messages.provider_message_id`
 *     exists.
 */
import { MailService } from '@sendgrid/mail';

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

interface SendGridResponse {
  statusCode?: number;
  headers?: Record<string, string | string[] | undefined>;
}

export class SendGridChannel implements Channel {
  readonly type: ChannelType = 'email';
  readonly capabilities: ChannelCapabilities = {
    subject: true,
    html: true,
    attachments: true,
    supportsDeliveryReceipts: true,
  };

  /** Bounded, keyed on the API key — the source had no client reuse at all. */
  private readonly clients = new Map<string, MailService>();
  private static readonly MAX_CLIENTS = 50;

  constructor(private readonly deps: ChannelDeps) {}

  validate(msg: RenderedMessage, to: ContactPoint): ValidationOutcome {
    if (!to.value.includes('@')) return { ok: false, reason: 'recipient is not an email address' };
    if (!msg.subject) return { ok: false, reason: 'email requires a subject' };
    if (!msg.body && !msg.html) return { ok: false, reason: 'email requires body or html' };
    return { ok: true };
  }

  private client(apiKey: string): MailService {
    const existing = this.clients.get(apiKey);
    if (existing) return existing;

    if (this.clients.size >= SendGridChannel.MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }

    const client = new MailService();
    client.setApiKey(apiKey);
    this.clients.set(apiKey, client);
    return client;
  }

  async send(
    msg: RenderedMessage,
    to: ContactPoint,
    creds: ChannelCredentials,
  ): Promise<DeliveryResult> {
    if (this.deps.dryRun) return dryRunResult(this.deps.logger, this.type, to, msg, creds);

    const apiKey = creds.values.apiKey;
    if (!apiKey) {
      return failure({
        code: 'MISSING_API_KEY',
        message: 'SendGrid credentials carry no apiKey',
        retryable: false,
      });
    }
    if (!creds.from) {
      return failure({
        code: 'MISSING_FROM',
        message: 'SendGrid requires a from address',
        retryable: false,
      });
    }

    try {
      const [response] = (await this.client(apiKey).send({
        to: maskDestination(to.value),
        from: creds.values.fromName
          ? { email: creds.from, name: creds.values.fromName }
          : creds.from,
        subject: msg.subject ?? '',
        text: msg.body,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.attachments?.length
          ? {
              attachments: msg.attachments.map((a) => ({
                filename: a.fileName,
                content: a.content ? a.content.toString('base64') : '',
                type: a.mimeType,
                disposition: 'attachment' as const,
              })),
            }
          : {}),
      })) as unknown as [SendGridResponse];

      const header = response?.headers?.['x-message-id'];
      const providerMessageId = Array.isArray(header) ? header[0] : header;

      this.deps.logger.info('email sent', {
        to: maskDestination(to.value),
        providerMessageId,
        credentialSource: creds.source,
      });

      return { success: true, dispatched: true, providerMessageId, raw: response?.statusCode };
    } catch (error) {
      // `code` is an HTTP status for an API rejection and a STRING for a
      // network failure — 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'. It went
      // straight into `retryableForStatus`, where `'ECONNRESET' >= 500` is
      // false, so every transient network blip was classified permanent and
      // the mail was dropped after one attempt.
      //
      // A numeric code is a real status. Anything else is the transport, and
      // the transport is exactly what is worth retrying.
      const raw = (error as { code?: unknown })?.code;
      const status = typeof raw === 'number' ? raw : undefined;
      const transport = status === undefined;

      return failure(
        {
          code: `SENDGRID_${status ?? (typeof raw === 'string' ? raw : 'ERROR')}`,
          message: error instanceof Error ? error.message : String(error),
          retryable: transport ? true : retryableForStatus(status),
        },
        error,
      );
    }
  }
}
