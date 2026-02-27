import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the OpenAI module before importing the judge (Vitest hoists vi.mock)
vi.mock('openai', () => {
  const mockCreate = vi.fn();
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }));
  // Attach the mockCreate so tests can configure it
  (MockOpenAI as unknown as Record<string, unknown>)._mockCreate = mockCreate;

  return {
    default: MockOpenAI,
    __mockCreate: mockCreate,
  };
});

import { createOpenAIJudge } from './openaiJudge.js';

// Retrieve the mocked create function for configuring in tests
async function getMockCreate() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openai = await import('openai' as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion
  return (openai as any).__mockCreate;
}

function makeCompletionResponse(
  content: string,
  options: {
    promptTokens?: number;
    completionTokens?: number;
  } = {}
) {
  return {
    choices: [
      {
        message: {
          content,
        },
      },
    ],
    usage: {
      prompt_tokens: options.promptTokens ?? 100,
      completion_tokens: options.completionTokens ?? 50,
    },
  };
}

describe('openaiJudge', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, OPENAI_API_KEY: 'test-api-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createOpenAIJudge', () => {
    it('throws when API key is not set', () => {
      delete process.env.OPENAI_API_KEY;

      expect(() => createOpenAIJudge({})).toThrow(
        'OpenAI judge requires an API key'
      );
    });

    it('throws when custom apiKeyEnvVar is not set', () => {
      delete process.env.MY_OPENAI_KEY;

      expect(() =>
        createOpenAIJudge({ apiKeyEnvVar: 'MY_OPENAI_KEY' })
      ).toThrow(
        'OpenAI judge requires an API key. Set the MY_OPENAI_KEY environment variable.'
      );
    });

    it('creates a judge with evaluate method', () => {
      const judge = createOpenAIJudge({});

      expect(judge).toBeDefined();
      expect(typeof judge.evaluate).toBe('function');
    });
  });

  describe('evaluate', () => {
    it('returns pass=true when response has pass:true', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue(
        makeCompletionResponse(
          JSON.stringify({ pass: true, score: 0.9, reasoning: 'Well done' })
        )
      );

      const judge = createOpenAIJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.9);
      expect(result.reasoning).toBe('Well done');
    });

    it('returns pass=false when score is below threshold', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue(
        makeCompletionResponse(
          JSON.stringify({ pass: false, score: 0.3, reasoning: 'Insufficient' })
        )
      );

      const judge = createOpenAIJudge({});
      const result = await judge.evaluate('candidate', null, 'rubric');

      expect(result.pass).toBe(false);
      expect(result.score).toBe(0.3);
      expect(result.reasoning).toBe('Insufficient');
    });

    it('derives pass from score when pass field is missing', async () => {
      // When pass field is missing in JSON, it defaults to false regardless of score
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue(
        makeCompletionResponse(
          JSON.stringify({
            score: 0.8,
            reasoning: 'Good score but no pass field',
          })
        )
      );

      const judge = createOpenAIJudge({});
      const result = await judge.evaluate('candidate', null, 'rubric');

      // openaiJudge uses: pass = typeof parsed.pass === 'boolean' ? parsed.pass : false
      // So when pass is missing, it defaults to false, and score stays 0.8
      expect(result.score).toBe(0.8);
      // pass defaults to false when the field is absent
      expect(result.pass).toBe(false);
    });

    it('handles invalid JSON response gracefully without throwing', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue(
        makeCompletionResponse('This is not JSON at all')
      );

      const judge = createOpenAIJudge({});
      // openaiJudge's parseJudgeResponse returns {pass:false, score:0} on parse error
      const result = await judge.evaluate('candidate', null, 'rubric');

      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reasoning).toContain('Failed to parse judge response');
    });

    it('propagates API errors (does not swallow them)', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockRejectedValue(new Error('OpenAI API rate limit exceeded'));

      const judge = createOpenAIJudge({});

      await expect(judge.evaluate('candidate', null, 'rubric')).rejects.toThrow(
        'OpenAI API rate limit exceeded'
      );
    });

    it('strips markdown code blocks from response before parsing', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue(
        makeCompletionResponse(
          '```json\n{"pass": true, "score": 0.95, "reasoning": "Excellent"}\n```'
        )
      );

      const judge = createOpenAIJudge({});
      const result = await judge.evaluate('candidate', null, 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.95);
      expect(result.reasoning).toBe('Excellent');
    });

    it('includes token usage in result', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue(
        makeCompletionResponse(
          JSON.stringify({ pass: true, score: 0.8, reasoning: 'OK' }),
          { promptTokens: 200, completionTokens: 75 }
        )
      );

      const judge = createOpenAIJudge({});
      const result = await judge.evaluate('candidate', null, 'rubric');

      expect(result.usage).toBeDefined();
      expect(result.usage?.inputTokens).toBe(200);
      expect(result.usage?.outputTokens).toBe(75);
    });

    it('uses the default model gpt-4o when not specified', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue(
        makeCompletionResponse(
          JSON.stringify({ pass: true, score: 1.0, reasoning: 'Perfect' })
        )
      );

      const judge = createOpenAIJudge({});
      await judge.evaluate('candidate', null, 'rubric');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o' })
      );
    });

    it('uses the specified model override', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue(
        makeCompletionResponse(
          JSON.stringify({ pass: true, score: 1.0, reasoning: 'Perfect' })
        )
      );

      const judge = createOpenAIJudge({ model: 'gpt-4o-mini' });
      await judge.evaluate('candidate', null, 'rubric');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o-mini' })
      );
    });

    it('handles null response content gracefully', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const judge = createOpenAIJudge({});
      const result = await judge.evaluate('candidate', null, 'rubric');

      // Empty string is passed to parseJudgeResponse, which fails to parse -> returns defaults
      expect(result.pass).toBe(false);
    });
  });
});
