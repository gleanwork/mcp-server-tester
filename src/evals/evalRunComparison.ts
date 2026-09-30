import type { EvalCaseResult } from '../types/reporter.js';
import type { EvalRunnerResult } from './evalRunner.js';
import {
  createStoredEvalArtifact,
  resolveEvalResultStore,
  type EvalResultStoreLike,
  type StoredEvalArtifact,
  type StoredEvalArtifactMetadata,
} from './resultStore.js';
import {
  REDACT_STORED_RESPONSES_BY_DEFAULT,
  redactStoredResponses,
} from './resultStore.js';

/** Labels used when presenting an eval run comparison. */
export interface EvalRunComparisonLabels {
  /** Label for the baseline run. Defaults to "baseline". */
  baseline?: string;
  /** Label for the candidate run. Defaults to the candidate variant id or "candidate". */
  candidate?: string;
}

/** Outcome of comparing one eval case across two completed eval runs. */
export type EvalCaseComparisonOutcome =
  | 'IMPROVED'
  | 'REGRESSED'
  | 'UNCHANGED_PASS'
  | 'UNCHANGED_FAIL'
  | 'MISSING_FROM_BASELINE'
  | 'MISSING_FROM_CANDIDATE';

/** Per-case comparison between a baseline run and candidate run. */
export interface EvalCaseComparison {
  /** Case ID */
  id: string;
  /** Outcome for this case */
  outcome: EvalCaseComparisonOutcome;
  /** Baseline case result, absent when the case only exists in the candidate run */
  baseline?: EvalCaseResult;
  /** Candidate case result, absent when the case only exists in the baseline run */
  candidate?: EvalCaseResult;
}

/** Options for comparing two completed eval runs. */
export interface CompareEvalRunsOptions {
  /** Baseline run result */
  baseline: EvalRunnerResult;
  /** Candidate run result */
  candidate: EvalRunnerResult;
  /** Optional human-readable run labels */
  labels?: EvalRunComparisonLabels;
}

/** Aggregated comparison between two completed eval runs. */
export interface EvalRunComparisonResult {
  /** Baseline label */
  baselineLabel: string;
  /** Candidate label */
  candidateLabel: string;
  /** Baseline pass rate (passed / total, or 0 when total is 0) */
  baselinePassRate: number;
  /** Candidate pass rate (passed / total, or 0 when total is 0) */
  candidatePassRate: number;
  /** Candidate pass rate minus baseline pass rate */
  deltaPassRate: number;
  /** Baseline dataset tool precision, when present */
  baselineToolPrecision?: number;
  /** Candidate dataset tool precision, when present */
  candidateToolPrecision?: number;
  /** Candidate precision minus baseline precision, when both are present */
  deltaToolPrecision?: number;
  /** Baseline dataset tool recall, when present */
  baselineToolRecall?: number;
  /** Candidate dataset tool recall, when present */
  candidateToolRecall?: number;
  /** Candidate recall minus baseline recall, when both are present */
  deltaToolRecall?: number;
  /** Baseline dataset tool F1, when present */
  baselineToolF1?: number;
  /** Candidate dataset tool F1, when present */
  candidateToolF1?: number;
  /** Candidate F1 minus baseline F1, when both are present */
  deltaToolF1?: number;
  /** All per-case comparison records in deterministic order */
  cases: EvalCaseComparison[];
  /** Cases that failed in baseline and passed in candidate */
  improvedCases: EvalCaseComparison[];
  /** Cases that passed in baseline and failed in candidate */
  regressedCases: EvalCaseComparison[];
  /** Cases that passed in both runs */
  unchangedPasses: EvalCaseComparison[];
  /** Cases that failed in both runs */
  unchangedFailures: EvalCaseComparison[];
  /** Cases present only in candidate */
  missingFromBaseline: EvalCaseComparison[];
  /** Cases present only in baseline */
  missingFromCandidate: EvalCaseComparison[];
  /**
   * Caveats about the comparison, e.g. the runs negotiated different MCP
   * protocol eras, so pass-rate changes may come from the protocol rather
   * than the change under test.
   */
  warnings: string[];
}

/** Explains why two runs' protocols make a comparison less meaningful. */
function protocolWarnings(
  baseline: EvalRunnerResult,
  candidate: EvalRunnerResult
): string[] {
  const a = baseline.metadata?.protocol;
  const b = candidate.metadata?.protocol;
  if (!a?.negotiated || !b?.negotiated) return [];
  if (a.era && b.era && a.era !== b.era) {
    return [
      `Runs used different MCP protocol eras (baseline ${a.negotiated}/${a.era}, candidate ${b.negotiated}/${b.era}); differences may come from the protocol, not the change under test.`,
    ];
  }
  if (a.negotiated !== b.negotiated) {
    return [
      `Runs negotiated different MCP protocol revisions (baseline ${a.negotiated}, candidate ${b.negotiated}).`,
    ];
  }
  return [];
}

export type StoredEvalRunRef = 'latest' | { id: string };

export interface SaveEvalRunComparisonOptions {
  store: EvalResultStoreLike;
  comparison: EvalRunComparisonResult;
  id?: string;
  metadata?: StoredEvalArtifactMetadata;
  /** Omit raw responses from the stored comparison. @default true */
  redactStoredResponses?: boolean;
}

/**
 * Compares two completed eval runs without running any evals or reading files.
 *
 * Use this after running a baseline and candidate (for example a toolOverrides
 * variant) to compute pass-rate deltas, tool metric deltas, and per-case
 * improvement/regression buckets.
 */
export function compareEvalRuns(
  options: CompareEvalRunsOptions
): EvalRunComparisonResult {
  const { baseline, candidate, labels } = options;
  const candidateMap = new Map<string, EvalCaseResult>(
    candidate.caseResults.map((result) => [result.id, result])
  );

  const cases: EvalCaseComparison[] = [];
  const seenIds = new Set<string>();

  for (const baselineCase of baseline.caseResults) {
    seenIds.add(baselineCase.id);
    const candidateCase = candidateMap.get(baselineCase.id);
    if (!candidateCase) {
      cases.push({
        id: baselineCase.id,
        outcome: 'MISSING_FROM_CANDIDATE',
        baseline: baselineCase,
      });
      continue;
    }

    cases.push({
      id: baselineCase.id,
      outcome: compareCaseOutcome(baselineCase.pass, candidateCase.pass),
      baseline: baselineCase,
      candidate: candidateCase,
    });
  }

  for (const candidateCase of candidate.caseResults) {
    if (seenIds.has(candidateCase.id)) {
      continue;
    }

    cases.push({
      id: candidateCase.id,
      outcome: 'MISSING_FROM_BASELINE',
      candidate: candidateCase,
    });
  }

  const baselinePassRate = passRate(baseline);
  const candidatePassRate = passRate(candidate);

  return {
    baselineLabel: labels?.baseline ?? 'baseline',
    candidateLabel:
      labels?.candidate ??
      candidate.metadata?.toolOverrideVariantId ??
      'candidate',
    baselinePassRate,
    candidatePassRate,
    deltaPassRate: candidatePassRate - baselinePassRate,
    ...metricDelta(
      'ToolPrecision',
      baseline.datasetToolPrecision,
      candidate.datasetToolPrecision
    ),
    ...metricDelta(
      'ToolRecall',
      baseline.datasetToolRecall,
      candidate.datasetToolRecall
    ),
    ...metricDelta('ToolF1', baseline.datasetToolF1, candidate.datasetToolF1),
    cases,
    improvedCases: cases.filter((c) => c.outcome === 'IMPROVED'),
    regressedCases: cases.filter((c) => c.outcome === 'REGRESSED'),
    unchangedPasses: cases.filter((c) => c.outcome === 'UNCHANGED_PASS'),
    unchangedFailures: cases.filter((c) => c.outcome === 'UNCHANGED_FAIL'),
    missingFromBaseline: cases.filter(
      (c) => c.outcome === 'MISSING_FROM_BASELINE'
    ),
    missingFromCandidate: cases.filter(
      (c) => c.outcome === 'MISSING_FROM_CANDIDATE'
    ),
    warnings: protocolWarnings(baseline, candidate),
  };
}

export async function loadStoredEvalRunnerResult(
  storeLike: EvalResultStoreLike,
  ref: StoredEvalRunRef
): Promise<StoredEvalArtifact<EvalRunnerResult>> {
  const store = resolveEvalResultStore(storeLike);
  const artifact =
    ref === 'latest'
      ? await store.loadLatestArtifact<EvalRunnerResult>('eval-runner-result')
      : await store.loadArtifact<EvalRunnerResult>(
          'eval-runner-result',
          ref.id
        );

  if (!artifact) {
    throw new Error('No latest eval run artifact found');
  }

  return artifact;
}

export async function saveEvalRunComparison(
  options: SaveEvalRunComparisonOptions
): Promise<StoredEvalArtifact<EvalRunComparisonResult>> {
  const store = resolveEvalResultStore(options.store);
  const data =
    (options.redactStoredResponses ?? REDACT_STORED_RESPONSES_BY_DEFAULT)
      ? redactStoredResponses(options.comparison)
      : options.comparison;
  const artifact = createStoredEvalArtifact({
    kind: 'eval-run-comparison',
    id: options.id,
    data,
    metadata: {
      labels: {
        baseline: options.comparison.baselineLabel,
        candidate: options.comparison.candidateLabel,
      },
      ...(options.metadata ?? {}),
    },
  });

  await store.saveArtifact(artifact);
  return artifact;
}

function compareCaseOutcome(
  baselinePass: boolean,
  candidatePass: boolean
): EvalCaseComparisonOutcome {
  if (!baselinePass && candidatePass) return 'IMPROVED';
  if (baselinePass && !candidatePass) return 'REGRESSED';
  return baselinePass ? 'UNCHANGED_PASS' : 'UNCHANGED_FAIL';
}

/** Fraction of cases that passed; 0 for a run without cases. Every run-level pass rate uses this. */
export function passRate(run: { passed: number; total: number }): number {
  return run.total > 0 ? run.passed / run.total : 0;
}

function metricDelta(
  name: 'ToolPrecision' | 'ToolRecall' | 'ToolF1',
  baselineValue: number | undefined,
  candidateValue: number | undefined
): Record<string, number> {
  const result: Record<string, number> = {};
  if (baselineValue !== undefined) {
    result[`baseline${name}`] = baselineValue;
  }
  if (candidateValue !== undefined) {
    result[`candidate${name}`] = candidateValue;
  }
  if (baselineValue !== undefined && candidateValue !== undefined) {
    result[`delta${name}`] = candidateValue - baselineValue;
  }
  return result;
}
