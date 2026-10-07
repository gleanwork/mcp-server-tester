import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvalRunnerResult, EvalContext } from './evalRunner.js';
import type { EvalDataset } from './datasetTypes.js';
import type { ToolOverrideVariant } from './evalRunner.js';
import type { MCPToolOptimizationData } from '../types/reporter.js';

const mocks = vi.hoisted(() => ({ runEvalDataset: vi.fn() }));
vi.mock('./evalRunner.js', () => ({ runEvalDataset: mocks.runEvalDataset }));

import { runToolOptimization } from './toolOptimization.js';

interface CaseSpec {
  id: string;
  pass: boolean;
  tags?: string[];
}

const REGRESSION = ['regression'];

/** `n` capability cases `f1`..`fn`. */
function caps(n: number, pass: boolean | ((i: number) => boolean)): CaseSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${i + 1}`,
    pass: typeof pass === 'function' ? pass(i) : pass,
  }));
}

/** A declared regression case. */
function reg(id: string, pass: boolean): CaseSpec {
  return { id, pass, tags: REGRESSION };
}

function makeResult(
  cases: CaseSpec[],
  metrics?: { f1?: number; precision?: number; recall?: number }
): EvalRunnerResult {
  return {
    total: cases.length,
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass).length,
    caseResults: cases.map((c) => ({
      id: c.id,
      datasetName: 'ds',
      toolName: 't',
      source: 'eval' as const,
      pass: c.pass,
      scores: {},
      durationMs: 1,
      ...(c.tags ? { tags: c.tags } : {}),
    })),
    durationMs: 1,
    datasetToolF1: metrics?.f1,
    datasetToolPrecision: metrics?.precision,
    datasetToolRecall: metrics?.recall,
  };
}

/**
 * Wire the mocked runner to return a canned result keyed by variant id. The
 * first run without overrides is `__baseline__`; a second (the grouping run)
 * is `__grouping__`, falling back to `__baseline__`.
 */
function setRuns(map: Record<string, EvalRunnerResult>): void {
  let baselineRuns = 0;
  mocks.runEvalDataset.mockImplementation(
    async (opts: { toolOverrides?: ToolOverrideVariant }) => {
      let key = opts.toolOverrides?.id;
      if (key === undefined) {
        baselineRuns++;
        key =
          baselineRuns > 1 && map.__grouping__
            ? '__grouping__'
            : '__baseline__';
      }
      const result = map[key];
      if (!result) {
        throw new Error(`no mock run registered for "${key}"`);
      }
      return result;
    }
  );
}

function variant(id: string): ToolOverrideVariant {
  return { id, tools: { search: { description: `desc for ${id}` } } };
}

const dataset: EvalDataset = { name: 'experiment-test', cases: [] };
const context = { mcp: {}, testInfo: undefined } as unknown as EvalContext;

beforeEach(() => {
  mocks.runEvalDataset.mockReset();
});

describe('runToolOptimization — single round', () => {
  it('ranks candidates by passRate and proposes applying the best', async () => {
    setRuns({
      __baseline__: makeResult([reg('r1', true), ...caps(8, false)]),
      vA: makeResult([reg('r1', true), ...caps(8, (i) => i < 4)]),
      vB: makeResult([reg('r1', true), ...caps(8, true)]),
    });

    const result = await runToolOptimization(
      { dataset, variants: [variant('vA'), variant('vB')] },
      context
    );

    expect(result.winner?.variant.id).toBe('vB');
    expect(result.proposal?.recommendation).toBe('apply');
    expect(result.proposal?.delta).toBeCloseTo(8 / 9);
    expect(result.proposal?.improvedCaseIds).toHaveLength(8);
    expect(result.proposal?.regressedCaseIds).toEqual([]);
    expect(result.grouping).toBe('declared');
    // baseline + 2 candidates; declared groups need no grouping run
    expect(mocks.runEvalDataset).toHaveBeenCalledTimes(3);
  });

  it('needs enough cases to call an improvement clear', async () => {
    // Two of two failing cases fixed is a 1-in-4 chance under no effect.
    setRuns({
      __baseline__: makeResult([reg('r1', true), ...caps(2, false)]),
      v: makeResult([reg('r1', true), ...caps(2, true)]),
    });
    const result = await runToolOptimization(
      { dataset, variants: [variant('v')] },
      context
    );
    expect(result.winner?.variant.id).toBe('v');
    expect(result.winner?.improvement.pBetter).toBeCloseTo(1 / 4);
    expect(result.winner?.fixes).toBe(false);
    expect(result.proposal?.recommendation).toBe('inconclusive');
  });

  it('disqualifies a regressing candidate and recommends rejecting it', async () => {
    setRuns({
      __baseline__: makeResult([reg('c1', true), ...caps(8, false)]),
      // improves every failing case but breaks c1
      vReg: makeResult([reg('c1', false), ...caps(8, true)]),
    });

    // One trial per case can't tell a broken case from a flaky one, so
    // this uses the strict rule; see the regressionCheck tests for trials.
    const result = await runToolOptimization(
      { dataset, variants: [variant('vReg')], regressionCheck: 'any-case' },
      context
    );

    expect(result.winner).toBeUndefined();
    expect(result.rounds[0]?.candidates[0]?.disqualified).toBe(true);
    expect(result.proposal?.recommendation).toBe('reject');
    expect(result.proposal?.regressedCaseIds).toEqual(['c1']);
  });

  it('allows regressions when opted in', async () => {
    setRuns({
      __baseline__: makeResult([reg('c1', true), ...caps(8, false)]),
      vReg: makeResult([reg('c1', false), ...caps(8, true)]),
    });

    const result = await runToolOptimization(
      {
        dataset,
        variants: [variant('vReg')],
        regressionCheck: 'any-case',
        allowRegressions: true,
      },
      context
    );

    expect(result.winner?.variant.id).toBe('vReg');
    expect(result.proposal?.recommendation).toBe('apply');
    expect(result.proposal?.regressedCaseIds).toEqual(['c1']);
  });

  it('reports inconclusive when nothing beats baseline', async () => {
    const baseline = makeResult([
      { id: 'c1', pass: true },
      { id: 'c2', pass: false },
    ]);
    setRuns({ __baseline__: baseline, vSame: baseline });

    const result = await runToolOptimization(
      { dataset, variants: [variant('vSame')] },
      context
    );

    expect(result.winner?.variant.id).toBe('vSame');
    expect(result.proposal?.recommendation).toBe('inconclusive');
    expect(result.proposal?.delta).toBe(0);
  });

  it('returns reason "no-variants" when no candidates are provided', async () => {
    setRuns({ __baseline__: makeResult([{ id: 'c1', pass: true }]) });

    const result = await runToolOptimization(
      { dataset, variants: [] },
      context
    );

    expect(result.reason).toBe('no-variants');
    expect(result.winner).toBeUndefined();
    expect(result.proposal).toBeUndefined();
    // only the baseline run
    expect(mocks.runEvalDataset).toHaveBeenCalledTimes(1);
  });
});

describe('runToolOptimization — metric selection', () => {
  it('ranks by toolF1 when requested', async () => {
    setRuns({
      __baseline__: makeResult([{ id: 'c1', pass: true }], { f1: 0.5 }),
      vLow: makeResult([{ id: 'c1', pass: true }], { f1: 0.6 }),
      vHigh: makeResult([{ id: 'c1', pass: true }], { f1: 0.9 }),
    });

    const result = await runToolOptimization(
      {
        dataset,
        metric: 'toolF1',
        variants: [variant('vLow'), variant('vHigh')],
      },
      context
    );

    expect(result.metric).toBe('toolF1');
    expect(result.winner?.variant.id).toBe('vHigh');
    expect(result.proposal?.candidateValue).toBeCloseTo(0.9);
  });

  it('throws a clear error when a tool metric is unavailable in the baseline', async () => {
    setRuns({ __baseline__: makeResult([{ id: 'c1', pass: true }]) });

    await expect(
      runToolOptimization(
        { dataset, metric: 'toolF1', variants: [variant('vA')] },
        context
      )
    ).rejects.toThrow(/Metric 'toolF1' is unavailable/);
  });
});

describe('runToolOptimization — multi-round proposeVariants', () => {
  it('threads history and bestSoFar into the callback', async () => {
    setRuns({
      __baseline__: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: false },
      ]),
      r0: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: true },
      ]),
      r1: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: true },
      ]),
    });

    const seen: Array<{ round: number; historyLen: number; best?: string }> =
      [];
    const proposeVariants = vi.fn(async (ctx) => {
      seen.push({
        round: ctx.round,
        historyLen: ctx.history.length,
        best: ctx.bestSoFar?.variant.id,
      });
      return ctx.round === 0 ? [variant('r0')] : [];
    });

    await runToolOptimization(
      { dataset, proposeVariants, maxRounds: 2 },
      context
    );

    expect(seen[0]).toEqual({ round: 0, historyLen: 0, best: undefined });
    expect(seen[1]).toEqual({ round: 1, historyLen: 1, best: 'r0' });
  });

  it('stops with "no-improvement" when a round fails to clear minImprovement', async () => {
    setRuns({
      __baseline__: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: false },
        { id: 'c3', pass: false },
      ]),
      // 2/3 -> clears the first round
      first: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: true },
        { id: 'c3', pass: false },
      ]),
      // also 2/3 -> no further improvement
      second: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: true },
        { id: 'c3', pass: false },
      ]),
    });

    const proposeVariants = vi.fn(async (ctx) =>
      ctx.round === 0 ? [variant('first')] : [variant('second')]
    );

    const result = await runToolOptimization(
      { dataset, proposeVariants, maxRounds: 5, minImprovement: 0.2 },
      context
    );

    expect(result.reason).toBe('no-improvement');
    expect(result.rounds).toHaveLength(2);
    expect(result.winner?.variant.id).toBe('first');
  });

  it('stops with "max-rounds" when the budget is exhausted while still improving', async () => {
    setRuns({
      __baseline__: makeResult([
        { id: 'c1', pass: false },
        { id: 'c2', pass: false },
      ]),
      a: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: false },
      ]),
      b: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: true },
      ]),
    });

    const proposeVariants = vi.fn(async (ctx) =>
      ctx.round === 0 ? [variant('a')] : [variant('b')]
    );

    const result = await runToolOptimization(
      { dataset, proposeVariants, maxRounds: 2 },
      context
    );

    expect(result.reason).toBe('max-rounds');
    expect(result.rounds).toHaveLength(2);
    expect(result.winner?.variant.id).toBe('b');
  });

  it('uses static variants in round 0 and the callback for later rounds', async () => {
    setRuns({
      __baseline__: makeResult([{ id: 'c1', pass: false }]),
      staticA: makeResult([{ id: 'c1', pass: true }]),
    });

    const proposeVariants = vi.fn(async () => []);

    const result = await runToolOptimization(
      {
        dataset,
        variants: [variant('staticA')],
        proposeVariants,
        maxRounds: 3,
      },
      context
    );

    // Round 0 used the static variant; round 1 asked the callback, got [], stopped.
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.candidates[0]?.variant.id).toBe('staticA');
    expect(proposeVariants).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('no-improvement');
  });
});

describe('runToolOptimization — reporter integration', () => {
  it('attaches winner results and an optimization summary when testInfo is present', async () => {
    setRuns({
      __baseline__: makeResult(caps(8, false)),
      v1: makeResult(caps(8, true)),
    });
    const attach = vi.fn();
    const ctx = { mcp: {}, testInfo: { attach } } as unknown as EvalContext;

    await runToolOptimization(
      { dataset, variants: [variant('v1')], metric: 'passRate' },
      ctx
    );

    const names = attach.mock.calls.map((c) => c[0] as string);
    expect(names).toContain('mcp-test-results');
    expect(names).toContain('mcp-tool-optimization');

    const expCall = attach.mock.calls.find(
      (c) => c[0] === 'mcp-tool-optimization'
    );
    const summaryBody = (expCall![1] as { body: Buffer }).body;
    const summary = JSON.parse(summaryBody.toString()) as {
      metric: string;
      baselineValue: number;
      bestValue: number;
      winnerVariantId?: string;
      recommendation?: string;
      rounds: unknown[];
    };
    expect(summary.metric).toBe('passRate');
    expect(summary.baselineValue).toBe(0);
    expect(summary.bestValue).toBe(1);
    expect(summary.winnerVariantId).toBe('v1');
    expect(summary.recommendation).toBe('apply');
    expect(summary.rounds).toHaveLength(1);

    // The surfaced case results are the WINNER's (both passing), not baseline.
    const resCall = attach.mock.calls.find((c) => c[0] === 'mcp-test-results');
    const surfacedBody = (resCall![1] as { body: Buffer }).body;
    const surfaced = JSON.parse(surfacedBody.toString()) as {
      caseResults: Array<{ pass: boolean }>;
    };
    expect(surfaced.caseResults.every((r) => r.pass)).toBe(true);
  });

  it('does not attach when testInfo is absent', async () => {
    setRuns({
      __baseline__: makeResult([{ id: 'c1', pass: true }]),
      v1: makeResult([{ id: 'c1', pass: true }]),
    });
    // context has testInfo: undefined — should complete without attaching.
    await expect(
      runToolOptimization(
        { dataset, variants: [variant('v1')], metric: 'passRate' },
        context
      )
    ).resolves.toBeDefined();
  });

  it('runs internal evals without testInfo so the reporter is not spammed', async () => {
    setRuns({
      __baseline__: makeResult([{ id: 'c1', pass: false }]),
      v1: makeResult([{ id: 'c1', pass: true }]),
    });
    const attach = vi.fn();
    const ctx = { mcp: {}, testInfo: { attach } } as unknown as EvalContext;

    await runToolOptimization(
      { dataset, variants: [variant('v1')], metric: 'passRate' },
      ctx
    );

    // Every internal runEvalDataset call received a context WITHOUT testInfo.
    for (const call of mocks.runEvalDataset.mock.calls) {
      const passedCtx = call[1] as EvalContext;
      expect(passedCtx.testInfo).toBeUndefined();
    }
  });

  it('attaches a case-by-case comparison with the original tool text', async () => {
    setRuns({
      __baseline__: makeResult([...caps(7, false), reg('r1', true)]),
      v1: makeResult([...caps(7, true), reg('r1', true)]),
    });
    const attach = vi.fn();
    const listTools = vi.fn(async () => [
      { name: 'search', description: 'original text', inputSchema: {} },
      { name: 'other', description: 'untouched', inputSchema: {} },
    ]);
    const ctx = {
      mcp: { listTools },
      testInfo: { attach },
    } as unknown as EvalContext;

    await runToolOptimization({ dataset, variants: [variant('v1')] }, ctx);

    const expCall = attach.mock.calls.find(
      (c) => c[0] === 'mcp-tool-optimization'
    );
    const summary = JSON.parse(
      (expCall![1] as { body: Buffer }).body.toString()
    ) as MCPToolOptimizationData;
    const comparison = summary.comparison!;
    expect(comparison.regressionCheck).toBe('significant');
    expect(comparison).toMatchObject({
      grouping: 'declared',
      regressionTag: 'regression',
      variantsTried: 1,
    });
    expect(comparison.recommendedId).toBe('v1');
    expect(comparison.variants.map((v) => v.status)).toEqual([
      'baseline',
      'recommended',
    ]);
    expect(comparison.variants[1]!.checks).toEqual({
      fixes: true,
      keepsRegressions: true,
    });
    expect(comparison.cases.map((c) => c.group)).toEqual([
      ...Array<string>(7).fill('capability'),
      'regression',
    ]);
    expect(comparison.variants[1]!.toolChanges).toEqual([
      {
        tool: 'search',
        field: 'description',
        before: 'original text',
        after: 'desc for v1',
      },
    ]);
  });

  it('still attaches the comparison when listTools fails', async () => {
    setRuns({
      __baseline__: makeResult([{ id: 'c1', pass: false }]),
      v1: makeResult([{ id: 'c1', pass: true }]),
    });
    const attach = vi.fn();
    const ctx = {
      mcp: { listTools: vi.fn(async () => Promise.reject(new Error('down'))) },
      testInfo: { attach },
    } as unknown as EvalContext;

    await runToolOptimization({ dataset, variants: [variant('v1')] }, ctx);

    const expCall = attach.mock.calls.find(
      (c) => c[0] === 'mcp-tool-optimization'
    );
    const summary = JSON.parse(
      (expCall![1] as { body: Buffer }).body.toString()
    ) as MCPToolOptimizationData;
    expect(summary.comparison!.variants[1]!.toolChanges[0]!.before).toBe(
      undefined
    );
  });
});

/** A run where each case passed `passes` of `trials` trials. */
function makeAttemptsResult(
  cases: Array<{
    id: string;
    passes: number;
    trials?: number;
    tags?: string[];
    toolPrecision?: number;
    toolRecall?: number;
  }>
): EvalRunnerResult {
  const caseResults = cases.map((c) => {
    const trials = c.trials ?? 5;
    return {
      id: c.id,
      datasetName: 'ds',
      toolName: 't',
      source: 'eval' as const,
      pass: c.passes === trials,
      scores: {},
      durationMs: 1,
      ...(c.tags ? { tags: c.tags } : {}),
      ...(c.toolPrecision !== undefined
        ? { toolPrecision: c.toolPrecision }
        : {}),
      ...(c.toolRecall !== undefined ? { toolRecall: c.toolRecall } : {}),
      passRate: c.passes / trials,
      trialResults: Array.from({ length: trials }, (_, i) => ({
        pass: i < c.passes,
        durationMs: 1,
      })),
    };
  });
  return {
    total: caseResults.length,
    passed: caseResults.filter((c) => c.pass).length,
    failed: caseResults.filter((c) => !c.pass).length,
    caseResults,
    durationMs: 1,
  };
}

describe('runToolOptimization — regressionCheck', () => {
  // Eight capability cases the baseline fails, eight declared regression
  // cases it passes on every trial.
  const fixCases = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];
  const keepCases = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
  const keep = (id: string, passes: number) => ({
    id,
    passes,
    tags: REGRESSION,
  });
  const baseline = makeAttemptsResult([
    ...fixCases.map((id) => ({ id, passes: 0 })),
    ...keepCases.map((id) => keep(id, 5)),
  ]);
  // Fixes everything, but one working case slips to 4 of 5.
  const slips = makeAttemptsResult([
    ...fixCases.map((id) => ({ id, passes: 5 })),
    ...keepCases.map((id) => keep(id, id === 'k1' ? 4 : 5)),
  ]);
  // Fixes everything, but most working cases fall apart.
  const breaks = makeAttemptsResult([
    ...fixCases.map((id) => ({ id, passes: 5 })),
    ...keepCases.map((id) => keep(id, id < 'k7' ? 1 : 5)),
  ]);

  it('disqualifies one slipped case under the any-case check', async () => {
    setRuns({ __baseline__: baseline, slips });
    const result = await runToolOptimization(
      { dataset, variants: [variant('slips')], regressionCheck: 'any-case' },
      context
    );
    expect(result.winner).toBeUndefined();
    expect(result.proposal?.recommendation).toBe('reject');
  });

  it('treats one slipped trial as noise by default', async () => {
    setRuns({ __baseline__: baseline, slips, breaks });
    const result = await runToolOptimization(
      { dataset, variants: [variant('breaks'), variant('slips')] },
      context
    );
    const [brk, slp] = result.rounds[0]!.candidates;
    expect(brk!.disqualified).toBe(true);
    expect(slp!.disqualified).toBe(false);
    expect(slp!.measurement.regression.change?.mean).toBeCloseTo(-0.025);
    expect(result.winner?.variant.id).toBe('slips');
    expect(result.proposal?.recommendation).toBe('apply');
  });

  it('needs a clear improvement to recommend under the significant check', async () => {
    // One of four failing cases improves by one trial: too small to tell.
    const barely = makeAttemptsResult([
      { id: 'f1', passes: 1 },
      ...fixCases.slice(1).map((id) => ({ id, passes: 0 })),
      ...keepCases.map((id) => keep(id, 5)),
    ]);
    setRuns({ __baseline__: baseline, barely });
    const result = await runToolOptimization(
      {
        dataset,
        variants: [variant('barely')],
        regressionCheck: 'significant',
      },
      context
    );
    expect(result.winner?.variant.id).toBe('barely');
    expect(result.proposal?.recommendation).toBe('inconclusive');
  });

  it('disqualifies a variant that breaks one working case outright', async () => {
    // Fixes everything; one working case drops from 5/5 to 0/5. The average
    // change (-12.5 pts) is within noise, but that case clearly broke.
    const breaksOne = makeAttemptsResult([
      ...fixCases.map((id) => ({ id, passes: 5 })),
      ...keepCases.map((id) => keep(id, id === 'k1' ? 0 : 5)),
    ]);
    setRuns({ __baseline__: baseline, breaksOne });
    const result = await runToolOptimization(
      { dataset, variants: [variant('breaksOne')] },
      context
    );
    const [candidate] = result.rounds[0]!.candidates;
    expect(candidate!.measurement.regression.change!.upper).toBeGreaterThan(0);
    expect(candidate!.measurement.brokenCaseIds).toEqual(['k1']);
    expect(candidate!.disqualified).toBe(true);
    expect(result.proposal?.recommendation).toBe('reject');
  });

  it('tests tool metrics on per-case scores, not the dataset total', async () => {
    // The dataset F1 went up, but no case has per-case scores to back it.
    setRuns({
      __baseline__: { ...baseline, datasetToolF1: 0.6 },
      noEvidence: { ...slips, datasetToolF1: 0.7 },
    });
    const thin = await runToolOptimization(
      { dataset, variants: [variant('noEvidence')], metric: 'toolF1' },
      context
    );
    expect(thin.winner?.improvement.cases).toBe(0);
    expect(thin.proposal?.recommendation).toBe('inconclusive');

    // Per-case precision went up on every capability case.
    // As the runner reports it: per-case scores and their dataset mean.
    const scored = (precision: number, source: EvalRunnerResult) => {
      const caseResults = source.caseResults.map((c) => ({
        ...c,
        toolPrecision: c.id.startsWith('f') ? precision : 1,
        toolRecall: 1,
      }));
      return {
        ...source,
        caseResults,
        datasetToolPrecision:
          caseResults.reduce((sum, c) => sum + c.toolPrecision, 0) /
          caseResults.length,
        datasetToolRecall: 1,
      };
    };
    setRuns({
      __baseline__: scored(0.2, baseline),
      better: scored(0.9, slips),
    });
    const result = await runToolOptimization(
      { dataset, variants: [variant('better')], metric: 'toolPrecision' },
      context
    );
    expect(result.winner?.improvement.assessment).toBe('better');
    expect(result.proposal?.recommendation).toBe('apply');
  });
});

describe('runToolOptimization — grouping', () => {
  const plain = (passes: number[]) =>
    makeAttemptsResult(passes.map((p, i) => ({ id: `c${i}`, passes: p })));

  it('runs a separate grouping baseline when no case is tagged', async () => {
    setRuns({
      __baseline__: plain([5, 0, 0, 0, 0, 0, 0, 0, 0]),
      // c0 is flaky: it passed the baseline, but not the grouping run.
      __grouping__: plain([4, 0, 0, 0, 0, 0, 0, 0, 5]),
      v: plain([5, 5, 5, 5, 5, 5, 5, 5, 5]),
    });
    const result = await runToolOptimization(
      { dataset, variants: [variant('v')] },
      context
    );
    expect(mocks.runEvalDataset).toHaveBeenCalledTimes(3);
    expect(result.grouping).toBe('grouping-run');
    expect(result.groupingBaseline).toBeDefined();
    // Groups come from the grouping run, not the baseline.
    const m = result.winner!.measurement;
    expect(m.regression.cases).toBe(1);
    expect(m.capability.cases).toBe(8);
  });

  it('skips the grouping run when there is nothing to compare', async () => {
    setRuns({ __baseline__: plain([5, 0]) });
    const result = await runToolOptimization(
      { dataset, variants: [] },
      context
    );
    expect(result.reason).toBe('no-variants');
    expect(mocks.runEvalDataset).toHaveBeenCalledTimes(1);
  });
});

describe('runToolOptimization — selection hygiene', () => {
  const heldOut = ['held-out'];
  const fixes = (seen: number, held: number) =>
    makeAttemptsResult([
      ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, passes: seen })),
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `h${i}`,
        passes: held,
        tags: heldOut,
      })),
      { id: 'r', passes: 5, tags: REGRESSION },
    ]);

  it('ranks variants without held-out cases', async () => {
    setRuns({
      __baseline__: fixes(0, 0),
      seenOnly: fixes(4, 0),
      heldOnly: fixes(0, 5),
    });
    const result = await runToolOptimization(
      { dataset, variants: [variant('heldOnly'), variant('seenOnly')] },
      context
    );
    // heldOnly passes more cases overall, but only on held-out ones.
    expect(result.winner?.variant.id).toBe('seenOnly');
    const [heldOnly] = result.rounds[0]!.candidates;
    expect(heldOnly!.metricDelta).toBe(0);
  });

  it('never shows held-out cases to proposeVariants', async () => {
    setRuns({ __baseline__: fixes(0, 0), v1: fixes(5, 5), v2: fixes(5, 5) });
    const seenIds: string[][] = [];
    await runToolOptimization(
      {
        dataset,
        maxRounds: 2,
        minImprovement: -1,
        proposeVariants: async (ctx) => {
          seenIds.push(ctx.baseline.caseResults.map((c) => c.id));
          for (const round of ctx.history) {
            for (const c of round.candidates) {
              seenIds.push(c.result.caseResults.map((r) => r.id));
              seenIds.push(c.comparison.improvedCases.map((r) => r.id));
            }
          }
          return ctx.round === 0 ? [variant('v1')] : [variant('v2')];
        },
      },
      context
    );
    expect(seenIds.flat().some((id) => id.startsWith('h'))).toBe(false);
    expect(seenIds.flat()).toContain('s0');
  });

  it('adjusts improvement for every variant tried', async () => {
    // 7 of 8 cases fixed: p = 1/128 = 0.008. Clear for one variant, and for
    // three (0.025 / 3 = 0.0083), but not for four (0.00625).
    const sevenFixed = makeAttemptsResult([
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `s${i}`,
        passes: i < 7 ? 5 : 0,
      })),
      { id: 'r', passes: 5, tags: REGRESSION },
    ]);
    const none = makeAttemptsResult([
      ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, passes: 0 })),
      { id: 'r', passes: 5, tags: REGRESSION },
    ]);
    const tryN = async (n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `v${i}`);
      setRuns({
        __baseline__: none,
        ...Object.fromEntries(
          ids.map((id, i) => [id, i === 0 ? sevenFixed : none])
        ),
      });
      return runToolOptimization(
        { dataset, variants: ids.map((id) => variant(id)) },
        context
      );
    };
    expect((await tryN(3)).proposal?.recommendation).toBe('apply');
    const four = await tryN(4);
    expect(four.winner?.variant.id).toBe('v0');
    expect(four.proposal?.recommendation).toBe('inconclusive');
  });
});

describe('runToolOptimization — a candidate without the metric', () => {
  it('is disqualified and marked, not scored as the baseline', async () => {
    setRuns({
      __baseline__: makeResult([{ id: 'c1', pass: true }], { f1: 0.5 }),
      vA: makeResult([{ id: 'c1', pass: true }]),
    });
    const result = await runToolOptimization(
      { dataset, variants: [variant('vA')], metric: 'toolF1' },
      context
    );
    expect(result.rounds[0]?.candidates[0]).toMatchObject({
      metricUnavailable: true,
      disqualified: true,
      metricValue: 0.5,
    });
    expect(result.winner).toBeUndefined();
  });
});
