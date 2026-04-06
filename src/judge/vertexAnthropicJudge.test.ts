/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@anthropic-ai/vertex-sdk', () => {
  const mockCreate = vi.fn();
  const MockAnthropicVertex = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return {
    AnthropicVertex: MockAnthropicVertex,
    __mockCreate: mockCreate,
  };
});

import { createVertexAnthropicJudge } from './vertexAnthropicJudge.js';

async function getMockCreate() {
  const mod = await import('@anthropic-ai/vertex-sdk' as any);
  return (mod as any).__mockCreate;
}

function makeResponse(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

describe('vertexAnthropicJudge', () => {
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

  it('creates a judge with evaluate method', () => {
    const judge = createVertexAnthropicJudge({});

    expect(judge).toBeDefined();
    expect(typeof judge.evaluate).toBe('function');
  });

  it('does not require ANTHROPIC_API_KEY', () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => createVertexAnthropicJudge({})).not.toThrow();
  });

  it('evaluates candidate against reference successfully', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(
      makeResponse(
        JSON.stringify({ pass: true, score: 0.85, reasoning: 'Accurate' }),
        200,
        40
      )
    );

    const judge = createVertexAnthropicJudge({});
    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(result.pass).toBe(true);
    expect(result.score).toBe(0.85);
    expect(result.reasoning).toBe('Accurate');
    expect(result.usage?.inputTokens).toBe(200);
    expect(result.usage?.outputTokens).toBe(40);
  });

  it('strips markdown code blocks from response', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(
      makeResponse(
        '```json\n{"pass": false, "score": 0.3, "reasoning": "Poor"}\n```'
      )
    );

    const judge = createVertexAnthropicJudge({});
    const result = await judge.evaluate('candidate', 'reference', 'rubric');

    expect(result.pass).toBe(false);
    expect(result.score).toBe(0.3);
  });

  it('throws on invalid JSON response', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(makeResponse('Not valid JSON'));

    const judge = createVertexAnthropicJudge({});

    await expect(
      judge.evaluate('candidate', 'reference', 'rubric')
    ).rejects.toThrow('Failed to parse judge response as JSON');
  });

  it('handles null reference gracefully', async () => {
    const mock = await getMockCreate();
    mock.mockResolvedValue(
      makeResponse(JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' }))
    );

    const judge = createVertexAnthropicJudge({});
    const result = await judge.evaluate('candidate', null, 'rubric');

    expect(result.pass).toBe(true);
  });

  it('propagates API errors', async () => {
    const mock = await getMockCreate();
    mock.mockRejectedValue(new Error('Vertex auth failed'));

    const judge = createVertexAnthropicJudge({});

    await expect(judge.evaluate('candidate', null, 'rubric')).rejects.toThrow(
      'Vertex auth failed'
    );
  });
});
