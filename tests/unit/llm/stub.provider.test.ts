/**
 * The stub provider's job is to be substitutable for Bedrock everywhere the
 * engine calls a model. These tests check the two properties that make it so:
 * its JSON satisfies the caller's schema, and the same request gives the same
 * answer twice.
 *
 * The draft contract is duplicated here rather than imported, deliberately.
 * `DRAFT_JSON_SCHEMA` is private to `generator.ts`, and a test that imported it
 * would pass by construction — it would assert the stub agrees with itself. The
 * copy makes the real assertion: this shape, which `ContentGenerator` validates
 * with Zod, is satisfiable.
 */
import winston from 'winston';

import { StubLlmProvider } from '../../../src/adapters/llm/stub.provider.js';
import { LlmError } from '../../../src/ports/llm.js';

const logger = winston.createLogger({ silent: true });

const provider = () =>
  new StubLlmProvider({ logger, defaultModel: 'amazon.nova-pro-v1:0' });

/** Mirrors `DRAFT_JSON_SCHEMA` in `engine/content/generator.ts`. */
const DRAFT_SCHEMA = {
  type: 'object',
  required: ['content'],
  properties: {
    content: { type: 'string' },
    subject: { type: 'string' },
    tone: { type: 'string' },
    reasoning: { type: 'string' },
  },
};

describe('StubLlmProvider', () => {
  it('satisfies the draft contract, including the optional fields', async () => {
    const res = await provider().generateJson<Record<string, unknown>>({
      prompt: 'Write a follow-up.',
      jsonSchema: DRAFT_SCHEMA,
    });

    expect(typeof res.content.content).toBe('string');
    // Optional fields are filled too — a stub emitting only the required subset
    // would make every optional-field path untestable.
    expect(typeof res.content.subject).toBe('string');
    expect(typeof res.content.tone).toBe('string');
  });

  it('is deterministic: the same request twice gives the same bytes', async () => {
    const req = { prompt: 'Write a reminder.', jsonSchema: DRAFT_SCHEMA };
    const a = await provider().generateJson(req);
    const b = await provider().generateJson(req);

    expect(a.content).toEqual(b.content);
    expect(a.tokensIn).toBe(b.tokensIn);
  });

  it('varies output between different prompts', async () => {
    const a = await provider().generateJson({ prompt: 'one', jsonSchema: DRAFT_SCHEMA });
    const b = await provider().generateJson({ prompt: 'two', jsonSchema: DRAFT_SCHEMA });

    expect(a.content).not.toEqual(b.content);
  });

  it('handles a nested schema it has never seen — arrays, enums and formats', async () => {
    // Approximates the `/ai/multimodal` shape: text plus a list of image specs.
    const res = await provider().generateJson<{
      textContent: string;
      images: Array<{ description: string; placement: string; url: string }>;
    }>({
      prompt: 'Compose a campaign.',
      jsonSchema: {
        type: 'object',
        required: ['textContent', 'images'],
        properties: {
          textContent: { type: 'string' },
          images: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                placement: { type: 'string', enum: ['header', 'inline', 'footer'] },
                url: { type: 'string', format: 'uri' },
              },
            },
          },
        },
      },
    });

    expect(res.content.images.length).toBeGreaterThanOrEqual(2);
    expect(['header', 'inline', 'footer']).toContain(res.content.images[0].placement);
    expect(res.content.images[0].url).toMatch(/^https:/);
  });

  it('reports token counts and cost derived from the text, not zeroes', async () => {
    // `GET /v1/usage` and `ai_interactions` aggregate these. Zeroes would make
    // the usage endpoint pass vacuously in the very mode built to test it.
    const res = await provider().generate({
      system: 'You are a careful writer.',
      prompt: 'Write a short appointment reminder for tomorrow at 9am.',
    });

    expect(res.tokensIn).toBeGreaterThan(0);
    expect(res.tokensOut).toBeGreaterThan(0);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.finishReason).toBe('stop');
  });

  it('marks its output so it cannot be mistaken for real copy', async () => {
    const res = await provider().generate({ prompt: 'anything' });
    expect(res.content).toContain('[stub-llm]');
  });

  it('throws a retryable LlmError in fail mode', async () => {
    const failing = new StubLlmProvider({
      logger,
      defaultModel: 'amazon.nova-pro-v1:0',
      failMode: true,
    });

    await expect(failing.generate({ prompt: 'x' })).rejects.toBeInstanceOf(LlmError);
    await expect(failing.generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'STUB_FAILURE',
      retryable: true,
    });
  });
});
