// DELETE IN P12
/**
 * `/ai-enhanced` (6) and `/automated-messages` (4) — both are "draft something
 * for this recipient", and they are one router here because they were only ever
 * two because two people wrote them.
 *
 * `/ai-enhanced` is the **other** approval implementation (D46). It writes the
 * `status` column while `approvals.controller.ts` writes the `queued_message`
 * JSONB, so today the two inboxes show disjoint sets: a draft created through
 * `/ai-enhanced/generate-communication` never appears in
 * `/approvals/pending/:providerId`, and vice versa. Neither list is the whole
 * queue and nothing anywhere shows both.
 *
 * **Both now write the same `approvals` table**, so the two inboxes agree for
 * the first time. That is the point of P6 and it is a visible change: a
 * provider who has been using one screen starts seeing drafts they did not know
 * existed. `docs/api/BREAKING.md` records it.
 *
 * The vocabulary difference the plan flagged — `REJECTED` vs `DECLINED` — is
 * handled on the way out: this router reports the states its callers know.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ApprovalApiDeps } from '../v1/approvals.js';
import type { ContentApiDeps } from '../v1/content.js';
import type { MessagingApiDeps } from '../v1/messaging.js';
import type { PlaybookApiDeps } from '../v1/playbooks.js';
import type { ContextRegistry } from '../../engine/context/registry.js';
import type { DraftService } from '../../engine/outreach/draft.service.js';
import {
  Permission,
  requirePermissions,
  requireTenant,
} from '../../platform/http/auth.middleware.js';
import { ValidationError } from '../../platform/http/errors.js';
import { toChannelType } from '../../ports/channel.js';
import { deprecate } from './index.js';
import { MEDSPA_RECIPIENT_SYSTEM, type CompatIdentity } from './translate.js';

const generateSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.string().optional(),
  channel: z.string().default('EMAIL'),
  communicationType: z.string().optional(),
  promptPackKey: z.string().optional(),
  goal: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
});

export interface GenerationCompatDeps {
  content: ContentApiDeps;
  approvals: ApprovalApiDeps;
  messaging: MessagingApiDeps;
  playbooks: PlaybookApiDeps;
  context: ContextRegistry;
  identity: CompatIdentity;
  /** P12: the drafting logic this file used to own (D101). */
  drafts: DraftService;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** `DECLINED` is the engine's word; `/ai-enhanced` callers know `REJECTED`. */
function toAiEnhancedStatus(status: string): string {
  return status === 'DECLINED' ? 'REJECTED' : status;
}

export function createLegacyGenerationRouters(deps: GenerationCompatDeps): {
  automated: Router;
  /** Exposed so `/communications/generate-message` shares the same path. */
  draft: (
    req: Request,
    input: z.infer<typeof generateSchema>,
  ) => Promise<{ approvalId?: string; messageId?: string; content: string; subject?: string; status: string }>;
} {
  /**
   * Draft one message and put it under approval.
   *
   * The source calls the model and writes `message_history` with
   * `status='PENDING_APPROVAL'` and no `queued_message`
   * (`ai-enhanced-communication.controller.ts:108-130`). Here it goes through
   * `approvals.submit`, which writes the message row *and* an `approvals` row —
   * so the draft is visible from both inboxes and carries an audit trail.
   *
   * **The work moved out in P12.** `DraftService` owns it now and
   * `POST /v1/outreach/generate` is the first-class route, so what is left here
   * is the vocabulary bridge this file exists to be: `patientId` becomes an
   * external ref, `providerId` becomes a sender, and `DECLINED` goes back out as
   * `REJECTED`. See D101.
   */
  async function draftFor(
    req: Request,
    input: z.infer<typeof generateSchema>,
  ): Promise<{ approvalId?: string; messageId?: string; content: string; subject?: string; status: string }> {
    const scope = requireTenant(req);
    const channel = toChannelType(input.channel);
    if (!channel) throw new ValidationError(`Unknown channel '${input.channel}'`);

    // Resolve-or-create BEFORE drafting. `DraftService` resolves through the
    // context provider but will not invent a recipient, and a legacy caller may
    // be naming a patient this tenant has never messaged — which the source
    // handled by creating one (D37, translate.ts).
    await deps.identity.ensure(scope, input.patientId);

    const draft = await deps.drafts.draft(scope, {
      channel,
      externalRef: { system: MEDSPA_RECIPIENT_SYSTEM, id: input.patientId },
      senderId: input.providerId ?? req.identity?.senderId,
      promptPackKey: input.promptPackKey,
      goal: input.goal ?? input.communicationType,
      context: { communicationType: input.communicationType, ...(input.context ?? {}) },
      priority: input.priority,
    });

    return {
      approvalId: draft.approvalId,
      messageId: draft.messageId,
      content: draft.content,
      subject: draft.subject,
      status: toAiEnhancedStatus(draft.status),
    };
  }

  // ── /ai-enhanced ──────────────────────────────────────────────────────────
  // `/ai-enhanced` was retired in P12 (D100): nothing calls any of its six
  // endpoints. `POST /v1/outreach/generate` and `/v1/approvals` replace them,
  // and the mount answers 410 naming both — see RETIRED_MOUNTS in index.ts.
  //
  // `draftFor` above survives: `/communications/generate-message` uses it, and
  // it is the one drafting path both legacy URLs shared.

  const automated = Router();
  automated.use(deprecate('/automated-messages', '/v1/outreach/generate'));

  automated.post(
    '/generate',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const body = generateSchema.parse(req.body);
      res.status(201).json({ success: true, data: await draftFor(req, body) });
    }),
  );

  // `/bulk-generate`, `/trigger-from-event` and `/test-context/:p/:pr` were
  // retired with it — the web and mobile clients call `/generate` and nothing
  // else. `POST /v1/campaigns`, `POST /v1/outreach/trigger` and
  // `GET /v1/context/preview` are their successors.
  return { automated, draft: draftFor };
}