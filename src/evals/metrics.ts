import { z } from 'zod';
import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import {
  getMetric,
  listMetrics,
  registerMetric as registerFrameworkMetric,
} from './frameworkRegistries.js';
export type MetricSpec =
  | string
  | {
      metric?: string;
      type?: string;
      name?: string;
      params?: Record<string, unknown>;
    };

import type {
  MetricValue,
  MetricKind,
  MetricDefinition,
  ResolvedMetric,
} from './evalFrameworkTypes.js';
export type {
  MetricValue,
  MetricKind,
  MetricDefinition,
  ResolvedMetric,
} from './evalFrameworkTypes.js';

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
  name: string,
  kind: MetricKind,
  compute: MetricDefinition['compute'],
  aggregate?: MetricDefinition['aggregate'],
  unit?: string
): MetricDefinition {
  return {
    name,
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
      name,
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
    schema: z
      .object({ params: z.object({ judge: z.string().min(1) }) })
      .passthrough(),
  };
}

const BUILT_INS_KEY = Symbol.for('mcp-server-tester.built-in-metrics');
const globalMetrics = globalThis as unknown as Record<symbol, unknown>;

/** Built-in metrics, including the metrics used by Scio's evaluations. */
export const BUILT_IN_METRICS: Record<string, MetricDefinition> =
  (globalMetrics[BUILT_INS_KEY] as
    | Record<string, MetricDefinition>
    | undefined) ?? {
    judge_pass_for: parameterizedJudgeMetric('judge_pass_for'),
    judge_score_for: parameterizedJudgeMetric('judge_score_for'),
    passed: metric(
      'passed',
      'binary',
      (result) => result.pass,
      rateAggregation
    ),
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
      (result) =>
        responseText(result).trim().split(/\s+/).filter(Boolean).length,
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

globalMetrics[BUILT_INS_KEY] = BUILT_IN_METRICS;

/**
 * Live record-compatible view of the process-wide framework registry. Both
 * registration APIs, validation, and computation use the same backing map.
 */
export const METRIC_REGISTRY: Record<string, MetricDefinition> = new Proxy(
  Object.create(null) as Record<string, MetricDefinition>,
  {
    get(_target, key) {
      return typeof key === 'string'
        ? listMetrics().find((definition) => definition.name === key)
        : undefined;
    },
    set(_target, key, definition: MetricDefinition) {
      if (typeof key !== 'string' || key !== definition.name) {
        throw new Error('Metric registry key must match the definition name.');
      }
      registerFrameworkMetric(definition);
      return true;
    },
    has(_target, key) {
      return (
        typeof key === 'string' &&
        listMetrics().some((definition) => definition.name === key)
      );
    },
    ownKeys() {
      return listMetrics().map((definition) => definition.name);
    },
    getOwnPropertyDescriptor(_target, key) {
      if (
        typeof key !== 'string' ||
        !listMetrics().some((definition) => definition.name === key)
      )
        return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: getMetric(key),
      };
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
    preventExtensions() {
      return false;
    },
  }
);

for (const definition of Object.values(BUILT_IN_METRICS)) {
  registerFrameworkMetric(definition);
}

/** Register a named metric; conflicting duplicates leave the registry unchanged. */
export function registerMetric(definition: MetricDefinition): void {
  registerFrameworkMetric(definition);
}

function slug(value: string): string {
  return value.replace(/-/g, '_');
}

/** Resolve one config metric, including parameterized judge metrics. */
export function resolveMetric(
  spec: MetricSpec,
  registry: Record<string, MetricDefinition> = METRIC_REGISTRY
): ResolvedMetric {
  const name =
    typeof spec === 'string' ? spec : (spec.metric ?? spec.type ?? spec.name);
  const params = typeof spec === 'string' ? {} : (spec.params ?? {});
  if (!name) throw new Error('Metric configuration requires a type or name.');
  const base = registry[name];
  if (base) {
    const judge = typeof params.judge === 'string' ? params.judge : 'unknown';
    const defaultName =
      name === 'judge_pass_for' || name === 'judge_score_for'
        ? `judge_${slug(judge)}_${name === 'judge_pass_for' ? 'pass' : 'score'}`
        : name;
    return {
      metric: base,
      outName:
        typeof spec === 'string' ? defaultName : (spec.name ?? defaultName),
      params,
    };
  }

  throw new Error(
    `Unknown metric "${name}". Available metrics: ${Object.keys(registry)
      .sort()
      .join(', ')}`
  );
}

export function computeMetrics(
  specs: MetricSpec[],
  cases: EvalCaseResult[],
  registry: Record<string, MetricDefinition> = METRIC_REGISTRY
): MetricResult {
  const resolved = specs.map((spec) => resolveMetric(spec, registry));
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
            : {
                key: item.outName,
                value: values.filter((value) => value !== null),
              };
    if (aggregate) aggregated[aggregate.key] = aggregate.value;
  }
  return { perCase, aggregated };
}
