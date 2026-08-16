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
import type { IdentityResolver } from '../../engine/content/identity.js';
import type { RenderContext } from '../../engine/content/render-context.js';
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

export interface SendCompatDeps {
  dispatcher: Dispatcher;
  identity: CompatIdentity;
  /**
   * Tenant and sender identity for the render context — a different question
   * from `identity` above, which resolves the *recipient*. Named apart because
   * conflating them is how `{{tenant.name}}` came to render blank here.
   */
  senderIdentity: IdentityResolver;
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

/**
 * Resolve a legacy body to something sendable: either a template key/id plus
 * variables, or a literal message — the same either/or the SMS route validates
 * at `sms.routes.ts:47-58`, applied to email too.
 *
 * Exported because the MCP tools take the same shape (`templateId` +
 * `variables` or a bare `message`) and must render identically; two copies of
 * this would drift the moment one grew a helper.
 */
export function createBodyResolver(deps: {
  templates: TemplateStore;
  renderer: Renderer;
  senderIdentity: IdentityResolver;
}): (
  tenantId: string,
  input: {
    templateId?: string;
    variables?: Record<string, unknown>;
    message?: string;
    subject?: string;
    html?: string;
  },
) => Promise<{ subject?: string; body: string; html?: string; templateId?: string }> {
  return async function resolveBody(
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
      ...(await deps.senderIdentity.baseContext({ tenantId })),
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
  };
}

export function createLegacySendRouters(deps: SendCompatDeps): {
  email: Router;
} {
  const resolveBody = createBodyResolver(deps);

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

  // `/sms` and `/slack` were retired in P12 (D100): nothing calls them. Both
  // answer 410 naming `POST /v1/messages` — see RETIRED_MOUNTS in index.ts.
  return { email };
}
