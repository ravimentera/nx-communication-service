/**
 * `/v1/content` and `/v1/templates` — the first slice of the real versioned
 * surface. The legacy `/templates/*` and `/ai/*` paths are added by the compat
 * shim in P8, not here.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { AssetService } from '../../engine/content/asset.service.js';
import type { ContentGenerator } from '../../engine/content/generator.js';
import type { IdentityResolver } from '../../engine/content/identity.js';
import type { RenderContext } from '../../engine/content/render-context.js';
import type { Renderer } from '../../engine/content/renderer.js';
import type { PackRegistry } from '../../packs/loader.js';
import type { ImageProvider } from '../../ports/image.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { Permission, requirePermissions, requireTenant } from '../../platform/http/auth.middleware.js';
import { CHANNEL_TYPES } from '../../ports/channel.js';
import type { TemplateStore } from '../../ports/template-store.js';
import { requireUuidParams } from '../../platform/http/params.js';

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
  /** Fills the `tenant` and `sender` namespaces the caller does not supply. */
  identity: IdentityResolver;
  packs: PackRegistry;
  /**
   * P12. Optional so the P4-era tests that build this object without a storage
   * adapter still compile; absent means `/templates/assets/upload` keeps
   * answering 501 rather than pretending to store a file.
   */
  assets?: AssetService;
  /** P12. Never set in a shipped configuration — see `ports/image.ts` and D92. */
  images?: ImageProvider;
  /** Optional: only the best-effort image pass needs to report a swallowed failure. */
  logger?: Logger;
}

/** Wrap an async handler so rejections reach the error middleware. */
function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * The caller's context, over the tenant and sender the engine resolved.
 *
 * Engine-resolved identity is the BASE and the caller's fields are spread over
 * it, which is the same precedence the prompt assembler now enforces: a caller
 * may add to `tenant` or `sender`, and an absent field falls back to the real
 * row rather than to nothing.
 */
async function buildContext(
  identity: IdentityResolver,
  tenantId: string,
  supplied: z.infer<typeof contextSchema> | undefined,
): Promise<RenderContext> {
  const base = await identity.baseContext(
    { tenantId },
    (supplied?.sender as { id?: string } | undefined)?.id,
  );
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
      const scope = requireTenant(req);
      const { tenantId } = scope;
      const body = renderSchema.parse(req.body);

      let source = body.content;
      let format = body.format ?? 'TEXT';
      let packId = body.packId;

      if (body.templateId) {
        const template = await deps.store.get(scope, body.templateId);
        if (!template) throw new NotFoundError(`Template '${body.templateId}' not found`);
        source = template.content;
        format = (body.format ?? template.format) as typeof format;
        packId = packId ?? template.packId ?? undefined;
      }

      if (!source) {
        throw new ValidationError('Provide either templateId or content');
      }

      const result = await deps.renderer.render(source, await buildContext(deps.identity, tenantId, body.data), {
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
      const scope = requireTenant(req);
      const { tenantId, subTenantId } = scope;
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
        context: await buildContext(deps.identity, tenantId, body.data),
        overrides: body.overrides,
      });

      res.json(draft);
    }),
  );

  // ── templates ─────────────────────────────────────────────────────────────

  router.get(
    '/templates',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const templates = await deps.store.list(scope, {
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
      const scope = requireTenant(req);
      const { subTenantId } = scope;
      const body = templateBodySchema.parse(req.body);
      const created = await deps.store.create(
        scope,
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
      const scope = requireTenant(req);
      const template = await deps.store.get(scope, req.params.id as string);
      if (!template) throw new NotFoundError(`Template '${req.params.id}' not found`);
      res.json(template);
    }),
  );

  // ── uuid-only, unlike their GET sibling ───────────────────────────────────
  //
  // `store.get` accepts an id OR a key and branches on the shape, so a non-uuid
  // on `GET /templates/:id` and `POST /templates/:id/render` is a legitimate
  // key lookup and must reach the store. `update`, `delete`, `setDefault` and
  // `versions` take the value straight to a `uuid` column, so the same input
  // there was a 500. Guarded per route rather than on the router for exactly
  // that reason (params.ts).
  router.put(
    '/templates/:id',
    requireUuidParams('id'),
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const patch = templateBodySchema.partial().parse(req.body);
      const updated = await deps.store.update(
        scope,
        req.params.id as string,
        patch,
        req.identity?.userId,
      );
      res.json(updated);
    }),
  );

  router.delete(
    '/templates/:id',
    requireUuidParams('id'),
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const deleted = await deps.store.delete(scope, req.params.id as string);
      if (!deleted) throw new NotFoundError(`Template '${req.params.id}' not found`);
      res.status(204).end();
    }),
  );

  router.post(
    '/templates/:id/default',
    requireUuidParams('id'),
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json(await deps.store.setDefault(scope, req.params.id as string));
    }),
  );

  router.get(
    '/templates/:id/versions',
    requireUuidParams('id'),
    handle(async (req, res) => {
      const scope = requireTenant(req);
      res.json({ versions: await deps.store.versions(scope, req.params.id as string) });
    }),
  );

  router.post(
    '/templates/:id/render',
    handle(async (req, res) => {
      const scope = requireTenant(req);
      const { tenantId } = scope;
      const template = await deps.store.get(scope, req.params.id as string);
      if (!template) throw new NotFoundError(`Template '${req.params.id}' not found`);

      const body = renderSchema.parse({ ...req.body, templateId: template.id });
      const result = await deps.renderer.render(
        template.content,
        await buildContext(deps.identity, tenantId, body.data),
        {
          format: template.format as 'TEXT' | 'HTML' | 'MARKDOWN' | 'MJML',
          aliases: deps.renderer.aliasesFor(template.packId),
        },
      );
      await deps.store.incrementUsage(scope, template.id);
      res.json({ output: result.output, format: result.format, warnings: result.warnings });
    }),
  );

  return router;
}
