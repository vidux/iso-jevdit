import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenRouterProvider } from '../../src/providers/openrouter.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter retry behavior', () => {
  it('reports a rate limit and retries the same decision request', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":"limited"}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            answers: { q_test: { type: 'choice', choice: 'compliant', probabilities: { compliant: 1 } } },
            usage: { input_tokens: 10, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenRouterProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.test',
      timeoutMs: 1000,
      maxRetries: 1,
      headers: {},
      rateLimitWaitMs: 1,
      defaults: {
        baseUrl: 'https://example.test',
        model: 'test-model',
        transport: 'decisions',
        decisionsPath: '/decisions',
        keyCheckPath: '/key',
        contextTokens: 32_000,
        pricing: { inputPerMTok: 1, outputPerMTok: 0 },
        apiKeyEnv: 'TEST_KEY',
        timeoutMs: 1000,
        maxRetries: 1,
        keyHint: 'https://example.test/key',
      },
    });
    const events: Array<{ type: string; waitMs: number }> = [];

    const response = await provider.decide(
      {
        model: 'test-model',
        state: { file: 'src/a.ts' },
        questions: { q_test: { type: 'choice', instructions: 'Safe?', criteria: { compliant: 'yes', violation: 'no' } } },
      },
      { onEvent: (event) => events.push(event) },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ type: 'rate-limit', waitMs: 1, attempt: 1, maxRetries: 1, detail: '429 {"error":"limited"}' }]);
    expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 1 });
  });
});