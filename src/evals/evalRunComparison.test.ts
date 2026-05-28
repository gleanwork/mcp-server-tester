import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareEvalRuns,
  loadStoredEvalRunnerResult,
  saveEvalRunComparison,
  type EvalRunComparisonResult,
} from './evalRunComparison.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';
import {
  FileEvalResultStore,
  createStoredEvalArtifact,
} from './resultStore.js';

function createCase(id: string, pass: boolean): EvalCaseResult {
  return {
    id,
    datasetName: 'comparison-test',
    toolName: 'mcp_host',
    source: 'eval',
    pass,
    expectations: {},
    durationMs: 1,
  };
}

function createRun(
  cases: EvalCaseResult[],
  overrides: Partial<EvalRunnerResult> = {}
): EvalRunnerResult {
  const passed = cases.filter((c) => c.pass).length;
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    caseResults: cases,
    durationMs: 10,
    ...overrides,
  };
}

describe('compareEvalRuns', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-run-comparison-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('buckets improved, regressed, unchanged, and missing cases', () => {
    const baseline = createRun([
      createCase('improved', false),
      createCase('regressed', true),
      createCase('unchanged-pass', true),
      createCase('unchanged-fail', false),
      createCase('missing-from-candidate', true),
    ]);
    const candidate = createRun([
      createCase('improved', true),
      createCase('regressed', false),
      createCase('unchanged-pass', true),
      createCase('unchanged-fail', false),
      createCase('missing-from-baseline', true),
    ]);

    const result = compareEvalRuns({ baseline, candidate });

    expect(result.cases.map((c) => [c.id, c.outcome])).toEqual([
      ['improved', 'IMPROVED'],
      ['regressed', 'REGRESSED'],
      ['unchanged-pass', 'UNCHANGED_PASS'],
      ['unchanged-fail', 'UNCHANGED_FAIL'],
      ['missing-from-candidate', 'MISSING_FROM_CANDIDATE'],
      ['missing-from-baseline', 'MISSING_FROM_BASELINE'],
    ]);
    expect(result.improvedCases.map((c) => c.id)).toEqual(['improved']);
    expect(result.regressedCases.map((c) => c.id)).toEqual(['regressed']);
    expect(result.unchangedPasses.map((c) => c.id)).toEqual(['unchanged-pass']);
    expect(result.unchangedFailures.map((c) => c.id)).toEqual([
      'unchanged-fail',
    ]);
    expect(result.missingFromBaseline.map((c) => c.id)).toEqual([
      'missing-from-baseline',
    ]);
    expect(result.missingFromCandidate.map((c) => c.id)).toEqual([
      'missing-from-candidate',
    ]);
  });

  it('computes pass-rate and tool metric deltas', () => {
    const baseline = createRun(
      [createCase('a', true), createCase('b', false), createCase('c', false)],
      {
        datasetToolPrecision: 0.5,
        datasetToolRecall: 0.25,
        datasetToolF1: 1 / 3,
      }
    );
    const candidate = createRun(
      [createCase('a', true), createCase('b', true), createCase('c', false)],
      {
        datasetToolPrecision: 0.75,
        datasetToolRecall: 0.5,
        datasetToolF1: 0.6,
      }
    );

    const result = compareEvalRuns({ baseline, candidate });

    expect(result.baselinePassRate).toBeCloseTo(1 / 3);
    expect(result.candidatePassRate).toBeCloseTo(2 / 3);
    expect(result.deltaPassRate).toBeCloseTo(1 / 3);
    expect(result.baselineToolPrecision).toBe(0.5);
    expect(result.candidateToolPrecision).toBe(0.75);
    expect(result.deltaToolPrecision).toBe(0.25);
    expect(result.baselineToolRecall).toBe(0.25);
    expect(result.candidateToolRecall).toBe(0.5);
    expect(result.deltaToolRecall).toBe(0.25);
    expect(result.baselineToolF1).toBeCloseTo(1 / 3);
    expect(result.candidateToolF1).toBe(0.6);
    expect(result.deltaToolF1).toBeCloseTo(0.6 - 1 / 3);
  });

  it('omits metric deltas when only one side has a metric', () => {
    const baseline = createRun([createCase('a', true)], {
      datasetToolPrecision: 0.5,
    });
    const candidate = createRun([createCase('a', true)]);

    const result = compareEvalRuns({ baseline, candidate });

    expect(result.baselineToolPrecision).toBe(0.5);
    expect(result.candidateToolPrecision).toBeUndefined();
    expect(result.deltaToolPrecision).toBeUndefined();
  });

  it('uses explicit labels and candidate variant id defaults', () => {
    const baseline = createRun([createCase('a', true)]);
    const candidate = createRun([createCase('a', true)], {
      metadata: {
        timestamp: '2026-05-19T00:00:00.000Z',
        packageVersion: '1.0.0',
        toolOverrideVariantId: 'search-description-v2',
      },
    });

    expect(compareEvalRuns({ baseline, candidate }).candidateLabel).toBe(
      'search-description-v2'
    );

    const labeled = compareEvalRuns({
      baseline,
      candidate,
      labels: {
        baseline: 'control',
        candidate: 'candidate-a',
      },
    });

    expect(labeled.baselineLabel).toBe('control');
    expect(labeled.candidateLabel).toBe('candidate-a');
  });

  it('returns zero pass rates for empty runs', () => {
    const result = compareEvalRuns({
      baseline: createRun([]),
      candidate: createRun([]),
    });

    expect(result.baselinePassRate).toBe(0);
    expect(result.candidatePassRate).toBe(0);
    expect(result.deltaPassRate).toBe(0);
  });

  it('loads a stored eval run for comparison', async () => {
    const store = new FileEvalResultStore({ provider: 'file', dir: tmpDir });
    const run = createRun([createCase('a', true)]);
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-runner-result',
        id: 'run-a',
        data: run,
        metadata: {
          timestamp: '2026-05-22T00:00:00.000Z',
          packageVersion: '1.0.0',
          toolOverrideVariantId: 'variant-a',
        },
      })
    );

    const loaded = await loadStoredEvalRunnerResult(store, { id: 'run-a' });

    // Artifact-level metadata is the storage envelope (set via
    // createStoredEvalArtifact's metadata option). EvalRunnerResult is the
    // runtime data and lives under loaded.data.
    expect(loaded.metadata.toolOverrideVariantId).toBe('variant-a');
    expect(loaded.data.caseResults).toHaveLength(1);
    expect(
      compareEvalRuns({ baseline: loaded.data, candidate: loaded.data }).cases
    ).toHaveLength(1);
  });

  it('saves eval run comparison artifacts with labels metadata', async () => {
    const store = new FileEvalResultStore({ provider: 'file', dir: tmpDir });
    const comparison = compareEvalRuns({
      baseline: createRun([createCase('a', false)]),
      candidate: createRun([createCase('a', true)]),
      labels: { baseline: 'control', candidate: 'variant' },
    });

    const artifact = await saveEvalRunComparison({
      store,
      comparison,
      id: 'comparison-a',
    });
    const loaded = await store.loadArtifact<EvalRunComparisonResult>(
      'eval-run-comparison',
      'comparison-a'
    );

    expect(artifact.metadata.labels).toEqual({
      baseline: 'control',
      candidate: 'variant',
    });
    expect(loaded.data.improvedCases).toHaveLength(1);
  });
});
