/**
 * Bedrock LLM provider. `services/ai/ai-service.ts` becomes this adapter's
 * internals.
 *
 * KEPT: the model ids, per-model request/response shaping (now as codecs), the
 * request timeout, retries via the SDK's `maxAttempts`, the JSON retry-once
 * behaviour, and the AWS error classification.
 *
 * FOUR DELIBERATE CHANGES:
 *
 *  1. **The timeout no longer leaks a timer.** `ai-service.ts:258-260` races the
 *     request against `new Promise((_, reject) => setTimeout(...))` and never
 *     clears it. Every call keeps the event loop alive for the full timeout —
 *     30s by default — after it has already returned. In a process it delays
 *     shutdown; in a test run it hangs Jest. Here an `AbortController` cancels
 *     the request and the timer is always cleared.
 *
 *  2. **Token counts are real.** The source estimates with
 *     `content.split(/\s+/).length` (`:334`), a word count of the output only.
 *     Bedrock returns actual usage; the codecs read it. Cost is not computable
 *     from a word count.
 *
 *  3. **Prompts are not logged at info level.** `ai-service.ts:214-217` logs the
 *     entire request body and `:280-285` logs 500 characters of every response,
 *     both at `info`. Those prompts carry recipient names and clinical context
 *     straight into stdout and on to log aggregation. Lengths and ids are
 *     logged; content only at `debug`.
 *
 *  4. **No hourly `setInterval`.** `:147-149` starts an unref'd-nowhere metrics
 *     timer in a constructor. Prometheus counters replace it.
 */
import {
  BedrockRuntimeClient,
  InternalServerException,
  InvokeModelCommand,
  ModelNotReadyException,
  ServiceQuotaExceededException,
  ThrottlingException,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime';
import type { Logger } from 'winston';

import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../../ports/llm.js';
import { codecFor, MODEL_CODECS } from './model-codecs.js';

/** The models `ai-service.ts` declares. Ids preserved verbatim. */
export const BEDROCK_MODELS = {
  NOVA_PRO: 'amazon.nova-pro-v1:0',
  TITAN_TEXT_PREMIER: 'amazon.titan-text-premier-v1:0',
  TITAN_TEXT_EXPRESS: 'amazon.titan-text-express-v1:0',
  CLAUDE_3_SONNET: 'anthropic.claude-3-sonnet-20240229-v1:0',
  CLAUDE_3_HAIKU: 'anthropic.claude-3-haiku-20240307-v1:0',
} as const;

/** USD per 1,000 tokens. Approximate, and deliberately overridable. */
export interface ModelRate {
  inputPer1k: number;
  outputPer1k: number;
}

export const DEFAULT_MODEL_RATES: Record<string, ModelRate> = {
  'amazon.nova-pro-v1:0': { inputPer1k: 0.0008, outputPer1k: 0.0032 },
  'amazon.titan-text-premier-v1:0': { inputPer1k: 0.0005, outputPer1k: 0.0015 },
  'amazon.titan-text-express-v1:0': { inputPer1k: 0.0002, outputPer1k: 0.0006 },
  'anthropic.claude-3-sonnet-20240229-v1:0': { inputPer1k: 0.003, outputPer1k: 0.015 },
  'anthropic.claude-3-haiku-20240307-v1:0': { inputPer1k: 0.00025, outputPer1k: 0.00125 },
};

export interface BedrockProviderConfig {
  region: string;
  defaultModel: string;
  maxRetries: number;
  timeoutMs: number;
  modelRates?: Record<string, ModelRate>;
}

export interface BedrockProviderDeps {
  config: BedrockProviderConfig;
  logger: Logger;
  /** Injected so tests do not have to mock the AWS SDK module. */
  client?: BedrockRuntimeClient;
}

export class BedrockProvider implements LlmProvider {
  readonly name = 'bedrock';

  private readonly client: BedrockRuntimeClient;
  private readonly rates: Record<string, ModelRate>;

  constructor(private readonly deps: BedrockProviderDeps) {
    this.client =
      deps.client ??
      new BedrockRuntimeClient({
        region: deps.config.region,
        maxAttempts: deps.config.maxRetries,
      });
    this.rates = deps.config.modelRates ?? DEFAULT_MODEL_RATES;
  }

  listModels(): string[] {
    return Object.values(BEDROCK_MODELS);
  }

  private costOf(model: string, tokensIn: number, tokensOut: number): number | undefined {
    const rate = this.rates[model];
    if (!rate) return undefined;
    return (tokensIn / 1000) * rate.inputPer1k + (tokensOut / 1000) * rate.outputPer1k;
  }

  async generate(req: LlmRequest): Promise<LlmResponse<string>> {
    const model = req.model ?? this.deps.config.defaultModel;
    const timeoutMs = req.timeoutMs ?? this.deps.config.timeoutMs;
    const codec = codecFor(model);

    if (!codec) {
      throw new LlmError(
        `Unsupported model '${model}'. Known families: ${MODEL_CODECS.map((c) => c.family).join(', ')}`,
        'UNSUPPORTED_MODEL',
        false,
      );
    }

    const body = codec.buildBody({
      system: req.system,
      prompt: req.prompt,
      maxTokens: req.maxTokens ?? 1000,
      temperature: req.temperature ?? 0.7,
      stopSequences: req.stopSequences,
    });

    // Content at debug only — prompts carry recipient data.
    this.deps.logger.debug('llm request', { model, body });
    this.deps.logger.info('llm request', {
      model,
      family: codec.family,
      promptChars: req.prompt.length,
      tenantId: req.audit?.tenantId,
      promptPackKey: req.audit?.promptPackKey,
    });

    const started = Date.now();
    // AbortController cancels the in-flight request, and the timer is cleared in
    // `finally` whichever way the call ends. See change (1) in the header.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: model,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(body),
        }),
        { abortSignal: controller.signal },
      );

      if (!response.body) {
        throw new LlmError('Empty response from Bedrock', 'EMPTY_RESPONSE', true);
      }

      const decoded = new TextDecoder().decode(response.body);
      const parsed = codec.parse(JSON.parse(decoded) as Record<string, unknown>);
      const latencyMs = Date.now() - started;

      this.deps.logger.debug('llm response', { model, content: parsed.content });
      this.deps.logger.info('llm response', {
        model,
        contentChars: parsed.content.length,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        latencyMs,
        finishReason: parsed.finishReason,
      });

      return {
        content: parsed.content,
        model,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        costUsd: this.costOf(model, parsed.tokensIn, parsed.tokensOut),
        latencyMs,
        finishReason: parsed.finishReason,
      };
    } catch (error) {
      throw this.classify(error, model, controller.signal.aborted, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * JSON with one retry, ported from `ai-service.ts:500-542`. The retry prompt
   * tells the model its previous answer was invalid; if the second attempt also
   * fails to parse, throw rather than return something unusable.
   */
  async generateJson<T>(req: LlmRequest & { jsonSchema: object }): Promise<LlmResponse<T>> {
    const system = [
      req.system,
      'Respond with a single valid JSON object and nothing else — no explanation, no markdown fences.',
      `It must satisfy this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const first = await this.generate({ ...req, system });
    const parsedFirst = tryParseJson<T>(first.content);
    if (parsedFirst.ok) return { ...first, content: parsedFirst.value };

    this.deps.logger.warn('llm returned invalid json, retrying once', {
      model: first.model,
      error: parsedFirst.error,
    });

    const second = await this.generate({
      ...req,
      system,
      prompt: `${req.prompt}\n\nYour previous response was not valid JSON (${parsedFirst.error}). Return only a valid JSON object.`,
    });
    const parsedSecond = tryParseJson<T>(second.content);
    if (parsedSecond.ok) return { ...second, content: parsedSecond.value };

    throw new LlmError(
      `Model did not return valid JSON after a retry: ${parsedSecond.error}`,
      'INVALID_JSON',
      false,
      second.content,
    );
  }

  /**
   * AWS exception → `LlmError`. The source turns these into friendly strings
   * (`ai-service.ts:375-434`); the messages are preserved but a caller can now
   * branch on `code` and `retryable` instead of matching on prose.
   */
  private classify(error: unknown, model: string, aborted: boolean, timeoutMs: number): LlmError {
    if (error instanceof LlmError) return error;

    if (aborted) {
      return new LlmError(`Request timed out after ${timeoutMs}ms`, 'TIMEOUT', true, error);
    }
    if (error instanceof ValidationException) {
      return new LlmError(`Invalid request format: ${error.message}`, 'VALIDATION', false, error);
    }
    if (error instanceof ThrottlingException) {
      return new LlmError(
        'Service is currently handling too many requests. Please try again shortly.',
        'THROTTLED',
        true,
        error,
      );
    }
    if (error instanceof ServiceQuotaExceededException) {
      return new LlmError(
        'Monthly usage quota exceeded. Please try again at the beginning of next billing cycle.',
        'QUOTA_EXCEEDED',
        false,
        error,
      );
    }
    if (error instanceof ModelNotReadyException) {
      return new LlmError(
        `Model ${model} is currently unavailable. Please try again later or use a different model.`,
        'MODEL_NOT_READY',
        true,
        error,
      );
    }
    if (error instanceof InternalServerException) {
      return new LlmError(
        'The AI service is experiencing internal issues. Please try again later.',
        'UPSTREAM_ERROR',
        true,
        error,
      );
    }
    return new LlmError(
      error instanceof Error ? error.message : String(error),
      'UNKNOWN',
      true,
      error,
    );
  }
}

function tryParseJson<T>(raw: string): { ok: true; value: T } | { ok: false; error: string } {
  // Models fence JSON in ```json blocks more often than they should.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return { ok: true, value: JSON.parse(cleaned) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'parse failed' };
  }
}
