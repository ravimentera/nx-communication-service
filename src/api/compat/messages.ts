// DELETE IN P12
/**
 * `/messages/webhook/sms`, `/messages/webhook/email`, `/messages/generate-reply`.
 *
 * Despite the name, **these are not provider webhooks** (see the header of
 * `api/webhooks/signature.ts`). They take an internal JSON envelope with
 * `patientId`/`providerId`/`medspaId` already resolved, and they sit behind the
 * gateway auth, so a real Twilio or SendGrid callback would 403 before reaching
 * them. Real callbacks live at `/v1/webhooks/*`.
 *
 * They are ported as what they are: an authenticated reply-ingestion API. Two
 * things change.
 *
 *  - **A missing prior message no longer 404s.** The source requires an
 *    existing OUTBOUND message on the same channel before it will record a
 *    reply (`webhooks-controller.ts:128`), so the first thing a recipient ever
 *    sends is dropped. An inbound message is a fact; recording it does not
 *    depend on us having spoken first.
 *  - **The AI reply is not generated inline.** The source calls
 *    `generateConversationReply` inside the request (`:173`), so a webhook
 *    blocks on a Bedrock round trip and a model timeout looks like a failed
 *    webhook — which the provider then retries, generating again. It goes
 *    through the playbook runtime as a `PATIENT_REPLY` trigger instead, and a
 *    tenant with no such playbook simply records the reply.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ReceiptService } from '../../engine/messaging/receipt.service.js';
import type { PlaybookApiDeps } from '../v1/playbooks.js';
import { requireTenant } from '../../platform/http/auth.middleware.js';
import type { MessageService } from '../../engine/messaging/message.service.js';
import { deprecate } from './index.js';
import type { CompatIdentity } from './translate.js';

const replySchema = z.object({
  fromNumber: z.string().optional(),
  toNumber: z.string().optional(),
  messageContent: z.string().min(1),
  messageId: z.string().optional(),
  channel: z.string().default('SMS'),
  timestamp: z.string().optional(),
  providerId: z.string().optional(),
  medspaId: z.string().optional(),
  patientId: z.string().min(1),
});

export interface MessagesCompatDeps {
  receipts: ReceiptService;
  messages: MessageService;
  playbooks: PlaybookApiDeps;
  identity: CompatIdentity;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createLegacyMessagesRouter(deps: MessagesCompatDeps): Router {
  const router = Router();
  router.use(deprecate('/messages', '/v1/webhooks/twilio'));

  const ingest = (channel: string) =>
    handle(async (req: Request, res: Response) => {
      const scope = requireTenant(req);
      const body = replySchema.parse({ ...req.body, channel: req.body?.channel ?? channel });

      // Resolve-or-create: the reply is evidence the recipient exists, even if
      // this tenant has never messaged them from here.
      const recipientId = await deps.identity.ensure(scope, body.patientId, {
        phone: body.fromNumber,
      });

      const result = await deps.receipts.recordInboundFor({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        recipientId,
        senderId: body.providerId ?? req.identity?.senderId,
        channel: body.channel,
        content: body.messageContent,
        at: body.timestamp ? new Date(body.timestamp) : new Date(),
        from: body.fromNumber,
        to: body.toNumber,
      });

      // Fire and forget: a playbook that drafts a reply must not make the
      // caller wait, and its failure must not lose the recorded reply.
      void deps.playbooks.runtime
        .run({
          type: 'event',
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId,
          eventType: 'PATIENT_REPLY',
          correlationId: result.messageId ?? `reply:${body.patientId}`,
          idempotencyKey: `reply:${result.messageId}`,
          recipientId,
          senderId: body.providerId ?? req.identity?.senderId,
          payload: { context: { reply: body.messageContent, channel: body.channel } },
        })
        .catch(() => {
          // Already logged by the runtime; swallowed so an unhandled rejection
          // cannot take the process down.
        });

      res.status(200).json({
        success: true,
        data: {
          replyId: result.messageId,
          patientId: body.patientId,
          providerId: body.providerId ?? req.identity?.senderId,
          medspaId: scope.tenantId,
        },
      });
    });

  router.post('/webhook/sms', ingest('SMS'));
  router.post('/webhook/email', ingest('EMAIL'));

  return router;
}
