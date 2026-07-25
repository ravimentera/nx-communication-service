/**
 * Per-model-family request shaping and response parsing.
 *
 * `ai-service.ts` does this with two parallel if/else chains — one to build the
 * body (`:184-255`) and one to parse the response (`:289-330`) — which have to
 * be kept in step by hand. A codec pairs them, so adding a model family is
 * adding one object rather than editing two chains in two places.
 */

export interface CodecRequest {
  system?: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  stopSequences?: string[];
}

export interface CodecResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
}

export interface ModelCodec {
  readonly family: string;
  matches(modelId: string): boolean;
  buildBody(req: CodecRequest): unknown;
  parse(response: Record<string, unknown>): CodecResult;
}

const DEFAULT_SYSTEM =
  "You are a helpful assistant that generates high-quality text based on the user's request.";

/** Amazon Nova — the `messages-v1` schema. Default model for this service. */
const nova: ModelCodec = {
  family: 'nova',
  matches: (id) => id.includes('nova'),
  buildBody: (req) => ({
    schemaVersion: 'messages-v1',
    messages: [{ role: 'user', content: [{ text: req.prompt }] }],
    system: [{ text: req.system ?? DEFAULT_SYSTEM }],
    inferenceConfig: {
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      topP: 0.9,
      topK: 20,
      ...(req.stopSequences?.length ? { stopSequences: req.stopSequences } : {}),
    },
  }),
  parse: (response) => {
    const output = response.output as
      | { message?: { content?: Array<{ text?: string }> } }
      | undefined;
    const blocks = output?.message?.content ?? [];
    const usage = (response.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
    return {
      content: blocks
        .filter((b) => typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n'),
      // Real counts from the provider. The source estimated with
      // `content.split(/\s+/).length`, which is a word count, not tokens, and
      // counts only the output — so cost could never be computed from it.
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
      finishReason: (response.stopReason as string) ?? 'unknown',
    };
  },
};

/** Anthropic Claude 3+ on Bedrock. */
const claude3: ModelCodec = {
  family: 'claude-3',
  matches: (id) => id.startsWith('anthropic.') && id.includes('claude-3'),
  buildBody: (req) => ({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    ...(req.system ? { system: req.system } : {}),
    messages: [{ role: 'user', content: req.prompt }],
    ...(req.stopSequences?.length ? { stop_sequences: req.stopSequences } : {}),
  }),
  parse: (response) => {
    const content = response.content;
    const usage = (response.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    let text = '';
    if (Array.isArray(content)) {
      text = (content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n');
    } else if (typeof content === 'string') {
      text = content;
    }
    return {
      content: text,
      tokensIn: usage.input_tokens ?? 0,
      tokensOut: usage.output_tokens ?? 0,
      finishReason: (response.stop_reason as string) ?? 'unknown',
    };
  },
};

/**
 * Pre-Claude-3 Anthropic. Kept because the source supports it and a tenant
 * config could still name one; it uses the Human/Assistant prompt form.
 */
const claudeLegacy: ModelCodec = {
  family: 'claude-legacy',
  matches: (id) => id.startsWith('anthropic.'),
  buildBody: (req) => ({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    prompt: `\n\nHuman: ${req.system ? `${req.system}\n\n${req.prompt}` : req.prompt}\n\nAssistant:`,
  }),
  parse: (response) => ({
    content: (response.completion as string) ?? '',
    tokensIn: 0,
    tokensOut: 0,
    finishReason: (response.stop_reason as string) ?? 'unknown',
  }),
};

const titan: ModelCodec = {
  family: 'titan',
  matches: (id) => id.startsWith('amazon.titan-'),
  buildBody: (req) => ({
    inputText: req.system ? `${req.system}\n\n${req.prompt}` : req.prompt,
    textGenerationConfig: {
      maxTokenCount: req.maxTokens,
      temperature: req.temperature,
      topP: 0.9,
      ...(req.stopSequences?.length ? { stopSequences: req.stopSequences } : {}),
    },
  }),
  parse: (response) => {
    const results = (response.results ?? []) as Array<{
      outputText?: string;
      tokenCount?: number;
      completionReason?: string;
    }>;
    const first = results[0];
    return {
      content: first?.outputText ?? '',
      tokensIn: (response.inputTextTokenCount as number) ?? 0,
      tokensOut: first?.tokenCount ?? 0,
      finishReason: first?.completionReason ?? 'unknown',
    };
  },
};

/** Order matters: claude3 must be tried before claudeLegacy. */
export const MODEL_CODECS: readonly ModelCodec[] = [nova, claude3, claudeLegacy, titan];

export function codecFor(modelId: string): ModelCodec | undefined {
  return MODEL_CODECS.find((codec) => codec.matches(modelId));
}
