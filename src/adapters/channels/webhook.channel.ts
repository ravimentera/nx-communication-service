/**
 * Webhook adapter. Ports the send path of
 * `services/notification/webhook-notification.ts` (399L).
 *
 * The endpoint registry that file also carried (`registerEndpoint`,
 * `getEndpointsForEvent`, ... over an in-process Map) is **not** ported: it is
 * subscription state that belongs in a table, and P8 owns the webhook API. This
 * adapter does one thing — deliver one payload to one URL.
 *
 * Retries are BullMQ's job, not the adapter's; the source had its own retry
 * loop inside `sendWebhook`, which multiplied with the queue's retries.
 */
import { createHmac } from 'node:crypto';

import axios, { type AxiosRequestConfig, type Method } from 'axios';

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
import { dryRunResult, failure, retryableForStatus, type ChannelDeps } from './base.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SIGNATURE_HEADER = 'x-outreach-signature';

export class WebhookChannel implements Channel {
  readonly type: ChannelType = 'webhook';
  readonly capabilities: ChannelCapabilities = {
    subject: false,
    html: false,
    attachments: false,
    supportsDeliveryReceipts: false,
  };

  constructor(private readonly deps: ChannelDeps) {}

  validate(_msg: RenderedMessage, to: ContactPoint): ValidationOutcome {
    if (!to.value) return { ok: false, reason: 'no webhook url' };
    try {
      const url = new URL(to.value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { ok: false, reason: `unsupported webhook protocol '${url.protocol}'` };
      }
    } catch {
      return { ok: false, reason: `'${to.value}' is not a valid url` };
    }
    return { ok: true };
  }

  /** Hex-encoded HMAC-SHA256 over the serialized body. Ported verbatim. */
  private sign(body: unknown, secret: string): string {
    return createHmac('sha256', secret)
      .update(typeof body === 'string' ? body : JSON.stringify(body))
      .digest('hex');
  }

  async send(
    msg: RenderedMessage,
    to: ContactPoint,
    creds: ChannelCredentials,
  ): Promise<DeliveryResult> {
    if (this.deps.dryRun) return dryRunResult(this.deps.logger, this.type, to, msg, creds);

    const meta = msg.metadata ?? {};
    const method = ((meta.method as string) ?? 'POST').toUpperCase() as Method;
    const headers = { ...((meta.headers as Record<string, string>) ?? {}) };
    const body = meta.body ?? { body: msg.body, subject: msg.subject };

    const secret = creds.values.signingSecret ?? (meta.secret as string | undefined);
    if (secret) {
      const header = (meta.signatureHeader as string) ?? DEFAULT_SIGNATURE_HEADER;
      headers[header] = this.sign(body, secret);
    }

    const request: AxiosRequestConfig = {
      method,
      url: to.value,
      headers,
      timeout: (meta.timeoutMs as number) ?? DEFAULT_TIMEOUT_MS,
      // Inspect the status ourselves rather than letting axios throw, so a 4xx
      // is classified as permanent instead of retried five times.
      validateStatus: () => true,
      ...(method !== 'GET' ? { data: body } : {}),
    };

    try {
      const response = await axios(request);

      if (response.status >= 200 && response.status < 300) {
        this.deps.logger.info('webhook delivered', { url: to.value, status: response.status });
        return {
          success: true,
          dispatched: true,
          providerMessageId: String(response.headers['x-request-id'] ?? ''),
          raw: response.status,
        };
      }

      return failure(
        {
          code: `WEBHOOK_${response.status}`,
          message: `webhook returned ${response.status}`,
          retryable: retryableForStatus(response.status),
        },
        response.status,
      );
    } catch (error) {
      // No response at all — DNS, connection refused, timeout. Worth retrying.
      return failure({
        code: 'WEBHOOK_NETWORK_ERROR',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }
}
