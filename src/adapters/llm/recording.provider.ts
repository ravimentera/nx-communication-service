/**
 * Wraps any `LlmProvider` so every call writes an `ai_interactions` row and
 * moves the Prometheus counters.
 *
 * The source already writes this audit trail and it is the right instinct —
 * keeping it as a decorator means the Bedrock adapter stays about Bedrock, and
 * a future provider gets the same auditing for free.
 *
 * A failure to write the audit row must never fail the generation: the caller
 * already has content, and losing a log line is not worth losing the draft.
 */
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { aiInteractions } from '../../db/schema.js';
import { metricsRegistry, promClient } from '../../platform/observability/metrics.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../../ports/llm.js';
import { LlmError } from '../../ports/llm.js';

export const llmRequestsTotal = new promClient.Counter({
  name: 'outreach_llm_requests_total',
  help: 'LLM calls by model, tenant and outcome',
  labelNames: ['model', 'tenant', 'status'] as const,
  registers: [metricsRegistry],
});

export const llmTokensTotal = new promClient.Counter({
  name: 'outreach_llm_tokens_total',
  help: 'Tokens consumed by model and direction',
  labelNames: ['model', 'direction'] as const,
  registers: [metricsRegistry],
});

export const llmCostUsdTotal = new promClient.Counter({
  name: 'outreach_llm_cost_usd_total',
  help: 'Estimated LLM spend in USD by model and tenant',
  labelNames: ['model', 'tenant'] as const,
  registers: [metricsRegistry],
});

export const llmLatencySeconds = new promClient.Histogram({
  name: 'outreach_llm_latency_seconds',
  help: 'LLM call latency',
  labelNames: ['model', 'status'] as const,
  buckets: [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

/** Prompts are truncated before storage — enough to reproduce, not a transcript. */
const SUMMARY_LIMIT = 2000;

function truncate(value: string, limit = SUMMARY_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [${value.length} chars]`;
}

export class RecordingLlmProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly inner: LlmProvider,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {
    this.name = inner.name;
  }

  listModels(): string[] {
    return this.inner.listModels();
  }

  generate(req: LlmRequest): Promise<LlmResponse<string>> {
    return this.record(req, () => this.inner.generate(req), (r) => r.content);
  }

  generateJson<T>(req: LlmRequest & { jsonSchema: object }): Promise<LlmResponse<T>> {
    return this.record(
      req,
      () => this.inner.generateJson<T>(req),
      (r) => JSON.stringify(r.content),
    );
  }

  private async record<T>(
    req: LlmRequest,
    call: () => Promise<LlmResponse<T>>,
    renderOutput: (response: LlmResponse<T>) => string,
  ): Promise<LlmResponse<T>> {
    const started = Date.now();
    const tenant = req.audit?.tenantId ?? 'unknown';

    try {
      const response = await call();

      llmRequestsTotal.inc({ model: response.model, tenant, status: 'success' });
      llmTokensTotal.inc({ model: response.model, direction: 'in' }, response.tokensIn);
      llmTokensTotal.inc({ model: response.model, direction: 'out' }, response.tokensOut);
      if (response.costUsd !== undefined) {
        llmCostUsdTotal.inc({ model: response.model, tenant }, response.costUsd);
      }
      llmLatencySeconds.observe(
        { model: response.model, status: 'success' },
        response.latencyMs / 1000,
      );

      await this.write(req, {
        model: response.model,
        // ── THE SYSTEM BLOCK IS PART OF THE PROMPT ──────────────────────────
        //
        // Only `req.prompt` was recorded, so the stored input omitted the
        // persona, the constraints, the channel rules and the tenant's house
        // style — everything the pack contributes. `ai_interactions` exists so a
        // prompt regression is diagnosable after the fact, and a record of half
        // the prompt cannot answer "why did it write that?": the half it drops
        // is the half a pack edit changes.
        input: req.system ? `[system]\n${req.system}\n\n[prompt]\n${req.prompt}` : req.prompt,
        output: renderOutput(response),
        tokensUsed: response.tokensIn + response.tokensOut,
        // The column holds one total, and input and output tokens are priced
        // differently by every provider — so a total cannot be re-costed if a
        // rate changes, and cannot be checked against a vendor bill that itemises
        // them. Kept on `metadata` rather than in two new columns: §0.10 tier 2,
        // and P12's usage endpoint is the only reader.
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        processingTime: response.latencyMs,
        costUsd: response.costUsd,
        success: true,
      });

      return response;
    } catch (error) {
      const model = req.model ?? 'unknown';
      const latencyMs = Date.now() - started;

      llmRequestsTotal.inc({ model, tenant, status: 'error' });
      llmLatencySeconds.observe({ model, status: 'error' }, latencyMs / 1000);

      // A failed generation is exactly the case someone will want to inspect.
      await this.write(req, {
        model,
        // ── THE SYSTEM BLOCK IS PART OF THE PROMPT ──────────────────────────
        //
        // Only `req.prompt` was recorded, so the stored input omitted the
        // persona, the constraints, the channel rules and the tenant's house
        // style — everything the pack contributes. `ai_interactions` exists so a
        // prompt regression is diagnosable after the fact, and a record of half
        // the prompt cannot answer "why did it write that?": the half it drops
        // is the half a pack edit changes.
        input: req.system ? `[system]\n${req.system}\n\n[prompt]\n${req.prompt}` : req.prompt,
        output: '',
        processingTime: latencyMs,
        success: false,
        errorMessage:
          error instanceof LlmError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
      });

      throw error;
    }
  }

  private async write(
    req: LlmRequest,
    row: {
      model: string;
      input: string;
      output: string;
      tokensUsed?: number;
      tokensIn?: number;
      tokensOut?: number;
      processingTime: number;
      costUsd?: number;
      success: boolean;
      errorMessage?: string;
    },
  ): Promise<void> {
    if (!req.audit) return;

    try {
      await this.db.insert(aiInteractions).values({
        tenantId: req.audit.tenantId,
        subTenantId: req.audit.subTenantId,
        playbookId: req.audit.playbookId,
        modelId: row.model,
        actionGroup: req.audit.promptPackKey,
        // Truncated, but enough to reproduce the draft — the plan calls this
        // out as the regression guard against silent prompt drift.
        inputSummary: truncate(row.input),
        outputSummary: truncate(row.output),
        tokensUsed: row.tokensUsed,
        processingTime: row.processingTime,
        costUsd: row.costUsd?.toFixed(6),
        success: row.success,
        errorMessage: row.errorMessage,
        metadata:
          row.tokensIn === undefined && row.tokensOut === undefined
            ? null
            : { tokensIn: row.tokensIn ?? 0, tokensOut: row.tokensOut ?? 0 },
      });
    } catch (error) {
      this.logger.error('failed to write ai_interactions row', {
        tenantId: req.audit.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
