// DELETE IN P12
/**
 * `/templates` — fourteen endpoints, and **Seam A**.
 *
 * providers-service proxies this router through `settings.service.ts:1266`, and
 * it also holds the real foreign keys into `communication_templates`
 * (`template_versions`, `notification_rules.email_template_id`/`sms_template_id`).
 * P10 turns its `template.service.ts` into an HTTP client against this surface,
 * so these fourteen have to answer correctly before the cutover can happen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SOURCE'S TEMPLATE ENGINE HAS NO TENANT SCOPING AT ALL.
 *
 *     $ grep -c "medspaId\|tenantId" services/templates/template-engine.ts
 *     0
 *
 * `listTemplates(filter)`, `getTemplate(id)`, `updateTemplate(id, …)` and
 * `deleteTemplate(id)` take no tenant and apply no predicate. Every one of the
 * fourteen endpoints therefore reads and writes across tenants: any
 * authenticated caller can list another clinic's templates, edit the body of
 * one, or delete it. That is broader than D45 (approval mutations) and D62
 * (three controller reads) — it is the whole router.
 *
 * Latent with one tenant, like the ghost tables (D11). Not latent after P10.
 *
 * Every path here goes through `DrizzleTemplateStore`, which takes a tenantId
 * on every call. That is a **tightening**, and `docs/api/BREAKING.md` records it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Response shapes are the source's, which are inconsistent with each other and
 * with the rest of the service — `{templates}`, `{templateId}`, `{success}`,
 * `{metadata, content}`, and no `success` envelope anywhere. Preserved as-is:
 * providers-service reads `templateId` off a create and `templates` off a list.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ContentApiDeps } from '../v1/content.js';
import { emptyContext, type RenderContext } from '../../engine/content/render-context.js';
import type { TemplateFormat } from '../../engine/content/renderer.js';
import {
  Permission,
  requirePermissions,
  requireTenant,
} from '../../platform/http/auth.middleware.js';
import {
  NotFoundError,
  NotImplementedError,
  ValidationError,
} from '../../platform/http/errors.js';
import type { TemplateRecord } from '../../ports/template-store.js';
import { deprecate } from './index.js';

const createSchema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  channel: z.string().default('email'),
  subject: z.string().optional(),
  description: z.string().optional(),
  format: z.enum(['TEXT', 'HTML', 'MARKDOWN', 'MJML']).default('TEXT'),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  key: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const generateSchema = z.object({
  prompt: z.string().min(1),
  format: z.enum(['TEXT', 'HTML', 'MARKDOWN', 'MJML']).default('MJML'),
  channel: z.string().default('email'),
  promptPackKey: z.string().optional(),
  metadata: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** `{metadata, content}` — what the source returns from get and generate. */
function toLegacyTemplate(t: TemplateRecord) {
  return {
    metadata: {
      id: t.id,
      name: t.name,
      description: t.description ?? null,
      channel: t.channel,
      subject: t.subject ?? null,
      format: t.format,
      category: t.category ?? null,
      tags: t.tags ?? null,
      variables: t.variables ?? null,
      status: t.status,
      version: t.version,
      isDefault: t.isDefault,
    },
    content: t.content,
  };
}

export function createLegacyTemplateRouter(deps: ContentApiDeps): Router {
  const router = Router();
  router.use(deprecate('/templates', '/v1/templates'));

  // ── CRUD ──────────────────────────────────────────────────────────────────

  router.get(
    '/',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const templates = await deps.store.list(tenantId, {
        category: req.query.category as string | undefined,
        channel: req.query.channel as string | undefined,
      });
      const tags = req.query.tags ? (req.query.tags as string).split(',') : undefined;
      const format = req.query.format as string | undefined;

      // `tags` and `format` are filtered here rather than in the store: the
      // store's filter is the v1 surface's, and adding two legacy-only
      // predicates to it would outlive this file.
      const filtered = templates.filter(
        (t) =>
          (!format || t.format === format) &&
          (!tags || tags.every((tag) => (t.tags ?? []).includes(tag))),
      );

      res.json({ templates: filtered.map((t) => toLegacyTemplate(t).metadata) });
    }),
  );

  router.post(
    '/',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
      const body = createSchema.parse(req.body);

      const created = await deps.store.create(
        tenantId,
        {
          ...body,
          subTenantId,
          variables: deps.renderer.extractVariables(body.content),
        },
        req.identity?.userId,
      );
      // The source returns only the id (`:215`); providers-service reads it.
      res.status(201).json({ templateId: created.id });
    }),
  );

  /**
   * Two campaign paths are declared *before* `/:id`, because Express matches in
   * declaration order and `/campaigns` would otherwise be read as a template id.
   * The source gets away with this only because its `/campaigns` routes are
   * registered before `/:id/render` and after `/:id` — a GET `/campaigns` would
   * hit `getTemplate('campaigns')` there.
   */
  const campaignNotPorted = (successor: string) =>
    handle(async () => {
      throw new NotImplementedError(
        `Campaign template generation is not ported. Author the campaign as a playbook and use ${successor}.`,
      );
    });

  router.post('/campaigns', campaignNotPorted('POST /v1/outreach/trigger'));
  router.post('/campaigns/follow-up', campaignNotPorted('POST /v1/outreach/trigger'));
  router.post('/campaigns/educational', campaignNotPorted('POST /v1/outreach/trigger'));
  router.post('/campaigns/promotional', campaignNotPorted('POST /v1/outreach/trigger'));

  /**
   * Asset upload and image generation are the two things P4 explicitly left
   * unported, and they need machinery this repo does not have yet: a storage
   * adapter for the upload, and an **image** model for the generation — the
   * `LlmProvider` port is text-only by design (`generate` / `generateJson`).
   *
   * A 501 naming what is missing beats a stub that stores a file nowhere.
   */
  router.post(
    '/assets/upload',
    handle(async () => {
      throw new NotImplementedError(
        'Asset upload needs a storage adapter (config.storage is declared but unwired). Tracked for P11.',
      );
    }),
  );
  router.post(
    '/assets/generate-image',
    handle(async () => {
      throw new NotImplementedError(
        'Image generation needs an image model; the LlmProvider port is text-only. Tracked for P11.',
      );
    }),
  );

  // ── AI generation ─────────────────────────────────────────────────────────

  /**
   * `generateTemplateWithAI` — the source asks the model for a template body
   * and stores it. Ported through `ContentGenerator`, so it gets the P4
   * treatment for free: real token accounting (D31), no prompt logging at info
   * (D32), and the lint ruleset (D52).
   */
  router.post(
    '/generate',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
      const body = generateSchema.parse(req.body);

      const packKey = body.promptPackKey ?? 'core.template-author';
      const pack = deps.packs.prompt(packKey);
      if (!pack) {
        throw new NotFoundError(
          `Prompt pack '${packKey}' not found. Supply promptPackKey, or install a pack that provides one.`,
          { available: deps.packs.list() },
        );
      }

      const context: RenderContext = {
        ...emptyContext(tenantId),
        context: { prompt: body.prompt, format: body.format },
      };
      const draft = await deps.generator.generate({
        tenantId,
        subTenantId,
        pack,
        channel: body.channel as never,
        playbookGoal: body.prompt,
        context,
      });

      const created = await deps.store.create(
        tenantId,
        {
          name: body.metadata?.name ?? `Generated: ${body.prompt.slice(0, 60)}`,
          description: body.metadata?.description,
          channel: body.channel,
          subject: draft.subject,
          content: draft.content,
          format: body.format,
          category: body.metadata?.category,
          tags: body.metadata?.tags,
          subTenantId,
          variables: deps.renderer.extractVariables(draft.content),
        },
        req.identity?.userId,
      );

      res.status(201).json({ templateId: created.id, ...toLegacyTemplate(created) });
    }),
  );

  router.post(
    '/generate-with-images',
    handle(async () => {
      throw new NotImplementedError(
        'Image generation needs an image model; the LlmProvider port is text-only. Use POST /templates/generate for the body. Tracked for P11.',
      );
    }),
  );

  // ── by id, declared last ──────────────────────────────────────────────────

  router.post(
    '/:id/render',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const { data, options } = (req.body ?? {}) as {
        data?: Record<string, unknown>;
        options?: { format?: string };
      };
      if (!data) throw new ValidationError('Data object is required');

      const template = await deps.store.get(tenantId, req.params.id as string);
      if (!template) throw new NotFoundError(`Template '${req.params.id}' not found`);

      // Legacy callers pass a flat variable bag, referenced bare in the body.
      const context = {
        ...data,
        ...emptyContext(tenantId),
        context: data,
      } as RenderContext;

      const rendered = await deps.renderer.render(template.content, context, {
        format: (options?.format ?? template.format) as TemplateFormat,
        aliases: deps.renderer.aliasesFor(template.packId ?? undefined),
      });

      res.json({
        templateId: template.id,
        metadata: toLegacyTemplate(template).metadata,
        renderedContent: rendered.output,
      });
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const template = await deps.store.get(tenantId, req.params.id as string);
      if (!template) throw new NotFoundError(`Template '${req.params.id}' not found`);

      const legacy = toLegacyTemplate(template);
      // `?content=true` is opt-in; without it the source returns metadata only.
      res.json(req.query.content === 'true' ? legacy : { metadata: legacy.metadata });
    }),
  );

  router.put(
    '/:id',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const patch = createSchema.partial().parse(req.body ?? {});
      if (!patch.content && !patch.metadata && Object.keys(patch).length === 0) {
        throw new ValidationError('Content or metadata is required');
      }

      const updated = await deps.store.update(
        tenantId,
        req.params.id as string,
        {
          ...patch,
          ...(patch.content
            ? { variables: deps.renderer.extractVariables(patch.content) }
            : {}),
        },
        req.identity?.userId,
      );
      res.json({ success: Boolean(updated) });
    }),
  );

  router.delete(
    '/:id',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const deleted = await deps.store.delete(tenantId, req.params.id as string);
      res.json({ success: deleted });
    }),
  );

  return router;
}
