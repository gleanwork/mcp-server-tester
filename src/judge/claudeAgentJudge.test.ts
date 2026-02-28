import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createClaudeAgentJudge } from './claudeAgentJudge.js';
import type { JudgeConfig } from './judgeTypes.js';

// Mock the Claude Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Import the mocked query function
import { query } from '@anthropic-ai/claude-agent-sdk';

// Helper to create a mock async generator from query
function mockQueryResponse(
  result: string,
  options: {
    inputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
    durationMs?: number;
    durationApiMs?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    subtype?: string;
    errors?: string[];
  } = {}
) {
  const resultMessage = {
    type: 'result' as const,
    result,
    subtype: options.subtype ?? 'success',
    usage: {
      input_tokens: options.inputTokens ?? 100,
      output_tokens: options.outputTokens ?? 50,
      cache_read_input_tokens: options.cacheReadInputTokens,
      cache_creation_input_tokens: options.cacheCreationInputTokens,
    },
    total_cost_usd: options.totalCostUsd ?? 0.001,
    duration_ms: options.durationMs ?? 500,
    duration_api_ms: options.durationApiMs,
    errors: options.errors,
  };

  // Create an async generator that yields the result message
  async function* mockGenerator() {
    yield resultMessage;
  }

  (query as Mock).mockReturnValue(mockGenerator());
}

describe('claudeAgentJudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createClaudeAgentJudge', () => {
    it('creates a judge with default configuration', () => {
      const judge = createClaudeAgentJudge({});
      expect(judge).toBeDefined();
      expect(typeof judge.evaluate).toBe('function');
    });

    it('evaluates candidate against reference successfully', async () => {
      mockQueryResponse(
        JSON.stringify({
          pass: true,
          score: 0.9,
          reasoning: 'Good match',
        }),
        {
          inputTokens: 150,
          outputTokens: 30,
          totalCostUsd: 0.002,
          durationMs: 450,
        }
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.9);
      expect(result.reasoning).toBe('Good match');
      expect(result.usage).toBeDefined();
      expect(result.usage?.inputTokens).toBe(150);
      expect(result.usage?.outputTokens).toBe(30);
      expect(result.usage?.totalCostUsd).toBe(0.002);
      expect(result.usage?.durationMs).toBe(450);
      expect(result.candidateSizeBytes).toBeDefined();
      expect(result.exceedsMaxToolOutputSize).toBe(false);
    });

    it('handles JSON response with markdown code blocks', async () => {
      mockQueryResponse(
        '```json\n{"pass": true, "score": 0.8, "reasoning": "Works"}\n```'
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.8);
      expect(result.reasoning).toBe('Works');
    });

    it('handles JSON response with just ``` blocks', async () => {
      mockQueryResponse(
        '```\n{"pass": false, "score": 0.3, "reasoning": "Fail"}\n```'
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(false);
      expect(result.score).toBe(0.3);
    });

    it('extracts JSON from text with surrounding content', async () => {
      mockQueryResponse(
        'Here is my evaluation:\n{"pass": true, "score": 0.95, "reasoning": "Excellent"}\nDone.'
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.95);
    });

    it('tracks cache statistics when available', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'Perfect' }),
        {
          cacheReadInputTokens: 50,
          cacheCreationInputTokens: 100,
        }
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.usage?.cacheReadInputTokens).toBe(50);
      expect(result.usage?.cacheCreationInputTokens).toBe(100);
    });
  });

  describe('maxToolOutputSize threshold', () => {
    it('fails fast when candidate exceeds maxToolOutputSize', async () => {
      const config: JudgeConfig = {
        maxToolOutputSize: 10, // Very small threshold
      };
      const judge = createClaudeAgentJudge(config);

      // This candidate is larger than 10 bytes
      const result = await judge.evaluate(
        'This is a long candidate response',
        'reference',
        'rubric'
      );

      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
      expect(result.exceedsMaxToolOutputSize).toBe(true);
      expect(result.reasoning).toContain('exceeds maximum allowed size');
      expect(result.candidateSizeBytes).toBeGreaterThan(10);
      // Verify API was NOT called (fail fast)
      expect(query).not.toHaveBeenCalled();
    });

    it('proceeds when candidate is within maxToolOutputSize', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 0.9, reasoning: 'Good' })
      );

      const config: JudgeConfig = {
        maxToolOutputSize: 10000, // Large threshold
      };
      const judge = createClaudeAgentJudge(config);

      const result = await judge.evaluate('small', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.exceedsMaxToolOutputSize).toBe(false);
      expect(query).toHaveBeenCalled();
    });

    it('proceeds when maxToolOutputSize is not configured', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 0.8, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate(
        'any size candidate',
        'reference',
        'rubric'
      );

      expect(result.pass).toBe(true);
      expect(query).toHaveBeenCalled();
    });

    it('calculates size correctly for objects', async () => {
      const config: JudgeConfig = {
        maxToolOutputSize: 50,
      };
      const judge = createClaudeAgentJudge(config);

      // Object will be JSON.stringified with formatting
      const result = await judge.evaluate(
        { key: 'value', nested: { a: 1, b: 2 } },
        'reference',
        'rubric'
      );

      expect(result.exceedsMaxToolOutputSize).toBe(true);
      expect(result.candidateSizeBytes).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('throws error when SDK returns error result', async () => {
      mockQueryResponse('', {
        subtype: 'error_max_budget_usd',
        errors: ['Budget exceeded'],
      });

      const judge = createClaudeAgentJudge({});

      await expect(
        judge.evaluate('candidate', 'reference', 'rubric')
      ).rejects.toThrow('Claude Agent SDK error: Budget exceeded');
    });

    it('throws error when no result message received', async () => {
      // Mock an empty generator
      async function* emptyGenerator() {
        // Yield nothing
      }
      (query as Mock).mockReturnValue(emptyGenerator());

      const judge = createClaudeAgentJudge({});

      await expect(
        judge.evaluate('candidate', 'reference', 'rubric')
      ).rejects.toThrow('No result message received from Claude Agent SDK');
    });

    it('throws error for invalid JSON response', async () => {
      mockQueryResponse('This is not valid JSON at all');

      const judge = createClaudeAgentJudge({});

      await expect(
        judge.evaluate('candidate', 'reference', 'rubric')
      ).rejects.toThrow('Failed to parse judge response as JSON');
    });

    it('wraps SDK errors appropriately', async () => {
      (query as Mock).mockImplementation(() => {
        throw new Error('Network error');
      });

      const judge = createClaudeAgentJudge({});

      await expect(
        judge.evaluate('candidate', 'reference', 'rubric')
      ).rejects.toThrow('Claude Agent judge evaluation failed: Network error');
    });
  });

  describe('configuration', () => {
    it('uses default model when not specified', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({});
      await judge.evaluate('candidate', 'reference', 'rubric');

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'claude-sonnet-4-20250514',
          }),
        })
      );
    });

    it('uses specified model', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({
        model: 'claude-3-haiku-20240307',
      });
      await judge.evaluate('candidate', 'reference', 'rubric');

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'claude-3-haiku-20240307',
          }),
        })
      );
    });

    it('uses default maxBudgetUsd when not specified', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({});
      await judge.evaluate('candidate', 'reference', 'rubric');

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            maxBudgetUsd: 0.1,
          }),
        })
      );
    });

    it('uses specified maxBudgetUsd', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({ maxBudgetUsd: 0.05 });
      await judge.evaluate('candidate', 'reference', 'rubric');

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            maxBudgetUsd: 0.05,
          }),
        })
      );
    });

    it('uses response-only mode with empty tools array', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({});
      await judge.evaluate('candidate', 'reference', 'rubric');

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            tools: [],
            permissionMode: 'bypassPermissions',
            maxTurns: 1,
          }),
        })
      );
    });
  });

  describe('parseJudgeResponse edge cases', () => {
    it('parses plain JSON response', async () => {
      mockQueryResponse(
        '{"pass":true,"score":0.85,"reasoning":"clear answer"}'
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.85);
      expect(result.reasoning).toBe('clear answer');
    });

    it('strips ```json code block and parses', async () => {
      mockQueryResponse(
        '```json\n{"pass":true,"score":0.9,"reasoning":"good"}\n```'
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.9);
      expect(result.reasoning).toBe('good');
    });

    it('strips plain ``` code block and parses', async () => {
      mockQueryResponse(
        '```\n{"pass":false,"score":0.3,"reasoning":"poor"}\n```'
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(false);
      expect(result.score).toBe(0.3);
      expect(result.reasoning).toBe('poor');
    });

    it('extracts JSON from text with surrounding explanation', async () => {
      mockQueryResponse(
        'Here is my evaluation: {"pass":true,"score":0.8,"reasoning":"ok"} hope that helps'
      );

      const judge = createClaudeAgentJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.8);
      expect(result.reasoning).toBe('ok');
    });

    it('throws when response has no parseable JSON', async () => {
      mockQueryResponse('I cannot evaluate this response.');

      const judge = createClaudeAgentJudge({});

      await expect(
        judge.evaluate('candidate', 'reference', 'rubric')
      ).rejects.toThrow('Failed to parse judge response as JSON');
    });

    it('throws when response is missing required pass field', async () => {
      // JSON parses successfully but has no "pass" key — schema validation rejects it
      mockQueryResponse('{"score":0.6,"reasoning":"partial credit"}');

      const judge = createClaudeAgentJudge({});

      await expect(
        judge.evaluate('candidate', 'reference', 'rubric')
      ).rejects.toThrow('Judge returned invalid response');
    });
  });

  describe('prompt construction', () => {
    it('includes candidate in prompt', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({});
      await judge.evaluate('my candidate response', 'reference', 'my rubric');

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('my candidate response'),
        })
      );
    });

    it('includes reference in prompt when provided', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({});
      await judge.evaluate('candidate', 'expected reference', 'rubric');

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('expected reference'),
        })
      );
    });

    it('includes rubric in prompt', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({});
      await judge.evaluate('candidate', 'reference', 'Evaluate accuracy');

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Evaluate accuracy'),
        })
      );
    });

    it('handles null reference gracefully', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({});
      await judge.evaluate('candidate', null, 'rubric');

      const callArg = (query as Mock).mock.calls[0]?.[0] as {
        prompt: string;
      };
      expect(callArg.prompt).not.toContain('Reference Response');
    });

    it('stringifies object candidates with formatting', async () => {
      mockQueryResponse(
        JSON.stringify({ pass: true, score: 1.0, reasoning: 'OK' })
      );

      const judge = createClaudeAgentJudge({});
      await judge.evaluate({ data: 'value' }, 'reference', 'rubric');

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('"data": "value"'),
        })
      );
    });
  });
});
