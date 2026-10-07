import { describe, expect, it } from 'vitest';
import type { EvalCaseResult } from '../types/reporter.js';
import { costSource, estimateCosts } from './pricing.js';
import { computeMetrics } from './metrics.js';

function result(
  id: string,
  usage: EvalCaseResult['clientUsage'],
  trials?: Array<EvalCaseResult['clientUsage']>
): EvalCaseResult {
  return {
    id,
    datasetName: 'd',
    source: 'eval',
    pass: true,
    scores: {},
    durationMs: 1,
    clientUsage: usage,
    ...(trials
      ? {
          trialResults: trials.map((clientUsage) => ({
            pass: true,
            durationMs: 1,
            clientUsage,
          })),
        }
      : {}),
  };
}

const pricing = {
  priced: { input: 3, output: 15, cacheRead: 0.3 },
};

describe('estimateCosts', () => {
  it('prices usage without a reported cost, including cache reads, per trial', () => {
    const results = [
      result('a', { inputTokens: 2000, outputTokens: 200, durationMs: 1 }, [
        {
          inputTokens: 1000,
          outputTokens: 100,
          durationMs: 1,
          cacheReadInputTokens: 1000,
        },
        { inputTokens: 1000, outputTokens: 100, durationMs: 1 },
      ]),
    ];
    estimateCosts(results, () => 'priced', pricing);
    const trials = results[0]!.trialResults!;
    expect(trials[0]!.clientUsage!.estimatedCostUsd).toBeCloseTo(0.0048, 9);
    expect(trials[1]!.clientUsage!.estimatedCostUsd).toBeCloseTo(0.0045, 9);
    expect(
      computeMetrics(['cost_usd'], results).aggregated.cost_usd_mean
    ).toBeCloseTo(0.00465, 9);
    expect(costSource(results)).toBe('pricing');
  });

  it('never replaces a reported cost, and leaves unpriced models unpriced', () => {
    const reported = result('r', {
      inputTokens: 1000,
      outputTokens: 0,
      durationMs: 1,
      totalCostUsd: 1,
    });
    const unpriced = result('u', {
      inputTokens: 1000,
      outputTokens: 0,
      durationMs: 1,
    });
    estimateCosts([reported], () => 'priced', pricing);
    estimateCosts([unpriced], () => 'other-model', pricing);
    expect(reported.clientUsage).not.toHaveProperty('estimatedCostUsd');
    expect(unpriced.clientUsage).not.toHaveProperty('estimatedCostUsd');
    expect(costSource([reported])).toBe('client');
    expect(costSource([unpriced])).toBeUndefined();
    estimateCosts([unpriced], () => 'priced', pricing);
    expect(costSource([reported, unpriced])).toBe('mixed');
  });
});

describe('call counts', () => {
  it('counts MCP calls and client-native events separately, per trial', () => {
    const traced: EvalCaseResult = {
      ...result('t', undefined),
      trace: {
        evidence: 'structured',
        events: [
          { kind: 'tool_call', source: 'mcp', name: 'search', server: 'docs' },
          { kind: 'tool_call', source: 'mcp', name: 'read', server: 'docs' },
          { kind: 'tool_call', source: 'builtin', name: 'ToolSearch' },
          { kind: 'skill', source: 'builtin', name: 'summarize' },
        ],
      },
    };
    expect(
      computeMetrics(['mcp_call_count', 'builtin_event_count'], [traced])
        .aggregated
    ).toEqual({ mcp_call_count_mean: 2, builtin_event_count_mean: 2 });
  });
});
