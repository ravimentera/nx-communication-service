// DELETE IN P12
/**
 * `/email`, `/sms` and `/slack` — five endpoints, one dispatcher.
 *
 * `POST /email/send` is the first of the five call sites the P10 cutover
 * repoints: providers-service sends its `email-verification`,
 * `provider-invitation` and `password-reset` mails through it. Those three
 * arrive as `templateId` **keys**, not UUIDs, which is why the template store's
 * `get()` accepts either.
 *
 * Behaviour worth calling out, because it changes:
 *
 *  - The source reports `{success:true}` for a *queued* email and 500 for a
 *    failure to queue, with no id (`email.controller.ts:22`). The reply now
 *    carries the `jobId` and `messageId`, so a caller can follow a message. The
 *    `success` field a legacy consumer reads is unchanged.
 *  - All three are **transactional**: an account-verification mail is not
 *    marketing and must not be held by a quiet-hours window or an opt-out.
 *    Nothing in the source says so because the source has no gate; getting this
 *    wrong would silently stop password resets.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { Dispatcher } from '../../engine/delivery/dispatcher.js';
import { emptyContext, type RenderContext } from '../../engine/content/render-context.js';
import type { Renderer, TemplateFormat } from '../../engine/content/renderer.js';
import { requireTenant } from '../../platform/http/auth.middleware.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import type { TemplateStore } from '../../ports/template-store.js';
import { deprecate } from './index.js';
import type { CompatIdentity } from './translate.js';

const emailSchema = z.object({
  to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  templateId: z.string().optional(),
  subject: z.string().optional(),
  message: z.string().optional(),
  html: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  patientId: z.string().optional(),
  providerId: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
});

const smsSchema = z.object({
  to: z.string().min(1),
  message: z.string().optional(),
  templateId: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  patientId: z.string().optional(),
  providerId: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
});

const slackSchema = z.object({
  channel: z.string().optional(),
  text: z.string().optional(),
  message: z.string().optional(),
  blocks: z.array(z.unknown()).optional(),
});

export interface SendCompatDeps {
  dispatcher: Dispatcher;
  identity: CompatIdentity;
  templates: TemplateStore;
  renderer: Renderer;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createLegacySendRouters(deps: SendCompatDeps): {
  email: Router;
  sms: Router;
  slack: Router;
} {
  /**
   * Resolve the body to something sendable. Either a template key/id plus
   * variables, or a literal message — the same either/or the SMS route
   * validates at `sms.routes.ts:47-58`, applied to email too.
   */
  async function resolveBody(
    tenantId: string,
    input: {
      templateId?: string;
      variables?: Record<string, unknown>;
      message?: string;
      subject?: string;
      html?: string;
    },
  ): Promise<{ subject?: string; body: string; html?: string; templateId?: string }> {
    if (!input.templateId) {
      if (!input.message) {
        throw new ValidationError('Either message or templateId is required');
      }
      return { subject: input.subject, body: input.message, html: input.html };
    }

    const template = await deps.templates.get(tenantId, input.templateId);
    if (!template) throw new NotFoundError(`Template '${input.templateId}' not found`);

    // Legacy templates reference variables bare — `{{firstName}}`, not
    // `{{context.firstName}}` — so the bag is spread at the top level as well
    // as namespaced. The namespaces are applied *after* the spread, so a
    // variable that happens to be called `tenant` cannot shadow one.
    const context = {
      ...(input.variables ?? {}),
      ...emptyContext(tenantId),
      context: input.variables ?? {},
    } as RenderContext;
    const rendered = await deps.renderer.render(template.content, context, {
      format: template.format as TemplateFormat,
    });
    const subject = template.subject
      ? (await deps.renderer.render(template.subject, context)).output
      : input.subject;

    return {
      subject,
      body: rendered.output,
      html: template.format === 'TEXT' ? undefined : rendered.output,
      templateId: template.id,
    };
  }

  // ── /email ────────────────────────────────────────────────────────────────
  const email = Router();
  email.use(deprecate('/email', '/v1/messages'));

  email.post(
    '/send',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const body = emailSchema.parse(req.body);
      // A legacy `to` may be an array; the engine addresses one contact point
      // per message, so an array fans out and the first result is reported —
      // which is what `sendTemplatedEmail` did with its single boolean.
      const addresses = Array.isArray(body.to) ? body.to : [body.to];
      const rendered = await resolveBody(scope.tenantId, body);
      const recipientId = body.patientId
        ? await deps.identity.ensure(scope, body.patientId, { email: addresses[0] })
        : undefined;

      const results = [];
      for (const address of addresses) {
        results.push(
          await deps.dispatcher.dispatch({
            tenantId: scope.tenantId,
            subTenantId: scope.subTenantId,
            channel: 'email',
            to: { type: 'email', value: address },
            rendered: { subject: rendered.subject, body: rendered.body, html: rendered.html },
            templateId: rendered.templateId,
            recipientId,
            senderId: body.providerId ?? req.identity?.senderId,
            priority: body.priority,
            transactional: true,
          }),
        );
      }

      res.json({
        success: true,
        message: 'Email sent successfully',
        jobId: results[0]?.jobId,
        messageId: results[0]?.messageId,
        results,
      });
    }),
  );

  // ── /sms ──────────────────────────────────────────────────────────────────
  const sms = Router();
  sms.use(deprecate('/sms', '/v1/messages'));

  const sendSms = (transactional: boolean) =>
    handle(async (req: Request, res: Response) => {
      const scope = requireTenant(req);
      const body = smsSchema.parse(req.body);
      if (body.templateId && !body.variables) {
        throw new ValidationError('Template variables are required when using templateId');
      }
      const rendered = await resolveBody(scope.tenantId, body);
      const senderId = body.providerId ?? req.identity?.senderId;

      const result = await deps.dispatcher.dispatch({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        channel: 'sms',
        to: { type: 'phone', value: body.to },
        rendered: { body: rendered.body },
        templateId: rendered.templateId,
        recipientId: body.patientId
          ? await deps.identity.ensure(scope, body.patientId, { phone: body.to })
          : undefined,
        senderId,
        priority: body.priority,
        transactional,
      });

      res.json({
        success: true,
        message: 'SMS notification queued successfully',
        jobId: result.jobId,
        messageId: result.messageId,
        messageType: body.templateId ? 'templated' : 'plain',
        medspaId: scope.tenantId,
        providerId: senderId,
      });
    });

  sms.post('/send', sendSms(false));
  /**
   * `send-direct` "bypasses the queue for immediate sending". It no longer
   * does: the worker is what holds the provider credentials and the retry
   * policy, and a synchronous send would have neither. It is marked
   * transactional instead, which is the property callers of `-direct` were
   * actually reaching for — do not make me wait behind a rate limit.
   */
  sms.post('/send-direct', sendSms(true));

  // ── /slack ────────────────────────────────────────────────────────────────
  const slack = Router();
  slack.use(deprecate('/slack', '/v1/messages'));

  const sendSlack = (priority: 'MEDIUM' | 'URGENT', defaultChannelRequired: boolean) =>
    handle(async (req: Request, res: Response) => {
      const scope = requireTenant(req);
      const body = slackSchema.parse(req.body);
      const text = body.text ?? body.message;
      if (!text) throw new ValidationError('text is required');
      if (!body.channel && defaultChannelRequired) {
        // The source defaults to the literal `urgent-alerts`
        // (`slack.service.ts:109`) — a cross-tenant destination (D55). The
        // tenant's configured default is resolved by the adapter; if it has
        // none, saying so beats posting into another tenant's channel.
        throw new ValidationError(
          'channel is required, or configure slackDefaultChannel for this tenant',
        );
      }

      const result = await deps.dispatcher.dispatch({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        channel: 'slack',
        to: { type: 'slack', value: body.channel ?? '' },
        rendered: {
          body: text,
          // Blocks pass through untouched — a channel adapter does not know
          // what a treatment is (D25).
          ...(body.blocks ? { metadata: { blocks: body.blocks } } : {}),
        },
        priority,
        transactional: true,
      });

      res.json({
        success: true,
        message:
          priority === 'URGENT' ? 'Urgent alert sent successfully' : 'Slack message sent successfully',
        jobId: result.jobId,
        messageId: result.messageId,
      });
    });

  slack.post('/message', sendSlack('MEDIUM', true));
  slack.post('/urgent', sendSlack('URGENT', false));

  return { email, sms, slack };
}
