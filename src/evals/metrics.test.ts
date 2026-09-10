import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvalCaseResult } from '../types/reporter.js';
import {
  BUILT_IN_METRICS,
  METRIC_REGISTRY,
  computeMetrics,
  registerMetric,
  resolveMetric,
  type MetricDefinition,
} from './metrics.js';
import {
  clearMetrics,
  getMetric,
  registerMetric as registerFrameworkMetric,
  validateManifestRegistrations,
} from './frameworkRegistries.js';

afterEach(() => {
  clearMetrics();
  for (const definition of Object.values(BUILT_IN_METRICS))
    registerFrameworkMetric(definition);
});

function result(
  id: string,
  pass: boolean,
  options: {
    calls?: string[];
    usage?: EvalCaseResult['hostUsage'];
    judge?: { name: string; pass: boolean; score: number };
    response?: EvalCaseResult['response'];
  } = {}
): EvalCaseResult {
  return {
    id,
    datasetName: 'metrics',
    toolName: 'test',
    source: 'eval',
    pass,
    response: options.response ?? {
      toolCalls: (options.calls ?? []).map((name) => ({ name })),
      response: 'one two three',
    },
    expectations: options.judge
      ? {
          judge: {
            pass: options.judge.pass,
            score: options.judge.score,
            judgeName: options.judge.name,
          },
        }
      : {},
    authType: 'none',
    durationMs: 1000,
    hostUsage: options.usage,
  };
}

describe('computeMetrics', () => {
  it('aggregates public plugin metrics by kind when no custom aggregate is provided', () => {
    registerFrameworkMetric({
      name: 'plugin-binary',
      schema: z.object({}),
      kind: 'binary',
      compute: (row) => row.pass,
    });
    registerFrameworkMetric({
      name: 'plugin-continuous',
      schema: z.object({}),
      kind: 'continuous',
      compute: (row) => row.durationMs,
    });
    const metrics = computeMetrics(
      ['plugin-binary', 'plugin-continuous'],
      [result('a', true), result('b', false)]
    );
    expect(metrics.aggregated['plugin-binary_rate']).toBe(0.5);
    expect(metrics.aggregated['plugin-continuous_mean']).toBe(1000);
  });
  it('computes Scio-compatible metrics and aggregates nulls correctly', () => {
    const cases = [
      result('one', true, {
        calls: ['search', 'read'],
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalCostUsd: 0.2,
          durationMs: 100,
          durationApiMs: 50,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
        },
        judge: { name: 'quality', pass: true, score: 0.9 },
      }),
      result('two', false),
    ];

    const metrics = computeMetrics(
      [
        'passed',
        'input_tokens',
        'input_tokens_uncached',
        'cost_usd',
        'duration_api_s',
        'tool_count',
        'response_words',
        'judge_score',
        {
          metric: 'judge_score_for',
          name: 'quality_score',
          params: { judge: 'quality' },
        },
      ],
      cases
    );

    expect(metrics.perCase.one!.input_tokens).toBe(17);
    expect(metrics.perCase.one!.input_tokens_uncached).toBe(10);
    expect(metrics.perCase.one!.duration_api_s).toBe(0.05);
    expect(metrics.perCase.one!.tool_count).toBe(2);
    expect(metrics.perCase.one!.response_words).toBe(3);
    expect(metrics.perCase.one!.judge_score).toEqual({ quality: 0.9 });
    expect(metrics.perCase.two!.cost_usd).toBeNull();
    expect(metrics.aggregated.passed_rate).toBe(0.5);
    expect(metrics.aggregated.input_tokens_mean).toBe(8.5);
    expect(metrics.aggregated.cost_usd_mean).toBe(0.2);
    expect(metrics.aggregated.quality_score_mean).toBe(0.9);
    expect(metrics.aggregated.judge_score).toEqual({ quality: 0.9 });
  });

  it('extracts text from direct MCP content responses', () => {
    const metrics = computeMetrics(
      ['response_len', 'response_words'],
      [
        result('direct', true, {
          response: {
            content: [{ type: 'text', text: 'one two three' }],
          },
        }),
      ]
    );

    expect(metrics.perCase.direct!.response_len).toBe(13);
    expect(metrics.perCase.direct!.response_words).toBe(3);
  });

  it('aggregates duplicate IDs independently across datasets and repeated arms', () => {
    const cases = [
      result('shared', true),
      { ...result('shared', false), datasetName: 'other' },
      result('shared', false),
    ];
    const metrics = computeMetrics(['passed'], cases);
    expect(Object.keys(metrics.perCase)).toHaveLength(3);
    expect(Object.values(metrics.perCase).map((row) => row.passed)).toEqual([
      true,
      false,
      false,
    ]);
    expect(metrics.aggregated.passed_rate).toBeCloseTo(1 / 3);
    expect(
      metrics.perCase[JSON.stringify(['metrics', 'shared', 0])]?.passed
    ).toBe(true);
  });

  it('avoids collisions with generated keys and handles prototype-like case IDs', () => {
    const cases = [
      result('same', true),
      result('same', false),
      result(JSON.stringify(['metrics', 'same', 0]), true),
      result('__proto__', false),
    ];
    const metrics = computeMetrics(['passed'], cases);
    expect(Object.keys(metrics.perCase)).toHaveLength(4);
    expect(metrics.perCase.__proto__?.passed).toBe(false);
    expect(metrics.aggregated.passed_rate).toBe(0.5);
  });

  it('uses one registry for both registration APIs, validation, computation, and clearing', async () => {
    const definition: MetricDefinition = {
      name: 'plugin-metric',
      schema: z.object({
        params: z
          .object({
            factor: z
              .number()
              .default(3)
              .transform((value) => value * 2),
          })
          .default({ factor: 6 }),
      }),
      kind: 'continuous',
      compute: (_case, params) => Number(params?.factor),
    };
    registerFrameworkMetric(definition);
    expect(METRIC_REGISTRY['plugin-metric']).toBe(definition);
    const parsed = validateManifestRegistrations({
      name: 'metrics',
      datasets: [],
      metrics: [{ type: 'plugin-metric', name: 'alias', params: {} }],
    });
    expect(
      computeMetrics(parsed.metrics ?? [], [result('one', true)]).perCase.one
        ?.alias
    ).toBe(6);
    const duplicate = { ...definition, compute: () => 99 };
    expect(() => registerMetric(duplicate)).toThrow('already registered');
    expect(() => {
      METRIC_REGISTRY['plugin-metric'] = duplicate;
    }).toThrow('already registered');
    expect(getMetric('plugin-metric')).toBe(definition);
    expect(resolveMetric('plugin-metric').metric).toBe(definition);
    expect(() => registerMetric(definition)).not.toThrow();
    vi.resetModules();
    const secondCopy = await import('./metrics.js');
    expect(secondCopy.resolveMetric('plugin-metric').metric).toBe(definition);
    const secondDefinition = { ...definition, name: 'second-copy' };
    secondCopy.registerMetric(secondDefinition);
    expect(getMetric('second-copy')).toBe(secondDefinition);
    clearMetrics();
    expect(Object.keys(METRIC_REGISTRY)).toEqual([]);
    expect(() => secondCopy.resolveMetric('plugin-metric')).toThrow(
      'Unknown metric'
    );
  });

  it('validates parameterized built-ins and output aliases through the same registry', () => {
    const parsed = validateManifestRegistrations({
      name: 'metrics',
      datasets: [],
      metrics: [
        {
          type: 'judge_score_for',
          name: 'quality_score',
          params: { judge: 'quality' },
        },
      ],
    });
    expect(
      computeMetrics(parsed.metrics ?? [], [
        result('one', true, {
          judge: { name: 'quality', pass: true, score: 0.7 },
        }),
      ]).perCase.one?.quality_score
    ).toBe(0.7);
    expect(() =>
      validateManifestRegistrations({
        name: 'metrics',
        datasets: [],
        metrics: [{ type: 'judge_score_for' }],
      })
    ).toThrow('Invalid metric options');
  });

  it('rejects unknown metric names instead of silently dropping them', () => {
    expect(() => computeMetrics(['not-a-metric'], [])).toThrow(
      'Unknown metric "not-a-metric"'
    );
  });
});
