/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
  return {
    default: MockAnthropic,
    __mockCreate: mockCreate,
  };
});

import { createAnthropicJudge } from './anthropicJudge.js';

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk' as any);
  return (mod as any).__mockCreate;
}

function makeResponse(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

describe('anthropicJudge', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'test-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when API key is not set', () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => createAnthropicJudge({})).toThrow(
      'Anthropic judge requires an API key'
    );
  });

  it('throws when custom apiKeyEnvVar is not set', () => {
    delete process.env.MY_KEY;

    expect(() => createAnthropicJudge({ apiKeyEnvVar: 'MY_KEY' })).toThrow(
      'Anthropic judge requires an API key. Set the MY_KEY environment variable.'
    );
  });

  it('creates a judge with evaluate method', () => {
    const judge = createAnthropicJudge({});

    expect(judge).toBeDefined();
    expect(typeof judge.evaluate).toBe('function');
  });

  it('evaluates candidate against reference successfully', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(
      makeResponse(
        JSON.stringify({ pass: true, score: 0.9, reasoning: 'Good match' }),
        150,
        30
      )
    );

    const judge = createAnthropicJudge({});
    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(result.pass).toBe(true);
    expect(result.score).toBe(0.9);
    expect(result.reasoning).toBe('Good match');
    expect(result.usage?.inputTokens).toBe(150);
    expect(result.usage?.outputTokens).toBe(30);
  });

  it('strips markdown code blocks from response', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(
      makeResponse(
        '```json\n{"pass": true, "score": 0.8, "reasoning": "Works"}\n```'
      )
    );

    const judge = createAnthropicJudge({});
    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(result.pass).toBe(true);
    expect(result.score).toBe(0.8);
  });

  it('throws on invalid JSON response', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(makeResponse('Not valid JSON'));

    const judge = createAnthropicJudge({});

    await expect(
      judge.evaluate('candidate', 'reference', 'rubric')
    ).rejects.toThrow('Failed to parse judge response as JSON');
  });

  it('handles null reference gracefully', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(
      makeResponse(JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' }))
    );

    const judge = createAnthropicJudge({});
    const result = await judge.evaluate('candidate', null, 'rubric');

    expect(result.pass).toBe(true);
  });

  it('propagates API errors', async () => {
    const mock = await getMockCreate();
    mock.mockRejectedValue(new Error('Rate limit exceeded'));

    const judge = createAnthropicJudge({});

    await expect(judge.evaluate('candidate', null, 'rubric')).rejects.toThrow(
      'Rate limit exceeded'
    );
  });

  it('uses the default model when not specified', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(
      makeResponse(JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' }))
    );

    const judge = createAnthropicJudge({});
    await judge.evaluate('candidate', null, 'rubric');

    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-20250514' })
    );
  });

  it('uses the specified model override', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(
      makeResponse(JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' }))
    );

    const judge = createAnthropicJudge({ model: 'claude-haiku-4-5-20251001' });
    await judge.evaluate('candidate', null, 'rubric');

    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' })
    );
  });
});
