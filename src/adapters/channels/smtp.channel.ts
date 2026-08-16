/**
 * SMTP email adapter. Ports `services/email/nodemailer.ts`.
 * The fallback when a tenant has no SendGrid key. Registered under `email` only
 * when SendGrid is absent — see `createChannelRegistry`.
 */
import nodemailer, { type Transporter } from 'nodemailer';

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
import { maskDestination, dryRunResult, failure, type ChannelDeps } from './base.js';

export class SmtpChannel implements Channel {
  readonly type: ChannelType = 'email';
  readonly capabilities: ChannelCapabilities = {
    subject: true,
    html: true,
    attachments: true,
    // SMTP gives no receipt we can correlate.
    supportsDeliveryReceipts: false,
  };

  private readonly transports = new Map<string, Transporter>();
  private static readonly MAX_TRANSPORTS = 20;

  constructor(private readonly deps: ChannelDeps) {}

  validate(msg: RenderedMessage, to: ContactPoint): ValidationOutcome {
    if (!to.value.includes('@')) return { ok: false, reason: 'recipient is not an email address' };
    if (!msg.subject) return { ok: false, reason: 'email requires a subject' };
    if (!msg.body && !msg.html) return { ok: false, reason: 'email requires body or html' };
    return { ok: true };
  }

  private transport(values: Record<string, string>): Transporter {
    const key = `${values.host}:${values.port}:${values.user}`;
    const existing = this.transports.get(key);
    if (existing) return existing;

    if (this.transports.size >= SmtpChannel.MAX_TRANSPORTS) {
      const oldest = this.transports.keys().next().value;
      if (oldest !== undefined) this.transports.delete(oldest);
    }

    const transport = nodemailer.createTransport({
      host: values.host,
      port: Number(values.port ?? 587),
      secure: values.secure === 'true',
      ...(values.user ? { auth: { user: values.user, pass: values.pass ?? '' } } : {}),
    });
    this.transports.set(key, transport);
    return transport;
  }

  async send(
    msg: RenderedMessage,
    to: ContactPoint,
    creds: ChannelCredentials,
  ): Promise<DeliveryResult> {
    if (this.deps.dryRun) return dryRunResult(this.deps.logger, this.type, to, msg, creds);

    if (!creds.values.host) {
      return failure({
        code: 'MISSING_SMTP_HOST',
        message: 'SMTP credentials carry no host',
        retryable: false,
      });
    }
    if (!creds.from) {
      return failure({
        code: 'MISSING_FROM',
        message: 'SMTP requires a from address',
        retryable: false,
      });
    }

    try {
      const info = await this.transport(creds.values).sendMail({
        to: maskDestination(to.value),
        from: creds.from,
        subject: msg.subject ?? '',
        text: msg.body,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.attachments?.length
          ? {
              attachments: msg.attachments.map((a) => ({
                filename: a.fileName,
                ...(a.content ? { content: a.content } : { path: a.url }),
                contentType: a.mimeType,
              })),
            }
          : {}),
      });

      this.deps.logger.info('email sent via smtp', {
        to: maskDestination(to.value),
        providerMessageId: info.messageId,
      });
      return { success: true, dispatched: true, providerMessageId: info.messageId };
    } catch (error) {
      // SMTP 5xx is permanent, 4xx is a transient greylist/quota condition —
      // the inverse of HTTP, which is a genuinely easy mistake to make here.
      const responseCode = (error as { responseCode?: number }).responseCode;
      return failure(
        {
          code: `SMTP_${responseCode ?? 'ERROR'}`,
          message: error instanceof Error ? error.message : String(error),
          retryable: responseCode === undefined || responseCode < 500,
        },
        error,
      );
    }
  }
}
