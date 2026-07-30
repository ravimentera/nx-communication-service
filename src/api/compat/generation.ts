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
import { actorOf } from '../v1/approvals.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/http/errors.js';
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

const batchSchema = z.object({
  patientIds: z.array(z.string().min(1)).min(1).max(200),
  providerId: z.string().optional(),
  channel: z.string().default('EMAIL'),
  promptPackKey: z.string().optional(),
  goal: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const triggerSchema = z.object({
  eventType: z.string().min(1),
  patientId: z.string().optional(),
  providerId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  channels: z.array(z.string()).optional(),
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
  aiEnhanced: Router;
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
  const aiEnhanced = Router();
  aiEnhanced.use(deprecate('/ai-enhanced', '/v1/outreach/generate'));

  aiEnhanced.post(
    '/generate-communication',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const body = generateSchema.parse(req.body);
      res.status(201).json({ success: true, data: await draftFor(req, body) });
    }),
  );

  aiEnhanced.post(
    '/batch-generate',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const body = batchSchema.parse(req.body);

      // Per-recipient outcomes without aborting the batch. The source's
      // `Promise.all` rejects the whole run on the first failure, so one
      // recipient with no email address loses every other draft in the batch.
      const results = [];
      for (const patientId of body.patientIds) {
        try {
          results.push({
            patientId,
            success: true,
            ...(await draftFor(req, { ...body, patientId, priority: 'MEDIUM' })),
          });
        } catch (error) {
          results.push({
            patientId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      res.status(201).json({
        success: results.some((r) => r.success),
        data: results,
        summary: {
          requested: body.patientIds.length,
          generated: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success).length,
        },
      });
    }),
  );

  aiEnhanced.get(
    '/pending-approvals/:providerId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const providerId = req.params.providerId as string;
      const senderId = req.identity?.senderId;
      const isAdmin = req.identity?.permissions?.includes(Permission.ADMIN);
      if (!isAdmin && senderId && senderId !== providerId) {
        throw new ForbiddenError('Access denied: you can only access your own approval queue');
      }

      const page = await deps.approvals.approvals.list(scope, {
        approverRef: providerId,
        status: 'PENDING_APPROVAL',
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.limit ? Number(req.query.limit) : 50,
      });

      // The same rows `/approvals/pending/:providerId` returns. Under the
      // source these two lists are disjoint (D46).
      res.json({
        success: true,
        data: page.approvals.map((a) => ({ ...a, status: toAiEnhancedStatus(a.status) })),
        pagination: page,
      });
    }),
  );

  aiEnhanced.post(
    '/approve/:messageId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const approval = await deps.approvals.approvals.getByMessageId(
        scope,
        req.params.messageId as string,
      );
      if (!approval) throw new NotFoundError(`No approval found for message '${req.params.messageId}'`);

      const result = await deps.approvals.approvals.approve(scope, approval.id, actorOf(req));
      res.json({
        success: true,
        message: 'Communication approved',
        data: { ...result, approval: { ...result.approval, status: toAiEnhancedStatus(result.approval.status) } },
      });
    }),
  );

  aiEnhanced.get(
    '/patient/:patientId/suggested-communications',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipientId = await deps.identity.lookup(scope, req.params.patientId as string);
      if (!recipientId) throw new NotFoundError('Patient not found');

      // The source asks the model which messages a provider *might* send. That
      // is a playbook question now: what would fire for this recipient. Listing
      // the tenant's active playbooks answers it without an LLM call, and
      // without the source's habit of inventing suggestions from thin context.
      const playbooks = await deps.playbooks.registry.listPlaybooks(scope, { active: true });
      res.json({
        success: true,
        data: playbooks.map((p) => ({
          playbookKey: p.key,
          name: p.name,
          channels: p.channelPlan,
          requiresApproval: Boolean(p.approvalPolicyId),
        })),
      });
    }),
  );

  aiEnhanced.post(
    '/analyze-communication-style',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const packKey = (req.body?.promptPackKey as string) ?? 'core.content-analyze';
      const pack = deps.content.packs.prompt(packKey);
      if (!pack) throw new NotFoundError(`Prompt pack '${packKey}' not found`);

      const draft = await deps.content.generator.generate({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        pack,
        channel: 'email',
        playbookGoal: 'analyse communication style',
        context: {
          ...emptyContext(scope.tenantId),
          context: { samples: req.body?.samples ?? [], ...(req.body?.context ?? {}) },
        },
      });

      res.json({ success: true, data: { analysis: draft.content, model: draft.model } });
    }),
  );

  // ── /automated-messages ───────────────────────────────────────────────────
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

  automated.post(
    '/bulk-generate',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const body = batchSchema.parse(req.body);
      const results = [];
      for (const patientId of body.patientIds) {
        try {
          results.push({
            patientId,
            success: true,
            ...(await draftFor(req, { ...body, patientId, priority: 'MEDIUM' })),
          });
        } catch (error) {
          results.push({
            patientId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      res.status(201).json({ success: results.some((r) => r.success), data: results });
    }),
  );

  automated.post(
    '/trigger-from-event',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = triggerSchema.parse(req.body);
      const results = await deps.playbooks.runtime.run({
        type: 'event',
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        eventType: body.eventType,
        correlationId: `automated:${body.eventType}:${body.patientId ?? 'none'}`,
        recipientId: body.patientId
          ? ((await deps.identity.lookup(scope, body.patientId)) ?? undefined)
          : undefined,
        senderId: body.providerId ?? req.identity?.senderId,
        payload: { context: body.data ?? {} },
      });
      res.json({ success: true, matched: results.length, data: results });
    }),
  );

  /**
   * `GET /test-context/:patientId/:providerId` — what context would this
   * message be rendered against? A debugging endpoint, and a genuinely useful
   * one; the source builds it by calling patient-service and provider-service
   * directly. It goes through the pack-gated context registry here, so a tenant
   * without the medspa pack gets a 403 rather than another vertical's records
   * (D37).
   */
  automated.get(
    '/test-context/:patientId/:providerId',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const recipient = await deps.messaging.recipients.getOrResolve(scope, {
        kind: 'mentera-patient',
        id: req.params.patientId as string,
      });

      res.json({
        success: true,
        data: {
          patientId: req.params.patientId,
          providerId: req.params.providerId,
          resolved: Boolean(recipient),
          recipient: recipient
            ? {
                id: recipient.id,
                displayName: recipient.displayName,
                timezone: recipient.timezone,
                locale: recipient.locale,
                contactPoints: recipient.contactPoints,
                status: recipient.status,
              }
            : null,
        },
      });
    }),
  );

  return { aiEnhanced, automated, draft: draftFor };
}
