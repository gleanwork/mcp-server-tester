/**
 * Judge contract tests: the input a judge receives and the outputs it may
 * return, through the real plugin table, validator, runner, and metrics.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { clientRunToExecution } from '../evals/clientTrace.js';
import { z } from 'zod';
import { runEvalDataset } from '../evals/evalRunner.js';
import { validateEvalDataset } from '../evals/datasetTypes.js';
import { computeMetrics } from '../evals/metrics.js';
import { validateJudge } from '../assertions/validators/judge.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import {
  buildJudgeCase,
  buildJudgeTrial,
  checkJudgeScore,
  missingRequirement,
  sumJudgeUsage,
  type JudgeInput,
  type JudgeScore,
} from './judgeContract.js';

afterEach(() => resetPluginsForTests());

/** Install `evaluate` as the judge `<name>/judge/judge`, one plugin per judge. */
function judge(
  name: string,
  evaluate: (
    input: JudgeInput,
    options: Record<string, unknown>
  ) => Promise<JudgeScore>,
  requires?: string[]
) {
  const fn = vi.fn(evaluate);
  installPlugins([
    {
      meta: { name: `${name}-plugin`, namespace: name },
      judges: {
        judge: {
          schema: z.object({}).passthrough(),
          evaluate: fn,
          ...(requires && { requires }),
        },
      },
    },
  ]);
  return fn;
}

async function run(
  cases: Array<Record<string, unknown>>,
  answer = 'the answer'
) {
  const dataset = validateEvalDataset({ name: 'contract', cases });
  return runEvalDataset(
    {
      dataset,
      executeCase: async () =>
        clientRunToExecution({ finalText: answer, events: [] }, 'structured'),
    },
    {}
  );
}

describe('buildJudgeCase', () => {
  it('maps the case to input, expected, tags, and metadata', () => {
    expect(
      buildJudgeCase({
        id: 'c',
        input: 'q',
        expected: {
          answer: 'canonical',
          criteria: { grounded: 'Cites a source' },
        },
        tags: ['t'],
        metadata: { owner: 'x' },
      })
    ).toEqual({
      id: 'c',
      input: { prompt: 'q' },
      expected: {
        answer: 'canonical',
        criteria: { grounded: 'Cites a source' },
      },
      tags: ['t'],
      metadata: { owner: 'x' },
    });
  });

  it('prefers a judge reference over expected.answer', () => {
    const source = { expected: { answer: 'e' } };
    expect(buildJudgeCase(source, 'r').expected.answer).toBe('r');
    expect(buildJudgeCase(source).expected.answer).toBe('e');
    expect(buildJudgeCase(undefined).expected).toEqual({});
  });
});

describe('buildJudgeTrial', () => {
  it('reads text, tool events, messages, and usage from a client response', () => {
    const clientResponse = {
      success: true,
      response: 'final text',
      toolCalls: [{ name: 'search', arguments: { q: 'x' }, output: 'hit' }],
      conversationHistory: [{ role: 'user' as const, content: 'q' }],
      usage: { inputTokens: 1, outputTokens: 2, durationMs: 3 },
    };
    expect(
      buildJudgeTrial(clientResponse, {
        clientResponse: clientResponse,
        evidence: 'structured',
      })
    ).toEqual({
      response: clientResponse,
      text: 'final text',
      events: [
        {
          kind: 'tool_call',
          source: 'mcp',
          name: 'search',
          arguments: { q: 'x' },
          output: 'hit',
        },
      ],
      messages: [{ role: 'user', content: 'q' }],
      evidence: 'structured',
      usage: { inputTokens: 1, outputTokens: 2, durationMs: 3 },
    });
  });

  it('keeps client events when the client reports them', () => {
    const events = [
      { kind: 'skill' as const, source: 'builtin' as const, name: 's' },
    ];
    const clientResponse = { response: 't', toolCalls: [], events };
    expect(
      buildJudgeTrial(clientResponse, { clientResponse: clientResponse }).events
    ).toBe(events);
  });

  it('reads a direct result as text with no events', () => {
    expect(
      buildJudgeTrial({ content: [{ type: 'text', text: 'tool text' }] })
    ).toMatchObject({ text: 'tool text', events: [] });
  });
});

describe('missingRequirement', () => {
  const input: JudgeInput = {
    case: buildJudgeCase({ expected: { answer: 'a', criteria: {} } }),
    trial: buildJudgeTrial('x'),
  };

  it('returns the first missing or empty path', () => {
    expect(missingRequirement(input, ['case.expected.answer'])).toBeUndefined();
    expect(
      missingRequirement(input, [
        'case.expected.answer',
        'case.expected.criteria',
      ])
    ).toBe('case.expected.criteria');
    expect(missingRequirement(input, ['case.input.prompt'])).toBe(
      'case.input.prompt'
    );
    expect(missingRequirement(input, undefined)).toBeUndefined();
  });
});

describe('checkJudgeScore', () => {
  it('derives pass from the threshold when the judge gives none', () => {
    expect(checkJudgeScore({ score: 0.6 }, 0.5).pass).toBe(true);
    expect(checkJudgeScore({ score: 0.4 }, 0.5).pass).toBe(false);
  });

  it("keeps the judge's own `pass` over the threshold", () => {
    expect(checkJudgeScore({ score: 0.9, pass: false }, 0.5).pass).toBe(false);
    expect(checkJudgeScore({ score: 0.1, pass: true }, 0.5).pass).toBe(true);
  });

  it('accepts a skip without a valid score', () => {
    expect(
      checkJudgeScore({ score: Number.NaN, skipped: true }, 0.5)
    ).toMatchObject({ pass: true, skipped: true });
  });

  it.each([
    [null, 'no score object'],
    [{ score: Number.NaN }, 'not a number'],
    [{ score: 1.5 }, 'not between 0 and 1'],
    [{ score: 1, pass: 'yes' }, '`pass` that is not a boolean'],
    [{ score: 1, subScores: { a: { score: 2 } } }, 'sub-score "a"'],
    [{ score: 1, subScores: [] }, '`subScores` that is not an object'],
  ])('rejects invalid output %j', (output, message) => {
    expect(() => checkJudgeScore(output, 0.5)).toThrow(message);
  });
});

describe('sumJudgeUsage', () => {
  it('adds only fields that some record reports', () => {
    expect(
      sumJudgeUsage([
        { inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01 },
        undefined,
        { inputTokens: 5, outputTokens: 1 },
      ])
    ).toEqual({ inputTokens: 15, outputTokens: 3, totalCostUsd: 0.01 });
    expect(sumJudgeUsage([undefined, {}])).toBeUndefined();
  });
});

describe('judge input', () => {
  it('gives a dataset judge the case and the trial, and options apart', async () => {
    const evaluate = judge('ctx', async (input) => ({
      score: input.case.expected.criteria ? 1 : 0,
    }));
    const result = await run([
      {
        id: 'with-input',
        input: 'Summarize the plan',
        expected: {
          answer: 'Three phases',
          criteria: { grounded: 'Cites the plan' },
        },
        tags: ['rubric'],
        judges: [{ type: 'ctx/judge/judge', threshold: 0.6, strict: true }],
      },
    ]);
    expect(result.passed).toBe(1);
    const [input, options] = evaluate.mock.calls[0]!;
    expect(input.case).toEqual({
      id: 'with-input',
      input: { prompt: 'Summarize the plan' },
      expected: {
        answer: 'Three phases',
        criteria: { grounded: 'Cites the plan' },
      },
      tags: ['rubric'],
      metadata: {},
    });
    expect(input.trial).toMatchObject({
      response: { response: 'the answer' },
      text: 'the answer',
    });
    // The threshold stays with the framework; options hold the judge's settings.
    expect(options).toEqual({ strict: true });
    expect(JSON.stringify(input)).not.toContain('0.6');
  });

  it('gives matcher-style calls an empty case', async () => {
    const evaluate = judge('bare', async () => ({ score: 1 }));
    await validateJudge('x', { judge: 'bare/judge/judge', reference: 'ref' });
    expect(evaluate.mock.calls[0]![0].case).toEqual({
      input: {},
      expected: { answer: 'ref' },
      tags: [],
      metadata: {},
    });
  });

  it('skips the judge without calling it when a required path is missing', async () => {
    const evaluate = judge('needs', async () => ({ score: 1 }), [
      'case.expected.criteria',
    ]);
    const result = await run([
      {
        id: 'none',
        input: 'q',
        judges: [{ type: 'needs/judge/judge' }],
      },
      {
        id: 'some',
        input: 'q',
        expected: { criteria: { c: 'x' } },
        judges: [{ type: 'needs/judge/judge' }],
      },
    ]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.caseResults[0]!.scores.judge).toMatchObject({
      skipped: true,
      pass: true,
      details: 'Judge "needs/judge/judge" skipped: no case.expected.criteria',
    });
    expect(result.caseResults[1]!.scores.judge).toMatchObject({
      score: 1,
    });
  });

  it('rejects an expected block with non-string criteria', () => {
    expect(() =>
      validateEvalDataset({
        name: 'bad',
        cases: [{ id: 'x', input: 'q', expected: { criteria: { c: 1 } } }],
      })
    ).toThrow();
  });
});

describe('judge output', () => {
  it('records sub-scores, usage, model, and metadata', async () => {
    judge('rich', async () => ({
      score: 0.5,
      pass: true,
      reasoning: 'one of two criteria met',
      subScores: {
        grounded: { score: 1, pass: true },
        concise: { score: 0, pass: false, reasoning: 'too long' },
      },
      usage: { inputTokens: 100, outputTokens: 10, totalCostUsd: 0.002 },
      model: 'judge-model',
      provider: 'judge-provider',
      metadata: { label: 'PARTIAL' },
    }));
    const result = await run([
      {
        id: 'rich',
        input: 'q',
        judges: [{ type: 'rich/judge/judge', threshold: 0.9 }],
      },
    ]);
    const caseResult = result.caseResults[0]!;
    // The judge's own `pass` wins over score 0.5 < threshold 0.9.
    expect(caseResult.pass).toBe(true);
    expect(caseResult.scores.judge).toMatchObject({
      pass: true,
      score: 0.5,
      judgeName: 'rich/judge/judge',
      judgeModel: 'judge-model',
      judgeProvider: 'judge-provider',
      subScores: { concise: { score: 0, reasoning: 'too long' } },
      usage: { inputTokens: 100, totalCostUsd: 0.002 },
      metadata: { label: 'PARTIAL' },
    });
    expect(caseResult.judgeUsage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      totalCostUsd: 0.002,
    });
    expect(result.totalJudgeUsage).toEqual(caseResult.judgeUsage);
    expect(result.totalClientUsage).toBeUndefined();
  });

  it('fails the judge assertion on an invalid output', async () => {
    judge('bad', async () => ({ score: 7 }));
    const result = await run([
      {
        id: 'bad',
        input: 'q',
        judges: [{ type: 'bad/judge/judge' }],
      },
    ]);
    expect(result.passed).toBe(0);
    expect(result.caseResults[0]!.scores.judge?.details).toContain(
      'between 0 and 1'
    );
  });

  it('excludes skipped judges from pass/fail and score metrics but keeps their usage', async () => {
    judge('needs-criteria', async (input) =>
      input.case.expected.criteria
        ? { score: 0.2, usage: { inputTokens: 7, outputTokens: 1 } }
        : {
            score: 0,
            skipped: true,
            reasoning: 'no criteria',
            usage: { inputTokens: 3, outputTokens: 0 },
          }
    );
    judge('always', async () => ({
      score: 1,
      usage: { inputTokens: 10, outputTokens: 2 },
    }));
    const judges = [
      { type: 'always/judge/judge', threshold: 0.5 },
      { type: 'needs-criteria/judge/judge', threshold: 0.5 },
    ];
    const result = await run([
      {
        id: 'no-criteria',
        input: 'q',
        judges,
      },
      {
        id: 'with-criteria',
        input: 'q',
        expected: { criteria: { c: 'x' } },
        judges,
      },
    ]);
    const [skippedCase, gradedCase] = result.caseResults;
    expect(skippedCase!.pass).toBe(true);
    expect(skippedCase!.scores.judge).toMatchObject({
      pass: true,
      details: '1/1 judges passed (1 skipped)',
    });
    const skippedEntry = skippedCase!.scores.judge?.judgeResults?.find(
      (entry) => entry.judgeName === 'needs-criteria/judge/judge'
    );
    expect(skippedEntry).toMatchObject({ skipped: true, pass: true });
    expect(skippedEntry?.score).toBeUndefined();
    expect(gradedCase!.pass).toBe(false);
    expect(skippedCase!.judgeUsage).toEqual({
      inputTokens: 13,
      outputTokens: 2,
    });
    expect(result.totalJudgeUsage).toEqual({
      inputTokens: 30,
      outputTokens: 5,
    });

    const metrics = computeMetrics(
      [
        'judge_pass',
        'judge_score',
        { type: 'judge_score_for', judge: 'needs-criteria/judge/judge' },
        'judge_input_tokens',
      ],
      result.caseResults
    );
    // Only the graded case counts toward the skipping judge's score.
    expect(metrics.aggregated).toMatchObject({
      'judge_needs_criteria/judge/judge_score_mean': 0.2,
      judge_input_tokens_mean: 15,
    });
    expect(metrics.perCase['no-criteria']).toMatchObject({
      judge_pass: true,
      judge_score: { 'always/judge/judge': 1 },
    });
  });

  it('decides a judge-owned score by majority over reps and sums usage', async () => {
    const passes = [true, false, true];
    const evaluate = judge('vote', async () => ({
      score: 0.1,
      pass: passes.shift()!,
      usage: { inputTokens: 5, outputTokens: 1 },
    }));
    const result = await validateJudge('x', {
      judge: 'vote/judge/judge',
      reps: 3,
      threshold: 0.9,
    });
    expect(evaluate).toHaveBeenCalledTimes(3);
    // 2 of 3 reps pass, though the mean score is under the threshold.
    expect(result.pass).toBe(true);
    expect(result.details).toMatchObject({
      score: 0.1,
      usage: { inputTokens: 15, outputTokens: 3 },
    });
  });

  it('fails a judge-owned score on a tie', async () => {
    const passes = [true, false];
    judge('tie', async () => ({ score: 1, pass: passes.shift()! }));
    const result = await validateJudge('x', {
      judge: 'tie/judge/judge',
      reps: 2,
    });
    expect(result.pass).toBe(false);
  });

  it('stops at the first skipped rep', async () => {
    const evaluate = judge('skip-rep', async () => ({
      score: 0,
      skipped: true,
      reasoning: 'nothing to grade',
      usage: { inputTokens: 2, outputTokens: 0 },
    }));
    const result = await validateJudge('x', {
      judge: 'skip-rep/judge/judge',
      reps: 3,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      pass: true,
      message: 'Judge "skip-rep/judge/judge" skipped: nothing to grade',
      details: { skipped: true, usage: { inputTokens: 2, outputTokens: 0 } },
    });
  });

  it('uses expected.answer as the reference', async () => {
    const evaluate = judge('answer', async () => ({ score: 1 }));
    await run([
      {
        id: 'a',
        input: 'q',
        expected: { answer: 'new' },
        judges: [{ type: 'answer/judge/judge' }],
      },
    ]);
    expect(evaluate.mock.calls[0]![0].case.expected.answer).toBe('new');
  });

  it('reports judge usage per trial over trials', async () => {
    judge('iter', async () => ({
      score: 1,
      usage: { inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01 },
    }));
    const result = await run([
      {
        id: 'iterated',
        input: 'q',
        trials: 3,
        judges: [{ type: 'iter/judge/judge' }],
      },
    ]);
    const caseResult = result.caseResults[0]!;
    expect(caseResult.trialResults?.map((i) => i.judgeUsage)).toEqual([
      { inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01 },
      { inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01 },
      { inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01 },
    ]);
    expect(caseResult.judgeUsage).toMatchObject({ inputTokens: 30 });
    const metrics = computeMetrics(
      ['judge_input_tokens', 'judge_cost_usd'],
      result.caseResults
    );
    // The mean per trial, not the sum over the case's three runs.
    expect(metrics.perCase.iterated).toMatchObject({
      judge_input_tokens: 10,
      judge_cost_usd: 0.01,
    });
  });

  it('passes a case whose only judge skipped', async () => {
    judge('skip', async () => ({ score: 0, skipped: true }));
    const result = await run([
      {
        id: 'only-skip',
        input: 'q',
        judges: [{ type: 'skip/judge/judge' }],
      },
    ]);
    expect(result.caseResults[0]!.pass).toBe(true);
    expect(result.caseResults[0]!.scores.judge).toMatchObject({
      skipped: true,
      pass: true,
    });
  });
});
