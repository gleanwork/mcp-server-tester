import { describe, expect, it } from 'vitest';
import type { EvalCaseResult } from '../types/reporter.js';
import { computeMetrics } from './metrics.js';

function result(
  id: string,
  pass: boolean,
  options: {
    calls?: string[];
    usage?: EvalCaseResult['hostUsage'];
    judge?: { name: string; pass: boolean; score: number };
  } = {}
): EvalCaseResult {
  return {
    id,
    datasetName: 'metrics',
    toolName: 'test',
    source: 'eval',
    pass,
    response: {
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

  it('rejects unknown metric names instead of silently dropping them', () => {
    expect(() => computeMetrics(['not-a-metric'], [])).toThrow(
      'Unknown metric "not-a-metric"'
    );
  });
});
