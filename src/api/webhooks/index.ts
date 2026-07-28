/**
 * `/v1/webhooks/{twilio,sendgrid,slack}` — real provider callbacks.
 *
 * **Mounted before the auth middleware**, like `/metrics` and `/unsubscribe`.
 * Twilio has no gateway headers and never will; the signature is the credential.
 * That is also why the source's `/messages/webhook/*` has never received a real
 * callback — it sits behind gateway auth and would 403 every one.
 *
 * **Mounted before the ordinary JSON parser**, because signature verification
 * needs the exact bytes. Each router installs its own parser with
 * `rawBodySaver`, and Twilio's is urlencoded rather than JSON.
 *
 * Always answer 2xx once the signature checks out, even when nothing matched.
 * Every one of these providers retries a non-2xx with backoff, and a receipt
 * for a message this deployment did not send is normal during a parallel run —
 * answering 404 would have Twilio retrying it for a day.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import express from 'express';
import type { Logger } from 'winston';

import type { ChannelConfigService } from '../../engine/delivery/channel-config.service.js';
import type {
  Receipt,
  ReceiptEvent,
  ReceiptService,
} from '../../engine/messaging/receipt.service.js';
import { AuthError } from '../../platform/http/errors.js';
import {
  callbackUrl,
  rawBodySaver,
  verifySendgrid,
  verifySlack,
  verifyTwilio,
  type RawBodyRequest,
} from './signature.js';

export interface WebhookDeps {
  receipts: ReceiptService;
  configs: ChannelConfigService;
  logger: Logger;
  config: {
    requireSignature: boolean;
    publicUrl?: string;
    sendgridPublicKey?: string;
    slackSigningSecret?: string;
  };
  /** Env-level Twilio auth token — the fallback when a tenant has none. */
  twilioAuthToken?: string;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Twilio `MessageStatus` → our vocabulary. Unknown values are ignored. */
const TWILIO_STATUS: Record<string, ReceiptEvent> = {
  sent: 'sent',
  delivered: 'delivered',
  undelivered: 'failed',
  failed: 'failed',
  read: 'opened',
};

/** SendGrid event names → ours. */
const SENDGRID_EVENT: Record<string, ReceiptEvent> = {
  processed: 'sent',
  delivered: 'delivered',
  open: 'opened',
  click: 'clicked',
  bounce: 'bounced',
  dropped: 'failed',
  deferred: 'deferred',
  spamreport: 'spam',
  unsubscribe: 'unsubscribed',
};

export function createWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();

  /**
   * A deployment with no verification secret configured cannot verify. Failing
   * closed is the only safe default — an unverified endpoint that writes to
   * `messages` lets anyone mark a message delivered or inject a reply into a
   * clinical conversation. `WEBHOOK_REQUIRE_SIGNATURE=false` exists for local
   * development and says so in the log every single time.
   */
  const unverified = (req: Request, why: string): AuthError | null => {
    if (!deps.config.requireSignature) {
      deps.logger.warn('WEBHOOK SIGNATURE NOT VERIFIED — this must not be a production setting', {
        path: req.path,
        why,
      });
      return null;
    }
    deps.logger.warn('rejected an unverified provider callback', { path: req.path, why });
    return new AuthError('Invalid webhook signature');
  };

  // ── Twilio ────────────────────────────────────────────────────────────────
  // Form-encoded, not JSON. One callback carries either a status update or an
  // inbound message, distinguished by the presence of `Body`.
  router.post(
    '/twilio',
    express.urlencoded({ extended: false, verify: rawBodySaver }),
    handle(async (req, res) => {
      const body = req.body as Record<string, string>;

      // The account sid in the payload identifies the tenant, and the tenant's
      // own auth token is what signed it. An agent-level Twilio account does not
      // exist — an agent has a number, not an account (D20) — so this is the
      // only level that can carry a signing key.
      const accountSid = body.AccountSid;
      const tenantConfig = accountSid
        ? await deps.configs.getTenantConfigByTwilioAccount(accountSid)
        : null;
      const authToken = tenantConfig?.twilioAuthToken ?? deps.twilioAuthToken;

      if (!authToken) {
        const err = unverified(req, 'no auth token for this account sid');
        if (err) throw err;
      } else {
        const ok = verifyTwilio({
          signature: req.get('x-twilio-signature'),
          url: callbackUrl(req, deps.config.publicUrl),
          params: body,
          authToken,
        });
        if (!ok) {
          const err = unverified(req, 'signature mismatch');
          if (err) throw err;
        }
      }

      if (body.Body !== undefined && body.From && body.To) {
        const result = await deps.receipts.recordInbound({
          from: body.From,
          to: body.To,
          channel: 'sms',
          content: body.Body,
          at: new Date(),
          providerMessageId: body.MessageSid,
          raw: body,
        });
        // Twilio renders a TwiML reply from the response body; an empty
        // <Response/> means "received, say nothing back".
        res.type('text/xml').send('<Response></Response>');
        deps.logger.debug('twilio inbound handled', { recorded: result.recorded });
        return;
      }

      const event = TWILIO_STATUS[String(body.MessageStatus ?? '').toLowerCase()];
      if (event && body.MessageSid) {
        await deps.receipts.apply({
          providerMessageId: body.MessageSid,
          event,
          at: new Date(),
          reason: body.ErrorCode ? `twilio ${body.ErrorCode}` : undefined,
          raw: body,
        });
      }
      res.status(204).end();
    }),
  );

  // ── SendGrid ──────────────────────────────────────────────────────────────
  // A JSON **array** of events, batched. One bad event must not drop the batch,
  // because SendGrid replays the whole batch on a non-2xx.
  router.post(
    '/sendgrid',
    express.json({ verify: rawBodySaver, limit: '2mb' }),
    handle(async (req, res) => {
      if (!deps.config.sendgridPublicKey) {
        const err = unverified(req, 'SENDGRID_WEBHOOK_PUBLIC_KEY is not set');
        if (err) throw err;
      } else {
        const ok = verifySendgrid({
          signature: req.get('x-twilio-email-event-webhook-signature'),
          timestamp: req.get('x-twilio-email-event-webhook-timestamp'),
          rawBody: (req as RawBodyRequest).rawBody,
          publicKey: deps.config.sendgridPublicKey,
        });
        if (!ok) {
          const err = unverified(req, 'signature mismatch');
          if (err) throw err;
        }
      }

      const events = Array.isArray(req.body) ? (req.body as Record<string, unknown>[]) : [];
      let applied = 0;

      for (const raw of events) {
        const event = SENDGRID_EVENT[String(raw.event ?? '').toLowerCase()];
        // `sg_message_id` carries a suffix after the id SendGrid returned on
        // send (`<id>.filterdrecv…`); the part before the first dot is what
        // `provider_message_id` holds.
        const id = String(raw.sg_message_id ?? '').split('.')[0];
        if (!event || !id) continue;

        try {
          const receipt: Receipt = {
            providerMessageId: id,
            event,
            at: raw.timestamp ? new Date(Number(raw.timestamp) * 1000) : new Date(),
            reason: typeof raw.reason === 'string' ? raw.reason : undefined,
            clickedLink: typeof raw.url === 'string' ? raw.url : undefined,
            raw,
          };
          const result = await deps.receipts.apply(receipt);
          if (result.applied) applied += 1;
        } catch (error) {
          deps.logger.error('failed to apply one sendgrid event; continuing the batch', {
            event: raw.event,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      res.json({ received: events.length, applied });
    }),
  );

  // ── Slack ─────────────────────────────────────────────────────────────────
  router.post(
    '/slack',
    express.json({ verify: rawBodySaver }),
    handle(async (req, res) => {
      if (!deps.config.slackSigningSecret) {
        const err = unverified(req, 'SLACK_SIGNING_SECRET is not set');
        if (err) throw err;
      } else {
        const ok = verifySlack({
          signature: req.get('x-slack-signature'),
          timestamp: req.get('x-slack-request-timestamp'),
          rawBody: (req as RawBodyRequest).rawBody,
          signingSecret: deps.config.slackSigningSecret,
        });
        if (!ok) {
          const err = unverified(req, 'signature mismatch');
          if (err) throw err;
        }
      }

      const body = req.body as { type?: string; challenge?: string };
      // Slack verifies an endpoint by posting a challenge it expects echoed
      // back. Answering anything else leaves the subscription disabled.
      if (body.type === 'url_verification') {
        res.json({ challenge: body.challenge });
        return;
      }

      // Message events are acknowledged and dropped: Slack is an outbound
      // staff-notification channel here, not a conversation surface. Recording
      // them would put staff chatter into a recipient's message history.
      res.status(204).end();
    }),
  );

  return router;
}
