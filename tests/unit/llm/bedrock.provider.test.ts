import { ValidationException } from '@aws-sdk/client-bedrock-runtime';
import winston from 'winston';

import { BedrockProvider } from '../../../src/adapters/llm/bedrock.provider.js';
import { codecFor } from '../../../src/adapters/llm/model-codecs.js';
import { LlmError } from '../../../src/ports/llm.js';

const logger = winston.createLogger({ silent: true });

/** Stands in for BedrockRuntimeClient — no AWS SDK module mocking required. */
class FakeClient {
  sent: unknown[] = [];
  responses: string[] = [];
  error?: Error;
  /** Resolve after this long, to exercise the timeout path. */
  delayMs = 0;

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    this.sent.push(command);
    if (this.error) throw this.error;

    if (this.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        options?.abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    }

    const body = this.responses.shift() ?? '{}';
    return { body: new TextEncoder().encode(body) };
  }
}

function provider(client: FakeClient, timeoutMs = 5_000) {
  return new BedrockProvider({
    config: {
      region: 'us-east-1',
      defaultModel: 'amazon.nova-pro-v1:0',
      maxRetries: 1,
      timeoutMs,
    },
    logger,
    client: client as never,
  });
}

const novaBody = (text: string) =>
  JSON.stringify({
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 12, outputTokens: 34 },
    stopReason: 'end_turn',
  });

describe('model codecs', () => {
  it('selects nova for the default model', () => {
    expect(codecFor('amazon.nova-pro-v1:0')?.family).toBe('nova');
  });

  it('prefers claude-3 over the legacy claude codec', () => {
    expect(codecFor('anthropic.claude-3-sonnet-20240229-v1:0')?.family).toBe('claude-3');
    expect(codecFor('anthropic.claude-v2')?.family).toBe('claude-legacy');
  });

  it('selects titan', () => {
    expect(codecFor('amazon.titan-text-premier-v1:0')?.family).toBe('titan');
  });

  it('returns undefined for an unknown model', () => {
    expect(codecFor('meta.llama3')).toBeUndefined();
  });

  it('reads real token counts rather than estimating from word count', () => {
    const parsed = codecFor('amazon.nova-pro-v1:0')!.parse(
      JSON.parse(novaBody('one two three')) as Record<string, unknown>,
    );
    expect(parsed.tokensIn).toBe(12);
    expect(parsed.tokensOut).toBe(34);
    expect(parsed.content).toBe('one two three');
  });
});

describe('generate', () => {
  it('returns content, usage and cost', async () => {
    const client = new FakeClient();
    client.responses = [novaBody('Hello there')];

    const result = await provider(client).generate({ prompt: 'hi' });
    expect(result.content).toBe('Hello there');
    expect(result.tokensIn).toBe(12);
    expect(result.tokensOut).toBe(34);
    expect(result.finishReason).toBe('end_turn');
    // 12/1000*0.0008 + 34/1000*0.0032
    expect(result.costUsd).toBeCloseTo(0.0001184, 8);
  });

  it('rejects an unknown model without calling the client', async () => {
    const client = new FakeClient();
    await expect(provider(client).generate({ prompt: 'hi', model: 'meta.llama3' })).rejects.toThrow(
      LlmError,
    );
    expect(client.sent).toHaveLength(0);
  });

  it('maps a Bedrock ValidationException to a non-retryable LlmError', async () => {
    const client = new FakeClient();
    client.error = new ValidationException({ message: 'bad shape', $metadata: {} });
    try {
      await provider(client).generate({ prompt: 'hi' });
      fail('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).code).toBe('VALIDATION');
      expect((error as LlmError).retryable).toBe(false);
    }
  });
});

describe('timeout', () => {
  it('aborts at timeoutMs and reports TIMEOUT', async () => {
    const client = new FakeClient();
    client.delayMs = 2_000;
    client.responses = [novaBody('too late')];

    try {
      await provider(client, 100).generate({ prompt: 'hi' });
      fail('expected a timeout');
    } catch (error) {
      expect((error as LlmError).code).toBe('TIMEOUT');
      expect((error as LlmError).retryable).toBe(true);
    }
  });

  it('does not leave a pending timer after a fast response', async () => {
    // The source races against a setTimeout it never clears, so every call kept
    // the event loop alive for the full timeout. If that regressed, Jest would
    // report open handles / refuse to exit for this suite.
    const client = new FakeClient();
    client.responses = [novaBody('quick')];
    const before = process.hrtime.bigint();
    await provider(client, 30_000).generate({ prompt: 'hi' });
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe('generateJson', () => {
  const schema = { type: 'object', properties: { a: { type: 'number' } } };

  it('parses a clean JSON response', async () => {
    const client = new FakeClient();
    client.responses = [novaBody('{"a":1}')];
    const result = await provider(client).generateJson<{ a: number }>({
      prompt: 'x',
      jsonSchema: schema,
    });
    expect(result.content).toEqual({ a: 1 });
  });

  it('strips a markdown fence', async () => {
    const client = new FakeClient();
    client.responses = [novaBody('```json\n{"a":2}\n```')];
    const result = await provider(client).generateJson<{ a: number }>({
      prompt: 'x',
      jsonSchema: schema,
    });
    expect(result.content).toEqual({ a: 2 });
  });

  it('retries exactly once on invalid JSON, then succeeds', async () => {
    const client = new FakeClient();
    client.responses = [novaBody('not json at all'), novaBody('{"a":3}')];
    const result = await provider(client).generateJson<{ a: number }>({
      prompt: 'x',
      jsonSchema: schema,
    });
    expect(result.content).toEqual({ a: 3 });
    expect(client.sent).toHaveLength(2);
  });

  it('throws after the retry also fails, rather than returning something unusable', async () => {
    const client = new FakeClient();
    client.responses = [novaBody('nope'), novaBody('still nope')];
    try {
      await provider(client).generateJson({ prompt: 'x', jsonSchema: schema });
      fail('expected a throw');
    } catch (error) {
      expect((error as LlmError).code).toBe('INVALID_JSON');
      expect((error as LlmError).retryable).toBe(false);
    }
    expect(client.sent).toHaveLength(2);
  });

  it('puts the schema in the system prompt', async () => {
    const client = new FakeClient();
    client.responses = [novaBody('{"a":1}')];
    await provider(client).generateJson({ prompt: 'x', jsonSchema: schema });

    const sent = client.sent[0] as { input: { body: string } };
    const body = JSON.parse(sent.input.body) as { system: Array<{ text: string }> };
    expect(body.system[0]!.text).toContain('JSON Schema');
  });
});

describe('listModels', () => {
  it('reports the ids the source declares', () => {
    const models = provider(new FakeClient()).listModels();
    expect(models).toContain('amazon.nova-pro-v1:0');
    expect(models).toContain('anthropic.claude-3-haiku-20240307-v1:0');
  });
});
