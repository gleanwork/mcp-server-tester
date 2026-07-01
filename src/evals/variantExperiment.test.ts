import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvalRunnerResult, EvalContext } from './evalRunner.js';
import type { EvalDataset } from './datasetTypes.js';
import type { ToolOverrideVariant } from './evalRunner.js';

const mocks = vi.hoisted(() => ({ runEvalDataset: vi.fn() }));
vi.mock('./evalRunner.js', () => ({ runEvalDataset: mocks.runEvalDataset }));

import { runVariantExperiment } from './variantExperiment.js';

interface CaseSpec {
  id: string;
  pass: boolean;
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
      expectations: {},
      durationMs: 1,
    })),
    durationMs: 1,
    datasetToolF1: metrics?.f1,
    datasetToolPrecision: metrics?.precision,
    datasetToolRecall: metrics?.recall,
  };
}

/** Wire the mocked runner to return a canned result keyed by variant id. */
function setRuns(map: Record<string, EvalRunnerResult>): void {
  mocks.runEvalDataset.mockImplementation(
    async (opts: { toolOverrides?: ToolOverrideVariant }) => {
      const key = opts.toolOverrides?.id ?? '__baseline__';
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

describe('runVariantExperiment — single round', () => {
  it('ranks candidates by passRate and proposes applying the best', async () => {
    setRuns({
      __baseline__: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: false },
        { id: 'c3', pass: false },
      ]),
      vA: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: true },
        { id: 'c3', pass: false },
      ]),
      vB: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: true },
        { id: 'c3', pass: true },
      ]),
    });

    const result = await runVariantExperiment(
      { dataset, variants: [variant('vA'), variant('vB')] },
      context
    );

    expect(result.winner?.variant.id).toBe('vB');
    expect(result.proposal?.recommendation).toBe('apply');
    expect(result.proposal?.delta).toBeCloseTo(2 / 3);
    expect(result.proposal?.improvedCaseIds.sort()).toEqual(['c2', 'c3']);
    expect(result.proposal?.regressedCaseIds).toEqual([]);
    // baseline + 2 candidates
    expect(mocks.runEvalDataset).toHaveBeenCalledTimes(3);
  });

  it('disqualifies a regressing candidate and recommends rejecting it', async () => {
    setRuns({
      __baseline__: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: false },
        { id: 'c3', pass: false },
      ]),
      // improves c2/c3 but breaks c1
      vReg: makeResult([
        { id: 'c1', pass: false },
        { id: 'c2', pass: true },
        { id: 'c3', pass: true },
      ]),
    });

    const result = await runVariantExperiment(
      { dataset, variants: [variant('vReg')] },
      context
    );

    expect(result.winner).toBeUndefined();
    expect(result.rounds[0]?.candidates[0]?.disqualified).toBe(true);
    expect(result.proposal?.recommendation).toBe('reject');
    expect(result.proposal?.regressedCaseIds).toEqual(['c1']);
  });

  it('allows regressions when opted in', async () => {
    setRuns({
      __baseline__: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: false },
        { id: 'c3', pass: false },
      ]),
      vReg: makeResult([
        { id: 'c1', pass: false },
        { id: 'c2', pass: true },
        { id: 'c3', pass: true },
      ]),
    });

    const result = await runVariantExperiment(
      { dataset, variants: [variant('vReg')], allowRegressions: true },
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

    const result = await runVariantExperiment(
      { dataset, variants: [variant('vSame')] },
      context
    );

    expect(result.winner?.variant.id).toBe('vSame');
    expect(result.proposal?.recommendation).toBe('inconclusive');
    expect(result.proposal?.delta).toBe(0);
  });

  it('returns reason "no-variants" when no candidates are provided', async () => {
    setRuns({ __baseline__: makeResult([{ id: 'c1', pass: true }]) });

    const result = await runVariantExperiment(
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

describe('runVariantExperiment — metric selection', () => {
  it('ranks by toolF1 when requested', async () => {
    setRuns({
      __baseline__: makeResult([{ id: 'c1', pass: true }], { f1: 0.5 }),
      vLow: makeResult([{ id: 'c1', pass: true }], { f1: 0.6 }),
      vHigh: makeResult([{ id: 'c1', pass: true }], { f1: 0.9 }),
    });

    const result = await runVariantExperiment(
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
      runVariantExperiment(
        { dataset, metric: 'toolF1', variants: [variant('vA')] },
        context
      )
    ).rejects.toThrow(/Metric 'toolF1' is unavailable/);
  });
});

describe('runVariantExperiment — multi-round proposeVariants', () => {
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

    await runVariantExperiment(
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

    const result = await runVariantExperiment(
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

    const result = await runVariantExperiment(
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

    const result = await runVariantExperiment(
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

describe('runVariantExperiment — reporter integration', () => {
  it('attaches winner results and an experiment summary when testInfo is present', async () => {
    setRuns({
      __baseline__: makeResult([
        { id: 'c1', pass: false },
        { id: 'c2', pass: false },
      ]),
      v1: makeResult([
        { id: 'c1', pass: true },
        { id: 'c2', pass: true },
      ]),
    });
    const attach = vi.fn();
    const ctx = { mcp: {}, testInfo: { attach } } as unknown as EvalContext;

    await runVariantExperiment(
      { dataset, variants: [variant('v1')], metric: 'passRate' },
      ctx
    );

    const names = attach.mock.calls.map((c) => c[0] as string);
    expect(names).toContain('mcp-test-results');
    expect(names).toContain('mcp-variant-experiment');

    const expCall = attach.mock.calls.find(
      (c) => c[0] === 'mcp-variant-experiment'
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
      runVariantExperiment(
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

    await runVariantExperiment(
      { dataset, variants: [variant('v1')], metric: 'passRate' },
      ctx
    );

    // Every internal runEvalDataset call received a context WITHOUT testInfo.
    for (const call of mocks.runEvalDataset.mock.calls) {
      const passedCtx = call[1] as EvalContext;
      expect(passedCtx.testInfo).toBeUndefined();
    }
  });
});
