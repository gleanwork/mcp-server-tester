import { describe, it, expect } from 'vitest';
import type { EvalCaseResult, IterationResult } from '../types/reporter.js';
import type { EvalRunnerResult } from './evalRunner.js';
import {
  compareVariants,
  trialsToDetectBrokenCase,
  breaksRegressionCases,
  improvesCapabilityCases,
  holmRejected,
  measureAgainstBaseline,
  pairedChange,
  signFlipTest,
  worseCaseP,
} from './variantComparison.js';
import type { CaseGrouping } from './variantComparison.js';

type Trace = NonNullable<IterationResult['mcpHostTrace']>;

interface CaseSpec {
  id: string;
  /** One entry per trial. */
  trials: boolean[];
  tags?: string[];
  traces?: Array<Trace | undefined>;
  error?: Array<string | undefined>;
  infra?: boolean[];
  tokens?: number;
}

function caseResult(spec: CaseSpec): EvalCaseResult {
  const iterations: IterationResult[] = spec.trials.map((pass, i) => ({
    pass,
    durationMs: 1,
    ...(spec.traces?.[i] ? { mcpHostTrace: spec.traces[i] } : {}),
    ...(spec.error?.[i] ? { error: spec.error[i] } : {}),
    ...(spec.infra?.[i] ? { isInfrastructureError: true } : {}),
    ...(spec.tokens !== undefined
      ? {
          hostUsage: {
            inputTokens: spec.tokens,
            outputTokens: 0,
            durationMs: 0,
          },
        }
      : {}),
  }));
  const counted = iterations.filter((it) => !it.isInfrastructureError);
  const rate =
    counted.length > 0
      ? counted.filter((it) => it.pass).length / counted.length
      : 0;
  return {
    id: spec.id,
    datasetName: 'ds',
    toolName: 'mcp_host',
    source: 'eval',
    pass: rate === 1,
    expectations: {},
    durationMs: 1,
    tags: spec.tags,
    request: {
      scenario: `Prompt for ${spec.id}`,
      expect: { toolsTriggered: { calls: [{ name: 'search' }] } },
    },
    ...(iterations.length > 1 ? { iterationResults: iterations } : {}),
    ...(iterations.length === 1 && iterations[0]!.mcpHostTrace
      ? { mcpHostTrace: iterations[0]!.mcpHostTrace }
      : {}),
  };
}

function run(cases: CaseSpec[]): EvalRunnerResult {
  const results = cases.map(caseResult);
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    caseResults: results,
    durationMs: 1,
  };
}

const all = (pass: boolean, n = 5) => Array.from({ length: n }, () => pass);
const some = (passes: number, n = 5) =>
  Array.from({ length: n }, (_, i) => i < passes);

const searchCall: Trace = {
  calls: [{ name: 'search', arguments: {}, status: 'expected' }],
  missed: [],
};
const wrongCall: Trace = {
  calls: [{ name: 'get_status', arguments: {}, status: 'unexpected' }],
  missed: [{ name: 'search' }],
};
const noCall: Trace = { calls: [], missed: [{ name: 'search' }] };

describe('signFlipTest', () => {
  it('is exact: the share of sign flips at least as extreme', () => {
    // Three cases all better: only 1 of 8 sign assignments is as extreme.
    expect(signFlipTest([1, 1, 1])).toEqual({ pBetter: 1 / 8, pWorse: 1 });
    expect(signFlipTest([0.2, 0.4]).pBetter).toBeCloseTo(1 / 4);
    expect(signFlipTest([0.2, -0.4]).pWorse).toBeCloseTo(2 / 4);
  });

  it('ignores cases that did not change', () => {
    expect(signFlipTest([1, 0, 0, 0])).toEqual(signFlipTest([1]));
    expect(signFlipTest([0, 0])).toEqual({ pBetter: 1, pWorse: 1 });
  });

  it("is McNemar's exact test for one trial per case", () => {
    // 6 cases fixed, 1 broken: P(Binomial(7, 0.5) >= 6) = 8 / 128.
    expect(signFlipTest([1, 1, 1, 1, 1, 1, -1, 0, 0]).pBetter).toBeCloseTo(
      8 / 128
    );
  });

  it('falls back to its normal limit when exact sums would explode', () => {
    const values = Array.from({ length: 22 }, (_, i) => (i + 1) / Math.PI);
    const { pBetter, pWorse } = signFlipTest(values);
    expect(pBetter).toBeLessThan(0.001);
    expect(pWorse).toBeGreaterThan(0.999);
  });
});

describe('trialsToDetectBrokenCase', () => {
  it('grows with the number of regression cases checked', () => {
    // 5/5 to 0/5 gives p = 1/252 = 0.004: enough for up to 12 cases.
    expect(trialsToDetectBrokenCase(1)).toBe(4);
    expect(trialsToDetectBrokenCase(12)).toBe(5);
    expect(trialsToDetectBrokenCase(13)).toBe(6);
    expect(trialsToDetectBrokenCase(100)).toBe(7);
  });
});

describe('holmRejected', () => {
  it('steps down until a p-value misses its threshold', () => {
    const tests = [
      { id: 'a', p: 0.01 },
      { id: 'b', p: 0.04 },
      { id: 'c', p: 0.03 },
    ];
    // 0.01 < 0.05/3, then 0.03 >= 0.05/2: stop.
    expect(holmRejected(tests, 0.05)).toEqual(['a']);
    expect(holmRejected([{ id: 'a', p: 0.04 }], 0.05)).toEqual(['a']);
    expect(holmRejected([], 0.05)).toEqual([]);
  });
});

describe('pairedChange', () => {
  it('spans every possible difference with fewer than two cases', () => {
    expect(pairedChange([])).toMatchObject({
      mean: 0,
      lower: -1,
      upper: 1,
      cases: 0,
      assessment: 'unclear',
    });
    expect(pairedChange([0.4])).toMatchObject({
      mean: 0.4,
      lower: -1,
      upper: 1,
      cases: 1,
      assessment: 'unclear',
    });
  });

  it('uses a t-interval over cases for display', () => {
    // mean 0.4, sd 0.2, n 3: margin = 4.303 * 0.2 / sqrt(3)
    const change = pairedChange([0.2, 0.4, 0.6]);
    expect(change.mean).toBeCloseTo(0.4);
    expect(change.lower).toBeCloseTo(0.4 - (4.303 * 0.2) / Math.sqrt(3));
    expect(change.upper).toBeCloseTo(0.4 + (4.303 * 0.2) / Math.sqrt(3));
  });

  it("won't call a change clear from too few cases, even with no spread", () => {
    // The t-interval collapses to [1, 1], but 3 cases can't show much.
    const change = pairedChange([1, 1, 1]);
    expect([change.lower, change.upper]).toEqual([1, 1]);
    expect(change.pBetter).toBe(1 / 8);
    expect(change.assessment).toBe('unclear');
  });

  it('adjusts "better" for the number of variants tried', () => {
    // 6 cases all better: p = 1/64 = 0.016.
    const six = [1, 1, 1, 1, 1, 1];
    expect(pairedChange(six).assessment).toBe('better');
    expect(pairedChange(six, 3).assessment).toBe('unclear');
    // "Worse" is never relaxed by trying more variants.
    expect(
      pairedChange(
        six.map((d) => -d),
        3
      ).assessment
    ).toBe('worse');
  });

  it('clamps the interval to the range of possible differences', () => {
    const change = pairedChange([1, -1]);
    expect(change.lower).toBe(-1);
    expect(change.upper).toBe(1);
  });
});

describe('measureAgainstBaseline', () => {
  const regression = ['regression'];
  const declared: { grouping: CaseGrouping } = {
    grouping: { source: 'declared', tag: 'regression' },
  };
  const baseline = run([
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `fix-${i}`,
      trials: all(false),
      ...(i === 5 ? { tags: ['held-out'] } : {}),
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `keep-${i}`,
      trials: all(true),
      tags: regression,
    })),
  ]);
  const candidateWith = (
    fix: (i: number) => boolean[],
    keep: (i: number) => boolean[]
  ) =>
    run([
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `fix-${i}`,
        trials: fix(i),
        ...(i === 5 ? { tags: ['held-out'] } : {}),
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `keep-${i}`,
        trials: keep(i),
        tags: regression,
      })),
    ]);

  it('groups cases by the declared regression tag', () => {
    const m = measureAgainstBaseline(baseline, baseline, declared);
    expect(m.capability.cases).toBe(6);
    expect(m.regression.cases).toBe(8);
    expect(m.regression.change?.mean).toBe(0);
  });

  it('groups cases by a separate grouping run when none are declared', () => {
    const groupingRun = run([
      { id: 'fix-0', trials: all(true) },
      { id: 'keep-0', trials: some(4) },
    ]);
    const m = measureAgainstBaseline(baseline, baseline, {
      grouping: { source: 'grouping-run', run: groupingRun },
    });
    // Only fix-0 passed the grouping run; the baseline's own results don't count.
    expect(m.regression.cases).toBe(1);
    expect(m.capability.cases).toBe(13);
  });

  it('splits seen and held-out pass rates and checks held-out on its own', () => {
    const m = measureAgainstBaseline(
      baseline,
      candidateWith(
        (i) => (i === 5 ? some(2) : all(true)),
        () => all(true)
      ),
      declared
    );
    expect(m.capability.seenPassRate).toBe(1);
    expect(m.capability.heldOutPassRate).toBeCloseTo(0.4);
    expect(m.capability.heldOutChange).toMatchObject({
      cases: 1,
      assessment: 'unclear',
    });
  });

  it('treats one slipped trial on a working case as noise', () => {
    const m = measureAgainstBaseline(
      baseline,
      candidateWith(
        () => all(true),
        (i) => (i === 0 ? some(4) : all(true))
      ),
      declared
    );
    expect(m.regression.change?.assessment).toBe('unclear');
    expect(m.brokenCaseIds).toEqual([]);
    expect(breaksRegressionCases(m)).toBe(false);
    expect(improvesCapabilityCases(m)).toBe(true);
  });

  it('flags a clear drop across working cases', () => {
    const m = measureAgainstBaseline(
      baseline,
      candidateWith(
        () => all(true),
        (i) => (i < 6 ? some(3) : all(true))
      ),
      declared
    );
    expect(m.regression.change?.assessment).toBe('worse');
    expect(breaksRegressionCases(m)).toBe(true);
  });

  it('flags one working case that broke outright, even within group noise', () => {
    const m = measureAgainstBaseline(
      baseline,
      candidateWith(
        () => all(true),
        (i) => (i === 0 ? all(false) : all(true))
      ),
      declared
    );
    expect(m.regression.change?.assessment).toBe('unclear');
    // p = 1/252 = 0.004, below Holm's 0.05 / 8 = 0.00625.
    expect(m.brokenCaseIds).toEqual(['keep-0']);
    expect(breaksRegressionCases(m)).toBe(true);
  });

  it('corrects single-case breakage for the number of cases checked', () => {
    const slipTo = (passes: number) =>
      measureAgainstBaseline(
        baseline,
        candidateWith(
          () => all(true),
          (i) => (i === 0 ? some(passes) : all(true))
        ),
        declared
      ).brokenCaseIds;
    // 5/5 to 1/5 gives p = 0.024: real for one case, not among 8.
    expect(slipTo(1)).toEqual([]);
    const alone = (passes: number) =>
      measureAgainstBaseline(
        run([{ id: 'k', trials: all(true), tags: regression }]),
        run([{ id: 'k', trials: some(passes), tags: regression }]),
        declared
      ).brokenCaseIds;
    expect(alone(1)).toEqual(['k']);
    expect(alone(2)).toEqual([]);
  });

  it('computes the one-sided Fisher exact p-value', () => {
    expect(worseCaseP(5, 5, 4, 5)).toBeCloseTo(0.5);
    expect(worseCaseP(5, 5, 1, 5)).toBeCloseTo(6 / 252);
    expect(worseCaseP(5, 5, 0, 5)).toBeCloseTo(1 / 252);
    expect(worseCaseP(10, 10, 6, 10)).toBeCloseTo(8008 / 184756);
    expect(worseCaseP(3, 5, 5, 5)).toBeCloseTo(1);
  });

  it('leaves out infrastructure failures, as the runner does', () => {
    const base = run([{ id: 'c', trials: [false, false] }]);
    const candidate = run([
      { id: 'c', trials: [true, false], infra: [false, true] },
    ]);
    expect(
      measureAgainstBaseline(base, candidate, declared).capability.passRate
    ).toBe(1);
  });
});

/**
 * Calibration: simulated experiments where the truth is known. These pin the
 * error rates the report's assessments imply, so a change to the statistics
 * can't quietly start overstating results.
 */
describe('calibration', () => {
  let seed = 1;
  function rand(): number {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  /** One run of cases with the given true per-trial pass rates. */
  function draw(rates: number[], trials = 5): EvalRunnerResult {
    return run(
      rates.map((p, i) => ({
        id: `c${i}`,
        trials: Array.from({ length: trials }, () => rand() < p),
      }))
    );
  }
  // Tool-selection cases of mixed reliability: some solid, some flaky,
  // some mostly failing.
  const mixed = [
    ...Array<number>(8).fill(0.97),
    ...Array<number>(6).fill(0.85),
    ...Array<number>(6).fill(0.6),
    ...Array<number>(8).fill(0.1),
  ];
  const sims = 300;

  function rates(candidateRates: number[], groupBy: 'separate' | 'same') {
    let breaks = 0;
    let fixes = 0;
    for (let s = 0; s < sims; s++) {
      const baseline = draw(mixed);
      const groupingRun = groupBy === 'separate' ? draw(mixed) : baseline;
      const m = measureAgainstBaseline(baseline, draw(candidateRates), {
        grouping: { source: 'grouping-run', run: groupingRun },
      });
      if (breaksRegressionCases(m)) breaks++;
      if (improvesCapabilityCases(m)) fixes++;
    }
    return { breaks: breaks / sims, fixes: fixes / sims };
  }

  it('rarely calls an identical variant better or broken', () => {
    seed = 1;
    const { breaks, fixes } = rates(mixed, 'separate');
    // Nominal: "better" 2.5%; "broken" at most 2.5% (group) + 5% (cases).
    expect(fixes).toBeLessThan(0.05);
    expect(breaks).toBeLessThan(0.075);
  });

  it('would overstate results if groups came from the compared run', () => {
    // Why grouping uses a separate run: regression to the mean.
    seed = 1;
    const { breaks, fixes } = rates(mixed, 'same');
    // With a separate grouping run these are about 0.3% and 1%.
    expect(breaks).toBeGreaterThan(0.04);
    expect(fixes).toBeGreaterThan(0.06);
  });

  it('still finds a real improvement most of the time', () => {
    seed = 2;
    const better = mixed.map((p) => (p === 0.1 ? 0.8 : p));
    const { breaks, fixes } = rates(better, 'separate');
    expect(fixes).toBeGreaterThan(0.75);
    expect(breaks).toBeLessThan(0.075);
  });
});

describe('compareVariants', () => {
  const grouping: CaseGrouping = { source: 'declared', tag: 'regression' };
  const baseline = run([
    {
      id: 'find-doc',
      trials: all(false, 3),
      traces: [noCall, noCall, wrongCall],
      tokens: 100,
    },
    {
      id: 'live-status',
      trials: all(true, 3),
      tags: ['regression'],
      traces: [searchCall, searchCall, searchCall],
      tokens: 100,
    },
  ]);
  const better = run([
    {
      id: 'find-doc',
      trials: [true, true, false],
      traces: [searchCall, searchCall, searchCall],
      tokens: 300,
    },
    {
      id: 'live-status',
      trials: [true, false, true],
      tags: ['regression'],
      traces: [searchCall, wrongCall, searchCall],
      error: [undefined, undefined, undefined],
      tokens: 300,
    },
  ]);

  const data = compareVariants({
    baseline,
    candidates: [
      {
        id: 'v1',
        description: 'Scoped search',
        tools: { search: { description: 'Search company docs.' } },
        result: better,
        fixes: true,
        disqualified: false,
      },
    ],
    winnerId: 'v1',
    regressionCheck: 'significant',
    grouping,
    originalTools: { search: { description: 'Fetch an object by key.' } },
  });

  it('lists the baseline first, then each candidate', () => {
    expect(data.baselineId).toBe('baseline');
    expect(data.variants.map((v) => v.id)).toEqual(['baseline', 'v1']);
    expect(data.variants[0]!.status).toBe('baseline');
    expect(data.variants[0]!.checks).toBeUndefined();
    expect(data.variants[1]!.status).toBe('recommended');
    expect(data.recommendedId).toBe('v1');
    expect(data.trialsPerCase).toBe(3);
  });

  it('records how it judged the variants', () => {
    expect(data).toMatchObject({
      grouping: 'declared',
      regressionTag: 'regression',
      alpha: 0.025,
      variantsTried: 1,
      caseAlpha: 0.05,
    });
    expect(data.cases.map((c) => c.group)).toEqual([
      'capability',
      'regression',
    ]);
  });

  it('records every trial per case and variant', () => {
    const findDoc = data.cases.find((c) => c.id === 'find-doc')!;
    expect(findDoc.group).toBe('capability');
    expect(findDoc.input).toBe('Prompt for find-doc');
    expect(findDoc.expectedTools).toEqual(['search']);
    expect(findDoc.trials.baseline!.map((a) => a.failure)).toEqual([
      'no-tool-call',
      'no-tool-call',
      'wrong-tool',
    ]);
    expect(findDoc.trials.v1![2]).toMatchObject({
      pass: false,
      failure: 'check-failed',
      calls: ['search'],
    });
  });

  it('counts improved, regressed and unsteady cases', () => {
    const v1 = data.variants[1]!;
    expect(v1.improvedCaseIds).toEqual(['find-doc']);
    expect(v1.regressedCaseIds).toEqual(['live-status']);
    expect(v1.unsteadyCaseIds).toEqual(['find-doc', 'live-status']);
  });

  it('totals failures and groups tool mistakes', () => {
    const base = data.variants[0]!;
    expect(base.failures).toEqual({
      'no-tool-call': 2,
      'wrong-tool': 1,
      'check-failed': 0,
      error: 0,
    });
    expect(base.mistakes[0]).toEqual({
      called: null,
      expected: ['search'],
      calledExpected: false,
      trials: 2,
      caseIds: ['find-doc'],
    });
    const v1 = data.variants[1]!;
    expect(v1.failedTrials).toBe(2);
    expect(v1.meanTokensPerTrial).toBe(300);
    expect(v1.meanToolCallsPerTrial).toBe(1);
  });

  it('shows what each variant changed, next to the original', () => {
    expect(data.variants[1]!.toolChanges).toEqual([
      {
        tool: 'search',
        field: 'description',
        before: 'Fetch an object by key.',
        after: 'Search company docs.',
      },
    ]);
  });

  it('renames the baseline when a candidate already uses its id', () => {
    const clash = compareVariants({
      baseline,
      candidates: [
        {
          id: 'baseline',
          tools: {},
          result: better,
          fixes: false,
          disqualified: false,
        },
      ],
      regressionCheck: 'any-case',
      grouping,
    });
    expect(clash.baselineId).toBe('_baseline');
    expect(clash.variants[1]!.status).toBe('no-change');
  });

  it('marks disqualified candidates as breaking cases', () => {
    const broken = compareVariants({
      baseline,
      candidates: [
        {
          id: 'v2',
          tools: {},
          result: better,
          fixes: true,
          disqualified: true,
        },
      ],
      regressionCheck: 'any-case',
      grouping,
    });
    expect(broken.variants[1]!.status).toBe('breaks');
    expect(broken.variants[1]!.checks).toEqual({
      fixes: true,
      keepsRegressions: false,
    });
  });
});
