/**
 * Slack adapter. Ports `services/slack/slack.service.ts`'s `sendMessage` only.
 *
 * `sendAppointmentNotification` and `sendUrgentAlert` (slack.service.ts:58,109)
 * are **not** ported as channel methods. They hardcode medspa vocabulary —
 * "Patient", "Treatment", "Provider" block fields, and a default channel of
 * `'urgent-alerts'`. A channel sends; it does not know what a treatment is.
 * They become pack-authored block templates in P7 (§0.10 tier 1: the blocks
 * arrive in `msg.metadata`).
 */
import { WebClient, type Block, type KnownBlock } from '@slack/web-api';

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
import { dryRunResult, failure, type ChannelDeps } from './base.js';

/** Slack rejects messages over 40k characters outright. */
const SLACK_MAX_TEXT = 40_000;

export class SlackChannel implements Channel {
  readonly type: ChannelType = 'slack';
  readonly capabilities: ChannelCapabilities = {
    subject: false,
    html: false,
    attachments: false,
    maxLength: SLACK_MAX_TEXT,
    supportsDeliveryReceipts: false,
  };

  private readonly clients = new Map<string, WebClient>();
  private static readonly MAX_CLIENTS = 50;

  constructor(private readonly deps: ChannelDeps) {}

  validate(msg: RenderedMessage, to: ContactPoint): ValidationOutcome {
    if (!to.value) return { ok: false, reason: 'no slack channel or user id' };
    if (!msg.body && !msg.metadata?.blocks) {
      return { ok: false, reason: 'slack requires a body or blocks' };
    }
    if (msg.body.length > SLACK_MAX_TEXT) {
      return { ok: false, reason: `slack text is ${msg.body.length} chars, max ${SLACK_MAX_TEXT}` };
    }
    return { ok: true };
  }

  private client(botToken: string): WebClient {
    const existing = this.clients.get(botToken);
    if (existing) return existing;

    if (this.clients.size >= SlackChannel.MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }

    const client = new WebClient(botToken);
    this.clients.set(botToken, client);
    return client;
  }

  async send(
    msg: RenderedMessage,
    to: ContactPoint,
    creds: ChannelCredentials,
  ): Promise<DeliveryResult> {
    if (this.deps.dryRun) return dryRunResult(this.deps.logger, this.type, to, msg, creds);

    const botToken = creds.values.botToken;
    if (!botToken) {
      return failure({
        code: 'MISSING_BOT_TOKEN',
        message: 'Slack credentials carry no botToken',
        retryable: false,
      });
    }

    // Blocks are pack-supplied content, carried through untouched.
    const blocks = msg.metadata?.blocks as (Block | KnownBlock)[] | undefined;

    try {
      const response = await this.client(botToken).chat.postMessage({
        channel: to.value || creds.from || '',
        text: msg.body,
        ...(blocks?.length ? { blocks } : {}),
      });

      if (!response.ok) {
        return failure({
          code: `SLACK_${response.error ?? 'ERROR'}`,
          message: response.error ?? 'slack rejected the message',
          // Bad channel or revoked token will not fix itself.
          retryable: false,
        });
      }

      this.deps.logger.info('slack message sent', {
        channel: to.value,
        providerMessageId: response.ts,
        credentialSource: creds.source,
      });

      return { success: true, dispatched: true, providerMessageId: response.ts };
    } catch (error) {
      const code = (error as { data?: { error?: string } }).data?.error;
      return failure(
        {
          code: `SLACK_${code ?? 'ERROR'}`,
          message: error instanceof Error ? error.message : String(error),
          // Rate limits are the one Slack failure worth retrying.
          retryable: code === 'ratelimited',
        },
        error,
      );
    }
  }
}
