/**
 * The image-generation port. **Declared here; no adapter ships with the engine.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO IMPLEMENTATION, AND WHY THAT IS NOT A REGRESSION
 *
 * `EXTRACTION_PLAN.md` and `docs/api/BREAKING.md` both held that seven legacy
 * endpoints were blocked on "an image-capable `LlmProvider`". Six of them were
 * not blocked on anything — see D92. This is the seventh, and the one that is
 * genuinely blocked.
 *
 * It is blocked in the source too. `AIService.generateImage`
 * (`ai-service.ts:562-570`) is a method whose entire body is:
 *
 *     throw new Error('Image generation not supported with current Bedrock
 *     models. Please implement with a compatible image generation model.');
 *
 * So `POST /templates/assets/generate-image`, which calls it with nothing
 * catching the throw, has answered 500 for its whole life. The engine answering
 * 501 with the reason named is strictly better information and identical
 * capability.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The port exists so that stops being an engine change. A deployment that has
 * an image model — Bedrock's Titan Image Generator, or anything else — writes
 * one adapter, registers it in the composition root, and the endpoint starts
 * working. Nothing else moves.
 *
 * Kept deliberately separate from `LlmProvider` rather than added as a third
 * method on it: every existing implementation of that port would have to grow a
 * method it cannot honour, and `RecordingLlmProvider` would have to decide what
 * an image costs in `ai_interactions` before anyone has generated one.
 */
import type { LlmAudit } from './llm.js';

/** The sizes the source's `ImageGenerationOptions` declared. Preserved. */
export type ImageSize = '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';

export interface ImageRequest {
  prompt: string;
  size?: ImageSize;
  style?: 'natural' | 'vivid';
  /** Images to return. An adapter may return fewer; never more. */
  count?: number;
  model?: string;
  timeoutMs?: number;
  audit?: LlmAudit;
}

export interface GeneratedImage {
  /** Raw bytes. The caller stores them through the storage port. */
  body: Buffer;
  mimeType: string;
  model: string;
  costUsd?: number;
  latencyMs: number;
}

export class ImageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

export interface ImageProvider {
  readonly name: string;
  generate(req: ImageRequest): Promise<GeneratedImage[]>;
  listModels(): string[];
}
