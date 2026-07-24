/**
 * Shared adapter concerns: dry-run and error classification.
 */
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
    to: to.value,
    from: creds.from,
    credentialSource: creds.source,
    subject: msg.subject,
    bodyLength: msg.body.length,
  });
  return {
    success: true,
    dispatched: false,
    providerMessageId: `dryrun-${channel}-${Date.now()}`,
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
