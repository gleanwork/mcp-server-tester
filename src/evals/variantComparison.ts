/**
 * Case-by-case comparison of tool-metadata variants against a baseline run.
 *
 * Pure functions over completed eval runs: no I/O. `runVariantExperiment`
 * uses `measureAgainstBaseline` to apply its regression check, and
 * `compareVariants` to build the report payload, so the numbers the
 * reporter shows are the numbers the experiment decided on.
 *
 * The statistics follow established practice for comparing two systems on
 * the same test cases:
 *
 * - Each case scores the share of its trials that passed, and variants are
 *   compared by per-case paired differences (Miller, "Adding Error Bars to
 *   Evals", 2024). The 95% t-interval is shown for scale.
 * - Assessments use an exact paired sign-flip (randomization) test, valid for
 *   any number of cases. With one trial per case it is McNemar's exact test.
 * - A variant counts as clearly better only below `alpha / variantsTried`
 *   (Bonferroni), so trying many variants can't promote a lucky one.
 * - One case breaks on its own when a one-sided Fisher's exact test on its
 *   trials says so, Holm-corrected across the cases checked.
 * - Case groups never come from the baseline run being compared against:
 *   they are declared by tag, or come from a separate grouping run. Grouping
 *   by the same run's results builds in regression to the mean.
 */
import type {
  TrialFailureKind,
  EvalCaseResult,
  IterationResult,
  MCPComparisonData,
  PairedChange,
  RegressionCheck,
  VariantTrial,
  VariantCaseGroup,
  VariantComparisonCase,
  VariantComparisonEntry,
  VariantGroupStats,
  VariantStatus,
  VariantToolChange,
  VariantToolMistake,
} from '../types/reporter.js';
import type { EvalRunnerResult, ToolMetadataOverride } from './evalRunner.js';

/** The tag that marks a case as held out, unless the experiment sets another. */
export const DEFAULT_HELD_OUT_TAG = 'held-out';

/** The tag that marks a regression case, unless the experiment sets another. */
export const DEFAULT_REGRESSION_TAG = 'regression';

/**
 * One-sided level for calling a change clearly better or worse. 0.025 matches
 * the two-sided 95% intervals the report shows.
 */
const CHANGE_ALPHA = 0.025;

/**
 * Familywise level for calling any one `regression` case broken. Looser than
 * `CHANGE_ALPHA` by design: wrongly rejecting a variant costs less than
 * shipping one that broke a working case.
 */
const BROKEN_CASE_ALPHA = 0.05;

const BASELINE_ID = 'baseline';

const FAILURE_KINDS: readonly TrialFailureKind[] = [
  'no-tool-call',
  'wrong-tool',
  'check-failed',
  'error',
];

/** Two-sided 95% critical values of Student's t, by degrees of freedom. */
const T_975: Record<number, number> = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  11: 2.201,
  12: 2.179,
  13: 2.16,
  14: 2.145,
  15: 2.131,
  16: 2.12,
  17: 2.11,
  18: 2.101,
  19: 2.093,
  20: 2.086,
  21: 2.08,
  22: 2.074,
  23: 2.069,
  24: 2.064,
  25: 2.06,
  26: 2.056,
  27: 2.052,
  28: 2.048,
  29: 2.045,
  30: 2.042,
  40: 2.021,
  60: 2.0,
  120: 1.98,
};

/** Critical value for `df`, rounding df down to the nearest tabulated value. */
function tCritical(df: number): number {
  if (df >= 1000) return 1.96;
  const tabulated = Object.keys(T_975)
    .map(Number)
    .filter((d) => d <= df);
  return T_975[Math.max(...tabulated)] ?? T_975[1]!;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error below 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
    t;
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Beyond this many distinct sums, the exact test falls back to its normal limit. */
const MAX_EXACT_SUMS = 200_000;

/**
 * Exact paired sign-flip test on per-case differences (Fisher's randomization
 * test). Under the null hypothesis that the variant makes no difference, each
 * case's difference is as likely to be negative as positive; the p-values are
 * the share of sign assignments at least as extreme as the one observed. With
 * 0/1 differences (one trial per case) this is McNemar's exact test.
 */
export function signFlipTest(differences: number[]): {
  pBetter: number;
  pWorse: number;
} {
  const nonzero = differences.filter((d) => Math.abs(d) > 1e-12);
  if (nonzero.length === 0) return { pBetter: 1, pWorse: 1 };
  const observed = nonzero.reduce((sum, d) => sum + d, 0);
  const key = (sum: number) => Math.round(sum * 1e9) / 1e9;
  let sums = new Map<number, number>([[0, 1]]);
  for (const d of nonzero) {
    const size = Math.abs(d);
    const next = new Map<number, number>();
    for (const [sum, p] of sums) {
      for (const s of [key(sum + size), key(sum - size)]) {
        next.set(s, (next.get(s) ?? 0) + p / 2);
      }
    }
    sums = next;
    if (sums.size > MAX_EXACT_SUMS) {
      const z =
        observed / Math.sqrt(nonzero.reduce((sum, v) => sum + v * v, 0));
      return { pBetter: 1 - normalCdf(z), pWorse: normalCdf(z) };
    }
  }
  const target = key(observed);
  let better = 0;
  let worse = 0;
  for (const [sum, p] of sums) {
    if (sum >= target) better += p;
    if (sum <= target) worse += p;
  }
  return { pBetter: Math.min(1, better), pWorse: Math.min(1, worse) };
}

/**
 * Trials per case needed before one case breaking outright (every trial
 * passing, then every trial failing) can be called broken on its own,
 * among `cases` regression cases. Fisher's exact p for that is 1 / C(2k, k);
 * Holm's first step needs it below `caseAlpha / cases`.
 */
export function trialsToDetectBrokenCase(
  cases: number,
  caseAlpha = BROKEN_CASE_ALPHA
): number {
  const threshold = caseAlpha / Math.max(1, cases);
  // C(2k, k) built by exact integer steps, so 1/20 compares as exactly 0.05.
  const centralBinomial = (k: number) => {
    let c = 1;
    for (let i = 1; i <= k; i++) c = (c * (k + i)) / i;
    return c;
  };
  let k = 1;
  while (1 / centralBinomial(k) >= threshold) k++;
  return k;
}

/**
 * Holm's step-down correction: the ids whose p-values stay significant when
 * the chance of any false rejection is held below `alpha`.
 */
export function holmRejected(
  tests: Array<{ id: string; p: number }>,
  alpha: number
): string[] {
  const sorted = [...tests].sort((a, b) => a.p - b.p);
  const rejected: string[] = [];
  for (const [i, test] of sorted.entries()) {
    if (test.p >= alpha / (sorted.length - i)) break;
    rejected.push(test.id);
  }
  return rejected;
}

function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i <= k; i++) sum += Math.log((n - k + i) / i);
  return sum;
}

/**
 * One-sided Fisher's exact test: the chance of the candidate passing
 * `candidatePasses` or fewer of its trials if it were exactly as good as
 * the baseline, given both runs' trials.
 */
export function worseCaseP(
  baselinePasses: number,
  baselineAttempts: number,
  candidatePasses: number,
  candidateAttempts: number
): number {
  const total = baselineAttempts + candidateAttempts;
  const passes = baselinePasses + candidatePasses;
  const fails = total - passes;
  const denominator = logChoose(total, candidateAttempts);
  let p = 0;
  const lowest = Math.max(0, candidateAttempts - fails);
  for (let x = lowest; x <= candidatePasses; x++) {
    p += Math.exp(
      logChoose(passes, x) +
        logChoose(fails, candidateAttempts - x) -
        denominator
    );
  }
  // Log-space sums drift (1/20 comes out as 0.0499...); round so a p-value
  // exactly at a threshold isn't counted as below it.
  return Math.min(1, Number(p.toPrecision(12)));
}

/**
 * Mean of paired differences, a 95% t-interval for display, and a assessment
 * from the exact sign-flip test. Fewer than two pairs can't support an
 * interval, so it spans every possible difference.
 *
 * @param variantsTried Variants the experiment tried; "better" needs
 *   `pBetter < CHANGE_ALPHA / variantsTried`. Defaults to 1.
 */
export function pairedChange(
  differences: number[],
  variantsTried = 1
): PairedChange {
  const n = differences.length;
  const { pBetter, pWorse } = signFlipTest(differences);
  const assessment =
    n > 0 && pBetter < CHANGE_ALPHA / Math.max(1, variantsTried)
      ? 'better'
      : n > 0 && pWorse < CHANGE_ALPHA
        ? 'worse'
        : 'unclear';
  const tests = { pBetter, pWorse, assessment } as const;
  if (n === 0) return { mean: 0, lower: -1, upper: 1, cases: 0, ...tests };
  const m = mean(differences);
  if (n < 2) return { mean: m, lower: -1, upper: 1, cases: n, ...tests };
  const variance =
    differences.reduce((sum, d) => sum + (d - m) ** 2, 0) / (n - 1);
  const margin = tCritical(n - 1) * Math.sqrt(variance / n);
  return {
    mean: m,
    lower: Math.max(-1, m - margin),
    upper: Math.min(1, m + margin),
    cases: n,
    ...tests,
  };
}

/** Classifies a failed trial from its trace and error. */
function failureOf(
  trial: Pick<IterationResult, 'error' | 'isInfrastructureError'> & {
    toolCallTrace?: IterationResult['toolCallTrace'];
  }
): TrialFailureKind {
  if (trial.isInfrastructureError || trial.error) return 'error';
  const trace = trial.toolCallTrace;
  if (!trace) return 'check-failed';
  if (trace.calls.length === 0) return 'no-tool-call';
  if (
    trace.missed.length > 0 ||
    trace.calls.some((call) => call.status === 'unexpected')
  ) {
    return 'wrong-tool';
  }
  return 'check-failed';
}

interface RecordedAttempt extends VariantTrial {
  /** Infrastructure failures don't count toward pass rates, as in the runner. */
  infrastructure: boolean;
}

function toAttempt(
  pass: boolean,
  source: Pick<
    IterationResult,
    'error' | 'isInfrastructureError' | 'clientUsage'
  > & { toolCallTrace?: IterationResult['toolCallTrace'] }
): RecordedAttempt {
  const trace = source.toolCallTrace;
  const usage = source.clientUsage;
  return {
    pass,
    ...(pass ? {} : { failure: failureOf(source) }),
    ...(trace
      ? {
          calls: trace.calls.map((call) => call.name),
          missed: trace.missed.map((tool) => tool.name),
        }
      : {}),
    ...(usage ? { tokens: usage.inputTokens + usage.outputTokens } : {}),
    infrastructure: source.isInfrastructureError === true,
  };
}

/** The trials behind a case result: its iterations, or the case itself. */
function attemptsOf(result: EvalCaseResult): RecordedAttempt[] {
  if (result.iterationResults && result.iterationResults.length > 0) {
    return result.iterationResults.map((iteration) =>
      toAttempt(iteration.pass, iteration)
    );
  }
  return [toAttempt(result.pass, result)];
}

/** Share of trials that passed, ignoring infrastructure failures. */
function passRateOf(trials: RecordedAttempt[]): number | undefined {
  const counted = trials.filter((a) => !a.infrastructure);
  if (counted.length === 0) return undefined;
  return counted.filter((a) => a.pass).length / counted.length;
}

/**
 * Mean per-case share of trials passed (pass@1, each case weighted
 * equally), ignoring infrastructure failures. 0 for a run with no cases.
 */
export function meanCasePassRate(result: EvalRunnerResult): number {
  const rates = result.caseResults
    .map((c) => passRateOf(attemptsOf(c)))
    .filter((r): r is number => r !== undefined);
  return rates.length > 0 ? mean(rates) : 0;
}

function byId(result: EvalRunnerResult): Map<string, EvalCaseResult> {
  return new Map(result.caseResults.map((c) => [c.id, c]));
}

/** A case's tags, wherever the runner recorded them. */
export function caseTags(result: EvalCaseResult): string[] {
  return result.tags ?? result.request?.tags ?? [];
}

/**
 * How cases are split into `capability` and `regression`. Never the
 * baseline run being compared against, which would build in regression to
 * the mean.
 *
 * - `declared`: cases with `tag` are regression cases.
 * - `grouping-run`: cases that passed `run`, a separate baseline run, are
 *   regression cases.
 */
export type CaseGrouping =
  | { source: 'declared'; tag: string }
  | { source: 'grouping-run'; run: EvalRunnerResult };

function grouper(
  grouping: CaseGrouping
): (result: EvalCaseResult) => VariantCaseGroup {
  if (grouping.source === 'declared') {
    return (result) =>
      caseTags(result).includes(grouping.tag) ? 'regression' : 'capability';
  }
  const passed = new Map(grouping.run.caseResults.map((c) => [c.id, c.pass]));
  return (result) =>
    passed.get(result.id) === true ? 'regression' : 'capability';
}

function isHeldOut(result: EvalCaseResult, heldOutTag: string): boolean {
  return caseTags(result).includes(heldOutTag);
}

interface CaseRates {
  id: string;
  group: VariantCaseGroup;
  heldOut: boolean;
  baseline: number;
  candidate: number;
  candidateAllPassed: boolean;
  /** One-sided Fisher's exact p-value that the candidate is worse on this case. */
  worseP: number;
}

function passCount(trials: RecordedAttempt[]): [number, number] {
  const counted = trials.filter((a) => !a.infrastructure);
  return [counted.filter((a) => a.pass).length, counted.length];
}

/** Pairs each baseline case with the candidate's result for it. */
function pairCases(
  baseline: EvalRunnerResult,
  candidate: EvalRunnerResult,
  groupOf: (result: EvalCaseResult) => VariantCaseGroup,
  heldOutTag: string
): CaseRates[] {
  const candidateCases = byId(candidate);
  const pairs: CaseRates[] = [];
  for (const base of baseline.caseResults) {
    const other = candidateCases.get(base.id);
    if (!other) continue;
    const baseAttempts = attemptsOf(base);
    const otherAttempts = attemptsOf(other);
    const baseRate = passRateOf(baseAttempts);
    const otherRate = passRateOf(otherAttempts);
    if (baseRate === undefined || otherRate === undefined) continue;
    const [basePasses, baseCount] = passCount(baseAttempts);
    const [otherPasses, otherCount] = passCount(otherAttempts);
    pairs.push({
      id: base.id,
      group: groupOf(base),
      heldOut: isHeldOut(base, heldOutTag),
      baseline: baseRate,
      candidate: otherRate,
      candidateAllPassed: otherAttempts.every((a) => a.pass),
      worseP:
        otherRate < baseRate
          ? worseCaseP(basePasses, baseCount, otherPasses, otherCount)
          : 1,
    });
  }
  return pairs;
}

function groupStats(
  pairs: CaseRates[],
  group: VariantCaseGroup,
  side: 'baseline' | 'candidate',
  withChange: boolean,
  variantsTried: number
): VariantGroupStats {
  const diff = (p: CaseRates) => p.candidate - p.baseline;
  const inGroup = pairs.filter((p) => p.group === group);
  if (inGroup.length === 0) return { cases: 0 };
  const rate = (p: CaseRates) => p[side];
  const seen = inGroup.filter((p) => !p.heldOut);
  const heldOut = inGroup.filter((p) => p.heldOut);
  return {
    cases: inGroup.length,
    passRate: mean(inGroup.map(rate)),
    ...(heldOut.length > 0 && seen.length > 0
      ? { seenPassRate: mean(seen.map(rate)) }
      : {}),
    ...(heldOut.length > 0 ? { heldOutPassRate: mean(heldOut.map(rate)) } : {}),
    allTrialsPassedRate: mean(
      inGroup.map((p) =>
        (side === 'candidate' ? p.candidateAllPassed : p.baseline === 1) ? 1 : 0
      )
    ),
    ...(withChange
      ? { change: pairedChange(inGroup.map(diff), variantsTried) }
      : {}),
    // Variants are ranked without held-out cases, so this check needs no
    // adjustment for the number tried.
    ...(withChange && heldOut.length > 0 && seen.length > 0
      ? { heldOutChange: pairedChange(heldOut.map(diff)) }
      : {}),
  };
}

/** A candidate's results on each case group, compared with the baseline. */
export interface BaselineMeasurement {
  capability: VariantGroupStats;
  regression: VariantGroupStats;
  /**
   * `regression` cases that clearly broke on their own (Fisher's exact
   * test per case, Holm-corrected at `BROKEN_CASE_ALPHA`).
   */
  brokenCaseIds: string[];
}

function brokenIn(pairs: CaseRates[]): string[] {
  return holmRejected(
    pairs
      .filter((p) => p.group === 'regression')
      .map((p) => ({ id: p.id, p: p.worseP })),
    BROKEN_CASE_ALPHA
  );
}

/** Options for {@link measureAgainstBaseline}. */
interface MeasureOptions {
  grouping: CaseGrouping;
  heldOutTag?: string;
  /**
   * Variants the experiment tried. A change counts as clearly better only
   * when `pBetter < CHANGE_ALPHA / variantsTried`. @default 1
   */
  variantsTried?: number;
}

/**
 * Measures a candidate run against the baseline on `capability` and
 * `regression` cases. Cases are paired by id; a case missing from either
 * run, or with only infrastructure failures, is left out.
 */
export function measureAgainstBaseline(
  baseline: EvalRunnerResult,
  candidate: EvalRunnerResult,
  options: MeasureOptions
): BaselineMeasurement {
  const pairs = pairCases(
    baseline,
    candidate,
    grouper(options.grouping),
    options.heldOutTag ?? DEFAULT_HELD_OUT_TAG
  );
  const tried = options.variantsTried ?? 1;
  return {
    capability: groupStats(pairs, 'capability', 'candidate', true, tried),
    regression: groupStats(pairs, 'regression', 'candidate', true, tried),
    brokenCaseIds: brokenIn(pairs),
  };
}

/**
 * Paired change in a per-case score, such as tool precision, over every case
 * both runs scored.
 */
export function scoreChange(
  baseline: EvalRunnerResult,
  candidate: EvalRunnerResult,
  scoreOf: (result: EvalCaseResult) => number | undefined,
  variantsTried = 1
): PairedChange {
  const candidateCases = byId(candidate);
  const differences: number[] = [];
  for (const base of baseline.caseResults) {
    const other = candidateCases.get(base.id);
    const before = scoreOf(base);
    const after = other ? scoreOf(other) : undefined;
    if (before !== undefined && after !== undefined) {
      differences.push(after - before);
    }
  }
  return pairedChange(differences, variantsTried);
}

/**
 * True when `regression` cases clearly got worse: as a group (sign-flip
 * test), or any one case on its own (see `brokenCaseIds`).
 */
export function breaksRegressionCases(
  measurement: BaselineMeasurement
): boolean {
  return (
    measurement.regression.change?.assessment === 'worse' ||
    measurement.brokenCaseIds.length > 0
  );
}

/** True when `capability` cases clearly got better. */
export function improvesCapabilityCases(
  measurement: BaselineMeasurement
): boolean {
  return measurement.capability.change?.assessment === 'better';
}

/** One candidate run, as `runVariantExperiment` scored it. */
interface VariantRunInput {
  id: string;
  description?: string;
  tools: Record<string, ToolMetadataOverride>;
  result: EvalRunnerResult;
  /** Whether the experiment judged this variant to fix what it should. */
  fixes: boolean;
  disqualified: boolean;
}

/** Options for {@link compareVariants}. */
export interface CompareVariantsOptions {
  baseline: EvalRunnerResult;
  /** Every candidate that ran, in order. */
  candidates: VariantRunInput[];
  /** The experiment's winner, if any. */
  winnerId?: string;
  regressionCheck: RegressionCheck;
  grouping: CaseGrouping;
  heldOutTag?: string;
  /** Variants tried across every round. @default candidates.length */
  variantsTried?: number;
  /** The server's original metadata for the tools the variants change. */
  originalTools?: Record<
    string,
    { description?: string; inputSchema?: unknown }
  >;
}

function expectedToolsOf(result: EvalCaseResult): string[] | undefined {
  const triggered = result.request?.assertions?.toolsTriggered;
  if (!triggered || typeof triggered !== 'object') return undefined;
  const calls = (triggered as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return undefined;
  const names = calls
    .map((call) =>
      call && typeof call === 'object'
        ? (call as { name?: unknown }).name
        : undefined
    )
    .filter((name): name is string => typeof name === 'string');
  return names.length > 0 ? names : undefined;
}

function stripAttempt(trial: RecordedAttempt): VariantTrial {
  const { infrastructure: _infrastructure, ...rest } = trial;
  return rest;
}

function toolChangesOf(
  tools: Record<string, ToolMetadataOverride>,
  original: CompareVariantsOptions['originalTools']
): VariantToolChange[] {
  const changes: VariantToolChange[] = [];
  for (const [tool, override] of Object.entries(tools)) {
    if (override.description !== undefined) {
      const before = original?.[tool]?.description;
      changes.push({
        tool,
        field: 'description',
        ...(before !== undefined ? { before } : {}),
        after: override.description,
      });
    }
    if (override.inputSchema !== undefined) {
      const before = original?.[tool]?.inputSchema;
      changes.push({
        tool,
        field: 'inputSchema',
        ...(before !== undefined
          ? { before: JSON.stringify(before, null, 2) }
          : {}),
        after: JSON.stringify(override.inputSchema, null, 2),
      });
    }
  }
  return changes;
}

function mistakesOf(
  rows: VariantComparisonCase[],
  variantId: string
): VariantToolMistake[] {
  const groups = new Map<string, VariantToolMistake>();
  for (const row of rows) {
    const expected = row.expectedTools ?? [];
    for (const trial of row.trials[variantId] ?? []) {
      if (trial.pass || trial.calls === undefined) continue;
      const called = trial.calls[0] ?? null;
      const calledExpected =
        called !== null &&
        expected.length > 0 &&
        expected.includes(called) &&
        (trial.missed ?? []).length === 0;
      const key = JSON.stringify([called, expected, calledExpected]);
      const entry = groups.get(key) ?? {
        called,
        expected,
        calledExpected,
        trials: 0,
        caseIds: [],
      };
      entry.trials++;
      if (!entry.caseIds.includes(row.id)) entry.caseIds.push(row.id);
      groups.set(key, entry);
    }
  }
  return [...groups.values()].sort((a, b) => b.trials - a.trials);
}

function statusOf(
  id: string,
  options: CompareVariantsOptions,
  measurement: BaselineMeasurement,
  disqualified: boolean
): VariantStatus {
  if (id === options.winnerId) return 'recommended';
  if (disqualified) return 'breaks';
  if (improvesCapabilityCases(measurement)) return 'better';
  if (measurement.capability.change?.assessment === 'worse') return 'worse';
  return 'no-change';
}

/**
 * Builds the report payload for a variant experiment: every variant's results
 * on every case and trial, its group pass rates and changes from the
 * baseline, its failures, and where it landed.
 */
export function compareVariants(
  options: CompareVariantsOptions
): MCPComparisonData {
  const heldOutTag = options.heldOutTag ?? DEFAULT_HELD_OUT_TAG;
  const groupOf = grouper(options.grouping);
  const variantsTried = options.variantsTried ?? options.candidates.length;
  const ids = new Set(options.candidates.map((c) => c.id));
  let baselineId = BASELINE_ID;
  while (ids.has(baselineId)) baselineId = `_${baselineId}`;

  const runs = [
    { id: baselineId, result: options.baseline },
    ...options.candidates.map((c) => ({ id: c.id, result: c.result })),
  ];
  const resultsById = runs.map((run) => ({
    id: run.id,
    cases: byId(run.result),
  }));

  const attemptCounts: number[] = [];
  const rows: VariantComparisonCase[] = options.baseline.caseResults.map(
    (base) => {
      const trials: Record<string, VariantTrial[]> = {};
      for (const run of resultsById) {
        const result = run.cases.get(base.id);
        if (!result) continue;
        const recorded = attemptsOf(result);
        attemptCounts.push(recorded.length);
        trials[run.id] = recorded.map(stripAttempt);
      }
      const input = base.request?.input ?? base.request?.description;
      const expectedTools = expectedToolsOf(base);
      return {
        id: base.id,
        ...(input !== undefined ? { input } : {}),
        group: groupOf(base),
        heldOut: isHeldOut(base, heldOutTag),
        ...(expectedTools ? { expectedTools } : {}),
        trials,
      };
    }
  );

  const entryFor = (
    id: string,
    result: EvalRunnerResult,
    candidate: VariantRunInput | undefined
  ): VariantComparisonEntry => {
    const isBaseline = candidate === undefined;
    const pairs = pairCases(options.baseline, result, groupOf, heldOutTag);
    const side = isBaseline ? 'baseline' : 'candidate';
    const stats = (group: VariantCaseGroup) =>
      groupStats(pairs, group, side, !isBaseline, variantsTried);
    const measurement: BaselineMeasurement = {
      capability: stats('capability'),
      regression: stats('regression'),
      brokenCaseIds: isBaseline ? [] : brokenIn(pairs),
    };
    const all = rows.flatMap((row) => row.trials[id] ?? []);
    const failed = all.filter((a) => !a.pass);
    const failures = Object.fromEntries(
      FAILURE_KINDS.map((kind) => [
        kind,
        failed.filter((a) => a.failure === kind).length,
      ])
    ) as Record<TrialFailureKind, number>;
    const tokens = all
      .map((a) => a.tokens)
      .filter((t): t is number => t !== undefined);
    const traced = all.filter((a) => a.calls !== undefined);
    const passesOf = (row: VariantComparisonCase, variant: string) =>
      (row.trials[variant] ?? []).filter((a) => a.pass).length;
    const comparable = rows.filter(
      (row) => row.trials[id] && row.trials[baselineId]
    );
    const disqualified = candidate?.disqualified ?? false;

    return {
      id,
      ...(candidate?.description !== undefined
        ? { description: candidate.description }
        : {}),
      status: isBaseline
        ? 'baseline'
        : statusOf(id, options, measurement, disqualified),
      ...(isBaseline
        ? {}
        : {
            checks: {
              fixes: candidate?.fixes ?? false,
              keepsRegressions: !disqualified,
            },
          }),
      capability: measurement.capability,
      regression: measurement.regression,
      improvedCaseIds: isBaseline
        ? []
        : comparable
            .filter((row) => passesOf(row, id) > passesOf(row, baselineId))
            .map((row) => row.id),
      regressedCaseIds: isBaseline
        ? []
        : comparable
            .filter((row) => passesOf(row, id) < passesOf(row, baselineId))
            .map((row) => row.id),
      brokenCaseIds: measurement.brokenCaseIds,
      unsteadyCaseIds: rows
        .filter((row) => {
          const passes = passesOf(row, id);
          return passes > 0 && passes < (row.trials[id] ?? []).length;
        })
        .map((row) => row.id),
      trials: all.length,
      failedTrials: failed.length,
      failures,
      mistakes: mistakesOf(rows, id),
      ...(tokens.length > 0 ? { meanTokensPerTrial: mean(tokens) } : {}),
      ...(traced.length > 0
        ? {
            meanToolCallsPerTrial: mean(
              traced.map((a) => (a.calls ?? []).length)
            ),
          }
        : {}),
      toolChanges: candidate
        ? toolChangesOf(candidate.tools, options.originalTools)
        : [],
    };
  };

  const variants = [
    entryFor(baselineId, options.baseline, undefined),
    ...options.candidates.map((c) => entryFor(c.id, c.result, c)),
  ];

  const regressionCases = rows.filter((row) => row.group === 'regression');
  const regressionAttempts = regressionCases.flatMap((row) =>
    Object.values(row.trials).map((a) => a.length)
  );
  return {
    baselineId,
    regressionCheck: options.regressionCheck,
    grouping: options.grouping.source,
    trialsToDetectBrokenCase: trialsToDetectBrokenCase(regressionCases.length),
    ...(regressionAttempts.length > 0
      ? { regressionTrialsPerCase: Math.min(...regressionAttempts) }
      : {}),
    regressionTag:
      options.grouping.source === 'declared'
        ? options.grouping.tag
        : DEFAULT_REGRESSION_TAG,
    heldOutTag,
    alpha: CHANGE_ALPHA,
    variantsTried,
    caseAlpha: BROKEN_CASE_ALPHA,
    trialsPerCase: attemptCounts.length > 0 ? Math.max(...attemptCounts) : 0,
    minTrialsPerCase: attemptCounts.length > 0 ? Math.min(...attemptCounts) : 0,
    ...(options.winnerId !== undefined
      ? { recommendedId: options.winnerId }
      : {}),
    variants,
    cases: rows,
  };
}
