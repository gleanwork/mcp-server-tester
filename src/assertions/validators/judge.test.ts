/**
 * Judge Validator Unit Tests
 *
 * Tests for validateJudge, including the reps (multi-rep averaging) behavior.
 * The judge calls external LLM APIs so createJudge is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateJudge } from './judge.js';

// Mock the judgeClient module so no real LLM calls are made
vi.mock('../../judge/judgeClient.js', () => ({
  createJudge: vi.fn(),
}));

// Import after mock so we get the mocked version
import { createJudge } from '../../judge/judgeClient.js';

const mockCreateJudge = vi.mocked(createJudge);

function makeMockJudge(
  results: Array<{ score?: number; pass: boolean; reasoning?: string }>
) {
  let callIndex = 0;
  return {
    evaluate: vi.fn().mockImplementation(async () => {
      const result = results[callIndex % results.length]!;
      callIndex++;
      return result;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateJudge', () => {
  describe('single rep (default behavior)', () => {
    it('calls judge once when reps is 1 (default)', async () => {
      const mockJudge = makeMockJudge([{ score: 0.8, pass: true }]);
      mockCreateJudge.mockReturnValue(mockJudge);

      await validateJudge('some response', { rubric: { text: 'Is it good?' } });

      expect(mockJudge.evaluate).toHaveBeenCalledTimes(1);
    });

    it('calls judge once when reps is explicitly 1', async () => {
      const mockJudge = makeMockJudge([{ score: 0.8, pass: true }]);
      mockCreateJudge.mockReturnValue(mockJudge);

      await validateJudge('some response', {
        rubric: { text: 'Is it good?' },
        reps: 1,
      });

      expect(mockJudge.evaluate).toHaveBeenCalledTimes(1);
    });

    it('passes when score meets default threshold (0.7)', async () => {
      const mockJudge = makeMockJudge([{ score: 0.75, pass: true }]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
      });

      expect(result.pass).toBe(true);
      expect(result.message).toContain('0.75');
    });

    it('fails when score is below threshold', async () => {
      const mockJudge = makeMockJudge([
        { score: 0.5, pass: false, reasoning: 'Too vague' },
      ]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
      });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('0.50');
      expect(result.message).toContain('Too vague');
    });

    it('does not include rep breakdown in message for single rep', async () => {
      const mockJudge = makeMockJudge([{ score: 0.8, pass: true }]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
      });

      expect(result.message).not.toContain('mean of');
      expect(result.message).not.toContain('reps');
    });

    it('uses pass boolean when score is not provided', async () => {
      const mockJudge = makeMockJudge([{ pass: true }]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
      });

      // pass=true → score=1.0, which is >= 0.7 threshold
      expect(result.pass).toBe(true);
    });
  });

  describe('multiple reps averaging', () => {
    it('calls judge N times when reps > 1', async () => {
      const mockJudge = makeMockJudge([
        { score: 0.6, pass: false },
        { score: 0.8, pass: true },
        { score: 0.9, pass: true },
      ]);
      mockCreateJudge.mockReturnValue(mockJudge);

      await validateJudge('response', {
        rubric: { text: 'Is it good?' },
        reps: 3,
      });

      expect(mockJudge.evaluate).toHaveBeenCalledTimes(3);
    });

    it('passes when mean score meets threshold', async () => {
      // Scores: 0.6 and 0.8, mean = 0.7 → passes at threshold 0.7
      const mockJudge = makeMockJudge([
        { score: 0.6, pass: false },
        { score: 0.8, pass: true },
      ]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
        reps: 2,
        threshold: 0.7,
      });

      expect(result.pass).toBe(true);
    });

    it('fails when mean score is below threshold even if some reps pass', async () => {
      // Scores: 0.4 and 0.6, mean = 0.5 → fails at threshold 0.7
      const mockJudge = makeMockJudge([
        { score: 0.4, pass: false },
        { score: 0.6, pass: false },
      ]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
        reps: 2,
        threshold: 0.7,
      });

      expect(result.pass).toBe(false);
    });

    it('includes rep breakdown in message when reps > 1', async () => {
      const mockJudge = makeMockJudge([
        { score: 0.6, pass: false },
        { score: 0.8, pass: true },
      ]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
        reps: 2,
      });

      expect(result.message).toContain('mean of 2 reps');
      expect(result.message).toContain('0.60');
      expect(result.message).toContain('0.80');
    });

    it('averages scores correctly: [0.6, 0.8] → mean 0.70', async () => {
      const mockJudge = makeMockJudge([
        { score: 0.6, pass: false },
        { score: 0.8, pass: true },
      ]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
        reps: 2,
        threshold: 0.7,
      });

      // mean = 0.7, threshold = 0.7 → should pass
      expect(result.pass).toBe(true);
      expect(result.message).toContain('0.70');
    });

    it('includes scores and scoreStdDev in details when reps > 1', async () => {
      const mockJudge = makeMockJudge([
        { score: 0.6, pass: false },
        { score: 0.8, pass: true },
      ]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
        reps: 2,
      });

      expect(result.details).toBeDefined();
      expect(result.details!.scores).toEqual([0.6, 0.8]);
      expect(typeof result.details!.scoreStdDev).toBe('number');
      expect(result.details!.highVariance).toBe(false); // stddev ≈ 0.1
    });

    it('flags highVariance when stddev > 0.2', async () => {
      // Scores: 0.1 and 0.9 → mean = 0.5, stdDev = 0.4
      const mockJudge = makeMockJudge([
        { score: 0.1, pass: false },
        { score: 0.9, pass: true },
      ]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const consoleSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
        reps: 2,
      });

      expect(result.details!.highVariance).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('high variance')
      );

      consoleSpy.mockRestore();
    });

    it('does not include details for single rep', async () => {
      const mockJudge = makeMockJudge([{ score: 0.8, pass: true }]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
        reps: 1,
      });

      expect(result.details).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('returns failed result when judge throws', async () => {
      const mockJudge = {
        evaluate: vi.fn().mockRejectedValue(new Error('API error')),
      };
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
      });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('Judge evaluation error');
      expect(result.message).toContain('API error');
    });
  });
});
