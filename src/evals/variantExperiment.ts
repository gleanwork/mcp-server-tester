import { runEvalDataset } from './evalRunner.js';
import type {
  EvalContext,
  EvalRunnerResult,
  ToolMetadataOverride,
  ToolOverrideVariant,
} from './evalRunner.js';
import type { EvalDataset } from './datasetTypes.js';
import { compareEvalRuns } from './evalRunComparison.js';
import type { EvalRunComparisonResult } from './evalRunComparison.js';
import type { ZodType } from 'zod';

/**
 * Metric used to rank variant candidates and decide improvement.
 *
 * - `passRate`: passed / total across the dataset (always available).
 * - `toolF1` / `toolPrecision` / `toolRecall`: dataset-level tool-call metrics,
 *   only available when the dataset has `mcp_host` cases with `toolsTriggered`
 *   expectations. Choosing one of these when no such cases exist throws a clear
 *   error rather than silently ranking on nothing.
 */
export type ExperimentMetric =
  | 'passRate'
  | 'toolF1'
  | 'toolPrecision'
  | 'toolRecall';

/**
 * Why a variant experiment stopped.
 *
 * - `no-variants`: no candidates were ever produced (round 0 yielded none).
 * - `no-improvement`: a round's best candidate did not beat the best-so-far by
 *   at least `minImprovement`, or `proposeVariants` returned no further
 *   candidates.
 * - `max-rounds`: the configured `maxRounds` budget was exhausted.
 * - `threshold-met`: reserved for future absolute-target convergence; not
 *   emitted by the current delta-based logic.
 */
export type VariantExperimentReason =
  | 'threshold-met'
  | 'no-improvement'
  | 'max-rounds'
  | 'no-variants';

/** Whether a winning variant should be applied, rejected, or is inconclusive. */
export type VariantRecommendation = 'apply' | 'reject' | 'inconclusive';

/** Result of running and scoring a single candidate variant. */
export interface VariantCandidateResult {
  /** The variant that was injected via `toolOverrides`. */
  variant: ToolOverrideVariant;
  /** The eval run produced for this variant. */
  result: EvalRunnerResult;
  /** Comparison of this candidate against the original baseline run. */
  comparison: EvalRunComparisonResult;
  /** The selected metric's value for this candidate. */
  metricValue: number;
  /** `metricValue` minus the baseline's metric value. */
  metricDelta: number;
  /**
   * True when this candidate regressed at least one case and `allowRegressions`
   * is not set. Disqualified candidates can never become the winner.
   */
  disqualified: boolean;
}

/** All candidates tried in a single round, plus the round's best non-disqualified pick. */
export interface VariantExperimentRound {
  /** 0-based round index. */
  round: number;
  /** Every candidate scored this round, in input order. */
  candidates: VariantCandidateResult[];
  /** Highest-scoring non-disqualified candidate this round, if any. */
  best?: VariantCandidateResult;
}

/** Context passed to a `proposeVariants` callback before each round. */
export interface ProposeVariantsContext {
  /** 0-based index of the round about to run. */
  round: number;
  /** The original baseline run (no overrides). */
  baseline: EvalRunnerResult;
  /** The metric the experiment is optimizing. */
  metric: ExperimentMetric;
  /** All completed rounds so far, in order. */
  history: VariantExperimentRound[];
  /** Best non-disqualified candidate across all prior rounds, if any. */
  bestSoFar?: VariantCandidateResult;
}

/** A structured, ready-to-act proposal derived from the best attempted candidate. */
export interface VariantImprovementProposal {
  /** `id` of the variant this proposal describes. */
  variantId: string;
  /** Metric the experiment optimized. */
  metric: ExperimentMetric;
  /** Baseline metric value. */
  baselineValue: number;
  /** Candidate metric value. */
  candidateValue: number;
  /** `candidateValue` minus `baselineValue`. */
  delta: number;
  /** Per-tool overrides this variant applied, keyed by canonical tool name. */
  toolChanges: Record<string, ToolMetadataOverride>;
  /** IDs of cases that failed in baseline and passed with this variant. */
  improvedCaseIds: string[];
  /** IDs of cases that passed in baseline and failed with this variant. */
  regressedCaseIds: string[];
  /**
   * `apply` when the variant improved the metric without disqualifying
   * regressions; `reject` when the best attempt regressed cases (and
   * regressions are not allowed); `inconclusive` when nothing beat baseline.
   */
  recommendation: VariantRecommendation;
}

/** Options for {@link runVariantExperiment}. */
export interface VariantExperimentOptions {
  /** The eval dataset. Treated as the stable behavioral contract; never mutated. */
  dataset: EvalDataset;
  /** Static candidates tried in round 0. */
  variants?: ToolOverrideVariant[];
  /**
   * AI hook returning the next candidates given prior-round results. Invoked for
   * rounds >= 1, and for round 0 when `variants` is omitted. Return `[]` to stop.
   */
  proposeVariants?: (
    context: ProposeVariantsContext
  ) => Promise<ToolOverrideVariant[]>;
  /** Metric to optimize. @default 'passRate' */
  metric?: ExperimentMetric;
  /** Maximum number of rounds to run. @default 1 */
  maxRounds?: number;
  /**
   * Convergence threshold. Stop when a round's best metric improvement over the
   * prior best-so-far is below this value. @default 0
   */
  minImprovement?: number;
  /**
   * When false (default), any candidate that regresses a case is disqualified
   * from winning and surfaced with `recommendation: 'reject'`. When true,
   * regressions do not disqualify.
   * @default false
   */
  allowRegressions?: boolean;
  /** Default `mcp_host` iterations per case. Forwarded to `runEvalDataset`. */
  defaultLlmIterations?: number;
  /** Default judge repetitions per case. Forwarded to `runEvalDataset`. */
  defaultJudgeReps?: number;
  /** Max eval cases to run concurrently within each run. Forwarded to `runEvalDataset`. */
  concurrency?: number;
  /** Run only cases with at least one of these tags. Forwarded to `runEvalDataset`. */
  filterTags?: string[];
  /** Schema registry for `expect.schema` cases. Forwarded to `runEvalDataset`. */
  schemas?: Record<string, ZodType>;
  /** MCP host model identifier recorded in run metadata. */
  mcpHostModel?: string;
  /** Judge model identifier recorded in run metadata. */
  judgeModel?: string;
}

/** Aggregated result of a variant experiment. */
export interface VariantExperimentResult {
  /** Metric that was optimized. */
  metric: ExperimentMetric;
  /** The original baseline run (no overrides). */
  baseline: EvalRunnerResult;
  /** Every round that ran, in order. */
  rounds: VariantExperimentRound[];
  /** Best non-disqualified candidate across all rounds, if any. */
  winner?: VariantCandidateResult;
  /** Structured proposal derived from the best attempted candidate, if any ran. */
  proposal?: VariantImprovementProposal;
  /** True when the experiment stopped on its own terms (always true today). */
  converged: boolean;
  /** Why the experiment stopped. */
  reason: VariantExperimentReason;
}

/**
 * Runs a tool-metadata variant experiment: establishes a baseline, then injects
 * each candidate variant via `toolOverrides`, compares it to the baseline,
 * ranks by the chosen metric, guards against regressions, and emits a structured
 * improvement proposal.
 *
 * The library owns the experiment mechanism; the *policy* — which variant to try
 * next — is the caller's, supplied either as a static `variants` list or an
 * iterative `proposeVariants` callback. This is the programmatic spine an AI or
 * skill drives to optimize tool descriptions/schemas for better host triggering.
 *
 * Candidates are always compared against the original baseline (not the prior
 * round), so the resulting proposal is directly applicable. Multi-round
 * convergence is tracked separately via best-so-far.
 *
 * @example
 * ```typescript
 * const result = await runVariantExperiment(
 *   { dataset, variants: [variantA, variantB], metric: 'passRate' },
 *   { mcp, testInfo }
 * );
 * if (result.proposal?.recommendation === 'apply') {
 *   console.log('Apply:', result.winner?.variant.id, '+', result.proposal.delta);
 * }
 * ```
 */
export async function runVariantExperiment(
  options: VariantExperimentOptions,
  context: EvalContext
): Promise<VariantExperimentResult> {
  const metric = options.metric ?? 'passRate';
  const maxRounds = options.maxRounds ?? 1;
  const minImprovement = options.minImprovement ?? 0;
  const allowRegressions = options.allowRegressions ?? false;

  const baseline = await runEvalDataset(
    buildRunOptions(options, undefined),
    context
  );

  const baselineValue = readMetric(baseline, metric);
  if (baselineValue === undefined) {
    throw new Error(
      `Metric '${metric}' is unavailable: the dataset produced no tool ` +
        `precision/recall data. Add mcp_host cases with toolsTriggered ` +
        `expectations, or use metric 'passRate'.`
    );
  }

  const rounds: VariantExperimentRound[] = [];
  let bestSoFar: VariantCandidateResult | undefined;
  let bestAttempted: VariantCandidateResult | undefined;
  let reason: VariantExperimentReason = 'max-rounds';

  for (let round = 0; round < maxRounds; round++) {
    const variants = await gatherVariants(options, {
      round,
      baseline,
      metric,
      history: rounds,
      bestSoFar,
    });

    if (variants.length === 0) {
      reason = round === 0 ? 'no-variants' : 'no-improvement';
      break;
    }

    const candidates: VariantCandidateResult[] = [];
    for (const variant of variants) {
      const candidate = await scoreVariant(
        options,
        context,
        baseline,
        baselineValue,
        metric,
        allowRegressions,
        variant
      );
      candidates.push(candidate);
      bestAttempted = pickBetter(bestAttempted, candidate, true);
    }

    const roundBest = candidates.reduce<VariantCandidateResult | undefined>(
      (best, candidate) => pickBetter(best, candidate, false),
      undefined
    );
    rounds.push({ round, candidates, best: roundBest });

    if (roundBest) {
      const improvement =
        roundBest.metricValue - (bestSoFar?.metricValue ?? baselineValue);
      bestSoFar = pickBetter(bestSoFar, roundBest, false);
      if (improvement < minImprovement) {
        reason = 'no-improvement';
        break;
      }
    }
  }

  const winner = bestSoFar;
  const proposalSource = winner ?? bestAttempted;
  const proposal = proposalSource
    ? buildProposal(metric, baselineValue, proposalSource, winner !== undefined)
    : undefined;

  return {
    metric,
    baseline,
    rounds,
    winner,
    proposal,
    converged: true,
    reason,
  };
}

async function gatherVariants(
  options: VariantExperimentOptions,
  context: ProposeVariantsContext
): Promise<ToolOverrideVariant[]> {
  if (context.round === 0 && options.variants && options.variants.length > 0) {
    return options.variants;
  }
  if (options.proposeVariants) {
    return options.proposeVariants(context);
  }
  return [];
}

async function scoreVariant(
  options: VariantExperimentOptions,
  context: EvalContext,
  baseline: EvalRunnerResult,
  baselineValue: number,
  metric: ExperimentMetric,
  allowRegressions: boolean,
  variant: ToolOverrideVariant
): Promise<VariantCandidateResult> {
  const result = await runEvalDataset(
    buildRunOptions(options, variant),
    context
  );
  const comparison = compareEvalRuns({
    baseline,
    candidate: result,
    labels: { candidate: variant.id },
  });
  const metricValue = readMetric(result, metric) ?? baselineValue;
  const disqualified =
    !allowRegressions && comparison.regressedCases.length > 0;

  return {
    variant,
    result,
    comparison,
    metricValue,
    metricDelta: metricValue - baselineValue,
    disqualified,
  };
}

/**
 * Returns the better of two candidates by metric value. When `includeDisqualified`
 * is false, disqualified candidates are never preferred (and an undefined return
 * means no eligible candidate). Ties keep the incumbent.
 */
function pickBetter(
  incumbent: VariantCandidateResult | undefined,
  challenger: VariantCandidateResult,
  includeDisqualified: boolean
): VariantCandidateResult | undefined {
  if (!includeDisqualified && challenger.disqualified) {
    return incumbent;
  }
  if (!incumbent) {
    return challenger;
  }
  return challenger.metricValue > incumbent.metricValue
    ? challenger
    : incumbent;
}

function buildProposal(
  metric: ExperimentMetric,
  baselineValue: number,
  source: VariantCandidateResult,
  isWinner: boolean
): VariantImprovementProposal {
  let recommendation: VariantRecommendation;
  if (isWinner) {
    recommendation = source.metricDelta > 0 ? 'apply' : 'inconclusive';
  } else {
    // No shippable winner: the best attempt was disqualified by a regression.
    recommendation = source.disqualified ? 'reject' : 'inconclusive';
  }

  return {
    variantId: source.variant.id,
    metric,
    baselineValue,
    candidateValue: source.metricValue,
    delta: source.metricDelta,
    toolChanges: source.variant.tools,
    improvedCaseIds: source.comparison.improvedCases.map((c) => c.id),
    regressedCaseIds: source.comparison.regressedCases.map((c) => c.id),
    recommendation,
  };
}

function readMetric(
  result: EvalRunnerResult,
  metric: ExperimentMetric
): number | undefined {
  switch (metric) {
    case 'passRate':
      return result.total > 0 ? result.passed / result.total : 0;
    case 'toolF1':
      return result.datasetToolF1;
    case 'toolPrecision':
      return result.datasetToolPrecision;
    case 'toolRecall':
      return result.datasetToolRecall;
  }
}

function buildRunOptions(
  options: VariantExperimentOptions,
  toolOverrides: ToolOverrideVariant | undefined
) {
  return {
    dataset: options.dataset,
    toolOverrides,
    defaultLlmIterations: options.defaultLlmIterations,
    defaultJudgeReps: options.defaultJudgeReps,
    concurrency: options.concurrency,
    filterTags: options.filterTags,
    schemas: options.schemas,
    mcpHostModel: options.mcpHostModel,
    judgeModel: options.judgeModel,
  };
}
