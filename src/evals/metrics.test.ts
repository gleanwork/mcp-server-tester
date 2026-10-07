import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillLoad } from '../types/index.js';
import type { EvalCaseResult } from '../types/reporter.js';
import {
  BUILT_IN_METRICS,
  computeMetrics,
  resolveMetric,
  type MetricDefinition,
} from './metrics.js';
import { validateEvalConfig } from './configValidation.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import { getMetric } from './metrics.js';

afterEach(() => resetPluginsForTests());

/** Install a `test` plugin providing `metrics` (referenced as `test/<name>`). */
function installMetrics(metrics: Record<string, MetricDefinition>): void {
  installPlugins([
    { meta: { name: 'test-plugin', namespace: 'test' }, metrics },
  ]);
}

function result(
  id: string,
  pass: boolean,
  options: {
    calls?: string[];
    usage?: EvalCaseResult['clientUsage'];
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
    scores: options.judge
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
    clientUsage: options.usage,
  };
}

describe('computeMetrics', () => {
  it('aggregates public plugin metrics by kind when no custom aggregate is provided', () => {
    installMetrics({
      'plugin-binary': {
        schema: z.object({}),
        kind: 'binary',
        compute: (row) => row.pass,
      },
      'plugin-continuous': {
        schema: z.object({}),
        kind: 'continuous',
        compute: (row) => row.durationMs,
      },
    });
    const metrics = computeMetrics(
      ['test/plugin-binary', 'test/plugin-continuous'],
      [result('a', true), result('b', false)]
    );
    expect(metrics.aggregated['test/plugin-binary_rate']).toBe(0.5);
    expect(metrics.aggregated['test/plugin-continuous_mean']).toBe(1000);
  });
  it('keeps the built-in metrics read-only', () => {
    expect(Object.isFrozen(BUILT_IN_METRICS)).toBe(true);
  });
  it('computes built-in metrics and aggregates nulls correctly', () => {
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
    expect(metrics.perCase.two!.input_tokens).toBeNull();
    expect(metrics.aggregated.input_tokens_mean).toBe(17);
    expect(metrics.aggregated.cost_usd_mean).toBe(0.2);
    expect(metrics.aggregated.quality_score_mean).toBe(0.9);
    expect(metrics.aggregated.judge_score).toEqual({ quality: 0.9 });
  });

  it('keeps unknown input usage null while including measured zero in the mean', () => {
    const unknown = computeMetrics(['input_tokens'], [result('unknown', true)]);
    expect(unknown.perCase.unknown?.input_tokens).toBeNull();
    expect(unknown.aggregated).not.toHaveProperty('input_tokens_mean');
    const measured = computeMetrics(
      ['input_tokens'],
      [
        result('unknown', true),
        result('zero', true, {
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0,
            durationMs: 0,
          },
        }),
        result('known', true, {
          usage: {
            inputTokens: 10,
            outputTokens: 1,
            totalCostUsd: 0,
            durationMs: 0,
          },
        }),
      ]
    );
    expect(measured.perCase.zero?.input_tokens).toBe(0);
    expect(measured.aggregated.input_tokens_mean).toBe(5);
  });

  it('passes tagged metric options through to compute without routing metadata', () => {
    const compute = vi.fn(
      (_row: EvalCaseResult, options?: Record<string, unknown>) =>
        Number(options?.weight)
    );
    installMetrics({
      weighted: {
        schema: z.object({ weight: z.number() }),
        kind: 'continuous',
        compute,
      },
    });
    const metrics = computeMetrics(
      [{ type: 'test/weighted', name: 'weighted_alias', weight: 7 }],
      [result('one', true)]
    );
    expect(metrics.perCase.one?.weighted_alias).toBe(7);
    expect(compute).toHaveBeenCalledWith(expect.anything(), { weight: 7 });
  });

  it('retains parsed top-level defaults and transforms without reparsing', () => {
    installMetrics({
      'weighted-parsed': {
        schema: z.object({
          weight: z
            .number()
            .default(3)
            .transform((value) => value * 2),
        }),
        kind: 'continuous',
        compute: (_row, options) => Number(options?.weight),
      },
    });
    const parsed = validateEvalConfig({
      name: 'metrics',
      datasets: [],
      metrics: [{ type: 'test/weighted-parsed', name: 'alias' }],
    });
    expect(
      computeMetrics(parsed.metrics ?? [], [result('one', true)]).perCase.one
        ?.alias
    ).toBe(6);
  });

  it('flattens legacy params only when keys do not overlap top-level options', () => {
    expect(
      resolveMetric({ type: 'passed', params: { weight: 7 } }).params
    ).toEqual({ weight: 7 });
    expect(
      resolveMetric({ type: 'passed', weight: 7, params: { offset: 2 } }).params
    ).toEqual({ weight: 7, offset: 2 });
    for (const weight of [7, 8]) {
      expect(() =>
        resolveMetric({ type: 'passed', weight: 7, params: { weight } })
      ).toThrow('Ambiguous metric option "weight"');
    }
  });

  it('accepts tagged top-level judge options with default output names', () => {
    const evalConfig = validateEvalConfig({
      name: 'metrics',
      datasets: [],
      metrics: [{ type: 'judge_score_for', judge: 'quality' }],
    });
    const metrics = computeMetrics(evalConfig.metrics ?? [], [
      result('one', true, {
        judge: { name: 'quality', pass: true, score: 0.7 },
      }),
    ]);
    expect(metrics.perCase.one?.judge_quality_score).toBe(0.7);
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

  it('aggregates duplicate IDs independently across datasets and repeated variants', () => {
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

  it('uses one extension table for validation, computation, module copies, and reset', async () => {
    const definition: MetricDefinition = {
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
    installMetrics({ 'plugin-metric': definition });
    const parsed = validateEvalConfig({
      name: 'metrics',
      datasets: [],
      metrics: [{ type: 'test/plugin-metric', name: 'alias', params: {} }],
    });
    expect(
      computeMetrics(parsed.metrics ?? [], [result('one', true)]).perCase.one
        ?.alias
    ).toBe(6);
    expect(getMetric('test/plugin-metric')).toBe(definition);
    expect(resolveMetric('test/plugin-metric').metric).toBe(definition);
    // Installing the same plugin version again is a no-op.
    const versioned = {
      meta: {
        name: 'versioned-plugin',
        version: '1.0.0',
        namespace: 'versioned',
      },
      metrics: { 'plugin-metric': definition },
    };
    installPlugins([versioned]);
    expect(() =>
      installPlugins([{ ...versioned, meta: { ...versioned.meta } }])
    ).not.toThrow();
    vi.resetModules();
    const secondCopy = await import('./metrics.js');
    expect(secondCopy.resolveMetric('test/plugin-metric').metric).toBe(
      definition
    );
    resetPluginsForTests();
    expect(() => secondCopy.resolveMetric('test/plugin-metric')).toThrow(
      'Metric "test/plugin-metric" needs the "test" plugin, which is not loaded.'
    );
    // Built-ins survive the reset.
    expect(secondCopy.resolveMetric('passed').outName).toBe('passed');
  });

  it('validates parameterized built-ins and output aliases through the same lookup', () => {
    const parsed = validateEvalConfig({
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
      validateEvalConfig({
        name: 'metrics',
        datasets: [],
        metrics: [{ type: 'judge_score_for' }],
      })
    ).toThrow('Invalid metric options');
  });

  it('rejects unknown metric names instead of silently dropping them', () => {
    expect(() => computeMetrics(['not-a-metric'], [])).toThrow(
      'Metric "not-a-metric" is not available. Available: '
    );
  });
});

describe('skill metrics', () => {
  const load = (verified: boolean, afterToolCalls: number): SkillLoad => ({
    name: 'weather-report',
    uri: 'skill://weather-report/SKILL.md',
    server: 'mcp',
    kind: 'skill',
    via: 'read_skill',
    verified,
    afterToolCalls,
  });

  it('computes load, load-before-tool, and verification-failure rates', () => {
    const cases = [
      result('before', true, {
        response: { toolCalls: [], skillLoads: [load(true, 0)] },
      }),
      result('after', true, {
        response: { toolCalls: [], skillLoads: [load(true, 2)] },
      }),
      result('refused', false, {
        response: { toolCalls: [], skillLoads: [load(false, 0)] },
      }),
      result('none', false, { response: { toolCalls: [], skillLoads: [] } }),
      // Skills disabled: excluded from the rates.
      result('off', true),
    ];

    const { perCase, aggregated } = computeMetrics(
      ['skill_loaded', 'skill_before_tool', 'skill_verification_failed'],
      cases
    );

    expect(perCase.off!.skill_loaded).toBeNull();
    expect(perCase.refused!.skill_loaded).toBe(0);
    expect(aggregated.skill_loaded_rate).toBe(0.5);
    expect(aggregated.skill_before_tool_rate).toBe(0.25);
    expect(aggregated.skill_verification_failed_rate).toBe(0.25);
  });

  it('averages across trials', () => {
    const multi = {
      ...result('multi', true),
      trialResults: [
        { pass: true, durationMs: 1, skillLoads: [load(true, 0)] },
        { pass: false, durationMs: 1, skillLoads: [] },
        { pass: true, durationMs: 1, skillLoads: [load(true, 1)] },
        { pass: true, durationMs: 1, skillLoads: [load(true, 0)] },
      ],
    };
    const { perCase } = computeMetrics(
      ['skill_loaded', 'skill_before_tool'],
      [multi]
    );
    expect(perCase.multi!.skill_loaded).toBe(0.75);
    expect(perCase.multi!.skill_before_tool).toBe(0.5);
  });

  it('does not count preloaded skills as loads', () => {
    const preloaded = result('preloaded', true, {
      response: {
        toolCalls: [],
        skillLoads: [{ ...load(true, 0), via: 'preload' as const }],
      },
    });
    const { perCase } = computeMetrics(
      ['skill_loaded', 'skill_before_tool', 'skill_verification_failed'],
      [preloaded]
    );
    expect(perCase.preloaded!.skill_loaded).toBeNull();
    expect(perCase.preloaded!.skill_before_tool).toBeNull();
    expect(perCase.preloaded!.skill_verification_failed).toBe(0);
  });
});

describe('per-trial metrics', () => {
  const usage = (inputTokens: number) => ({
    inputTokens,
    outputTokens: 10,
    durationMs: 1,
  });
  const event = (name: string) => ({
    kind: 'tool_call' as const,
    source: 'mcp' as const,
    name,
  });
  const trace = (
    calls: number,
    evidence: 'structured' | 'none' = 'structured'
  ) => ({
    events: Array.from({ length: calls }, (_, i) => event(`tool${i}`)),
    finalText: 'done',
    evidence,
  });
  const iterated = (
    overrides: Partial<EvalCaseResult> = {}
  ): EvalCaseResult => ({
    id: 'multi',
    datasetName: 'd',
    source: 'eval',
    pass: false,
    scores: {},
    durationMs: 999,
    // The case keeps the last trial's response and the summed usage.
    response: { toolCalls: [] },
    clientUsage: usage(600),
    passRate: 0.5,
    trialResults: [
      { pass: true, durationMs: 100, trace: trace(2), clientUsage: usage(100) },
      {
        pass: false,
        durationMs: 300,
        trace: trace(1),
        clientUsage: usage(300),
      },
      // Infrastructure failures don't count, as for the pass rate.
      {
        pass: false,
        durationMs: 0,
        isInfrastructureError: true,
        clientUsage: usage(200),
      },
    ],
    ...overrides,
  });

  it("averages usage, timing and tool counts over a case's trials", () => {
    const { aggregated } = computeMetrics(
      ['tool_count', 'input_tokens', 'duration_s', 'is_no_action'],
      [iterated()]
    );
    expect(aggregated).toEqual({
      tool_count_mean: 1.5,
      input_tokens_mean: 200,
      duration_s_mean: 0.2,
      is_no_action_rate: 0,
    });
  });

  it('reports the share of passing trials as trial_pass_rate', () => {
    const single: EvalCaseResult = {
      ...iterated(),
      id: 'single',
      trialResults: undefined,
      passRate: undefined,
      pass: true,
    };
    const { aggregated } = computeMetrics(
      ['passed', 'trial_pass'],
      [iterated(), single]
    );
    expect(aggregated).toEqual({ passed_rate: 0.5, trial_pass_rate: 0.75 });
  });

  it('reports no trace metrics for a host with no evidence, and lists them as unavailable', () => {
    const blind = iterated({
      trialResults: [{ pass: true, durationMs: 100, trace: trace(0, 'none') }],
    });
    const { aggregated, unavailable } = computeMetrics(
      ['tool_count', 'first_tool', 'cost_usd', 'passed'],
      [blind]
    );
    expect(aggregated.tool_count_mean).toBeUndefined();
    expect(unavailable).toEqual(['tool_count', 'first_tool', 'cost_usd']);
  });

  it('falls back to the response for results without a trace', () => {
    const direct: EvalCaseResult = {
      id: 'direct',
      datasetName: 'd',
      toolName: 'search',
      source: 'eval',
      pass: true,
      scores: {},
      durationMs: 5,
      response: { toolCalls: [{ name: 'a' }, { name: 'b' }] },
    };
    expect(computeMetrics(['tool_count'], [direct]).aggregated).toEqual({
      tool_count_mean: 2,
    });
  });

  it('names MCP tools by server, and reads only the first trial for first_tool', () => {
    const labelled = iterated({
      trialResults: [
        {
          pass: true,
          durationMs: 1,
          trace: {
            events: [
              {
                kind: 'tool_call',
                source: 'mcp',
                name: 'search',
                server: 'docs',
              },
              { kind: 'tool_call', source: 'host', name: 'ToolSearch' },
            ],
          },
        },
        { pass: true, durationMs: 1, trace: trace(1) },
      ],
    });
    expect(computeMetrics(['first_tool'], [labelled]).aggregated).toEqual({
      first_tool: ['docs.search'],
    });
  });

  it('leaves out runs that failed on infrastructure, and counts host failures as unsuccessful', () => {
    const base = {
      datasetName: 'd',
      source: 'eval' as const,
      pass: false,
      scores: {},
      durationMs: 30_000,
      response: undefined,
    };
    const outage: EvalCaseResult = {
      ...base,
      id: 'outage',
      error: 'fetch failed: ECONNRESET',
    };
    const crash: EvalCaseResult = {
      ...base,
      id: 'crash',
      error: 'Host execution failed.',
      trace: { events: [], error: 'Host execution failed.' },
    };
    const { aggregated } = computeMetrics(
      ['response_success', 'duration_s', 'trial_pass'],
      [outage, crash]
    );
    // Only the crash is a trial: it ran, and failed.
    expect(aggregated).toEqual({
      response_success_rate: 0,
      duration_s_mean: 30,
      trial_pass_rate: 0,
    });
  });

  it("doesn't borrow the case's response for a trial without a trace", () => {
    const partial = iterated({
      response: { toolCalls: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      trialResults: [
        { pass: true, durationMs: 1, trace: trace(1) },
        { pass: false, durationMs: 1, error: 'assertion threw' },
      ],
    });
    expect(computeMetrics(['tool_count'], [partial]).aggregated).toEqual({
      tool_count_mean: 1,
    });
  });
});

describe('tool_search_hit', () => {
  type Event = NonNullable<EvalCaseResult['trace']>['events'][number];
  const search = (...names: Array<[string, string?]>): Event => ({
    kind: 'tool_search',
    source: 'host',
    name: 'ToolSearch',
    results: names.map(([name, server]) => ({
      name,
      ...(server ? { server } : {}),
    })),
  });
  const call = (name: string, server?: string): Event => ({
    kind: 'tool_call',
    source: 'mcp',
    name,
    ...(server ? { server } : {}),
  });
  const traced = (
    id: string,
    events: Event[],
    evidence: 'structured' | 'none' = 'structured'
  ): EvalCaseResult => ({
    ...result(id, true),
    trace: { events, finalText: '', evidence },
  });

  it('is the share of trials whose search led to a call', () => {
    const { perCase, aggregated, unavailable } = computeMetrics(
      ['tool_search_hit'],
      [
        traced('hit', [
          search(['find_skills', 'agg']),
          call('find_skills', 'agg'),
        ]),
        traced('bare', [search(['find_skills']), call('find_skills', 'agg')]),
        traced('miss', [search(['search', 'agg']), call('find_skills', 'agg')]),
        traced('before', [
          call('find_skills', 'agg'),
          search(['find_skills', 'agg']),
        ]),
        traced('other-server', [
          search(['find_skills', 'b']),
          call('find_skills', 'agg'),
        ]),
        traced('no-search', [call('find_skills', 'agg')]),
        traced('no-evidence', [search(['x']), call('x')], 'none'),
      ]
    );
    expect(perCase.hit!.tool_search_hit).toBe(1);
    expect(perCase.bare!.tool_search_hit).toBe(1);
    expect(perCase.miss!.tool_search_hit).toBe(0);
    expect(perCase.before!.tool_search_hit).toBe(0);
    expect(perCase['other-server']!.tool_search_hit).toBe(0);
    expect(perCase['no-search']!.tool_search_hit).toBeNull();
    expect(perCase['no-evidence']!.tool_search_hit).toBeNull();
    expect(aggregated.tool_search_hit_rate).toBeCloseTo(2 / 5);
    expect(unavailable).toEqual([]);
  });
});
