/**
 * The LLM port.
 *
 * `services/ai/ai-service.ts` is already almost this — it has zero domain
 * knowledge and is the one piece of the source that ports nearly unchanged.
 * What it lacks is a seam: it is a concrete class named `AIService` that
 * everything imports directly, so Bedrock cannot be swapped and cannot be
 * mocked without mocking the AWS SDK.
 */

export interface LlmAudit {
  tenantId: string;
  subTenantId?: string;
  playbookId?: string;
  promptPackKey?: string;
}

export interface LlmRequest {
  system?: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  /** When set, the provider must return valid JSON matching this schema. */
  jsonSchema?: object;
  timeoutMs?: number;
  /**
   * Written to `ai_interactions`. Present on every call the engine makes, so a
   * tenant's AI spend and every generated draft are answerable from our own
   * database rather than a vendor bill.
   */
  audit?: LlmAudit;
}

export interface LlmResponse<T = string> {
  content: T;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  latencyMs: number;
  finishReason: string;
  raw?: unknown;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmProvider {
  readonly name: string;
  generate(req: LlmRequest): Promise<LlmResponse<string>>;
  generateJson<T>(req: LlmRequest & { jsonSchema: object }): Promise<LlmResponse<T>>;
  listModels(): string[];
}
