import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toPassToolJudge } from './toPassToolJudge.js';
import type { RubricSpec } from '../../judge/rubrics.js';

// Mock the judge client and registry so no real LLM calls are made
vi.mock('../../judge/judgeClient.js', () => ({
  createJudge: vi.fn(),
}));
vi.mock('../../judge/judgeRegistry.js', () => ({
  getRegisteredJudge: vi.fn(),
}));

import { createJudge } from '../../judge/judgeClient.js';
import { getRegisteredJudge } from '../../judge/judgeRegistry.js';

const RUBRIC: RubricSpec = { text: 'Is the response accurate and complete?' };

function makeMockJudge(
  results: Array<{ pass: boolean; score: number; reasoning?: string }>
) {
  let callCount = 0;
  return {
    evaluate: vi.fn().mockImplementation(async () => {
      const result = results[callCount % results.length];
      callCount++;
      return result;
    }),
  };
}

describe('toPassToolJudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('basic pass/fail', () => {
    it('passes when judge score meets the threshold', async () => {
      const mockJudge = makeMockJudge([
        { pass: true, score: 0.9, reasoning: 'Well answered' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(
        context,
        'some tool response',
        { text: 'Is the response accurate?' },
        { passingThreshold: 0.7 }
      );

      expect(result.pass).toBe(true);
    });

    it('fails when judge score is below threshold', async () => {
      const mockJudge = makeMockJudge([
        { pass: false, score: 0.4, reasoning: 'Missing key details' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(
        context,
        'incomplete response',
        { text: 'Is the response accurate?' },
        { passingThreshold: 0.7 }
      );

      expect(result.pass).toBe(false);
    });

    it('uses default passing threshold of 0.7 when not specified', async () => {
      // Score of 0.65 should fail the default threshold of 0.7
      const mockJudge = makeMockJudge([
        { pass: false, score: 0.65, reasoning: 'Close but not enough' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(
        context,
        'response',
        RUBRIC,
        {} // no passingThreshold
      );

      expect(result.pass).toBe(false);
    });

    it('passes at exactly the threshold score', async () => {
      const mockJudge = makeMockJudge([
        { pass: true, score: 0.7, reasoning: 'Just enough' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        passingThreshold: 0.7,
      });

      expect(result.pass).toBe(true);
    });
  });

  describe('reps averaging', () => {
    it('averages scores across multiple reps when reps > 1', async () => {
      // Three reps: scores 0.8, 0.8, 0.8 => mean = 0.8 => passes at threshold 0.7
      const mockJudge = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ pass: true, score: 0.8, reasoning: 'Good' })
          .mockResolvedValueOnce({ pass: true, score: 0.8, reasoning: 'Good' })
          .mockResolvedValueOnce({ pass: true, score: 0.8, reasoning: 'Good' }),
      };
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        reps: 3,
        passingThreshold: 0.7,
      });

      expect(mockJudge.evaluate).toHaveBeenCalledTimes(3);
      expect(result.pass).toBe(true);
    });

    it('fails when averaged score across reps is below threshold', async () => {
      // Two reps: scores 0.5, 0.6 => mean = 0.55 => fails at threshold 0.7
      const mockJudge = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ pass: false, score: 0.5, reasoning: 'Poor' })
          .mockResolvedValueOnce({
            pass: false,
            score: 0.6,
            reasoning: 'Below par',
          }),
      };
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        reps: 2,
        passingThreshold: 0.7,
      });

      expect(mockJudge.evaluate).toHaveBeenCalledTimes(2);
      expect(result.pass).toBe(false);
    });

    it('includes rep count and individual scores in failure message when reps > 1', async () => {
      const mockJudge = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            pass: false,
            score: 0.3,
            reasoning: 'Low quality',
          })
          .mockResolvedValueOnce({
            pass: false,
            score: 0.4,
            reasoning: 'Insufficient',
          }),
      };
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        reps: 2,
        passingThreshold: 0.7,
      });

      const msg = result.message();
      expect(msg).toContain('0.30');
      expect(msg).toContain('0.40');
    });
  });

  describe('failure message', () => {
    it('includes judge reasoning in the failure message', async () => {
      const mockJudge = makeMockJudge([
        {
          pass: false,
          score: 0.3,
          reasoning:
            'The response completely missed the point about data accuracy',
        },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        passingThreshold: 0.7,
      });

      expect(result.pass).toBe(false);
      const msg = result.message();
      expect(msg).toContain('missed the point about data accuracy');
    });

    it('includes score and threshold in the failure message', async () => {
      const mockJudge = makeMockJudge([
        { pass: false, score: 0.5, reasoning: 'Partial' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        passingThreshold: 0.8,
      });

      const msg = result.message();
      expect(msg).toContain('0.50');
      expect(msg).toContain('0.8');
    });
  });

  describe('isNot (negation)', () => {
    it('inverts pass when used with .not and judge fails', async () => {
      const mockJudge = makeMockJudge([
        { pass: false, score: 0.2, reasoning: 'Bad' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      // When isNot=true and judge actually fails, we invert: validateJudge returns pass=false
      // toPassToolJudge with isNot returns pass = !validation.pass = true
      const context = { isNot: true };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        passingThreshold: 0.7,
      });

      expect(result.pass).toBe(true);
    });

    it('inverts pass when used with .not and judge passes', async () => {
      const mockJudge = makeMockJudge([
        { pass: true, score: 0.9, reasoning: 'Great' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      // isNot=true and judge passes => validation.pass=true => toPassToolJudge returns pass=false
      const context = { isNot: true };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        passingThreshold: 0.7,
      });

      expect(result.pass).toBe(false);
    });
  });

  describe('API error propagation', () => {
    it('propagates API errors and does not swallow them', async () => {
      const apiError = new Error('OpenAI rate limit exceeded');
      const mockJudge = {
        evaluate: vi.fn().mockRejectedValue(apiError),
      };
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      // validateJudge catches errors and returns a failed ValidationResult with the error message
      const result = await toPassToolJudge.call(
        context,
        'response',
        RUBRIC,
        {}
      );

      // The error is caught by validateJudge and surfaced in the message, not re-thrown
      expect(result.pass).toBe(false);
      const msg = result.message();
      expect(msg).toContain('OpenAI rate limit exceeded');
    });

    it('surfaces error message from unexpected judge failure', async () => {
      const mockJudge = {
        evaluate: vi.fn().mockRejectedValue(new Error('Connection timeout')),
      };
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(
        context,
        'response',
        RUBRIC,
        {}
      );

      expect(result.pass).toBe(false);
      expect(result.message()).toContain('Connection timeout');
    });
  });

  describe('malformed judge response', () => {
    it('handles judge returning undefined score by treating it as 0 or using pass field', async () => {
      // Judge returns pass: false with no score — validateJudge uses pass ? 1.0 : 0.0
      const mockJudge = makeMockJudge([
        {
          pass: false,
          score: undefined as unknown as number,
          reasoning: 'No score',
        },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        passingThreshold: 0.7,
      });

      // pass: false with no score => score defaults to 0.0, which is < 0.7
      expect(result.pass).toBe(false);
    });

    it('handles judge returning undefined reasoning gracefully', async () => {
      const mockJudge = makeMockJudge([
        { pass: false, score: 0.3, reasoning: undefined },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', RUBRIC, {
        passingThreshold: 0.7,
      });

      // Should not throw even with missing reasoning
      expect(result.pass).toBe(false);
      expect(() => result.message()).not.toThrow();
    });

    it('handles non-Error exceptions from judge', async () => {
      const mockJudge = {
        evaluate: vi.fn().mockRejectedValue('raw string error'),
      };
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(
        context,
        'response',
        RUBRIC,
        {}
      );

      expect(result.pass).toBe(false);
      expect(result.message()).toContain('raw string error');
    });
  });

  describe('provider and model forwarding', () => {
    it('forwards provider option to createJudge', async () => {
      const mockJudge = makeMockJudge([
        { pass: true, score: 0.9, reasoning: 'OK' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      await toPassToolJudge.call(context, 'response', RUBRIC, {
        provider: 'openai',
      });

      expect(createJudge).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai' })
      );
    });

    it('forwards model option to createJudge', async () => {
      const mockJudge = makeMockJudge([
        { pass: true, score: 0.9, reasoning: 'OK' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      await toPassToolJudge.call(context, 'response', RUBRIC, {
        model: 'gpt-4o',
      });

      expect(createJudge).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o' })
      );
    });

    it('accepts built-in rubric names', async () => {
      const mockJudge = makeMockJudge([
        { pass: true, score: 0.9, reasoning: 'Correct' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      // 'correctness' is a valid BuiltInRubric
      const result = await toPassToolJudge.call(
        context,
        'response',
        'correctness',
        {}
      );

      expect(result.pass).toBe(true);
    });

    it('accepts custom rubric objects', async () => {
      const mockJudge = makeMockJudge([
        { pass: true, score: 0.85, reasoning: 'Custom rubric passed' },
      ]);
      vi.mocked(createJudge).mockReturnValue(mockJudge);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(
        context,
        'response',
        { text: 'Does the response mention all required fields?' },
        {}
      );

      expect(result.pass).toBe(true);
    });
  });

  describe('named custom judge (options-only signature)', () => {
    it('passes when called with { judge } options only (no rubric)', async () => {
      const executor = vi
        .fn()
        .mockResolvedValue({ score: 0.95, reasoning: 'Great' });
      vi.mocked(getRegisteredJudge).mockReturnValue(executor);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', {
        judge: 'my-judge',
      });

      expect(result.pass).toBe(true);
      expect(getRegisteredJudge).toHaveBeenCalledWith('my-judge');
      expect(createJudge).not.toHaveBeenCalled();
    });

    it('fails when custom judge score is below threshold', async () => {
      const executor = vi
        .fn()
        .mockResolvedValue({ score: 0.2, reasoning: 'Bad' });
      vi.mocked(getRegisteredJudge).mockReturnValue(executor);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(context, 'response', {
        judge: 'strict',
      });

      expect(result.pass).toBe(false);
    });

    it('supports .not with named judge', async () => {
      const executor = vi
        .fn()
        .mockResolvedValue({ score: 0.1, reasoning: 'Nope' });
      vi.mocked(getRegisteredJudge).mockReturnValue(executor);

      const context = { isNot: true };
      const result = await toPassToolJudge.call(context, 'response', {
        judge: 'strict',
      });

      expect(result.pass).toBe(true);
    });

    it('passes reference through to the executor', async () => {
      const executor = vi.fn().mockResolvedValue({ score: 1.0 });
      vi.mocked(getRegisteredJudge).mockReturnValue(executor);

      const context = { isNot: false };
      await toPassToolJudge.call(context, 'candidate', {
        judge: 'ref-judge',
        reference: 'expected answer',
      });

      expect(executor).toHaveBeenCalledWith('candidate', 'expected answer');
    });

    it('respects passingThreshold with named judge', async () => {
      const executor = vi.fn().mockResolvedValue({ score: 0.6 });
      vi.mocked(getRegisteredJudge).mockReturnValue(executor);

      const context = { isNot: false };

      // Fails at default threshold (0.7)
      const strict = await toPassToolJudge.call(context, 'response', {
        judge: 'my-judge',
      });
      expect(strict.pass).toBe(false);

      // Passes at lower threshold
      const lenient = await toPassToolJudge.call(context, 'response', {
        judge: 'my-judge',
        passingThreshold: 0.5,
      });
      expect(lenient.pass).toBe(true);
    });

    it('still works with rubric + judge in options (judge takes precedence)', async () => {
      const executor = vi.fn().mockResolvedValue({ score: 0.9 });
      vi.mocked(getRegisteredJudge).mockReturnValue(executor);

      const context = { isNot: false };
      const result = await toPassToolJudge.call(
        context,
        'response',
        'correctness',
        { judge: 'my-judge' }
      );

      expect(result.pass).toBe(true);
      expect(getRegisteredJudge).toHaveBeenCalledWith('my-judge');
      expect(createJudge).not.toHaveBeenCalled();
    });
  });
});
