/**
 * `/v1/assets` — the versioned surface behind the legacy `/templates/assets/*`.
 *
 * Appendix A maps `POST /templates/assets/upload` and
 * `POST /templates/assets/generate-image` to `/v1/assets*`. This is that.
 *
 * The upload route parses multipart **into memory**, bounded by
 * `ASSET_MAX_BYTES`. The source wrote to a temp file, read it back, saved it,
 * then unlinked it (`template-controller.ts:555-565`) — four filesystem
 * operations and a leaked temp file on any failure between them, for a body
 * already capped at ten megabytes.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';

import type { AssetService } from '../../engine/content/asset.service.js';
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
import type { ImageProvider } from '../../ports/image.js';

const generateImageSchema = z.object({
  prompt: z.string().min(1),
  size: z.enum(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792']).optional(),
  style: z.enum(['natural', 'vivid']).optional(),
  count: z.number().int().min(1).max(4).optional(),
  model: z.string().optional(),
});

export interface AssetApiDeps {
  assets: AssetService;
  /**
   * Optional, and unset in every shipped configuration — see `ports/image.ts`
   * and D92. When absent, the generate route answers 501 with the reason.
   */
  images?: ImageProvider;
}

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * The message multer raises for an oversized file is `File too large`, with a
 * `LIMIT_FILE_SIZE` code, and it arrives as an error from the middleware rather
 * than from a handler. Translating it here keeps it a 400 with the limit named,
 * instead of a 500 from the terminal handler.
 */
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

export function createAssetRouter(deps: AssetApiDeps): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.assets.maxBytes, files: 1 },
  });

  router.post(
    '/assets',
    requirePermissions(Permission.TEMPLATES_WRITE),
    upload.single('file'),
    translateUploadErrors,
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
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

      res.status(201).json(record);
    }),
  );

  router.get(
    '/assets',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const assets = await deps.assets.list(tenantId, {
        kind: req.query.kind as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ assets, count: assets.length });
    }),
  );

  /**
   * Declared before `/assets/:id`, because Express matches in declaration order
   * and `generate` would otherwise be read as an asset id — the same trap the
   * legacy template router documents for `/campaigns`.
   */
  router.post(
    '/assets/generate',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId, subTenantId } = requireTenant(req);
      const body = generateImageSchema.parse(req.body);

      if (!deps.images) {
        throw new NotImplementedError(
          'No image model is configured. The ImageProvider port is declared (src/ports/image.ts) and no adapter is registered; the source service could not generate images either (D92). Register an adapter in the composition root to enable this.',
        );
      }

      const images = await deps.images.generate({
        prompt: body.prompt,
        size: body.size,
        style: body.style,
        count: body.count,
        model: body.model,
        audit: { tenantId, subTenantId },
      });

      const saved = [];
      for (const image of images) {
        saved.push(
          await deps.assets.save({
            tenantId,
            subTenantId,
            kind: 'generated',
            body: image.body,
            mimeType: image.mimeType,
            uploadedBy: req.identity?.userId,
            metadata: {
              prompt: body.prompt,
              model: image.model,
              costUsd: image.costUsd ?? null,
              provider: deps.images.name,
            },
          }),
        );
      }

      res.status(201).json({ assets: saved, count: saved.length });
    }),
  );

  router.get(
    '/assets/:id',
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const asset = await deps.assets.get(tenantId, req.params.id as string);
      if (!asset) throw new NotFoundError(`Asset '${req.params.id}' not found`);
      res.json(asset);
    }),
  );

  router.delete(
    '/assets/:id',
    requirePermissions(Permission.TEMPLATES_WRITE),
    handle(async (req, res) => {
      const { tenantId } = requireTenant(req);
      const deleted = await deps.assets.delete(tenantId, req.params.id as string);
      if (!deleted) throw new NotFoundError(`Asset '${req.params.id}' not found`);
      res.status(204).end();
    }),
  );

  return router;
}
