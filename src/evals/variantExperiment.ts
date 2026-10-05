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
import type { MCPVariantExperimentData } from '../types/reporter.js';
import type { ZodType } from 'zod';
import { attachReporterData } from '../reporters/channel.js';
import { passRate } from './evalRunComparison.js';
import type { EvalArm } from './evalManifest.js';
import type { EvaluationArmResult } from './evalFrameworkTypes.js';
import type { Plugin } from '../plugins/plugin.js';
import { runEvalSuite } from './runEvalSuite.js';

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

/** A dataset metric, or (in suite mode) any numeric arm metric. */
type MetricName = ExperimentMetric | (string & {});

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
   * is not set, or reported no value for the metric. Disqualified candidates
   * can never become the winner.
   */
  disqualified: boolean;
  /**
   * The candidate reported no value for the metric (a suite arm can lack
   * one, such as `cost_usd` from an unpriced host); `metricValue` is then the
   * baseline's.
   */
  metricUnavailable?: true;
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
  /**
   * The baseline run: no tool variant on a dataset; on a suite, the base
   * arm as configured, including its own `toolOverrides` (variants replace
   * them).
   */
  baseline: EvalRunnerResult;
  /** The metric the experiment is optimizing. */
  metric: MetricName;
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
  metric: MetricName;
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

/** Where a suite-mode experiment runs. */
export interface VariantExperimentSuite {
  /** The manifest whose datasets, servers, host and judges the experiment uses. */
  manifestPath: string;
  /**
   * The arm variants build on, which is also the baseline: each variant runs
   * as a copy of it with the variant as its `toolOverrides`. Default: the
   * manifest's first arm, or the manifest's own settings when it has none.
   */
  arm?: string;
  rootDir?: string;
  pluginPaths?: string[];
  plugins?: readonly Plugin[];
  secretsFile?: string;
}

/**
 * Options for {@link runVariantExperiment} on a suite: variants run as arms,
 * on any host that can take tool variants (in-process or through MST's tool
 * proxy), and any numeric arm metric can be the target.
 */
export interface SuiteVariantExperimentOptions extends Pick<
  VariantExperimentOptions,
  | 'variants'
  | 'proposeVariants'
  | 'maxRounds'
  | 'minImprovement'
  | 'allowRegressions'
> {
  suite: VariantExperimentSuite;
  /**
   * The arm metric to optimize: `passRate`, `trialPassRate`, or any numeric
   * key of an arm's `metrics`, such as `tool_search_hit_rate` or
   * `input_tokens_mean`.
   * @default 'passRate'
   */
  metric?: string;
  /** Whether higher or lower values of `metric` are better. @default 'higher' */
  better?: 'higher' | 'lower';
}

/** Aggregated result of a variant experiment. */
export interface VariantExperimentResult {
  /** Metric that was optimized. */
  metric: MetricName;
  /**
   * The baseline run: no tool variant on a dataset; on a suite, the base
   * arm as configured, including its own `toolOverrides` (variants replace
   * them).
   */
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
 *
 * // On a suite: variants run as arms, on any host that takes tool variants.
 * const onSuite = await runVariantExperiment({
 *   suite: { manifestPath: './eval-manifest.json' },
 *   variants: [variantA, variantB],
 *   metric: 'tool_search_hit_rate',
 * });
 * if (result.proposal?.recommendation === 'apply') {
 *   console.log('Apply:', result.winner?.variant.id, '+', result.proposal.delta);
 * }
 * ```
 */
export async function runVariantExperiment(
  options: SuiteVariantExperimentOptions
): Promise<VariantExperimentResult>;
export async function runVariantExperiment(
  options: VariantExperimentOptions,
  context: EvalContext
): Promise<VariantExperimentResult>;
export async function runVariantExperiment(
  options: VariantExperimentOptions | SuiteVariantExperimentOptions,
  context?: EvalContext
): Promise<VariantExperimentResult> {
  if ('suite' in options) {
    return experiment(
      options,
      options.metric ?? 'passRate',
      options.better ?? 'higher',
      { run: suiteRunner(options), withBaseline: true },
      undefined
    );
  }
  if (!context)
    throw new Error(
      'runVariantExperiment needs an EvalContext for a dataset experiment.'
    );
  const metric = options.metric ?? 'passRate';
  // Internal eval runs must not attach to the reporter individually, or the
  // report would show only the baseline run. We attach the winner's results
  // plus an experiment summary once, at the end, when testInfo is present.
  const internalContext: EvalContext = {
    mcp: context.mcp,
    expect: context.expect,
  };
  const run: RunVariants = async (variants) => {
    const runs: ExperimentRun[] = [];
    for (const variant of variants) {
      const result = await runEvalDataset(
        buildRunOptions(options, variant),
        internalContext
      );
      runs.push({ result, value: readMetric(result, metric) });
    }
    return runs;
  };
  return experiment(
    options,
    metric,
    'higher',
    { run, withBaseline: false },
    context
  );
}

/** A run of the baseline (no variant) or a variant, with its metric value. */
interface ExperimentRun {
  result: EvalRunnerResult;
  value: number | undefined;
}

/** Runs the baseline (`undefined`) or variants, in order. */
type RunVariants = (
  variants: Array<ToolOverrideVariant | undefined>
) => Promise<ExperimentRun[]>;

interface ExperimentRunner {
  run: RunVariants;
  /** Run round 0's static variants together with the baseline. */
  withBaseline: boolean;
}

/** Each call runs one suite whose arms are the base arm and/or variants of it. */
function suiteRunner(options: SuiteVariantExperimentOptions): RunVariants {
  const { suite } = options;
  const metric = options.metric ?? 'passRate';
  return async (variants) => {
    const { summary } = await runEvalSuite({
      manifestPath: suite.manifestPath,
      rootDir: suite.rootDir,
      pluginPaths: suite.pluginPaths,
      plugins: suite.plugins,
      secretsFile: suite.secretsFile,
      arms: (manifestArms) => {
        const base =
          suite.arm === undefined
            ? (manifestArms[0] ?? { name: 'default' })
            : manifestArms.find((arm) => arm.name === suite.arm);
        if (!base)
          throw new Error(`The manifest has no arm named "${suite.arm}".`);
        const names = new Set<string>();
        return variants.map((variant) => {
          const arm: EvalArm = variant
            ? { ...base, name: variant.id, toolOverrides: variant }
            : base;
          if (names.has(arm.name) || (variant && variant.id === base.name))
            throw new Error(
              `Variant ids must be unique and differ from the base arm's name; "${arm.name}" repeats.`
            );
          names.add(arm.name);
          return arm;
        });
      },
    });
    return summary.arms.map((arm) => ({
      result: arm.result!,
      value: armMetric(arm, metric),
    }));
  };
}

/** An arm's value for a suite-mode metric, if it reports one. */
function armMetric(
  arm: EvaluationArmResult,
  metric: string
): number | undefined {
  if (metric === 'passRate')
    return arm.result ? passRate(arm.result) : undefined;
  const key = metric === 'trialPassRate' ? 'trial_pass_rate' : metric;
  const value = arm.metrics?.[key];
  return typeof value === 'number' ? value : undefined;
}

async function experiment(
  options: Pick<
    VariantExperimentOptions,
    | 'variants'
    | 'proposeVariants'
    | 'maxRounds'
    | 'minImprovement'
    | 'allowRegressions'
  >,
  metric: MetricName,
  better: 'higher' | 'lower',
  runner: ExperimentRunner,
  context: EvalContext | undefined
): Promise<VariantExperimentResult> {
  const maxRounds = options.maxRounds ?? 1;
  const minImprovement = options.minImprovement ?? 0;
  const allowRegressions = options.allowRegressions ?? false;
  // How much better a value is: larger is better either way.
  const gain = (value: number) => (better === 'lower' ? -value : value);

  // On a suite, static round-0 variants run with the baseline: one suite
  // run, which also checks their ids before anything runs. A dataset runs the
  // baseline first, so an unavailable metric fails before any candidate runs.
  const initialVariants = runner.withBaseline ? (options.variants ?? []) : [];
  const [baselineRun, ...initialRuns] = await runner.run([
    undefined,
    ...initialVariants,
  ]);
  const baseline = baselineRun!.result;
  const baselineValue = baselineRun!.value;
  if (baselineValue === undefined) {
    throw new Error(
      `Metric '${metric}' is unavailable for the baseline. For a dataset, ` +
        `the tool metrics need mcp_host cases with toolsTriggered ` +
        `expectations; for a suite, use passRate, trialPassRate or a numeric ` +
        `metric the base arm reports (tool F1, precision and recall are ` +
        `dataset metrics).`
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

    const runs =
      round === 0 && initialVariants.length > 0 && variants === options.variants
        ? initialRuns
        : await runner.run(variants);
    const candidates = variants.map((variant, index) =>
      scoreVariant(
        baseline,
        baselineValue,
        allowRegressions,
        variant,
        runs[index]!
      )
    );
    for (const candidate of candidates)
      bestAttempted = pickBetter(bestAttempted, candidate, true, gain);

    const roundBest = candidates.reduce<VariantCandidateResult | undefined>(
      (best, candidate) => pickBetter(best, candidate, false, gain),
      undefined
    );
    rounds.push({ round, candidates, best: roundBest });

    if (roundBest) {
      const improvement =
        gain(roundBest.metricValue) -
        gain(bestSoFar?.metricValue ?? baselineValue);
      bestSoFar = pickBetter(bestSoFar, roundBest, false, gain);
      if (improvement < minImprovement) {
        reason = 'no-improvement';
        break;
      }
    }
  }

  const winner = bestSoFar;
  const proposalSource = winner ?? bestAttempted;
  const proposal = proposalSource
    ? buildProposal(
        metric,
        baselineValue,
        proposalSource,
        winner !== undefined,
        gain
      )
    : undefined;

  const result: VariantExperimentResult = {
    metric,
    baseline,
    rounds,
    winner,
    proposal,
    converged: true,
    reason,
  };

  if (context?.testInfo) {
    // Surface the best run's case results so the report reflects the optimized
    // state, plus a compact summary of how the experiment got there.
    const surfaceRun = winner?.result ?? bestAttempted?.result ?? baseline;
    await attachReporterData(context.testInfo, {
      kind: 'evalResults',
      data: { caseResults: surfaceRun.caseResults },
    });
    await attachReporterData(context.testInfo, {
      kind: 'variantExperiment',
      data: buildExperimentData(result, baselineValue),
    });
  }

  return result;
}

function buildExperimentData(
  result: VariantExperimentResult,
  baselineValue: number
): MCPVariantExperimentData {
  return {
    metric: result.metric,
    baselineValue,
    bestValue:
      result.winner?.metricValue ??
      result.proposal?.candidateValue ??
      baselineValue,
    rounds: result.rounds.map((round) => {
      const best = round.best ?? round.candidates[0];
      return {
        round: round.round,
        variantId: best?.variant.id ?? '(none)',
        metricValue: best?.metricValue ?? baselineValue,
        metricDelta: best?.metricDelta ?? 0,
        disqualified: best?.disqualified ?? false,
      };
    }),
    winnerVariantId: result.winner?.variant.id,
    recommendation: result.proposal?.recommendation,
    reason: result.reason,
  };
}

async function gatherVariants(
  options: Pick<VariantExperimentOptions, 'variants' | 'proposeVariants'>,
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

function scoreVariant(
  baseline: EvalRunnerResult,
  baselineValue: number,
  allowRegressions: boolean,
  variant: ToolOverrideVariant,
  run: ExperimentRun
): VariantCandidateResult {
  const comparison = compareEvalRuns({
    baseline,
    candidate: run.result,
    labels: { candidate: variant.id },
  });
  const metricValue = run.value ?? baselineValue;
  const disqualified =
    run.value === undefined ||
    (!allowRegressions && comparison.regressedCases.length > 0);

  return {
    variant,
    result: run.result,
    comparison,
    metricValue,
    metricDelta: metricValue - baselineValue,
    disqualified,
    ...(run.value === undefined ? { metricUnavailable: true as const } : {}),
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
  includeDisqualified: boolean,
  gain: (value: number) => number
): VariantCandidateResult | undefined {
  if (!includeDisqualified && challenger.disqualified) {
    return incumbent;
  }
  if (!incumbent) {
    return challenger;
  }
  return gain(challenger.metricValue) > gain(incumbent.metricValue)
    ? challenger
    : incumbent;
}

function buildProposal(
  metric: MetricName,
  baselineValue: number,
  source: VariantCandidateResult,
  isWinner: boolean,
  gain: (value: number) => number
): VariantImprovementProposal {
  let recommendation: VariantRecommendation;
  if (isWinner) {
    recommendation =
      gain(source.metricValue) > gain(baselineValue) ? 'apply' : 'inconclusive';
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
      return passRate(result);
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
    // The experiment attaches the winning run itself.
    reporting: 'none' as const,
    defaultLlmIterations: options.defaultLlmIterations,
    defaultJudgeReps: options.defaultJudgeReps,
    concurrency: options.concurrency,
    filterTags: options.filterTags,
    schemas: options.schemas,
    mcpHostModel: options.mcpHostModel,
    judgeModel: options.judgeModel,
  };
}
