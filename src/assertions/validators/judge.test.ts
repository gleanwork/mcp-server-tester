/**
 * Judge Validator Unit Tests
 *
 * Tests for validateJudge, including the reps (multi-rep averaging) behavior.
 * The judge calls external LLM APIs so createJudge is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z, type ZodType } from 'zod';
import { validateJudge } from './judge.js';
import {
  installPlugins,
  resetPluginsForTests,
} from '../../plugins/extensions.js';
import type { JudgeDefinition } from '../../evals/evalFrameworkTypes.js';

// Mock the judgeClient module so no real LLM calls are made
vi.mock('../../judge/judgeClient.js', () => ({
  createJudge: vi.fn(),
}));

// Import after mock so we get the mocked version
import { createJudge } from '../../judge/judgeClient.js';

/** The input a matcher or `validateJudge` call gives a judge: no case, one trial. */
function matcherInput(response: string, answer?: unknown) {
  return {
    case: {
      input: {},
      expected: answer === undefined ? {} : { answer },
      tags: [],
      metadata: {},
    },
    trial: { response, text: response, events: [] },
  };
}

const mockCreateJudge = vi.mocked(createJudge);

/** Install `evaluate` as the `test/<name>` judge and return that reference. */
function installJudge(
  name: string,
  evaluate: JudgeDefinition['evaluate'],
  schema: ZodType = z.object({}).passthrough()
): string {
  installPlugins([
    {
      meta: { name: 'test-plugin', namespace: 'test' },
      judges: { [name]: { schema, evaluate } },
    },
  ]);
  return `test/${name}`;
}

afterEach(() => resetPluginsForTests());

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
      expect(result.details?.error).toBeUndefined();
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
      expect(result.message).toBe('Judge "rubric" error: API error');
      expect(result.details?.error).toBe(result.message);
    });

    it('returns failed result when neither judge nor rubric is provided', async () => {
      const result = await validateJudge('response', {});

      expect(result.pass).toBe(false);
      expect(result.message).toContain(
        'either "judge" or "rubric" must be provided'
      );
      expect(result.details?.error).toBe(result.message);
    });
  });

  describe('named custom judges', () => {
    it('uses the plugin judge when a judge name is provided', async () => {
      const evaluate = vi
        .fn()
        .mockResolvedValue({ score: 0.95, reasoning: 'Excellent' });
      const judge = installJudge('my-custom-judge', evaluate);

      const result = await validateJudge('some response', { judge });

      expect(evaluate).toHaveBeenCalledWith(matcherInput('some response'), {});
      expect(result.pass).toBe(true);
      expect(result.message).toContain('test/my-custom-judge');
      expect(result.message).toContain('0.95');
    });

    it('passes reference to the judge', async () => {
      const evaluate = vi.fn().mockResolvedValue({ score: 1.0 });
      const judge = installJudge('ref-judge', evaluate);

      await validateJudge('candidate', {
        judge,
        reference: 'expected answer',
      });

      expect(evaluate).toHaveBeenCalledWith(
        matcherInput('candidate', 'expected answer'),
        {}
      );
    });

    it('passes only explicit judge-owned options to strict schemas', async () => {
      const evaluate = vi.fn().mockResolvedValue({ score: 1 });
      const judge = installJudge('strict', evaluate, z.object({}).strict());
      const result = await validateJudge('candidate', {
        judge,
        threshold: 0.5,
        options: {},
      });
      expect(result.pass).toBe(true);
      expect(evaluate).toHaveBeenCalledWith(matcherInput('candidate'), {});
    });

    it('applies threshold to the judge score', async () => {
      // Score 0.6 should fail the default 0.7 threshold
      const evaluate = vi
        .fn()
        .mockResolvedValue({ score: 0.6, reasoning: 'Incomplete' });
      const judge = installJudge('my-judge', evaluate);

      const result = await validateJudge('response', { judge });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('0.60');
      expect(result.message).toContain('0.7');
    });

    it('respects custom threshold', async () => {
      // Score 0.6 passes with threshold 0.5
      const evaluate = vi
        .fn()
        .mockResolvedValue({ score: 0.6, reasoning: 'Good enough' });
      const judge = installJudge('my-judge', evaluate);

      const result = await validateJudge('response', {
        judge,
        threshold: 0.5,
      });

      expect(result.pass).toBe(true);
    });

    it('same judge reusable with different thresholds', async () => {
      const evaluate = vi.fn().mockResolvedValue({ score: 0.75 });
      const judge = installJudge('completeness', evaluate);

      const strict = await validateJudge('response', {
        judge,
        threshold: 0.8,
      });
      const lenient = await validateJudge('response', {
        judge,
        threshold: 0.5,
      });

      expect(strict.pass).toBe(false);
      expect(lenient.pass).toBe(true);
    });

    it('does not call createJudge when named judge is used', async () => {
      const evaluate = vi.fn().mockResolvedValue({ score: 1.0 });
      const judge = installJudge('custom', evaluate);

      await validateJudge('response', { judge });

      expect(mockCreateJudge).not.toHaveBeenCalled();
    });

    it('fails gracefully when the judge is not available', async () => {
      const result = await validateJudge('response', { judge: 'missing' });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('Judge "missing" error');
      expect(result.message).toContain('Judge "missing" is not available.');
      expect(result.details?.error).toBe(result.message);
    });

    it('treats a non-numeric score as an error, not a result', async () => {
      const judge = installJudge('nan-judge', async () => ({ score: NaN }));
      const result = await validateJudge('response', { judge });

      expect(result.pass).toBe(false);
      expect(result.details?.error).toContain('returned score NaN');
    });

    it('fails when a namespaced judge needs a plugin that is not loaded', async () => {
      const result = await validateJudge('response', { judge: 'other/x' });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('Judge "other/x" error');
      expect(result.message).toContain('needs the "other" plugin');
    });

    it('handles async judge rejection', async () => {
      const evaluate = vi.fn().mockRejectedValue(new Error('LLM API timeout'));
      const judge = installJudge('flaky', evaluate);

      const result = await validateJudge('response', { judge });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('LLM API timeout');
    });
  });

  describe('one judge contract', () => {
    it('treats a rubric as shorthand for the built-in rubric judge', async () => {
      const mockJudge = makeMockJudge([{ score: 0.8, pass: true }]);
      mockCreateJudge.mockReturnValue(mockJudge);

      const shorthand = await validateJudge('response', {
        rubric: 'correctness',
        model: 'm',
      });
      const explicit = await validateJudge('response', {
        judge: 'rubric',
        options: { rubric: 'correctness', model: 'm' },
      });

      expect(shorthand.pass).toBe(true);
      expect(shorthand.details?.judgeName).toBe('correctness');
      expect(explicit.details).toMatchObject({
        judgeName: 'correctness',
        score: 0.8,
        judgeProvider: 'anthropic',
        judgeModel: 'm',
      });
      expect(mockCreateJudge.mock.calls).toEqual([
        [{ model: 'm' }],
        [{ model: 'm' }],
      ]);
    });

    it('rejects a rubric judge option it does not know', async () => {
      const result = await validateJudge('response', {
        rubric: 'correctness',
        unknownSetting: true,
      });

      expect(result.pass).toBe(false);
      expect(result.details?.error).toContain('judge options "rubric"');
      expect(mockCreateJudge).not.toHaveBeenCalled();
    });

    it('scores a plugin judge once per rep and averages', async () => {
      const scores = [0.4, 1];
      const evaluate = vi.fn(async () => ({ score: scores.shift()! }));
      const judge = installJudge('repeated', evaluate);

      const result = await validateJudge('response', { judge, reps: 2 });

      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(result.pass).toBe(true);
      expect(result.details).toMatchObject({
        score: 0.7,
        scores: [0.4, 1],
        scoreStdDev: 0.3,
        highVariance: true,
      });
    });

    it("passes a plugin judge's flat fields to its schema", async () => {
      const evaluate = vi.fn(async () => ({ score: 1, model: 'their-model' }));
      const judge = installJudge('flat', evaluate);

      const result = await validateJudge('response', {
        judge,
        model: 'their-model',
        threshold: 0.5,
        reference: 'gold',
      });

      expect(evaluate).toHaveBeenCalledWith(matcherInput('response', 'gold'), {
        model: 'their-model',
      });
      expect(result.details?.judgeModel).toBe('their-model');
    });
  });
});
