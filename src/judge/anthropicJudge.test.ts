/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Anthropic SDK
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

// Mock the Vertex SDK
vi.mock('@anthropic-ai/vertex-sdk', () => {
  const mockCreate = vi.fn();
  const MockAnthropicVertex = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
  return {
    AnthropicVertex: MockAnthropicVertex,
    __mockCreate: mockCreate,
  };
});

import { createAnthropicJudge } from './anthropicJudge.js';

async function getAnthropicMockCreate() {
  const mod = await import('@anthropic-ai/sdk' as any);
  return (mod as any).__mockCreate;
}

async function getVertexMockCreate() {
  const mod = await import('@anthropic-ai/vertex-sdk' as any);
  return (mod as any).__mockCreate;
}

function makeResponse(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

describe('anthropicJudge (direct API)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'test-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates a judge and evaluates successfully', async () => {
    const mock = await getAnthropicMockCreate();
    mock.mockResolvedValue(
      makeResponse(
        JSON.stringify({ pass: true, score: 0.9, reasoning: 'Good match' })
      )
    );

    const judge = createAnthropicJudge({}, false);
    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(result.pass).toBe(true);
    expect(result.score).toBe(0.9);
    expect(result.reasoning).toBe('Good match');
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
  });

  it('throws when API key is missing', () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => createAnthropicJudge({}, false)).toThrow(
      'Anthropic judge requires an API key'
    );
  });

  it('uses custom apiKeyEnvVar', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.MY_KEY = 'custom-key';

    expect(() =>
      createAnthropicJudge({ apiKeyEnvVar: 'MY_KEY' }, false)
    ).not.toThrow();
  });

  it('fails fast when candidate exceeds maxToolOutputSize', async () => {
    const judge = createAnthropicJudge({ maxToolOutputSize: 10 }, false);
    const result = await judge.evaluate(
      'This is a long candidate response',
      'reference',
      'rubric'
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.exceedsMaxToolOutputSize).toBe(true);
    expect(result.reasoning).toContain('exceeds maximum allowed size');
  });

  it('handles markdown code blocks in response', async () => {
    const mock = await getAnthropicMockCreate();
    mock.mockResolvedValue(
      makeResponse(
        '```json\n{"pass": true, "score": 0.8, "reasoning": "Works"}\n```'
      )
    );

    const judge = createAnthropicJudge({}, false);
    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(result.pass).toBe(true);
    expect(result.score).toBe(0.8);
  });

  it('throws for invalid JSON response', async () => {
    const mock = await getAnthropicMockCreate();
    mock.mockResolvedValue(makeResponse('Not valid JSON'));

    const judge = createAnthropicJudge({}, false);

    await expect(
      judge.evaluate('candidate', 'reference', 'rubric')
    ).rejects.toThrow('Failed to parse judge response as JSON');
  });

  it('includes null reference gracefully', async () => {
    const mock = await getAnthropicMockCreate();
    mock.mockResolvedValue(
      makeResponse(JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' }))
    );

    const judge = createAnthropicJudge({}, false);
    const result = await judge.evaluate('candidate', null, 'rubric');

    expect(result.pass).toBe(true);
  });
});

describe('anthropicJudge (vertex)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      GOOGLE_VERTEX_PROJECT: 'test-project',
      GOOGLE_VERTEX_LOCATION: 'us-east5',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates a vertex judge and evaluates successfully', async () => {
    const mock = await getVertexMockCreate();
    mock.mockResolvedValue(
      makeResponse(
        JSON.stringify({ pass: true, score: 0.85, reasoning: 'Accurate' })
      )
    );

    const judge = createAnthropicJudge({}, true);
    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(result.pass).toBe(true);
    expect(result.score).toBe(0.85);
    expect(result.reasoning).toBe('Accurate');
  });

  it('does not require ANTHROPIC_API_KEY for vertex mode', () => {
    delete process.env.ANTHROPIC_API_KEY;

    // Should not throw — vertex uses Application Default Credentials
    expect(() => createAnthropicJudge({}, true)).not.toThrow();
  });
});
