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
import multer from 'multer';
import { z } from 'zod';

import type { ContentApiDeps } from '../v1/content.js';
import type { ImageSize } from '../../ports/image.js';
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

const generateWithImagesSchema = generateSchema.extend({
  imageSuggestions: z.array(z.string().min(1)).optional(),
});

const generateImageSchema = z.object({
  prompt: z.string().min(1),
  filename: z.string().optional(),
  size: z.enum(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792']).optional(),
  style: z.enum(['natural', 'vivid']).optional(),
});

/**
 * The source's `CampaignTemplateOptions`. `campaignType`, `audienceType`, `tone`
 * and `purpose` are required there too (`template-controller.ts:416-421`), but
 * as free strings rather than the enums the generator declares — the controller
 * never validates against `CampaignType`/`AudienceType`/`CampaignTone`, it only
 * checks for presence. Kept as strings so a body that works today still works,
 * and so the vocabulary stays the pack's rather than the engine's.
 */
const campaignSchema = z.object({
  campaignType: z.string().min(1),
  audienceType: z.string().min(1),
  tone: z.string().min(1),
  purpose: z.string().min(1),
  keyPoints: z.array(z.string()).optional(),
  callToAction: z.string().optional(),
  includeImages: z.boolean().optional(),
  imageSuggestions: z.array(z.string().min(1)).optional(),
  brandColors: z.array(z.string()).optional(),
  format: z.enum(['TEXT', 'HTML', 'MARKDOWN', 'MJML']).default('MJML'),
  promptPackKey: z.string().optional(),
});

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function translateUploadErrors(
  error: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (error instanceof multer.MulterError) {
    next(new ValidationError(`Upload rejected: ${error.message}`, { code: error.code }));
    return;
  }
  next(error);
}

/**
 * The best-effort image pass both `/campaigns*` and `/generate-with-images`
 * make. Every failure is logged and dropped, exactly as the source does at
 * `campaign-template-generator.ts:232-238` and `template-controller.ts:368-374`
 * — a campaign whose copy is fine must not 500 because an image did not come
 * back.
 *
 * With no `ImageProvider` registered this returns `[]` without calling anything,
 * which is the outcome the source reached the long way round.
 */
async function generateCampaignImages(
  deps: ContentApiDeps,
  input: {
    tenantId: string;
    subTenantId?: string;
    prompts: string[];
    enabled: boolean;
    style?: 'natural' | 'vivid';
    size?: ImageSize;
    uploadedBy?: string;
  },
): Promise<string[]> {
  if (!input.enabled || input.prompts.length === 0) return [];
  if (!deps.images || !deps.assets) return [];

  const images = deps.images;
  const assets = deps.assets;

  const results = await Promise.all(
    input.prompts.map(async (prompt) => {
      try {
        const [image] = await images.generate({
          prompt,
          size: input.size ?? '1024x1024',
          style: input.style,
          count: 1,
          audit: { tenantId: input.tenantId, subTenantId: input.subTenantId },
        });
        if (!image) return null;

        const record = await assets.save({
          tenantId: input.tenantId,
          subTenantId: input.subTenantId,
          kind: 'generated',
          body: image.body,
          mimeType: image.mimeType,
          uploadedBy: input.uploadedBy,
          metadata: { prompt, model: image.model, provider: images.name },
        });
        return record.url;
      } catch (error) {
        deps.logger?.error('failed to generate a campaign image — continuing without it', {
          tenantId: input.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  return results.filter((url): url is string => url !== null);
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

  // The source declares `multer({dest: 'uploads/'})` in the route file and
  // writes every upload to disk. In memory here, and bounded — with no adapter
  // configured the route 501s before the limit matters, so fall back to the
  // service's own default rather than making the limit optional.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.assets?.maxBytes ?? 10 * 1024 * 1024, files: 1 },
  });

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
  /**
   * ───────────────────────────────────────────────────────────────────────────
   * PORTED IN P12. These four were recorded as blocked on an image-capable
   * model. They never were — see D92.
   *
   * `campaign-template-generator.ts` generates campaign **copy** with Bedrock
   * text, then makes a best-effort pass over image prompts in which every single
   * attempt fails: `generateImageAsset` reaches `AIService.generateImage`, whose
   * whole body is `throw new Error('Image generation not supported with current
   * Bedrock models')`. Each failure is caught at `:232-238`, logged, and mapped
   * to `null`, then filtered out — so the source has always returned 201 with
   * `imageAssets` undefined.
   *
   * Reproduced exactly: the copy is generated, `imageAssets` is present only if
   * an `ImageProvider` is registered and produced something, and nothing fails
   * because no image was made.
   *
   * The vertical's phrasing moved to the pack. The source hardcoded 'new
   * patients who have recently joined the practice' and 'healthcare best
   * practices' in `formatAudienceType`/`buildTemplatePrompt`; those are pack
   * content by §0.10, so the brief is passed as context to
   * `core.campaign-author` and the pack does the wording.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const campaignHandler = (fixedType?: string) =>
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
      const body = campaignSchema.parse(
        fixedType ? { ...req.body, campaignType: req.body?.campaignType ?? fixedType } : req.body,
      );

      const packKey = body.promptPackKey ?? 'core.campaign-author';
      const pack = deps.packs.prompt(packKey);
      if (!pack) {
        throw new NotFoundError(`Prompt pack '${packKey}' not found`, {
          available: deps.packs.list(),
        });
      }

      const context: RenderContext = {
        ...emptyContext(tenantId),
        context: {
          campaignType: body.campaignType,
          audience: body.audienceType,
          tone: body.tone,
          purpose: body.purpose,
          keyPoints: body.keyPoints ?? [],
          callToAction: body.callToAction ?? null,
          brandColors: body.brandColors ?? [],
          includeImages: body.includeImages ?? false,
          format: body.format,
        },
      };

      const draft = await deps.generator.generate({
        tenantId,
        subTenantId,
        pack,
        channel: 'email',
        playbookGoal: body.purpose,
        context,
      });

      const imageAssets = await generateCampaignImages(deps, {
        tenantId,
        subTenantId,
        prompts: body.imageSuggestions ?? [],
        enabled: body.includeImages ?? false,
        // The source picks `natural` for professional and formal tones and
        // `vivid` for everything else (`:227-230`).
        style: body.tone === 'professional' || body.tone === 'formal' ? 'natural' : 'vivid',
        uploadedBy: req.identity?.userId,
      });

      const created = await deps.store.create(
        tenantId,
        {
          name: `${body.campaignType}_${body.audienceType}_campaign`,
          channel: 'email',
          subject: draft.subject,
          content: draft.content,
          format: body.format,
          category: body.campaignType,
          tags: [
            'campaign',
            body.campaignType,
            body.audienceType,
            body.tone,
            ...(imageAssets.length > 0 ? ['has-images'] : []),
          ],
          subTenantId,
          variables: deps.renderer.extractVariables(draft.content),
        },
        req.identity?.userId,
      );

      // `{templateId, emailConfig, previewContent, imageAssets?}` — the source's
      // `CampaignTemplateResult`, field for field.
      res.status(201).json({
        templateId: created.id,
        emailConfig: {
          subjectLine: draft.subject ?? `${body.campaignType} for ${body.audienceType}`,
          preheader: body.purpose,
        },
        previewContent: draft.content,
        imageAssets: imageAssets.length > 0 ? imageAssets : undefined,
      });
    });

  router.post('/campaigns', campaignHandler());
  router.post('/campaigns/follow-up', campaignHandler('follow_up'));
  router.post('/campaigns/educational', campaignHandler('educational'));
  router.post('/campaigns/promotional', campaignHandler('promotion'));

  /**
   * Asset upload — off its 501 in P12, now that a storage adapter exists.
   *
   * The source writes the multipart body to a temp file, reads it back, saves
   * it, and unlinks it (`template-controller.ts:555-565`). Here multer keeps it
   * in memory, bounded by `ASSET_MAX_BYTES`, and one write goes to the adapter.
   *
   * The response keeps the source's four fields and gains `assetId` and `url`.
   * `filename` alone was not enough to fetch the thing back — the source's
   * assets were addressable only by guessing a path in a shared directory.
   */
  router.post(
    '/assets/upload',
    requirePermissions(Permission.TEMPLATES_WRITE),
    upload.single('file'),
    translateUploadErrors,
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
      if (!deps.assets) {
        throw new NotImplementedError(
          'Asset upload needs a storage adapter and none is configured. Set S3_MEMORY_BUCKET with USE_LOCAL_STORAGE=false, or LOCAL_STORAGE_PATH for local development.',
        );
      }

      const file = req.file;
      if (!file) throw new ValidationError('No file uploaded (expected multipart field "file")');

      const record = await deps.assets.save({
        tenantId,
        subTenantId,
        kind: file.mimetype?.startsWith('image/') ? 'image' : 'document',
        body: file.buffer,
        filename: file.originalname,
        mimeType: file.mimetype,
        uploadedBy: req.identity?.userId,
      });

      res.status(201).json({
        filename: (record.metadata as { storageKey?: string } | null)?.storageKey,
        originalName: file.originalname,
        size: record.size,
        mimeType: record.mimeType,
        assetId: record.id,
        url: record.url,
      });
    }),
  );

  /**
   * The one endpoint that genuinely needs an image model — and the source could
   * not serve it either. `generateImageAsset` calls the throwing method with
   * nothing catching it, so this path has answered **500** since it was written.
   * A 501 naming the missing piece is the same capability and better
   * information. See `ports/image.ts` and D92.
   */
  router.post(
    '/assets/generate-image',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
      const body = generateImageSchema.parse(req.body);

      if (!deps.images || !deps.assets) {
        throw new NotImplementedError(
          'No image model is configured. The ImageProvider port is declared (src/ports/image.ts) with no adapter registered; the source service threw on this path too (D92).',
        );
      }

      const [image] = await deps.images.generate({
        prompt: body.prompt,
        size: body.size,
        style: body.style,
        count: 1,
        audit: { tenantId, subTenantId },
      });
      if (!image) throw new NotFoundError('The image model returned no image');

      const record = await deps.assets.save({
        tenantId,
        subTenantId,
        kind: 'generated',
        body: image.body,
        mimeType: image.mimeType,
        uploadedBy: req.identity?.userId,
        metadata: { prompt: body.prompt, model: image.model, provider: deps.images.name },
      });

      res.status(201).json({
        filename: (record.metadata as { storageKey?: string } | null)?.storageKey,
        assetId: record.id,
        url: record.url,
      });
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

  /**
   * PORTED IN P12. Also never image-blocked (D92): the source generates the
   * template, then loops `imageSuggestions` through `generateImageAsset` inside
   * a `try/catch` that logs and continues (`template-controller.ts:368-374`).
   * Because that call always threw, the loop has always produced nothing and the
   * endpoint has always returned 201 with `imageAssets` undefined.
   */
  router.post(
    '/generate-with-images',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
      const body = generateWithImagesSchema.parse(req.body);

      const packKey = body.promptPackKey ?? 'core.template-author';
      const pack = deps.packs.prompt(packKey);
      if (!pack) {
        throw new NotFoundError(`Prompt pack '${packKey}' not found`, {
          available: deps.packs.list(),
        });
      }

      const draft = await deps.generator.generate({
        tenantId,
        subTenantId,
        pack,
        channel: body.channel as never,
        playbookGoal: body.prompt,
        context: {
          ...emptyContext(tenantId),
          context: { prompt: body.prompt, format: body.format },
        },
      });

      const imageAssets = await generateCampaignImages(deps, {
        tenantId,
        subTenantId,
        prompts: body.imageSuggestions ?? [],
        enabled: (body.imageSuggestions ?? []).length > 0,
        uploadedBy: req.identity?.userId,
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

      res.status(201).json({
        templateId: created.id,
        ...toLegacyTemplate(created),
        imageAssets: imageAssets.length > 0 ? imageAssets : undefined,
      });
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
