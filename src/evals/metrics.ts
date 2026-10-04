import { z } from 'zod';
import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import type { HostTrace } from './evalFrameworkTypes.js';
import { isInfrastructureFailure } from './infrastructureFailure.js';
import { extensionLookup } from '../plugins/extensions.js';
/**
 * Tagged options are passed to compute without routing keys (type/metric/name).
 * Legacy params are flattened for compatibility; keys may not also occur at the
 * top level, since choosing either value would silently discard configuration.
 */
export type MetricSpec =
  | string
  | {
      metric?: string;
      type?: string;
      name?: string;
      params?: Record<string, unknown>;
      [option: string]: unknown;
    };

import type {
  MetricValue,
  MetricKind,
  MetricDefinition,
  ResolvedMetric,
} from './evalFrameworkTypes.js';
export type { MetricDefinition, ResolvedMetric } from './evalFrameworkTypes.js';

export interface MetricResult {
  perCase: Record<string, Record<string, MetricValue>>;
  aggregated: Record<string, unknown>;
  /** Metrics with no value for any case: unavailable, not zero. */
  unavailable: string[];
}

function responseObject(caseResult: EvalCaseResult): Record<string, unknown> {
  const response = caseResult.response;
  return response && typeof response === 'object'
    ? (response as Record<string, unknown>)
    : {};
}

/** One run of a case: an iteration, or the case itself when it runs once. */
interface Trial {
  pass: boolean;
  trace?: HostTrace;
  usage?: UsageMetrics;
  durationMs: number;
  error?: string;
  /** The case ran once, so its own response is this trial's. */
  isCase: boolean;
}

/**
 * A case's trials: the runs that didn't fail on infrastructure (they are left
 * out, as from accuracy).
 */
function caseTrials(caseResult: EvalCaseResult): Trial[] {
  if (caseResult.iterationResults?.length) {
    return caseResult.iterationResults
      .filter((iteration) => !iteration.isInfrastructureError)
      .map((iteration) => ({
        pass: iteration.pass,
        trace: iteration.trace,
        usage: iteration.hostUsage,
        durationMs: iteration.durationMs,
        error: iteration.error,
        isCase: false,
      }));
  }
  if (isInfrastructureFailure(caseResult)) return [];
  return [
    {
      pass: caseResult.pass,
      trace: caseResult.trace,
      usage: caseResult.hostUsage,
      durationMs: caseResult.durationMs,
      error: caseResult.error,
      isCase: true,
    },
  ];
}

/**
 * A case's value for a per-trial measurement: the mean over the trials that
 * have one, or null when none does. With equal iterations per case, the mean
 * over cases is the mean over all trials.
 */
function perTrial(
  caseResult: EvalCaseResult,
  value: (trial: Trial) => number | boolean | null
): number | null {
  const values = caseTrials(caseResult)
    .map(value)
    .filter((v): v is number | boolean => v !== null)
    .map(Number);
  return values.length === 0
    ? null
    : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * A trial's tool calls, each named `server.tool` when an MCP call names its
 * server; null when the host declares no evidence of them or the trial has
 * no record of them. A case without a trace (a direct case) falls back to
 * its response.
 */
function trialToolCalls(
  trial: Trial,
  caseResult: EvalCaseResult
): Array<{ name?: unknown }> | null {
  if (trial.trace) {
    if (trial.trace.evidence === 'none') return null;
    return trial.trace.events
      .filter((event) => event.kind === 'tool_call')
      .map((event) => ({
        name:
          event.source === 'mcp' && event.server !== undefined
            ? `${event.server}.${event.name}`
            : event.name,
      }));
  }
  if (!trial.isCase) return null;
  const calls = responseObject(caseResult).toolCalls;
  return Array.isArray(calls) ? (calls as Array<{ name?: unknown }>) : [];
}

/**
 * A trial's events from one source: MCP tool calls, or everything the host
 * did natively. Null without a trace, or when the host declares no evidence.
 */
function traceEventCount(trial: Trial, source: 'mcp' | 'host'): number | null {
  if (!trial.trace || trial.trace.evidence === 'none') return null;
  return trial.trace.events.filter(
    (event) =>
      event.source === source &&
      (source === 'host' || event.kind === 'tool_call')
  ).length;
}

/** The trial's answer: its trace's, or the case's response text. */
function trialText(trial: Trial, caseResult: EvalCaseResult): string | null {
  if (trial.trace) return trial.trace.finalText ?? '';
  return trial.isCase ? responseText(caseResult) : null;
}

/** Tokens a trial read, including cache reads and writes. */
function inputTokens(usage: UsageMetrics | undefined): number | null {
  return usage
    ? usage.inputTokens +
        (usage.cacheReadInputTokens ?? 0) +
        (usage.cacheCreationInputTokens ?? 0)
    : null;
}

/** Tool calls across every trial of every result: what a run made. */
export function countTrialToolCalls(results: EvalCaseResult[]): number {
  return results.reduce(
    (count, result) =>
      count +
      caseTrials(result).reduce(
        (sum, trial) => sum + (trialToolCalls(trial, result)?.length ?? 0),
        0
      ),
    0
  );
}

type SkillLoadRecord = Record<string, unknown>;

/**
 * Skill loads per attempt (one entry per iteration, or one for a single run),
 * or null when skills were not enabled.
 */
function skillLoadsPerAttempt(
  caseResult: EvalCaseResult
): SkillLoadRecord[][] | null {
  const iterations = (caseResult.iterationResults ?? [])
    .map((iteration) => iteration.skillLoads)
    .filter((loads): loads is NonNullable<typeof loads> => loads !== undefined);
  if (iterations.length > 0) {
    return iterations as unknown as SkillLoadRecord[][];
  }
  const loads = responseObject(caseResult).skillLoads;
  return Array.isArray(loads) ? [loads as SkillLoadRecord[]] : null;
}

/**
 * Fraction of attempts where `test` holds, skipping attempts it returns null
 * for; null when there is nothing to measure.
 */
function attemptFraction(
  caseResult: EvalCaseResult,
  test: (loads: SkillLoadRecord[]) => boolean | null
): number | null {
  const values = (skillLoadsPerAttempt(caseResult) ?? [])
    .map(test)
    .filter((value): value is boolean => value !== null);
  return values.length === 0
    ? null
    : values.filter(Boolean).length / values.length;
}

/**
 * Skills the model chose to load (catalog mode). Preloaded skills are in
 * context by construction, so an attempt with only preloads is not measured.
 */
function modelLoadedSkills(loads: SkillLoadRecord[]): SkillLoadRecord[] | null {
  if (loads.length > 0 && loads.every((load) => load.via === 'preload')) {
    return null;
  }
  return loads.filter(
    (load) =>
      load.via !== 'preload' && load.kind === 'skill' && load.verified !== false
  );
}

/** Mean of per-case fractions, reported under `<name>_rate`. */
function fractionRateAggregation(
  values: MetricValue[],
  metric: ResolvedMetric
): { key: string; value: unknown } | undefined {
  const numbers = values.filter(
    (value): value is number => typeof value === 'number'
  );
  return numbers.length > 0
    ? {
        key: `${metric.outName}_rate`,
        value: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
      }
    : undefined;
}

function responseText(caseResult: EvalCaseResult): string {
  const response = responseObject(caseResult);
  if (typeof response.response === 'string') return response.response;
  if (!Array.isArray(response.content)) return '';
  return response.content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const text = (item as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function judgeEntries(
  caseResult: EvalCaseResult
): Array<Record<string, unknown>> {
  const judge = caseResult.expectations?.judge as
    | Record<string, unknown>
    | undefined;
  if (!judge) return [];
  const nested = judge.judgeResults;
  if (Array.isArray(nested)) {
    return nested.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object'
    );
  }
  return [judge];
}

function scoreFromJudge(entry: Record<string, unknown>): number | null {
  if (typeof entry.score === 'number') return entry.score;
  if (typeof entry.details !== 'string') return null;
  const match = entry.details.match(/score\s+([0-9]*\.?[0-9]+)/i);
  return match ? Number(match[1]) : null;
}

function judgeName(entry: Record<string, unknown>): string {
  return typeof entry.judgeName === 'string' && entry.judgeName
    ? entry.judgeName
    : 'judge';
}

function judgeScores(caseResult: EvalCaseResult): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const entry of judgeEntries(caseResult)) {
    const score = scoreFromJudge(entry);
    if (score !== null) scores[judgeName(entry)] = score;
  }
  return scores;
}

function judgePass(caseResult: EvalCaseResult): boolean | null {
  const entries = judgeEntries(caseResult);
  if (entries.length === 0) return null;
  const verdicts = entries
    .map((entry) => entry.pass)
    .filter((value): value is boolean => typeof value === 'boolean');
  return verdicts.length > 0 ? verdicts.every(Boolean) : null;
}

function meanAggregation(
  values: MetricValue[],
  metric: ResolvedMetric
): { key: string; value: unknown } | undefined {
  const numbers = values.filter(
    (value): value is number => typeof value === 'number'
  );
  return numbers.length > 0
    ? {
        key: `${metric.outName}_mean`,
        value: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
      }
    : undefined;
}

function rateAggregation(
  values: MetricValue[],
  metric: ResolvedMetric
): { key: string; value: unknown } | undefined {
  const booleans = values.filter(
    (value): value is boolean => typeof value === 'boolean'
  );
  return booleans.length > 0
    ? {
        key: `${metric.outName}_rate`,
        value: booleans.filter(Boolean).length / booleans.length,
      }
    : undefined;
}

function judgeScoreAggregation(
  values: MetricValue[],
  metric: ResolvedMetric
): { key: string; value: unknown } | undefined {
  const byJudge: Record<string, number[]> = {};
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [name, score] of Object.entries(value)) {
      if (typeof score === 'number') (byJudge[name] ??= []).push(score);
    }
  }
  const averaged: Record<string, number> = {};
  for (const [name, scores] of Object.entries(byJudge)) {
    averaged[name] =
      scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }
  return Object.keys(averaged).length > 0
    ? { key: metric.outName, value: averaged }
    : undefined;
}

function metric(
  kind: MetricKind,
  compute: MetricDefinition['compute'],
  aggregate?: MetricDefinition['aggregate'],
  unit?: string
): MetricDefinition {
  return {
    schema: z.object({}).passthrough(),
    kind,
    compute,
    aggregate,
    unit,
  };
}

function parameterizedJudgeMetric(
  name: 'judge_pass_for' | 'judge_score_for'
): MetricDefinition {
  const passMetric = name === 'judge_pass_for';
  return {
    ...metric(
      passMetric ? 'binary' : 'continuous',
      (result, params) => {
        const entry = judgeEntries(result).find(
          (item) => judgeName(item) === params?.judge
        );
        if (!entry) return null;
        return passMetric
          ? typeof entry.pass === 'boolean'
            ? entry.pass
            : null
          : scoreFromJudge(entry);
      },
      passMetric ? rateAggregation : meanAggregation
    ),
    schema: z.union([
      z.object({ judge: z.string().min(1) }).passthrough(),
      z
        .object({ params: z.object({ judge: z.string().min(1) }) })
        .passthrough(),
    ]),
  };
}

const BUILT_INS_KEY = Symbol.for('mcp-server-tester.built-in-metrics');
const globalMetrics = globalThis as unknown as Record<symbol, unknown>;

/** Built-in metrics, read-only: plugins add metrics under their namespace. */
export const BUILT_IN_METRICS: Readonly<Record<string, MetricDefinition>> =
  (globalMetrics[BUILT_INS_KEY] as
    | Readonly<Record<string, MetricDefinition>>
    | undefined) ??
  Object.freeze({
    judge_pass_for: parameterizedJudgeMetric('judge_pass_for'),
    judge_score_for: parameterizedJudgeMetric('judge_score_for'),
    passed: metric('binary', (result) => result.pass, rateAggregation),
    // Per case: the share of its trials that passed. The case passes when
    // that share reaches its accuracy threshold; `trial_pass_rate` keeps it.
    trial_pass: metric(
      'continuous',
      (result) => perTrial(result, (trial) => trial.pass),
      fractionRateAggregation
    ),
    // Per case: the share of its trials that ran without a host error.
    response_success: metric(
      'continuous',
      (result) =>
        perTrial(result, (trial) =>
          trial.trace
            ? trial.trace.error === undefined
            : trial.error === undefined &&
              responseObject(result).success !== false
        ),
      fractionRateAggregation
    ),
    // Per case: the share of its trials with no tool call.
    is_no_action: metric(
      'continuous',
      (result) =>
        perTrial(result, (trial) => {
          const calls = trialToolCalls(trial, result);
          return calls === null ? null : calls.length === 0;
        }),
      fractionRateAggregation
    ),
    // Usage, timing and tool counts are per trial: a case's value is the
    // mean over its trials.
    // Reported cost, or the estimate from the manifest's pricing.
    cost_usd: metric(
      'continuous',
      (result) =>
        perTrial(
          result,
          (trial) =>
            trial.usage?.totalCostUsd ?? trial.usage?.estimatedCostUsd ?? null
        ),
      meanAggregation,
      'USD'
    ),
    input_tokens: metric(
      'continuous',
      (result) => perTrial(result, (trial) => inputTokens(trial.usage)),
      meanAggregation,
      'tokens'
    ),
    input_tokens_uncached: metric(
      'continuous',
      (result) => perTrial(result, (trial) => trial.usage?.inputTokens ?? null),
      meanAggregation,
      'tokens'
    ),
    cache_read_tokens: metric(
      'continuous',
      (result) =>
        perTrial(result, (trial) => trial.usage?.cacheReadInputTokens ?? null),
      meanAggregation,
      'tokens'
    ),
    cache_creation_tokens: metric(
      'continuous',
      (result) =>
        perTrial(
          result,
          (trial) => trial.usage?.cacheCreationInputTokens ?? null
        ),
      meanAggregation,
      'tokens'
    ),
    output_tokens: metric(
      'continuous',
      (result) =>
        perTrial(result, (trial) => trial.usage?.outputTokens ?? null),
      meanAggregation,
      'tokens'
    ),
    duration_s: metric(
      'continuous',
      (result) => perTrial(result, (trial) => trial.durationMs / 1000),
      meanAggregation,
      'seconds'
    ),
    duration_api_s: metric(
      'continuous',
      (result) =>
        perTrial(result, (trial) =>
          trial.usage?.durationApiMs === undefined
            ? null
            : trial.usage.durationApiMs / 1000
        ),
      meanAggregation,
      'seconds'
    ),
    // MCP tool calls, and host-native events (host tools, skills, commands).
    mcp_call_count: metric(
      'continuous',
      (result) => perTrial(result, (trial) => traceEventCount(trial, 'mcp')),
      meanAggregation,
      'calls'
    ),
    host_event_count: metric(
      'continuous',
      (result) => perTrial(result, (trial) => traceEventCount(trial, 'host')),
      meanAggregation,
      'calls'
    ),
    tool_count: metric(
      'continuous',
      (result) =>
        perTrial(
          result,
          (trial) => trialToolCalls(trial, result)?.length ?? null
        ),
      meanAggregation,
      'calls'
    ),
    // Per case: the fraction of attempts (iterations) where it held.
    skill_loaded: metric(
      'continuous',
      (result) =>
        attemptFraction(result, (loads) => {
          const loaded = modelLoadedSkills(loads);
          return loaded === null ? null : loaded.length > 0;
        }),
      fractionRateAggregation
    ),
    skill_before_tool: metric(
      'continuous',
      (result) =>
        attemptFraction(result, (loads) => {
          const loaded = modelLoadedSkills(loads);
          return loaded === null
            ? null
            : loaded.some((load) => load.afterToolCalls === 0);
        }),
      fractionRateAggregation
    ),
    skill_verification_failed: metric(
      'continuous',
      (result) =>
        attemptFraction(result, (loads) =>
          loads.some((load) => load.verified === false)
        ),
      fractionRateAggregation
    ),
    // The first tool of the case's first trial.
    first_tool: metric('categorical', (result) => {
      const trial = caseTrials(result)[0];
      const first = trial ? trialToolCalls(trial, result)?.[0] : undefined;
      return typeof first?.name === 'string' ? first.name : null;
    }),
    response_len: metric(
      'continuous',
      (result) =>
        perTrial(result, (trial) => trialText(trial, result)?.length ?? null),
      meanAggregation,
      'chars'
    ),
    response_words: metric(
      'continuous',
      (result) =>
        perTrial(result, (trial) => {
          const text = trialText(trial, result);
          return text === null
            ? null
            : text.trim().split(/\s+/).filter(Boolean).length;
        }),
      meanAggregation,
      'words'
    ),
    judge_pass: metric('binary', judgePass, rateAggregation),
    judge_score: metric(
      'object',
      (result) => judgeScores(result),
      judgeScoreAggregation
    ),
    judge_name: metric('categorical', (result) => {
      const first = judgeEntries(result)[0];
      return first ? judgeName(first) : null;
    }),
  });

globalMetrics[BUILT_INS_KEY] = BUILT_IN_METRICS;

const metrics = extensionLookup('metrics', () => BUILT_IN_METRICS);

/** The metric `reference` names: a built-in, or `namespace/name` from a plugin. */
export function getMetric(reference: string): MetricDefinition {
  return metrics.get(reference);
}

function slug(value: string): string {
  return value.replace(/-/g, '_');
}

function metricOptions(spec: MetricSpec): Record<string, unknown> {
  if (typeof spec === 'string') return {};
  const options = Object.fromEntries(
    Object.entries(spec).filter(
      ([key]) => !['metric', 'type', 'name', 'params'].includes(key)
    )
  );
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    if (Object.hasOwn(options, key)) {
      throw new Error(
        `Ambiguous metric option "${key}": specify it at the top level or in params, not both.`
      );
    }
    Object.defineProperty(options, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return options;
}

/** Resolve one config metric, including parameterized judge metrics. */
export function resolveMetric(spec: MetricSpec): ResolvedMetric {
  const name =
    typeof spec === 'string' ? spec : (spec.metric ?? spec.type ?? spec.name);
  const params = metricOptions(spec);
  if (!name) throw new Error('Metric configuration requires a type or name.');
  const metric = metrics.get(name);
  const judge = typeof params.judge === 'string' ? params.judge : 'unknown';
  const defaultName =
    name === 'judge_pass_for' || name === 'judge_score_for'
      ? `judge_${slug(judge)}_${name === 'judge_pass_for' ? 'pass' : 'score'}`
      : name;
  return {
    metric,
    outName:
      typeof spec === 'string' ? defaultName : (spec.name ?? defaultName),
    params,
  };
}

export function computeMetrics(
  specs: MetricSpec[],
  cases: EvalCaseResult[]
): MetricResult {
  const resolved = specs.map((spec) => resolveMetric(spec));
  const perCase: MetricResult['perCase'] = Object.create(
    null
  ) as MetricResult['perCase'];
  const idCounts = new Map<string, number>();
  for (const caseResult of cases)
    idCounts.set(caseResult.id, (idCounts.get(caseResult.id) ?? 0) + 1);
  const usedKeys = new Set(cases.map((caseResult) => caseResult.id));
  const rows = cases.map((caseResult) => {
    const values: Record<string, MetricValue> = Object.create(null) as Record<
      string,
      MetricValue
    >;
    for (const item of resolved)
      values[item.outName] = item.metric.compute(caseResult, item.params);
    // Preserve legacy keys for unique IDs. Qualify collisions by dataset and
    // occurrence (also distinguishes repeated cases from different arms).
    let key = caseResult.id;
    if (idCounts.get(key)! > 1) {
      let occurrence = 0;
      do {
        key = JSON.stringify([
          caseResult.datasetName,
          caseResult.id,
          occurrence++,
        ]);
      } while (usedKeys.has(key));
      usedKeys.add(key);
    }
    perCase[key] = values;
    return values;
  });

  const aggregated: Record<string, unknown> = {};
  const unavailable: string[] = [];
  for (const item of resolved) {
    // Aggregate rows directly, never via a potentially shared case ID.
    const values = rows.map((row) => row[item.outName] ?? null);
    const aggregate = item.metric.aggregate
      ? item.metric.aggregate(values, item)
      : item.metric.kind === 'binary'
        ? rateAggregation(values, item)
        : item.metric.kind === 'continuous'
          ? meanAggregation(values, item)
          : item.metric.kind === 'object'
            ? judgeScoreAggregation(values, item)
            : values.some((value) => value !== null)
              ? {
                  key: item.outName,
                  value: values.filter((value) => value !== null),
                }
              : undefined;
    if (aggregate) aggregated[aggregate.key] = aggregate.value;
    else unavailable.push(item.outName);
  }
  return { perCase, aggregated, unavailable };
}
