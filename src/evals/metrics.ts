import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import type { MetricSpec } from './evalConfigSchema.js';

/** Values emitted by a metric for one eval case. */
export type MetricValue =
  boolean | number | string | Record<string, number> | null;

export type MetricKind = 'binary' | 'continuous' | 'categorical' | 'object';

export interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit?: string;
  compute(caseResult: EvalCaseResult): MetricValue;
  aggregate?(
    values: MetricValue[],
    metric: ResolvedMetric
  ): { key: string; value: unknown } | undefined;
}

export interface ResolvedMetric {
  readonly metric: MetricDefinition;
  readonly outName: string;
  readonly params: Record<string, unknown>;
}

export interface MetricResult {
  perCase: Record<string, Record<string, MetricValue>>;
  aggregated: Record<string, unknown>;
}

function hostUsage(caseResult: EvalCaseResult): UsageMetrics | undefined {
  return caseResult.hostUsage;
}

function responseObject(caseResult: EvalCaseResult): Record<string, unknown> {
  const response = caseResult.response;
  return response && typeof response === 'object'
    ? (response as Record<string, unknown>)
    : {};
}

function toolCalls(caseResult: EvalCaseResult): unknown[] {
  const calls = responseObject(caseResult).toolCalls;
  return Array.isArray(calls) ? calls : [];
}

function responseText(caseResult: EvalCaseResult): string {
  const response = responseObject(caseResult).response;
  return typeof response === 'string' ? response : '';
}

function judgeEntries(
  caseResult: EvalCaseResult
): Array<Record<string, unknown>> {
  const judge = caseResult.expectations?.judge as
    Record<string, unknown> | undefined;
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
  name: string,
  kind: MetricKind,
  compute: (caseResult: EvalCaseResult) => MetricValue,
  aggregate?: MetricDefinition['aggregate'],
  unit?: string
): MetricDefinition {
  return { name, kind, compute, aggregate, unit };
}

/** Built-in metrics, including the metrics used by Scio's eval campaigns. */
export const BUILT_IN_METRICS: Record<string, MetricDefinition> = {
  passed: metric('passed', 'binary', (result) => result.pass, rateAggregation),
  response_success: metric(
    'response_success',
    'binary',
    (result) => responseObject(result).success !== false,
    rateAggregation
  ),
  is_no_action: metric(
    'is_no_action',
    'binary',
    (result) => toolCalls(result).length === 0,
    rateAggregation
  ),
  cost_usd: metric(
    'cost_usd',
    'continuous',
    (result) => hostUsage(result)?.totalCostUsd ?? null,
    meanAggregation,
    'USD'
  ),
  input_tokens: metric(
    'input_tokens',
    'continuous',
    (result) => {
      const usage = hostUsage(result);
      return usage
        ? usage.inputTokens +
            (usage.cacheReadInputTokens ?? 0) +
            (usage.cacheCreationInputTokens ?? 0)
        : 0;
    },
    meanAggregation,
    'tokens'
  ),
  input_tokens_uncached: metric(
    'input_tokens_uncached',
    'continuous',
    (result) => hostUsage(result)?.inputTokens ?? null,
    meanAggregation,
    'tokens'
  ),
  cache_read_tokens: metric(
    'cache_read_tokens',
    'continuous',
    (result) => hostUsage(result)?.cacheReadInputTokens ?? null,
    meanAggregation,
    'tokens'
  ),
  cache_creation_tokens: metric(
    'cache_creation_tokens',
    'continuous',
    (result) => hostUsage(result)?.cacheCreationInputTokens ?? null,
    meanAggregation,
    'tokens'
  ),
  output_tokens: metric(
    'output_tokens',
    'continuous',
    (result) => hostUsage(result)?.outputTokens ?? null,
    meanAggregation,
    'tokens'
  ),
  duration_s: metric(
    'duration_s',
    'continuous',
    (result) => result.durationMs / 1000,
    meanAggregation,
    'seconds'
  ),
  duration_api_s: metric(
    'duration_api_s',
    'continuous',
    (result) => {
      const durationMs = hostUsage(result)?.durationApiMs;
      return durationMs === undefined ? null : durationMs / 1000;
    },
    meanAggregation,
    'seconds'
  ),
  tool_count: metric(
    'tool_count',
    'continuous',
    (result) => toolCalls(result).length,
    meanAggregation,
    'calls'
  ),
  first_tool: metric('first_tool', 'categorical', (result) => {
    const first = toolCalls(result)[0];
    return first && typeof first === 'object' && 'name' in first
      ? String(first.name)
      : null;
  }),
  response_len: metric(
    'response_len',
    'continuous',
    (result) => responseText(result).length,
    meanAggregation,
    'chars'
  ),
  response_words: metric(
    'response_words',
    'continuous',
    (result) => responseText(result).trim().split(/\s+/).filter(Boolean).length,
    meanAggregation,
    'words'
  ),
  judge_pass: metric('judge_pass', 'binary', judgePass, rateAggregation),
  judge_score: metric(
    'judge_score',
    'object',
    (result) => judgeScores(result),
    judgeScoreAggregation
  ),
  judge_name: metric('judge_name', 'categorical', (result) => {
    const first = judgeEntries(result)[0];
    return first ? judgeName(first) : null;
  }),
};

/** Registry used by suite runs and available for application-specific metrics. */
export const METRIC_REGISTRY: Record<string, MetricDefinition> = {
  ...BUILT_IN_METRICS,
};

/** Register or replace a named metric for subsequent runs. */
export function registerMetric(definition: MetricDefinition): void {
  METRIC_REGISTRY[definition.name] = definition;
}

function slug(value: string): string {
  return value.replace(/-/g, '_');
}

/** Resolve one config metric, including parameterized judge metrics. */
export function resolveMetric(
  spec: MetricSpec,
  registry: Record<string, MetricDefinition> = METRIC_REGISTRY
): ResolvedMetric {
  const name = typeof spec === 'string' ? spec : spec.metric;
  const params = typeof spec === 'string' ? {} : (spec.params ?? {});
  const base = registry[name];
  if (base) {
    return {
      metric: base,
      outName: typeof spec === 'string' ? name : (spec.name ?? name),
      params,
    };
  }

  if (name === 'judge_pass_for' || name === 'judge_score_for') {
    const judge = typeof params.judge === 'string' ? params.judge : '';
    const defaultName = `judge_${slug(judge || 'unknown')}_${
      name === 'judge_pass_for' ? 'pass' : 'score'
    }`;
    const definition = metric(
      name,
      name === 'judge_pass_for' ? 'binary' : 'continuous',
      (result) => {
        const entry = judgeEntries(result).find(
          (item) => judgeName(item) === judge
        );
        if (!entry) return null;
        return name === 'judge_pass_for'
          ? typeof entry.pass === 'boolean'
            ? entry.pass
            : null
          : scoreFromJudge(entry);
      },
      name === 'judge_pass_for' ? rateAggregation : meanAggregation
    );
    return {
      metric: definition,
      outName:
        typeof spec === 'string' ? defaultName : (spec.name ?? defaultName),
      params,
    };
  }

  throw new Error(
    `Unknown metric "${name}". Available metrics: ${Object.keys(registry)
      .sort()
      .join(', ')}, judge_pass_for, judge_score_for`
  );
}

export function computeMetrics(
  specs: MetricSpec[],
  cases: EvalCaseResult[],
  registry: Record<string, MetricDefinition> = METRIC_REGISTRY
): MetricResult {
  const resolved = specs.map((spec) => resolveMetric(spec, registry));
  const perCase: MetricResult['perCase'] = {};
  for (const caseResult of cases) {
    const values: Record<string, MetricValue> = {};
    for (const item of resolved)
      values[item.outName] = item.metric.compute(caseResult);
    perCase[caseResult.id] = values;
  }

  const aggregated: Record<string, unknown> = {};
  for (const item of resolved) {
    const values = cases.map(
      (caseResult) => perCase[caseResult.id]?.[item.outName] ?? null
    );
    const aggregate = item.metric.aggregate?.(values, item);
    if (aggregate) aggregated[aggregate.key] = aggregate.value;
  }
  return { perCase, aggregated };
}
