/**
 * Draft generation: validate the caller's context, assemble the prompt, call the
 * LLM, score confidence, lint.
 */
import { z } from 'zod';
import type { Logger } from 'winston';

import { ValidationError } from '../../platform/http/errors.js';
import type { ChannelType } from '../../ports/channel.js';
import type { LlmProvider } from '../../ports/llm.js';
import type { RenderContext } from './render-context.js';
import type { PromptAssembler, PromptPack } from './prompt-assembler.js';

export interface GenerateInput {
  tenantId: string;
  subTenantId?: string;
  playbookKey?: string;
  playbookId?: string;
  playbookGoal?: string;
  /** JSON Schema from `playbooks.data_contract`. */
  dataContract?: object;
  pack: PromptPack;
  channel: ChannelType;
  context: RenderContext;
  complianceConstraints?: string[];
  tenantStyle?: string;
  overrides?: { tone?: string; language?: string; model?: string };
}

export interface GeneratedDraft {
  draftId: string;
  content: string;
  subject?: string;
  channel: ChannelType;
  aiConfidence: number;
  promptPackKey: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  lintWarnings: string[];
}

/** P5 owns the ruleset; P4 calls the hook so the seam exists. */
export type ContentLinter = (input: {
  content: string;
  channel: ChannelType;
  tenantId: string;
}) => Promise<string[]>;

const draftSchema = z.object({
  content: z.string().min(1),
  subject: z.string().optional(),
  tone: z.string().optional(),
  reasoning: z.string().optional(),
});

const DRAFT_JSON_SCHEMA = {
  type: 'object',
  required: ['content'],
  properties: {
    content: { type: 'string' },
    subject: { type: 'string' },
    tone: { type: 'string' },
    reasoning: { type: 'string' },
  },
} as const;

export interface GeneratorDeps {
  llm: LlmProvider;
  assembler: PromptAssembler;
  logger: Logger;
  lint?: ContentLinter;
}

export class ContentGenerator {
  constructor(private readonly deps: GeneratorDeps) {}

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    // Validate BEFORE spending a token. A contract violation is the caller's
    // bug, and a best-effort draft from bad context is worse than an error —
    // it looks fine and says the wrong thing.
    const contractFields = this.validateContext(input);

    const assembled = await this.deps.assembler.assemble({
      pack: input.pack,
      playbookGoal: input.playbookGoal,
      channel: input.channel,
      context: input.context,
      complianceConstraints: input.complianceConstraints,
      tenantStyle: input.tenantStyle,
    });

    const response = await this.deps.llm.generateJson<z.infer<typeof draftSchema>>({
      system: assembled.system,
      prompt: input.overrides?.tone
        ? `${assembled.prompt}\n\nUse a ${input.overrides.tone} tone.`
        : assembled.prompt,
      model: input.overrides?.model ?? assembled.model,
      temperature: assembled.temperature,
      maxTokens: assembled.maxTokens,
      jsonSchema: DRAFT_JSON_SCHEMA,
      audit: {
        tenantId: input.tenantId,
        subTenantId: input.subTenantId,
        playbookId: input.playbookId,
        promptPackKey: assembled.packKey,
      },
    });

    const parsed = draftSchema.safeParse(response.content);
    if (!parsed.success) {
      throw new ValidationError('Model returned JSON that does not match the draft contract', {
        issues: parsed.error.issues,
      });
    }

    const lintWarnings =
      (await this.deps.lint?.({
        content: parsed.data.content,
        channel: input.channel,
        tenantId: input.tenantId,
      })) ?? [];

    return {
      draftId: crypto.randomUUID(),
      content: parsed.data.content,
      subject: parsed.data.subject,
      channel: input.channel,
      aiConfidence: this.score(contractFields, lintWarnings),
      promptPackKey: assembled.packKey,
      model: response.model,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      costUsd: response.costUsd,
      lintWarnings,
    };
  }

  /**
   * Generate against a caller-supplied JSON Schema instead of the draft
   * contract. Added in P12 for `POST /ai/multimodal`, whose output is not a
   * message body at all — it is `{textContent, images[]}`, a composition plan.
   *
   * Everything the draft path gets that still applies is kept: the pack owns
   * sampling, the assembler builds the prompt, and the call is audited into
   * `ai_interactions` through `RecordingLlmProvider`. What is skipped is what
   * does not apply — `lint` and `aiConfidence` both judge a message someone will
   * receive, and nothing here is one. Emitting a confidence score for a
   * composition plan would put a number in front of P6's `threshold` mode that
   * means nothing to it.
   */
  async generateStructured<T>(
    input: GenerateInput & { jsonSchema: object },
  ): Promise<{
    data: T;
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd?: number;
  }> {
    const assembled = await this.deps.assembler.assemble({
      pack: input.pack,
      playbookGoal: input.playbookGoal,
      channel: input.channel,
      context: input.context,
      complianceConstraints: input.complianceConstraints,
      tenantStyle: input.tenantStyle,
    });

    const response = await this.deps.llm.generateJson<T>({
      system: assembled.system,
      prompt: assembled.prompt,
      model: input.overrides?.model ?? assembled.model,
      temperature: assembled.temperature,
      maxTokens: assembled.maxTokens,
      jsonSchema: input.jsonSchema,
      audit: {
        tenantId: input.tenantId,
        subTenantId: input.subTenantId,
        playbookId: input.playbookId,
        promptPackKey: assembled.packKey,
      },
    });

    return {
      data: response.content,
      model: response.model,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      costUsd: response.costUsd,
    };
  }

  /**
   * Compile the playbook's stored JSON Schema to Zod and check the context
   * against it. Returns how complete the context was, which feeds confidence.
   *
   * Only the subset of JSON Schema the data contracts actually use is
   * supported: object type, `required`, and scalar/array property types. An
   * unrecognised construct is ignored rather than rejected, so a richer schema
   * degrades to "check what we understand" instead of failing every call.
   */
  private validateContext(input: GenerateInput): { present: number; declared: number } {
    const contract = input.dataContract as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;

    if (!contract?.properties) return { present: 0, declared: 0 };

    const declared = Object.keys(contract.properties);
    const required = contract.required ?? [];
    const supplied = input.context.context ?? {};

    const missing = required.filter(
      (field) => supplied[field] === undefined || supplied[field] === null,
    );

    if (missing.length > 0) {
      throw new ValidationError(
        `Context does not satisfy the playbook data contract: missing ${missing.join(', ')}`,
        { missing, playbookKey: input.playbookKey },
      );
    }

    const present = declared.filter(
      (field) => supplied[field] !== undefined && supplied[field] !== null,
    ).length;

    return { present, declared: declared.length };
  }

  /**
   * `aiConfidence` — a **heuristic, not a calibrated probability**.
   *
   * The source has no confidence score at all (it takes whatever number the
   * model volunteers, defaulting to 0.5 at `ai-message-generator.ts:244`), but
   * P6's `threshold` approval mode needs one. This is a deterministic composite
   * of what we can actually observe:
   *
   *   context completeness × lint cleanliness
   *
   * A model-reported self-assessment is deliberately NOT used: models are not
   * calibrated about their own output, and letting a model raise its own score
   * past an auto-approval threshold is exactly the wrong incentive.
   *
   * Documented as heuristic in docs/PACKS.md. P6 must ship `threshold` mode OFF
   * by default because of this.
   */
  private score(
    contract: { present: number; declared: number },
    lintWarnings: string[],
  ): number {
    const completeness =
      contract.declared === 0 ? 0.8 : contract.present / contract.declared;
    const lintPenalty = Math.min(lintWarnings.length * 0.15, 0.6);
    return Math.max(0, Math.min(1, Number((completeness - lintPenalty).toFixed(3))));
  }
}
