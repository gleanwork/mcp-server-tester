import { rejectRenamedOptions } from './renamedKeys.js';
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
import type {
  EvalCaseResult,
  MCPToolOptimizationData,
  PairedChange,
  RegressionCheck,
  VariantGrouping,
} from '../types/reporter.js';
import type { ZodType } from 'zod';
import { attachReporterData } from '../reporters/channel.js';
import type { EvalVariant } from './evalConfig.js';
import type { EvaluationVariantResult } from './evalFrameworkTypes.js';
import type { Plugin } from '../plugins/plugin.js';
import { runEval } from './runEval.js';
import {
  DEFAULT_HELD_OUT_TAG,
  DEFAULT_REGRESSION_TAG,
  compareVariants,
  breaksRegressionCases,
  caseTags,
  meanCasePassRate,
  measureAgainstBaseline,
  scoreChange,
} from './variantComparison.js';
import type {
  CompareVariantsOptions,
  BaselineMeasurement,
  CaseGrouping,
} from './variantComparison.js';

/**
 * Metric used to rank variant candidates and decide improvement. Every
 * metric is computed without held-out cases.
 *
 * - `passRate`: mean per-case share of trials that passed (pass@1, each
 *   case weighted equally). Always available. With one trial per case
 *   this is the share of cases that passed.
 * - `toolF1` / `toolPrecision` / `toolRecall`: dataset-level tool-call metrics,
 *   only available when the dataset has client cases with `toolsTriggered`
 *   assertions. Choosing one of these when no such cases exist throws a clear
 *   error rather than silently ranking on nothing.
 */
export type OptimizationMetric =
  | 'passRate'
  | 'toolF1'
  | 'toolPrecision'
  | 'toolRecall';

/** A dataset metric, or (in eval mode) any numeric variant metric. */
type MetricName = OptimizationMetric | (string & {});

const EXPERIMENT_METRICS = new Set<string>([
  'passRate',
  'toolF1',
  'toolPrecision',
  'toolRecall',
]);
function isOptimizationMetric(
  metric: MetricName
): metric is OptimizationMetric {
  return EXPERIMENT_METRICS.has(metric);
}

/**
 * Why a tool optimization stopped.
 *
 * - `no-variants`: no candidates were ever produced (round 0 yielded none).
 * - `no-improvement`: a round's best candidate did not beat the best-so-far by
 *   at least `minImprovement`, or `proposeVariants` returned no further
 *   candidates.
 * - `max-rounds`: the configured `maxRounds` budget was exhausted.
 * - `threshold-met`: reserved for future absolute-target convergence; not
 *   emitted by the current delta-based logic.
 */
export type ToolOptimizationReason =
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
  /** The selected metric's value for this candidate, without held-out cases. */
  metricValue: number;
  /** `metricValue` minus the baseline's metric value. */
  metricDelta: number;
  /**
   * Pass rates and per-case changes from the baseline on capability
   * (`capability`) and regression (`regression`) cases. Once the optimization
   * ends, improvement assessments account for every variant tried.
   */
  measurement: BaselineMeasurement;
  /**
   * The metric's paired per-case change from the baseline, over every case.
   * `passRate` uses `measurement.capability.change`.
   */
  improvement: PairedChange;
  /**
   * True when the candidate is clearly better than the baseline after
   * adjusting for every variant tried: the metric improved (up, or down with
   * `better: 'lower'`), and for a dataset metric its paired per-case change
   * passes the sign-flip test at `0.025 / variantsTried`. A variant metric has
   * no per-case scores, so its improvement is taken as is. Final once the
   * optimization ends.
   */
  fixes: boolean;
  /**
   * True when this candidate breaks cases that work today, as judged by
   * `regressionCheck`, and `allowRegressions` is not set, or when it
   * reported no value for the metric. Disqualified candidates can never
   * become the winner.
   */
  disqualified: boolean;
  /**
   * The candidate reported no value for the metric (an eval variant can lack
   * one, such as `cost_usd` from an unpriced client); `metricValue` is then the
   * baseline's.
   */
  metricUnavailable?: true;
}

/** All candidates tried in a single round, plus the round's best non-disqualified pick. */
export interface ToolOptimizationRound {
  /** 0-based round index. */
  round: number;
  /** Every candidate scored this round, in input order. */
  candidates: VariantCandidateResult[];
  /** Highest-scoring non-disqualified candidate this round, if any. */
  best?: VariantCandidateResult;
}

/**
 * Context passed to a `proposeVariants` callback before each round. Held-out
 * cases are removed from every run in it, so proposals can't be tuned to
 * them and they stay a fair check on the winner.
 */
export interface ProposeVariantsContext {
  /** 0-based index of the round about to run. */
  round: number;
  /** The original baseline run (no overrides), without held-out cases. */
  baseline: EvalRunnerResult;
  /** The metric the optimization is optimizing. */
  metric: MetricName;
  /** All completed rounds so far, in order, without held-out cases. */
  history: ToolOptimizationRound[];
  /** Best non-disqualified candidate across all prior rounds, if any. */
  bestSoFar?: VariantCandidateResult;
}

/** A structured, ready-to-act proposal derived from the best attempted candidate. */
export interface VariantImprovementProposal {
  /** `id` of the variant this proposal describes. */
  variantId: string;
  /** Metric the optimization optimized. */
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
   * `apply` when the variant improved the metric without breaking cases
   * (with `regressionCheck: 'significant'` and the `passRate` metric, the
   * improvement on cases the baseline fails must also be clear); `reject`
   * when the best candidate tried broke cases (and regressions are not allowed);
   * `inconclusive` when nothing clearly beat baseline.
   */
  recommendation: VariantRecommendation;
}

/** Options for {@link runToolOptimization}. */
export interface ToolOptimizationOptions {
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
  metric?: OptimizationMetric;
  /** Maximum number of rounds to run. @default 1 */
  maxRounds?: number;
  /**
   * Convergence threshold. Stop when a round's best metric improvement over the
   * prior best-so-far is below this value. @default 0
   */
  minImprovement?: number;
  /**
   * When false (default), any candidate that breaks cases under
   * `regressionCheck` is disqualified from winning and surfaced with
   * `recommendation: 'reject'`. When true, breakage does not disqualify.
   * @default false
   */
  allowRegressions?: boolean;
  /**
   * How "breaks cases that work today" is judged, on regression
   * (`regression`) cases. See `regressionTag` for how those are chosen.
   *
   * - `significant` (default): each case scores the share of its trials
   *   that passed. The candidate is disqualified when regression cases
   *   clearly got worse: as a group (exact paired sign-flip test, one-sided
   *   p < 0.025), or any one case on its own (Fisher's exact test on its
   *   trials, Holm-corrected at 0.05 across regression cases). One flaky
   *   trial is noise, not breakage.
   * - `any-case`: any case that passed with the baseline and fails with the
   *   candidate disqualifies it, however small the drop. With flaky cases
   *   this rejects good variants for noise.
   *
   * Either way, a candidate is recommended only when it is clearly better:
   * the sign-flip test on its paired per-case change passes at
   * `0.025 / variantsTried`.
   * @default 'significant'
   */
  regressionCheck?: RegressionCheck;
  /**
   * Cases with this tag are regression cases (they must keep working), and
   * every other case is a capability case a variant should improve. When no
   * case has the tag, the optimization runs the baseline once more and treats
   * the cases that passed that run as regression cases. It never groups by
   * the baseline run variants are compared with, which would build in
   * regression to the mean.
   * @default 'regression'
   */
  regressionTag?: string;
  /**
   * Cases with this tag are held out: they don't count toward ranking, and
   * `proposeVariants` never sees them, so their results are a fair check on
   * the winner. They still count toward breakage and improvement checks.
   * @default 'held-out'
   */
  heldOutTag?: string;
  /** Default trials per client case. Forwarded to `runEvalDataset`. */
  defaultTrials?: number;
  /** Default judge repetitions per case. Forwarded to `runEvalDataset`. */
  defaultJudgeReps?: number;
  /** Max eval cases to run concurrently within each run. Forwarded to `runEvalDataset`. */
  concurrency?: number;
  /** Run only cases with at least one of these tags. Forwarded to `runEvalDataset`. */
  filterTags?: string[];
  /** Schema registry for `assertions.schema` cases. Forwarded to `runEvalDataset`. */
  schemas?: Record<string, ZodType>;
  /** The model cases run on, and recorded in run metadata. Forwarded to `runEvalDataset`. */
  model?: string;
  /** Judge model identifier recorded in run metadata. */
  judgeModel?: string;
}

/** Where a tool optimization on an eval runs. */
export interface ToolOptimizationEval {
  /** The eval config whose datasets, servers, client and judges the optimization uses. */
  configPath: string;
  /**
   * The config's variant the candidates build on, which is also the
   * baseline: each candidate runs as a copy of it with the candidate's tool
   * metadata as its `tools`. Default: the config's baseline (its first
   * variant), or the config's own settings when it has none.
   */
  baseVariant?: string;
  rootDir?: string;
  pluginPaths?: string[];
  plugins?: readonly Plugin[];
  secretsFile?: string;
}

/**
 * Options for {@link runToolOptimization} on an eval: candidates run as the
 * config's variants, on any client that can show tool metadata (in-process or
 * through MST's tool proxy), and any numeric variant metric can be the target.
 */
export interface EvalToolOptimizationOptions extends Pick<
  ToolOptimizationOptions,
  | 'variants'
  | 'proposeVariants'
  | 'maxRounds'
  | 'minImprovement'
  | 'allowRegressions'
  | 'regressionCheck'
  | 'regressionTag'
  | 'heldOutTag'
> {
  evalConfig: ToolOptimizationEval;
  /**
   * The variant metric to optimize: `passRate`, `trialPassRate`, or any numeric
   * key of a variant's `metrics`, such as `tool_search_hit_rate` or
   * `input_tokens_mean`.
   * @default 'passRate'
   */
  metric?: string;
  /** Whether higher or lower values of `metric` are better. @default 'higher' */
  better?: 'higher' | 'lower';
}

/** Aggregated result of a tool optimization. */
export interface ToolOptimizationResult {
  /** Metric that was optimized. */
  metric: MetricName;
  /**
   * The baseline run: no tool metadata on a dataset; on an eval, the base
   * variant as configured, including its own `tools` (candidates replace
   * them).
   */
  baseline: EvalRunnerResult;
  /** Where the case groups came from. */
  grouping: VariantGrouping;
  /**
   * The extra baseline run used only to group cases, when no case had the
   * regression tag.
   */
  groupingBaseline?: EvalRunnerResult;
  /** Every round that ran, in order. */
  rounds: ToolOptimizationRound[];
  /** Best non-disqualified candidate across all rounds, if any. */
  winner?: VariantCandidateResult;
  /** Structured proposal derived from the best attempted candidate, if any ran. */
  proposal?: VariantImprovementProposal;
  /** True when the optimization stopped on its own terms (always true today). */
  converged: boolean;
  /** Why the optimization stopped. */
  reason: ToolOptimizationReason;
}

/**
 * Runs a tool-metadata tool optimization: establishes a baseline, then injects
 * each candidate variant via `toolOverrides`, compares it to the baseline,
 * ranks by the chosen metric, guards against regressions, and emits a structured
 * improvement proposal.
 *
 * The library owns the optimization mechanism; the *policy* — which variant to try
 * next — is the caller's, supplied either as a static `variants` list or an
 * iterative `proposeVariants` callback. This is the programmatic spine an AI or
 * skill drives to optimize tool descriptions/schemas for better client triggering.
 *
 * Candidates are always compared against the original baseline (not the prior
 * round), so the resulting proposal is directly applicable. Multi-round
 * convergence is tracked separately via best-so-far.
 *
 * @example
 * ```typescript
 * const result = await runToolOptimization(
 *   { dataset, variants: [variantA, variantB], metric: 'passRate' },
 *   { mcp, testInfo }
 * );
 * if (result.proposal?.recommendation === 'apply') {
 *   console.log('Apply:', result.winner?.variant.id, '+', result.proposal.delta);
 * }
 * ```
 */
export async function runToolOptimization(
  options: EvalToolOptimizationOptions
): Promise<ToolOptimizationResult>;
export async function runToolOptimization(
  options: ToolOptimizationOptions,
  context: EvalContext
): Promise<ToolOptimizationResult>;
export async function runToolOptimization(
  options: ToolOptimizationOptions | EvalToolOptimizationOptions,
  context?: EvalContext
): Promise<ToolOptimizationResult> {
  if ('evalConfig' in options) {
    rejectRenamedOptions(
      options.evalConfig,
      { manifestPath: 'configPath', arm: 'baseVariant' },
      'runToolOptimization evalConfig'
    );
    return optimize(
      options,
      options.metric ?? 'passRate',
      options.better ?? 'higher',
      { run: evalRunner(options), withBaseline: true },
      undefined
    );
  }
  rejectRenamedOptions(
    options,
    { mcpHostModel: 'model', suite: 'evalConfig', eval: 'evalConfig' },
    'runToolOptimization'
  );
  if (!context)
    throw new Error(
      'runToolOptimization needs an EvalContext for a dataset optimization.'
    );
  const metric = options.metric ?? 'passRate';
  // Internal eval runs must not attach to the reporter individually, or the
  // report would show only the baseline run. We attach the winner's results
  // plus an optimization summary once, at the end, when testInfo is present.
  const internalContext: EvalContext = { mcp: context.mcp };
  const run: RunVariants = async (variants) => {
    const runs: OptimizationRun[] = [];
    for (const variant of variants) {
      const result = await runEvalDataset(
        buildRunOptions(options, variant),
        internalContext
      );
      runs.push({
        result,
        value: isOptimizationMetric(metric)
          ? readMetric(result, metric)
          : undefined,
      });
    }
    return runs;
  };
  return optimize(
    options,
    metric,
    'higher',
    { run, withBaseline: false },
    context
  );
}

/** A run of the baseline (no variant) or a variant, with its metric value. */
interface OptimizationRun {
  result: EvalRunnerResult;
  value: number | undefined;
}

/** Runs the baseline (`undefined`) or variants, in order. */
type RunVariants = (
  variants: Array<ToolOverrideVariant | undefined>
) => Promise<OptimizationRun[]>;

interface OptimizationRunner {
  run: RunVariants;
  /** Run round 0's static variants together with the baseline. */
  withBaseline: boolean;
}

/** Each call runs one eval whose variants are the base variant and/or candidates built on it. */
function evalRunner(options: EvalToolOptimizationOptions): RunVariants {
  const { evalConfig: target } = options;
  const metric = options.metric ?? 'passRate';
  return async (variants) => {
    const { summary } = await runEval({
      configPath: target.configPath,
      rootDir: target.rootDir,
      // Rounds rank candidates by the metric; pairwise judges would only cost.
      skipPairwise: true,
      // The optimization writes its own report.
      report: false,
      pluginPaths: target.pluginPaths,
      plugins: target.plugins,
      secretsFile: target.secretsFile,
      variants: (configVariants) => {
        const base =
          target.baseVariant === undefined
            ? (configVariants[0] ?? { name: 'default' })
            : configVariants.find(
                (candidate) => candidate.name === target.baseVariant
              );
        if (!base)
          throw new Error(
            `The eval config has no variant named "${target.baseVariant}".`
          );
        const names = new Set<string>();
        return variants.map((candidate) => {
          const variant: EvalVariant = candidate
            ? {
                ...base,
                name: candidate.id,
                ...(candidate.description !== undefined
                  ? { description: candidate.description }
                  : {}),
                tools: candidate.tools,
              }
            : base;
          if (
            names.has(variant.name) ||
            (candidate && candidate.id === base.name)
          )
            throw new Error(
              `Candidate ids must be unique and differ from the base variant's name; "${variant.name}" repeats.`
            );
          names.add(variant.name);
          return variant;
        });
      },
    });
    return summary.variants.map((variant) => ({
      result: variant.result!,
      value: variantMetric(variant, metric),
    }));
  };
}

/** A variant's value for an eval-config metric, if it reports one. */
function variantMetric(
  variant: EvaluationVariantResult,
  metric: string
): number | undefined {
  if (metric === 'passRate')
    return variant.result ? meanCasePassRate(variant.result) : undefined;
  const key = metric === 'trialPassRate' ? 'trial_pass_rate' : metric;
  const value = variant.metrics?.[key];
  return typeof value === 'number' ? value : undefined;
}

async function optimize(
  options: Pick<
    ToolOptimizationOptions,
    | 'variants'
    | 'proposeVariants'
    | 'maxRounds'
    | 'minImprovement'
    | 'allowRegressions'
    | 'regressionCheck'
    | 'regressionTag'
    | 'heldOutTag'
  >,
  metric: MetricName,
  better: 'higher' | 'lower',
  runner: OptimizationRunner,
  context: EvalContext | undefined
): Promise<ToolOptimizationResult> {
  const maxRounds = options.maxRounds ?? 1;
  const minImprovement = options.minImprovement ?? 0;
  const allowRegressions = options.allowRegressions ?? false;
  const regressionCheck = options.regressionCheck ?? 'significant';
  const heldOutTag = options.heldOutTag ?? DEFAULT_HELD_OUT_TAG;
  const regressionTag = options.regressionTag ?? DEFAULT_REGRESSION_TAG;
  // How much better a value is: larger is better either way.
  const gain = (value: number) => (better === 'lower' ? -value : value);

  // On an eval, static round-0 variants run with the baseline: one eval
  // run, which also checks their ids before anything runs. A dataset runs the
  // baseline first, so an unavailable metric fails before any candidate runs.
  const initialVariants = runner.withBaseline ? (options.variants ?? []) : [];
  const [baselineRun, ...initialRuns] = await runner.run([
    undefined,
    ...initialVariants,
  ]);
  const baseline = baselineRun!.result;
  const seenBaseline = withoutHeldOut(baseline, heldOutTag);
  const baselineValue = metricOf(baselineRun!, metric, heldOutTag);
  if (baselineValue === undefined) {
    throw new Error(
      `Metric '${metric}' is unavailable for the baseline. For a dataset, ` +
        `the tool metrics need client cases with toolsTriggered ` +
        `assertions; for an eval, use passRate, trialPassRate or a numeric ` +
        `metric the base variant reports (tool F1, precision and recall are ` +
        `dataset metrics).`
    );
  }

  // Groups must not come from `baseline` itself: cases picked for passing a
  // run tend to do worse when re-run, and cases picked for failing tend to do
  // better, even with no change at all. Declared tags are independent of any
  // run; otherwise a separate run does the grouping. It runs only once there
  // is a variant to compare.
  const declared = baseline.caseResults.some((c) =>
    caseTags(c).includes(regressionTag)
  );
  let grouping: CaseGrouping | undefined = declared
    ? { source: 'declared', tag: regressionTag }
    : undefined;
  let groupingBaseline: EvalRunnerResult | undefined;
  const ensureGrouping = async (): Promise<CaseGrouping> => {
    if (!grouping) {
      const [groupingRun] = await runner.run([undefined]);
      groupingBaseline = groupingRun!.result;
      grouping = { source: 'grouping-run', run: groupingBaseline };
    }
    return grouping;
  };

  const rounds: ToolOptimizationRound[] = [];
  const proposerHistory: ToolOptimizationRound[] = [];
  let bestSoFar: VariantCandidateResult | undefined;
  let bestAttempted: VariantCandidateResult | undefined;
  let reason: ToolOptimizationReason = 'max-rounds';

  for (let round = 0; round < maxRounds; round++) {
    const variants = await gatherVariants(options, {
      round,
      baseline: seenBaseline,
      metric,
      history: proposerHistory,
      bestSoFar: bestSoFar && proposerViewOf(bestSoFar, proposerHistory),
    });

    if (variants.length === 0) {
      reason = round === 0 ? 'no-variants' : 'no-improvement';
      break;
    }

    const runs =
      round === 0 && initialVariants.length > 0 && variants === options.variants
        ? initialRuns
        : await runner.run(variants);
    const rules: ScoringRules = {
      metric,
      better,
      allowRegressions,
      regressionCheck,
      heldOutTag,
      grouping: await ensureGrouping(),
    };
    const candidates = variants.map((variant, index) =>
      scoreVariant(baseline, baselineValue, rules, variant, runs[index]!)
    );
    for (const candidate of candidates)
      bestAttempted = pickBetter(bestAttempted, candidate, true, gain);

    const roundBest = candidates.reduce<VariantCandidateResult | undefined>(
      (best, candidate) => pickBetter(best, candidate, false, gain),
      undefined
    );
    rounds.push({ round, candidates, best: roundBest });
    proposerHistory.push(
      proposerRound({ round, candidates, best: roundBest }, seenBaseline, rules)
    );

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

  // Trying more variants raises the chance that one looks better by luck, so
  // improvement is judged once, at the end, against every variant tried.
  const tried = rounds.reduce((n, round) => n + round.candidates.length, 0);
  if (grouping) {
    const finalGrouping: CaseGrouping = grouping;
    for (const candidate of rounds.flatMap((r) => r.candidates)) {
      judgeImprovement(candidate, baseline, {
        metric,
        better,
        grouping: finalGrouping,
        heldOutTag,
        variantsTried: tried,
      });
    }
  }

  const winner = bestSoFar;
  const proposalSource = winner ?? bestAttempted;
  const proposal = proposalSource
    ? buildProposal(metric, baselineValue, proposalSource, winner !== undefined)
    : undefined;

  const result: ToolOptimizationResult = {
    metric,
    baseline,
    grouping: grouping?.source ?? (declared ? 'declared' : 'grouping-run'),
    ...(groupingBaseline ? { groupingBaseline } : {}),
    rounds,
    winner,
    proposal,
    converged: true,
    reason,
  };

  if (context?.testInfo) {
    // Surface the best run's case results so the report reflects the optimized
    // state, plus a compact summary of how the optimization got there.
    const surfaceRun = winner?.result ?? bestAttempted?.result ?? baseline;
    await attachReporterData(context.testInfo, {
      kind: 'evalResults',
      data: { caseResults: surfaceRun.caseResults },
    });
    const originalTools = await readOriginalTools(context, result);
    await attachReporterData(context.testInfo, {
      kind: 'toolOptimization',
      data: buildToolOptimizationData(result, baselineValue, {
        regressionCheck,
        regressionTag,
        heldOutTag,
        originalTools,
      }),
    });
  }

  return result;
}

/**
 * A run's value for `metric`. Dataset metrics are computed without held-out
 * cases; a variant metric (eval mode) is the variant's own value.
 */
function metricOf(
  run: OptimizationRun,
  metric: MetricName,
  heldOutTag: string
): number | undefined {
  return isOptimizationMetric(metric)
    ? readMetric(withoutHeldOut(run.result, heldOutTag), metric)
    : run.value;
}

/**
 * The server's own metadata for the tools the variants change, so the report
 * can show what each variant changed. Best effort: a failure leaves it out.
 */
async function readOriginalTools(
  context: EvalContext,
  result: ToolOptimizationResult
): Promise<CompareVariantsOptions['originalTools']> {
  const changed = new Set(
    result.rounds.flatMap((round) =>
      round.candidates.flatMap((c) => Object.keys(c.variant.tools))
    )
  );
  if (changed.size === 0 || typeof context.mcp?.listTools !== 'function') {
    return undefined;
  }
  try {
    const tools = await context.mcp.listTools();
    return Object.fromEntries(
      tools
        .filter((tool) => changed.has(tool.name))
        .map((tool) => [
          tool.name,
          { description: tool.description, inputSchema: tool.inputSchema },
        ])
    );
  } catch {
    return undefined;
  }
}

function buildToolOptimizationData(
  result: ToolOptimizationResult,
  baselineValue: number,
  report: Pick<
    CompareVariantsOptions,
    'regressionCheck' | 'heldOutTag' | 'originalTools'
  > & { regressionTag: string }
): MCPToolOptimizationData {
  const { regressionTag, ...analysis } = report;
  const recommendedId =
    result.proposal?.recommendation === 'apply'
      ? result.winner?.variant.id
      : undefined;
  const candidates = result.rounds.flatMap((round) => round.candidates);
  // With no variants and no tags, no grouping run happened: group nothing.
  const grouping: CaseGrouping =
    result.grouping === 'declared'
      ? { source: 'declared', tag: regressionTag }
      : {
          source: 'grouping-run',
          run: result.groupingBaseline ?? {
            total: 0,
            passed: 0,
            failed: 0,
            caseResults: [],
            durationMs: 0,
          },
        };
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
    comparison: compareVariants({
      baseline: result.baseline,
      candidates: candidates.map((c) => ({
        id: c.variant.id,
        description: c.variant.description,
        tools: c.variant.tools,
        result: c.result,
        fixes: c.fixes,
        disqualified: c.disqualified,
      })),
      winnerId: recommendedId,
      grouping,
      variantsTried: candidates.length,
      ...analysis,
    }),
  };
}

async function gatherVariants(
  options: Pick<ToolOptimizationOptions, 'variants' | 'proposeVariants'>,
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

interface ScoringRules {
  metric: MetricName;
  better: 'higher' | 'lower';
  allowRegressions: boolean;
  regressionCheck: RegressionCheck;
  heldOutTag: string;
  grouping: CaseGrouping;
}

function scoreVariant(
  baseline: EvalRunnerResult,
  baselineValue: number,
  rules: ScoringRules,
  variant: ToolOverrideVariant,
  run: OptimizationRun
): VariantCandidateResult {
  const { metric, allowRegressions, regressionCheck } = rules;
  const comparison = compareEvalRuns({
    baseline,
    candidate: run.result,
    labels: { candidate: variant.id },
  });
  const value = metricOf(run, metric, rules.heldOutTag);
  const metricValue = value ?? baselineValue;
  // Breakage doesn't depend on how many variants are tried; improvement
  // does, so `judgeImprovement` settles it once the optimization ends.
  const measurement = measureAgainstBaseline(baseline, run.result, rules);
  const breaks =
    regressionCheck === 'significant'
      ? breaksRegressionCases(measurement)
      : comparison.regressedCases.length > 0;

  const candidate: VariantCandidateResult = {
    variant,
    result: run.result,
    comparison,
    metricValue,
    metricDelta: metricValue - baselineValue,
    measurement,
    improvement: measurement.capability.change ?? pairedNone(),
    fixes: false,
    disqualified: value === undefined || (!allowRegressions && breaks),
    ...(value === undefined ? { metricUnavailable: true as const } : {}),
  };
  judgeImprovement(
    candidate,
    baseline,
    { ...rules, variantsTried: 1 },
    measurement
  );
  return candidate;
}

function pairedNone(): PairedChange {
  return {
    mean: 0,
    lower: -1,
    upper: 1,
    cases: 0,
    pBetter: 1,
    pWorse: 1,
    assessment: 'unclear',
  };
}

/** Per-case score behind each tool metric. */
function caseScoreOf(
  metric: Exclude<OptimizationMetric, 'passRate'>
): (result: EvalCaseResult) => number | undefined {
  switch (metric) {
    case 'toolPrecision':
      return (c) => c.toolPrecision;
    case 'toolRecall':
      return (c) => c.toolRecall;
    case 'toolF1':
      return (c) => {
        if (c.toolPrecision === undefined || c.toolRecall === undefined) {
          return undefined;
        }
        const sum = c.toolPrecision + c.toolRecall;
        return sum > 0 ? (2 * c.toolPrecision * c.toolRecall) / sum : 0;
      };
  }
}

interface ImprovementRules {
  metric: MetricName;
  better: 'higher' | 'lower';
  grouping: CaseGrouping;
  heldOutTag: string;
  variantsTried: number;
}

/**
 * Settles whether a candidate is clearly better, adjusting for the number of
 * variants tried (Bonferroni). For `passRate`, the evidence is the paired
 * change on capability cases; for tool metrics, the paired change in the
 * per-case score over every case. Either way the metric must also have gone
 * up, and the sign-flip test must pass at `0.025 / variantsTried`.
 */
function judgeImprovement(
  candidate: VariantCandidateResult,
  baseline: EvalRunnerResult,
  rules: ImprovementRules,
  measurement = measureAgainstBaseline(baseline, candidate.result, rules)
): void {
  candidate.measurement = measurement;
  const improved =
    rules.better === 'lower'
      ? candidate.metricDelta < 0
      : candidate.metricDelta > 0;
  if (!isOptimizationMetric(rules.metric)) {
    // A variant metric has no per-case scores to test, so its gain stands.
    candidate.improvement = pairedNone();
    candidate.fixes = improved;
    return;
  }
  candidate.improvement =
    rules.metric === 'passRate'
      ? (candidate.measurement.capability.change ?? pairedNone())
      : scoreChange(
          baseline,
          candidate.result,
          caseScoreOf(rules.metric),
          rules.variantsTried
        );
  candidate.fixes = improved && candidate.improvement.assessment === 'better';
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

/**
 * A run without its held-out cases, with the run-level counts and tool
 * metrics recomputed so nothing about held-out cases leaks through.
 */
function withoutHeldOut(
  result: EvalRunnerResult,
  heldOutTag: string
): EvalRunnerResult {
  const caseResults = result.caseResults.filter(
    (c) => !caseTags(c).includes(heldOutTag)
  );
  if (caseResults.length === result.caseResults.length) return result;
  const passed = caseResults.filter((c) => c.pass).length;
  const scored = caseResults.filter(
    (c) => c.toolPrecision !== undefined || c.toolRecall !== undefined
  );
  const precision =
    scored.length > 0
      ? scored.reduce((sum, c) => sum + (c.toolPrecision ?? 0), 0) /
        scored.length
      : undefined;
  const recall =
    scored.length > 0
      ? scored.reduce((sum, c) => sum + (c.toolRecall ?? 0), 0) / scored.length
      : undefined;
  return {
    total: caseResults.length,
    passed,
    failed: caseResults.length - passed,
    caseResults,
    durationMs: result.durationMs,
    ...(result.metadata ? { metadata: result.metadata } : {}),
    ...(precision !== undefined && recall !== undefined
      ? {
          datasetToolPrecision: precision,
          datasetToolRecall: recall,
          datasetToolF1:
            precision + recall > 0
              ? (2 * precision * recall) / (precision + recall)
              : 0,
        }
      : {}),
  };
}

/** A candidate as `proposeVariants` sees it: without held-out cases. */
function proposerCandidate(
  candidate: VariantCandidateResult,
  seenBaseline: EvalRunnerResult,
  rules: ScoringRules
): VariantCandidateResult {
  const result = withoutHeldOut(candidate.result, rules.heldOutTag);
  if (result === candidate.result) return candidate;
  const measurement = measureAgainstBaseline(seenBaseline, result, rules);
  return {
    ...candidate,
    result,
    comparison: compareEvalRuns({
      baseline: seenBaseline,
      candidate: result,
      labels: { candidate: candidate.variant.id },
    }),
    measurement,
    improvement:
      rules.metric === 'passRate'
        ? (measurement.capability.change ?? pairedNone())
        : isOptimizationMetric(rules.metric)
          ? scoreChange(
              seenBaseline,
              result,
              caseScoreOf(
                rules.metric as Exclude<OptimizationMetric, 'passRate'>
              )
            )
          : pairedNone(),
  };
}

function proposerRound(
  round: ToolOptimizationRound,
  seenBaseline: EvalRunnerResult,
  rules: ScoringRules
): ToolOptimizationRound {
  const candidates = round.candidates.map((c) =>
    proposerCandidate(c, seenBaseline, rules)
  );
  const bestIndex = round.best ? round.candidates.indexOf(round.best) : -1;
  return {
    round: round.round,
    candidates,
    ...(bestIndex >= 0 ? { best: candidates[bestIndex] } : {}),
  };
}

/** `candidate`'s held-out-free view from the proposer history. */
function proposerViewOf(
  candidate: VariantCandidateResult,
  history: ToolOptimizationRound[]
): VariantCandidateResult {
  for (const round of history) {
    const match = round.candidates.find((c) => c.variant === candidate.variant);
    if (match) return match;
  }
  return candidate;
}

function buildProposal(
  metric: MetricName,
  baselineValue: number,
  source: VariantCandidateResult,
  isWinner: boolean
): VariantImprovementProposal {
  let recommendation: VariantRecommendation;
  if (isWinner) {
    recommendation = source.fixes ? 'apply' : 'inconclusive';
  } else {
    // No shippable winner: the best candidate tried was disqualified for breaking cases.
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
  metric: OptimizationMetric
): number | undefined {
  switch (metric) {
    case 'passRate':
      return meanCasePassRate(result);
    case 'toolF1':
      return result.datasetToolF1;
    case 'toolPrecision':
      return result.datasetToolPrecision;
    case 'toolRecall':
      return result.datasetToolRecall;
  }
}

function buildRunOptions(
  options: ToolOptimizationOptions,
  toolOverrides: ToolOverrideVariant | undefined
) {
  return {
    dataset: options.dataset,
    toolOverrides,
    // The optimization attaches the winning run itself.
    reporting: 'none' as const,
    defaultTrials: options.defaultTrials,
    defaultJudgeReps: options.defaultJudgeReps,
    concurrency: options.concurrency,
    filterTags: options.filterTags,
    schemas: options.schemas,
    model: options.model,
    judgeModel: options.judgeModel,
  };
}
