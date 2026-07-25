import winston from 'winston';

import { ContentGenerator } from '../../../src/engine/content/generator.js';
import { PromptAssembler, type PromptPack } from '../../../src/engine/content/prompt-assembler.js';
import { emptyContext } from '../../../src/engine/content/render-context.js';
import { Renderer } from '../../../src/engine/content/renderer.js';
import { ValidationError } from '../../../src/platform/http/errors.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../../../src/ports/llm.js';

const logger = winston.createLogger({ silent: true });

const PACK: PromptPack = {
  key: 'medspa.followup',
  version: 1,
  persona: 'You write for {{sender.displayName}} at {{tenant.name}}.',
  goal: 'Check in after a treatment.',
  constraints: ['Never give medical advice.'],
  channelRules: { sms: 'Under 320 characters.' },
  modelHints: { temperature: 0.7, maxTokens: 800 },
};

const CONTRACT = {
  type: 'object',
  required: ['treatmentName'],
  properties: {
    treatmentName: { type: 'string' },
    treatmentDate: { type: 'string' },
  },
};

/** Records every call so a test can assert the LLM was never reached. */
class SpyLlm implements LlmProvider {
  readonly name = 'spy';
  calls: LlmRequest[] = [];
  reply: unknown = { content: 'Hope you are healing well!', subject: 'Checking in' };

  listModels() {
    return ['spy-model'];
  }

  async generate(req: LlmRequest): Promise<LlmResponse<string>> {
    this.calls.push(req);
    return {
      content: String(this.reply),
      model: 'spy-model',
      tokensIn: 10,
      tokensOut: 20,
      latencyMs: 5,
      finishReason: 'stop',
    };
  }

  async generateJson<T>(req: LlmRequest & { jsonSchema: object }): Promise<LlmResponse<T>> {
    this.calls.push(req);
    return {
      content: this.reply as T,
      model: 'spy-model',
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.0001,
      latencyMs: 5,
      finishReason: 'stop',
    };
  }
}

function build(llm: SpyLlm, lint?: (i: { content: string }) => Promise<string[]>) {
  const renderer = new Renderer({ logger });
  return new ContentGenerator({
    llm,
    assembler: new PromptAssembler(renderer),
    logger,
    lint: lint as never,
  });
}

function input(overrides: Record<string, unknown> = {}) {
  const context = emptyContext('t1');
  context.sender.displayName = 'Dr. Rivera';
  context.tenant.name = 'Northside Clinic';
  context.context = { treatmentName: 'Hydrafacial' };
  return {
    tenantId: 't1',
    pack: PACK,
    channel: 'sms' as const,
    dataContract: CONTRACT,
    context,
    ...overrides,
  };
}

describe('data contract validation happens before any LLM call', () => {
  it('throws when a required field is missing — and does not call the model', async () => {
    const llm = new SpyLlm();
    const context = emptyContext('t1');
    context.context = {}; // treatmentName missing

    await expect(build(llm).generate(input({ context }))).rejects.toThrow(ValidationError);
    // The point of the test: no tokens were spent on a request that could only
    // produce a plausible-sounding draft about nothing.
    expect(llm.calls).toHaveLength(0);
  });

  it('names the missing fields in the error', async () => {
    const llm = new SpyLlm();
    const context = emptyContext('t1');
    context.context = {};
    try {
      await build(llm).generate(input({ context }));
      fail('expected a throw');
    } catch (error) {
      expect((error as ValidationError).details).toMatchObject({ missing: ['treatmentName'] });
    }
  });

  it('proceeds when the contract is satisfied', async () => {
    const llm = new SpyLlm();
    const draft = await build(llm).generate(input());
    expect(llm.calls).toHaveLength(1);
    expect(draft.content).toBe('Hope you are healing well!');
    expect(draft.subject).toBe('Checking in');
  });

  it('skips validation when the playbook declares no contract', async () => {
    const llm = new SpyLlm();
    await expect(build(llm).generate(input({ dataContract: undefined }))).resolves.toBeDefined();
  });
});

describe('draft shape', () => {
  it('rejects a model response missing content', async () => {
    const llm = new SpyLlm();
    llm.reply = { subject: 'only a subject' };
    await expect(build(llm).generate(input())).rejects.toThrow(ValidationError);
  });

  it('carries model, tokens and cost through', async () => {
    const draft = await build(new SpyLlm()).generate(input());
    expect(draft.model).toBe('spy-model');
    expect(draft.tokensIn).toBe(10);
    expect(draft.tokensOut).toBe(20);
    expect(draft.costUsd).toBe(0.0001);
    expect(draft.promptPackKey).toBe('medspa.followup');
  });

  it('passes audit metadata so the ai_interactions row is attributable', async () => {
    const llm = new SpyLlm();
    await build(llm).generate(input({ playbookId: 'pb-1', subTenantId: 'st-1' }));
    expect(llm.calls[0]!.audit).toEqual({
      tenantId: 't1',
      subTenantId: 'st-1',
      playbookId: 'pb-1',
      promptPackKey: 'medspa.followup',
    });
  });
});

describe('aiConfidence is a heuristic, and behaves like one', () => {
  it('is 1 when every declared field is supplied and lint is clean', async () => {
    const context = emptyContext('t1');
    context.context = { treatmentName: 'Hydrafacial', treatmentDate: '2026-01-10' };
    const draft = await build(new SpyLlm()).generate(input({ context }));
    expect(draft.aiConfidence).toBe(1);
  });

  it('drops when the context is only partially complete', async () => {
    const draft = await build(new SpyLlm()).generate(input());
    expect(draft.aiConfidence).toBe(0.5);
  });

  it('drops further for each lint warning', async () => {
    const context = emptyContext('t1');
    context.context = { treatmentName: 'H', treatmentDate: 'd' };
    const draft = await build(new SpyLlm(), async () => ['too long', 'missing opt-out']).generate(
      input({ context }),
    );
    expect(draft.aiConfidence).toBeCloseTo(0.7, 5);
    expect(draft.lintWarnings).toHaveLength(2);
  });

  it('never goes below zero', async () => {
    const context = emptyContext('t1');
    context.context = {};
    const draft = await build(new SpyLlm(), async () =>
      Array.from({ length: 20 }, (_, i) => `w${i}`),
    ).generate(input({ context, dataContract: undefined }));
    expect(draft.aiConfidence).toBeGreaterThanOrEqual(0);
  });

  it('ignores any confidence the model volunteers', async () => {
    const llm = new SpyLlm();
    llm.reply = { content: 'hi', confidence: 0.99 };
    const draft = await build(llm).generate(input());
    // Derived from observable signals only — a model must not be able to talk
    // its own draft past an auto-approval threshold.
    expect(draft.aiConfidence).toBe(0.5);
  });
});
