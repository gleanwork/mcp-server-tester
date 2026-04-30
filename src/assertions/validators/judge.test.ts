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

// Mock the judge registry
vi.mock('../../judge/judgeRegistry.js', () => ({
  getRegisteredJudge: vi.fn(),
}));

// Import after mock so we get the mocked version
import { createJudge } from '../../judge/judgeClient.js';
import { getRegisteredJudge } from '../../judge/judgeRegistry.js';

const mockCreateJudge = vi.mocked(createJudge);
const mockGetRegisteredJudge = vi.mocked(getRegisteredJudge);

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

    it('includes judge metadata but not rep-specific fields for single rep', async () => {
      const mockJudge = makeMockJudge([
        { score: 0.8, pass: true, reasoning: 'Looks good' },
      ]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const result = await validateJudge('response', {
        rubric: { text: 'Is it good?' },
        reps: 1,
      });

      expect(result.details).toBeDefined();
      expect(result.details?.score).toBe(0.8);
      expect(result.details?.reasoning).toBe('Looks good');
      expect(result.details?.judgeProvider).toBe('anthropic');
      // No rep-specific fields for single rep
      expect(result.details?.scores).toBeUndefined();
      expect(result.details?.scoreStdDev).toBeUndefined();
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

    it('returns failed result when neither judge nor rubric is provided', async () => {
      const result = await validateJudge('response', {});

      expect(result.pass).toBe(false);
      expect(result.message).toContain(
        'either "judge" or "rubric" must be provided'
      );
    });
  });

  describe('named custom judges', () => {
    it('uses registered executor when judge name is provided', async () => {
      const executor = vi
        .fn()
        .mockResolvedValue({ score: 0.95, reasoning: 'Excellent' });
      mockGetRegisteredJudge.mockReturnValue(executor);

      const result = await validateJudge('some response', {
        judge: 'my-custom-judge',
      });

      expect(mockGetRegisteredJudge).toHaveBeenCalledWith('my-custom-judge');
      expect(executor).toHaveBeenCalledWith('some response', undefined);
      expect(result.pass).toBe(true);
      expect(result.message).toContain('my-custom-judge');
      expect(result.message).toContain('0.95');
    });

    it('passes reference to the executor', async () => {
      const executor = vi.fn().mockResolvedValue({ score: 1.0 });
      mockGetRegisteredJudge.mockReturnValue(executor);

      await validateJudge('candidate', {
        judge: 'ref-judge',
        reference: 'expected answer',
      });

      expect(executor).toHaveBeenCalledWith('candidate', 'expected answer');
    });

    it('applies threshold to executor score', async () => {
      // Score 0.6 should fail the default 0.7 threshold
      const executor = vi
        .fn()
        .mockResolvedValue({ score: 0.6, reasoning: 'Incomplete' });
      mockGetRegisteredJudge.mockReturnValue(executor);

      const result = await validateJudge('response', {
        judge: 'my-judge',
      });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('0.60');
      expect(result.message).toContain('0.7');
    });

    it('respects custom threshold', async () => {
      // Score 0.6 passes with threshold 0.5
      const executor = vi
        .fn()
        .mockResolvedValue({ score: 0.6, reasoning: 'Good enough' });
      mockGetRegisteredJudge.mockReturnValue(executor);

      const result = await validateJudge('response', {
        judge: 'my-judge',
        threshold: 0.5,
      });

      expect(result.pass).toBe(true);
    });

    it('same judge reusable with different thresholds', async () => {
      const executor = vi.fn().mockResolvedValue({ score: 0.75 });
      mockGetRegisteredJudge.mockReturnValue(executor);

      const strict = await validateJudge('response', {
        judge: 'completeness',
        threshold: 0.8,
      });
      const lenient = await validateJudge('response', {
        judge: 'completeness',
        threshold: 0.5,
      });

      expect(strict.pass).toBe(false);
      expect(lenient.pass).toBe(true);
    });

    it('does not call createJudge when named judge is used', async () => {
      const executor = vi.fn().mockResolvedValue({ score: 1.0 });
      mockGetRegisteredJudge.mockReturnValue(executor);

      await validateJudge('response', { judge: 'custom' });

      expect(mockCreateJudge).not.toHaveBeenCalled();
    });

    it('handles executor errors gracefully', async () => {
      mockGetRegisteredJudge.mockImplementation(() => {
        throw new Error('Judge "missing" is not registered.');
      });

      const result = await validateJudge('response', { judge: 'missing' });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('Custom judge "missing" error');
    });

    it('handles async executor rejection', async () => {
      const executor = vi.fn().mockRejectedValue(new Error('LLM API timeout'));
      mockGetRegisteredJudge.mockReturnValue(executor);

      const result = await validateJudge('response', { judge: 'flaky' });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('LLM API timeout');
    });
  });
});
