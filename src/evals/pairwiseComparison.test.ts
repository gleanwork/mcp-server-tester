import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import { assertPlugin } from '../plugins/plugin.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type {
  PairwiseJudgeDefinition,
  PairwiseJudgeInput,
  PairwiseVerdict,
} from '../judge/pairwiseContract.js';
import { comparePairwise, getPairwiseJudge } from './pairwiseComparison.js';

function result(
  id: string,
  text: string,
  extra: Partial<EvalCaseResult> = {}
): EvalCaseResult {
  return {
    id,
    datasetName: 'd',
    toolName: '',
    source: 'eval',
    pass: true,
    expectations: {},
    durationMs: 1,
    request: { input: `q-${id}` },
    response: { response: text, events: [] },
    ...extra,
  } as EvalCaseResult;
}

function install(judges: Record<string, PairwiseJudgeDefinition>) {
  installPlugins([
    { meta: { name: 'p', namespace: 'p' }, pairwiseJudges: judges },
  ]);
}

// Prefers the longer answer; the score scale is the length difference.
function longer(calls: PairwiseJudgeInput[] = []): PairwiseJudgeDefinition {
  return {
    schema: z.object({}).strict(),
    compare: async (input) => {
      calls.push(input);
      const b = input.baseline.text.length;
      const c = input.candidate.text.length;
      return {
        preference: c > b ? 'candidate' : b > c ? 'baseline' : 'tie',
        strength: Math.min(1, Math.abs(c - b) / 10),
        usage: { inputTokens: 10, outputTokens: 1, totalCostUsd: 0.01 },
        version: 'v1',
      };
    },
  };
}

afterEach(() => resetPluginsForTests());

describe('comparePairwise', () => {
  it('compares matched cases in both orders and reports a candidate win rate', async () => {
    const calls: PairwiseJudgeInput[] = [];
    install({ longer: longer(calls) });
    const out = await comparePairwise({
      baseline: {
        name: 'control',
        caseResults: [
          result('a', 'short'),
          result('b', 'a much longer answer'),
          result('c', 'same'),
          result('x', 'only base'),
        ],
      },
      candidate: {
        name: 'treatment',
        caseResults: [
          result('a', 'a much longer answer'),
          result('b', 'short'),
          result('c', 'same'),
          result('y', 'only cand'),
        ],
      },
      judges: [{ type: 'p/longer' }],
    });
    expect(out.baseline).toBe('control');
    expect(out.unmatched).toEqual({
      baselineOnly: ['x'],
      candidateOnly: ['y'],
    });
    expect(
      out.cases.map((c) => [
        c.id,
        c.verdicts[0]!.preference,
        c.verdicts[0]!.consistent,
      ])
    ).toEqual([
      ['a', 'candidate', true],
      ['b', 'baseline', true],
      ['c', 'tie', true],
    ]);
    // 3 cases x 2 orders; the swapped call sees the runs exchanged.
    expect(calls).toHaveLength(6);
    expect(calls[1]!.baseline.text).toBe(calls[0]!.candidate.text);
    expect(calls[0]!.case.input.prompt).toBe('q-a');
    const [summary] = out.summary;
    expect(summary).toMatchObject({
      judge: 'p/longer',
      compared: 3,
      candidateWins: 1,
      baselineWins: 1,
      ties: 1,
      candidateWinRate: 0.5,
      consistency: 1,
    });
    expect(summary!.usage?.totalCostUsd).toBeCloseTo(0.06);
    expect(out.cases[0]!.verdicts[0]).toMatchObject({
      version: 'v1',
      strength: 1,
    });
  });

  it('a judge with position bias is reconciled to a tie and marked inconsistent', async () => {
    install({
      first: {
        schema: z.object({}),
        compare: async () => ({ preference: 'baseline' }),
      },
    });
    const out = await comparePairwise({
      baseline: { caseResults: [result('a', '1')] },
      candidate: { caseResults: [result('a', '2')] },
      judges: [{ type: 'p/first' }],
    });
    expect(out.cases[0]!.verdicts[0]).toMatchObject({
      preference: 'tie',
      consistent: false,
    });
    expect(out.summary[0]).toMatchObject({ ties: 1, consistency: 0 });
  });

  it('a judge may opt out of swapping and use reps', async () => {
    let n = 0;
    install({
      once: {
        schema: z.object({}),
        swapPositions: false,
        compare: async () => ({
          preference: n++ % 3 === 2 ? 'baseline' : 'candidate',
        }),
      },
    });
    const out = await comparePairwise({
      baseline: { caseResults: [result('a', '1')] },
      candidate: { caseResults: [result('a', '2')] },
      judges: [{ type: 'p/once', reps: 3 }],
    });
    expect(n).toBe(3);
    expect(out.cases[0]!.verdicts[0]!.preference).toBe('candidate');
    expect(out.cases[0]!.verdicts[0]!.consistent).toBeUndefined();
  });

  it('skips cases missing required ground truth, and uses dataset cases for it', async () => {
    const calls: PairwiseJudgeInput[] = [];
    install({
      oracle: { ...longer(calls), requires: ['case.expected.answer'] },
    });
    const out = await comparePairwise({
      baseline: { caseResults: [result('a', '1'), result('b', '1')] },
      candidate: { caseResults: [result('a', '22'), result('b', '22')] },
      judges: [{ type: 'p/oracle' }],
      cases: new Map([
        ['a', { input: 'dataset q', expected: { answer: 'gold' } }],
      ]),
    });
    expect(out.cases.map((c) => c.verdicts[0]!.skipped ?? false)).toEqual([
      false,
      true,
    ]);
    expect(out.cases[1]!.verdicts[0]!.reasoning).toBe(
      'no case.expected.answer'
    );
    expect(calls[0]!.case).toMatchObject({
      id: 'a',
      input: { prompt: 'dataset q' },
      expected: { answer: 'gold' },
    });
    expect(out.summary[0]).toMatchObject({
      compared: 1,
      skipped: 1,
      candidateWinRate: 1,
    });
  });

  it('a judge skip or error is recorded, not a preference', async () => {
    install({
      picky: {
        schema: z.object({}),
        compare: async (input) => {
          if (input.baseline.text === 'none')
            return {
              preference: 'tie',
              skipped: true,
              reasoning: 'no evidence',
            } satisfies PairwiseVerdict;
          if (input.baseline.text === 'bad' || input.candidate.text === 'bad')
            return { preference: 'nope' } as never;
          throw new Error('provider down');
        },
      },
    });
    const out = await comparePairwise({
      baseline: {
        caseResults: [
          result('a', 'none'),
          result('b', 'bad'),
          result('c', 'x'),
        ],
      },
      candidate: {
        caseResults: [result('a', 'y'), result('b', 'y'), result('c', 'y')],
      },
      judges: [{ type: 'p/picky' }],
    });
    expect(out.cases.map((c) => c.verdicts[0])).toMatchObject([
      { skipped: true, reasoning: 'no evidence' },
      { error: 'returned preference nope' },
      { error: 'provider down' },
    ]);
    expect(out.summary[0]).toMatchObject({
      compared: 0,
      skipped: 1,
      errors: 2,
    });
    expect(out.summary[0]!.candidateWinRate).toBeUndefined();
  });

  it('reports per-dimension win rates, flipping swapped dimensions back', async () => {
    install({
      multi: {
        schema: z.object({}),
        compare: async (input) => {
          const candidateIsNew = input.candidate.text === 'new';
          const winner = candidateIsNew ? 'candidate' : 'baseline';
          return {
            preference: winner,
            dimensions: {
              correctness: {
                preference: winner,
                candidate: { score: candidateIsNew ? 0.9 : 0.4 },
              },
              readiness: { preference: 'tie' },
            },
          };
        },
      },
    });
    const out = await comparePairwise({
      baseline: { caseResults: [result('a', 'old')] },
      candidate: { caseResults: [result('a', 'new')] },
      judges: [{ type: 'p/multi' }],
    });
    const verdict = out.cases[0]!.verdicts[0]!;
    expect(verdict).toMatchObject({
      preference: 'candidate',
      consistent: true,
    });
    expect(verdict.dimensions?.correctness).toMatchObject({
      preference: 'candidate',
      candidate: { score: 0.9 },
    });
    expect(out.summary[0]!.dimensions).toEqual({
      correctness: { compared: 1, candidateWinRate: 1 },
      readiness: { compared: 1, candidateWinRate: 0.5 },
    });
  });

  it('validates options and names unknown judges', async () => {
    install({
      strict: {
        schema: z.object({ mode: z.enum(['a']) }).strict(),
        compare: async () => ({ preference: 'tie' }),
      },
    });
    await expect(
      comparePairwise({
        baseline: { caseResults: [] },
        candidate: { caseResults: [] },
        judges: [{ type: 'p/strict', options: { mode: 'b' } }],
      })
    ).rejects.toThrow(/pairwise judge options "p\/strict"/);
    expect(() => getPairwiseJudge('p/missing')).toThrow(
      /Pairwise judge "p\/missing" is not available/
    );
    expect(() => getPairwiseJudge('q/any')).toThrow(/needs the "q" plugin/);
  });
});

describe('pairwise judge plugins', () => {
  it('a pairwise judge needs a schema and a compare function', () => {
    expect(() =>
      assertPlugin(
        {
          meta: { name: 'x', namespace: 'x' },
          pairwiseJudges: { j: { schema: z.object({}) } },
        },
        'inline'
      )
    ).toThrow(/pairwiseJudges\.j needs a compare function/);
  });
});
