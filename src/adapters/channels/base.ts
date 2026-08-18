/**
 * Shared adapter concerns: dry-run and error classification.
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from 'winston';

import type {
  ChannelCredentials,
  ContactPoint,
  DeliveryError,
  DeliveryResult,
  RenderedMessage,
} from '../../ports/channel.js';

export interface ChannelDeps {
  logger: Logger;
  /**
   * Log the send and report success without calling the provider.
   *
   * The source spreads this decision across three adapters as
   * `process.env.NODE_ENV !== 'production'` (twilio.ts:25, sendgrid.ts:27,
   * slack.service.ts:17), which means a staging deploy silently sends nothing
   * and a misconfigured NODE_ENV silently sends everything. Here it is one
   * explicit flag, injected, defaulting to on.
   */
  dryRun: boolean;
  /**
   * Let the webhook adapter reach private and loopback addresses.
   *
   * For local development against `localhost` and for tests. The composition
   * root derives it from `NODE_ENV`, so a production image cannot turn it on
   * by configuration — which is the point, since it disables the SSRF guard.
   */
  allowPrivateWebhookTargets?: boolean;
}

/**
 * A destination safe to write to a log.
 *
 * Every adapter logged `to.value` at info — a patient's phone number or email
 * address, in plaintext, in a logger that has no redaction and supports a file
 * transport. Subjects went with them, and a subject line routinely names the
 * treatment.
 *
 * Enough survives to correlate a log line with a delivery receipt and to tell
 * two recipients apart; not enough to contact anybody or to identify them from
 * the log alone.
 *
 *   ada.lovelace@example.com  ->  a***e@example.com
 *   +15551234567              ->  +1555***4567
 */
export function maskDestination(value: string | undefined): string {
  if (!value) return '(none)';

  const at = value.lastIndexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at);
    // The domain stays: it is the tenant's own mail provider far more often
    // than it is identifying, and it is what makes a bounce diagnosable.
    const head = local[0] ?? '';
    const tail = local.length > 1 ? local[local.length - 1] : '';
    return `${head}***${tail}${domain}`;
  }

  // A phone number. Keep the last four, as a card receipt does, plus the
  // country prefix so a misrouted send is still recognisable.
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 4) {
    const prefix = value.startsWith('+') ? value.slice(0, Math.min(4, value.length - 4)) : '';
    return `${prefix}***${digits.slice(-4)}`;
  }

  return '***';
}

export function dryRunResult(
  logger: Logger,
  channel: string,
  to: ContactPoint,
  msg: RenderedMessage,
  creds: ChannelCredentials,
): DeliveryResult {
  logger.info('dry run — message not sent', {
    channel,
    to: maskDestination(to.value),
    from: creds.from,
    credentialSource: creds.source,
    // The subject is not logged: it routinely names the treatment, which is
    // the most identifying line in the whole message. Its length is enough to
    // tell "a subject was set" from "one was not".
    subjectLength: msg.subject?.length ?? 0,
    bodyLength: msg.body.length,
  });
  return {
    success: true,
    dispatched: false,
    // randomUUID, not Date.now(). Two messages dispatched in the same
    // millisecond — which a campaign does constantly — produced the SAME
    // provider id, and `messages.provider_message_id` is what a receipt joins
    // on. In dry run that meant one receipt could match several messages, and
    // 0017's inbound unique index would reject the second.
    providerMessageId: `dryrun-${channel}-${randomUUID()}`,
  };
}

/**
 * HTTP status → retryability. 5xx and 429 are worth another attempt; 4xx means
 * the request itself is wrong and will be wrong next time too.
 */
export function retryableForStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network failure, no response
  if (status === 429) return true;
  return status >= 500;
}

export function toDeliveryError(
  error: unknown,
  fallbackCode: string,
  retryable: boolean,
): DeliveryError {
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable,
  };
}

export function failure(error: DeliveryError, raw?: unknown): DeliveryResult {
  return { success: false, dispatched: true, error, raw };
}
