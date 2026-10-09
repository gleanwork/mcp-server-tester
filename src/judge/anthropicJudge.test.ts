/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return {
    default: MockAnthropic,
    __mockCreate: mockCreate,
  };
});

import { createJudge } from './judgeClient.js';
import type { JudgeConfig } from './judgeTypes.js';

/** The anthropic judge, through the public createJudge. */
function createAnthropicJudge(config: JudgeConfig = {}) {
  return createJudge({ ...config, provider: 'anthropic' });
}

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk' as any);
  return (mod as any).__mockCreate;
}

async function getMockClient() {
  const mod = await import('@anthropic-ai/sdk' as any);
  return (mod as any).default;
}

const JUDGE_OUTPUT = JSON.stringify({
  pass: true,
  score: 1.0,
  reasoning: 'OK',
});

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
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.MST_LLM_AUTH_COMMAND;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when API key is not set', () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => createAnthropicJudge({})).toThrow(
      'Anthropic judge requires an API key'
    );
    expect(() => createAnthropicJudge({})).toThrow('ANTHROPIC_AUTH_TOKEN');
  });

  it('does not take ANTHROPIC_AUTH_TOKEN alone, without a base URL override', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token';
    try {
      expect(() => createAnthropicJudge({})).toThrow(
        'Anthropic judge requires an API key'
      );
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it('sends the API key alone, so the SDK does not add a bearer header', async () => {
    (await getMockCreate()).mockResolvedValue(makeResponse(JUDGE_OUTPUT));

    await createAnthropicJudge({}).evaluate('candidate', null, 'rubric');

    expect(await getMockClient()).toHaveBeenCalledWith({
      apiKey: 'test-key',
      authToken: null,
      baseURL: 'https://api.anthropic.com',
    });
  });

  it('sends ANTHROPIC_AUTH_TOKEN as a bearer token to the base URL override', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token';
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example/anthropic';
    (await getMockCreate()).mockResolvedValue(makeResponse(JUDGE_OUTPUT));

    await createAnthropicJudge({}).evaluate('candidate', null, 'rubric');

    expect(await getMockClient()).toHaveBeenCalledWith({
      apiKey: null,
      authToken: 'gateway-token',
      baseURL: 'https://gateway.example/anthropic',
    });
  });

  it('gets a bearer token from MST_LLM_AUTH_COMMAND when no key is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example/anthropic';
    process.env.MST_LLM_AUTH_COMMAND = `node -e "process.stdout.write('judge-command-token')"`;
    (await getMockCreate()).mockResolvedValue(makeResponse(JUDGE_OUTPUT));

    await createAnthropicJudge({}).evaluate('candidate', null, 'rubric');

    expect(await getMockClient()).toHaveBeenCalledWith({
      apiKey: null,
      authToken: 'judge-command-token',
      baseURL: 'https://gateway.example/anthropic',
    });
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
      expect.objectContaining({ model: 'claude-sonnet-4-6' })
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
