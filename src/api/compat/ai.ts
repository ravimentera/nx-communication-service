// DELETE IN P12
/**
 * `/ai` — eight endpoints that are one endpoint with eight prompts.
 *
 * `ai-content-controller.ts` has `generateContent`, `enhanceContent`,
 * `personalizeContent`, `analyzeContent`, `generateMultimodalContent`,
 * `generateFollowUpContent`, `generatePromotionalContent` and
 * `generateEducationalContent`. Each builds a slightly different prompt string
 * in TypeScript and calls the same `aiService.generateContent`. That is the
 * shape §0.10 exists to stop: prompt text is **content**, not code, and adding
 * a ninth mode should not mean a deploy.
 *
 * Each legacy mode maps to a prompt pack key. `POST /v1/content/generate` takes
 * the key directly; this router picks it from the path so a legacy caller does
 * not have to.
 *
 * **A mode with no installed pack answers 404 naming the key**, rather than
 * silently falling back to a generic prompt. The source cannot fail this way,
 * because its prompts are compiled in — which is also why nobody can change one
 * without a release.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ContentApiDeps } from '../v1/content.js';
import { emptyContext, type RenderContext } from '../../engine/content/render-context.js';
import {
  Permission,
  requirePermissions,
  requireTenant,
} from '../../platform/http/auth.middleware.js';
import { NotFoundError, NotImplementedError } from '../../platform/http/errors.js';
import { deprecate } from './index.js';

/** Legacy path → prompt pack key. Pack content, not code. */
const MODES: Record<string, string> = {
  generate: 'core.content-generate',
  enhance: 'core.content-enhance',
  personalize: 'core.content-personalize',
  analyze: 'core.content-analyze',
  'follow-up': 'core.content-followup',
  promotional: 'core.content-promotional',
  educational: 'core.content-educational',
};

const bodySchema = z.object({
  prompt: z.string().min(1),
  context: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  format: z.string().default('text'),
  channel: z.string().default('email'),
  style: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
});

function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createLegacyAiRouter(deps: ContentApiDeps): Router {
  const router = Router();
  router.use(deprecate('/ai', '/v1/content/generate'));

  for (const [path, packKey] of Object.entries(MODES)) {
    router.post(
      `/${path}`,
      requirePermissions(Permission.SEND),
      handle(async (req, res) => {
        const { tenantId, subTenantId } = requireTenant(req);
        const body = bodySchema.parse(req.body);

        const pack = deps.packs.prompt(packKey);
        if (!pack) {
          throw new NotFoundError(
            `No prompt pack '${packKey}' is installed for this mode. Install a pack that provides it, or call POST /v1/content/generate with your own promptPackKey.`,
            { mode: path, available: deps.packs.list() },
          );
        }

        // The source concatenates `Context: …\n\nTask: …` into one string
        // (`:91-93`). Context is structured here, so the pack's template
        // decides where it goes — which is what makes a pack able to change the
        // framing without a code change.
        const context: RenderContext = {
          ...emptyContext(tenantId),
          context: {
            prompt: body.prompt,
            format: body.format,
            style: body.style,
            ...(typeof body.context === 'string'
              ? { background: body.context }
              : (body.context ?? {})),
          },
        };

        const draft = await deps.generator.generate({
          tenantId,
          subTenantId,
          pack,
          channel: body.channel as never,
          playbookGoal: body.prompt,
          context,
          // `temperature` and `maxTokens` are deliberately NOT honoured. The
          // source lets a caller set them per request (`:96-98`); the prompt
          // pack owns them here, so two callers of the same mode cannot get
          // differently-sampled output and blame the pack. `model` and `tone`
          // are overridable because they are editorial, not sampling.
          ...(body.model ? { overrides: { model: body.model } } : {}),
        });

        res.status(200).json({
          success: true,
          content: draft.content,
          metadata: {
            model: draft.model,
            format: body.format,
            style: body.style ?? 'standard',
            promptLength: body.prompt.length,
            generatedLength: draft.content.length,
            // New, and the reason D31 exists: real token counts, so a tenant's
            // AI spend is answerable without a vendor bill.
            tokensIn: draft.tokensIn,
            tokensOut: draft.tokensOut,
            costUsd: draft.costUsd,
            lintWarnings: draft.lintWarnings,
          },
        });
      }),
    );
  }

  /**
   * `generateMultimodalContent` took images alongside the prompt. The
   * `LlmProvider` port is text-only by design — `generate` and `generateJson`
   * — so this needs a port change, not a router change.
   */
  router.post(
    '/multimodal',
    handle(async () => {
      throw new NotImplementedError(
        'Multimodal generation needs an image-capable LlmProvider; the port is text-only. Tracked for P11.',
      );
    }),
  );

  return router;
}
