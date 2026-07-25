/**
 * `/v1/content` and `/v1/templates` — the first slice of the real versioned
 * surface. The legacy `/templates/*` and `/ai/*` paths are added by the compat
 * shim in P8, not here.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import type { ContentGenerator } from '../../engine/content/generator.js';
import { emptyContext, type RenderContext } from '../../engine/content/render-context.js';
import type { Renderer } from '../../engine/content/renderer.js';
import type { PackRegistry } from '../../packs/loader.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { Permission, requirePermissions, requireTenant } from '../../platform/http/auth.middleware.js';
import { CHANNEL_TYPES } from '../../ports/channel.js';
import type { TemplateStore } from '../../ports/template-store.js';

const contextSchema = z.object({
  recipient: z.record(z.unknown()).optional(),
  sender: z.record(z.unknown()).optional(),
  tenant: z.record(z.unknown()).optional(),
  context: z.record(z.unknown()).optional(),
  message: z.record(z.unknown()).optional(),
});

const renderSchema = z.object({
  templateId: z.string().optional(),
  content: z.string().optional(),
  format: z.enum(['TEXT', 'HTML', 'MARKDOWN', 'MJML']).optional(),
  packId: z.string().optional(),
  data: contextSchema.optional(),
});

const generateSchema = z.object({
  promptPackKey: z.string().min(1),
  channel: z.enum(CHANNEL_TYPES),
  playbookKey: z.string().optional(),
  playbookGoal: z.string().optional(),
  data: contextSchema.optional(),
  overrides: z
    .object({ tone: z.string().optional(), language: z.string().optional(), model: z.string().optional() })
    .optional(),
});

const templateBodySchema = z.object({
  key: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  channel: z.string().min(1),
  subject: z.string().optional(),
  content: z.string().min(1),
  htmlVersion: z.string().optional(),
  previewText: z.string().optional(),
  format: z.enum(['TEXT', 'HTML', 'MARKDOWN', 'MJML']).default('TEXT'),
  category: z.string().optional(),
  templateType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  packId: z.string().optional(),
});

export interface ContentApiDeps {
  renderer: Renderer;
  store: TemplateStore;
  generator: ContentGenerator;
  packs: PackRegistry;
}

/** Wrap an async handler so rejections reach the error middleware. */
function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function buildContext(
  tenantId: string,
  supplied: z.infer<typeof contextSchema> | undefined,
): RenderContext {
  const base = emptyContext(tenantId);
  return {
    recipient: { ...base.recipient, ...(supplied?.recipient ?? {}) },
    sender: { ...base.sender, ...(supplied?.sender ?? {}) },
    tenant: { ...base.tenant, ...(supplied?.tenant ?? {}) },
    context: { ...base.context, ...(supplied?.context ?? {}) },
    message: { ...base.message, ...(supplied?.message ?? {}) },
    now: base.now,
  };
}

export function createContentRouter(deps: ContentApiDeps): Router {
  const router = Router();

  // ── content ───────────────────────────────────────────────────────────────

  router.post(
    '/content/render',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const body = renderSchema.parse(req.body);

      let source = body.content;
      let format = body.format ?? 'TEXT';
      let packId = body.packId;

      if (body.templateId) {
        const template = await deps.store.get(tenantId, body.templateId);
        if (!template) throw new NotFoundError(`Template '${body.templateId}' not found`);
        source = template.content;
        format = (body.format ?? template.format) as typeof format;
        packId = packId ?? template.packId ?? undefined;
      }

      if (!source) {
        throw new ValidationError('Provide either templateId or content');
      }

      const result = await deps.renderer.render(source, buildContext(tenantId, body.data), {
        format,
        aliases: deps.renderer.aliasesFor(packId),
      });

      res.json({
        output: result.output,
        format: result.format,
        warnings: result.warnings,
      });
    }),
  );

  router.post(
    '/content/generate',
    requirePermissions(Permission.SEND),
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
      const body = generateSchema.parse(req.body);

      const pack = deps.packs.prompt(body.promptPackKey);
      if (!pack) {
        throw new NotFoundError(`Prompt pack '${body.promptPackKey}' not found`, {
          available: deps.packs.list(),
        });
      }

      const draft = await deps.generator.generate({
        tenantId,
        subTenantId,
        pack,
        channel: body.channel,
        playbookKey: body.playbookKey,
        playbookGoal: body.playbookGoal,
        context: buildContext(tenantId, body.data),
        overrides: body.overrides,
      });

      res.json(draft);
    }),
  );

  // ── templates ─────────────────────────────────────────────────────────────

  router.get(
    '/templates',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const templates = await deps.store.list(tenantId, {
        channel: req.query.channel as string | undefined,
        category: req.query.category as string | undefined,
        templateType: req.query.templateType as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ templates, count: templates.length });
    }),
  );

  router.post(
    '/templates',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
      const body = templateBodySchema.parse(req.body);
      const created = await deps.store.create(
        tenantId,
        {
          ...body,
          subTenantId,
          variables: deps.renderer.extractVariables(
            body.content,
            deps.renderer.aliasesFor(body.packId),
          ),
        },
        req.identity?.userId,
      );
      res.status(201).json(created);
    }),
  );

  router.get(
    '/templates/:id',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const template = await deps.store.get(tenantId, req.params.id as string);
      if (!template) throw new NotFoundError(`Template '${req.params.id}' not found`);
      res.json(template);
    }),
  );

  router.put(
    '/templates/:id',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const patch = templateBodySchema.partial().parse(req.body);
      const updated = await deps.store.update(
        tenantId,
        req.params.id as string,
        patch,
        req.identity?.userId,
      );
      res.json(updated);
    }),
  );

  router.delete(
    '/templates/:id',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const deleted = await deps.store.delete(tenantId, req.params.id as string);
      if (!deleted) throw new NotFoundError(`Template '${req.params.id}' not found`);
      res.status(204).end();
    }),
  );

  router.post(
    '/templates/:id/default',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      res.json(await deps.store.setDefault(tenantId, req.params.id as string));
    }),
  );

  router.get(
    '/templates/:id/versions',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      res.json({ versions: await deps.store.versions(tenantId, req.params.id as string) });
    }),
  );

  router.post(
    '/templates/:id/render',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const template = await deps.store.get(tenantId, req.params.id as string);
      if (!template) throw new NotFoundError(`Template '${req.params.id}' not found`);

      const body = renderSchema.parse({ ...req.body, templateId: template.id });
      const result = await deps.renderer.render(
        template.content,
        buildContext(tenantId, body.data),
        {
          format: template.format as 'TEXT' | 'HTML' | 'MARKDOWN' | 'MJML',
          aliases: deps.renderer.aliasesFor(template.packId),
        },
      );
      await deps.store.incrementUsage(tenantId, template.id);
      res.json({ output: result.output, format: result.format, warnings: result.warnings });
    }),
  );

  return router;
}
