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
import { assertSafeWebhookUrl } from './url-guard.js';

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

  /**
   * Shape only. The address check is in `send()` and cannot be here: deciding
   * whether a hostname is safe means resolving it, and `validate` is
   * synchronous across every channel.
   */
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

    // ─────────────────────────────────────────────────────────────────────────
    // WHERE THE URL IS CHECKED, AND WHY IT IS HERE
    //
    // This adapter fetches a URL a tenant user supplies, from inside the
    // cluster, and reports the status back. Without a guard that is a
    // request-forgery gadget: cloud instance metadata at 169.254.169.254,
    // anything on localhost, every internal service the pod can reach.
    //
    // As late as possible on purpose — immediately before the request, after
    // any allow-list has been resolved — because a check further from the call
    // is a check something can be inserted after.
    // ─────────────────────────────────────────────────────────────────────────
    const allowedHosts = creds.values.allowedHosts
      ? creds.values.allowedHosts.split(',').map((h) => h.trim()).filter(Boolean)
      : undefined;

    const verdict = await assertSafeWebhookUrl(to.value, {
      ...(allowedHosts?.length ? { allowedHosts } : {}),
      ...(this.deps.allowPrivateWebhookTargets ? { allowPrivateAddresses: true } : {}),
    });

    if (!verdict.ok) {
      this.deps.logger.warn('refused a webhook target', {
        // The hostname, not the full URL: a path can carry a token.
        host: safeHost(to.value),
        reason: verdict.reason,
      });
      return failure({
        code: 'WEBHOOK_TARGET_REFUSED',
        message: verdict.reason ?? 'webhook target refused',
        // Not retryable. The address will be just as private next time, and
        // retrying is five more requests at something we already declined.
        retryable: false,
      });
    }

    const meta = msg.metadata ?? {};
    const method = ((meta.method as string) ?? 'POST').toUpperCase() as Method;
    const headers = { ...((meta.headers as Record<string, string>) ?? {}) };
    const body = meta.body ?? { body: msg.body, subject: msg.subject };

    // From the tenant's config, never from the message.
    //
    // `msg.metadata.secret` was the fallback, which put the signing key into
    // the BullMQ job payload — plaintext in Redis, retained 24h for a completed
    // job and 7d for a failed one. A credential a caller can hand us in a
    // message is a credential in a queue.
    const secret = creds.values.signingSecret;
    if (secret) {
      const header = (meta.signatureHeader as string) ?? DEFAULT_SIGNATURE_HEADER;
      headers[header] = this.sign(body, secret);
    }

    const request: AxiosRequestConfig = {
      method,
      url: to.value,
      headers,
      timeout: (meta.timeoutMs as number) ?? DEFAULT_TIMEOUT_MS,
      // A public URL that 302s to 169.254.169.254 defeats every pre-flight
      // check, because the check ran against the URL we were given and the
      // request went somewhere else. Following redirects here buys nothing a
      // webhook receiver needs.
      maxRedirects: 0,
      // Inspect the status ourselves rather than letting axios throw, so a 4xx
      // is classified as permanent instead of retried five times.
      validateStatus: () => true,
      ...(method !== 'GET' ? { data: body } : {}),
    };

    try {
      const response = await axios(request);

      if (response.status >= 200 && response.status < 300) {
        // Host, not URL: a webhook path routinely carries a token.
        this.deps.logger.info('webhook delivered', {
          host: safeHost(to.value),
          status: response.status,
        });
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

/** The host alone, so a token in the path never reaches a log line. */
function safeHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return '(unparseable)';
  }
}
