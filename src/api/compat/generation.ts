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
import { emptyContext, type RenderContext } from '../../engine/content/render-context.js';
import {
  Permission,
  requirePermissions,
  requireTenant,
} from '../../platform/http/auth.middleware.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { toChannelType } from '../../ports/channel.js';
import { deprecate } from './index.js';
import type { CompatIdentity } from './translate.js';

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
   */
  async function draftFor(
    req: Request,
    input: z.infer<typeof generateSchema>,
  ): Promise<{ approvalId?: string; messageId?: string; content: string; subject?: string; status: string }> {
    const scope = requireTenant(req);
    const channel = toChannelType(input.channel);
    if (!channel) throw new ValidationError(`Unknown channel '${input.channel}'`);

    const packKey = input.promptPackKey ?? 'core.content-generate';
    const pack = deps.content.packs.prompt(packKey);
    if (!pack) {
      throw new NotFoundError(`Prompt pack '${packKey}' not found`, {
        available: deps.content.packs.list(),
      });
    }

    // Resolve-or-create, and pull whatever the installed context provider
    // knows. The source builds URLs to patient-service inline
    // (`ai-enhanced-communication.controller.ts:32-33`); the provider is
    // pack-gated here (D37).
    const recipientId = await deps.identity.ensure(scope, input.patientId);
    const recipient = await deps.messaging.recipients.getOrResolve(scope, {
      kind: 'mentera-patient',
      id: input.patientId,
    });

    const renderContext: RenderContext = {
      ...emptyContext(scope.tenantId),
      recipient: {
        id: recipientId,
        displayName: recipient?.displayName ?? undefined,
        firstName: recipient?.firstName ?? undefined,
        lastName: recipient?.lastName ?? undefined,
        timezone: recipient?.timezone ?? undefined,
        locale: recipient?.locale ?? undefined,
      },
      sender: { id: input.providerId ?? req.identity?.senderId },
      context: { communicationType: input.communicationType, ...(input.context ?? {}) },
    };

    const draft = await deps.content.generator.generate({
      tenantId: scope.tenantId,
      subTenantId: scope.subTenantId,
      pack,
      channel,
      playbookGoal: input.goal ?? input.communicationType,
      context: renderContext,
    });

    const contactPoints = (recipient?.contactPoints ?? []) as Array<{
      type: string;
      value: string;
      primary?: boolean;
    }>;
    const wanted = channel === 'sms' ? 'phone' : channel;
    const to =
      contactPoints.find((p) => p.type === wanted && p.primary) ??
      contactPoints.find((p) => p.type === wanted);
    if (!to) {
      throw new ValidationError(
        `No ${wanted} contact point for this recipient; add one before generating a ${channel} draft`,
      );
    }

    const submitted = await deps.approvals.approvals.submit(scope, {
      channel,
      to,
      rendered: { subject: draft.subject, body: draft.content },
      recipientId,
      senderId: input.providerId ?? req.identity?.senderId,
      priority: input.priority,
      aiGenerated: true,
      aiConfidence: draft.aiConfidence,
      // The policy's `threshold` mode counts errors; the generator reports the
      // warnings themselves. Passing the count is what P6 expects.
      lintErrors: draft.lintWarnings.length,
    });

    return {
      approvalId: submitted.approval?.id,
      messageId: submitted.approval?.messageId,
      content: draft.content,
      subject: draft.subject,
      status: toAiEnhancedStatus(submitted.approval?.status ?? 'PENDING_APPROVAL'),
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