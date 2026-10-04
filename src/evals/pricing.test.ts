import { describe, expect, it } from 'vitest';
import type { EvalCaseResult } from '../types/reporter.js';
import { costSource, estimateCosts } from './pricing.js';
import { computeMetrics } from './metrics.js';

function result(
  id: string,
  usage: EvalCaseResult['hostUsage'],
  iterations?: Array<EvalCaseResult['hostUsage']>
): EvalCaseResult {
  return {
    id,
    datasetName: 'd',
    toolName: 'mcp_host',
    source: 'eval',
    pass: true,
    expectations: {},
    durationMs: 1,
    hostUsage: usage,
    ...(iterations
      ? {
          iterationResults: iterations.map((hostUsage) => ({
            pass: true,
            durationMs: 1,
            hostUsage,
          })),
        }
      : {}),
  };
}

const pricing = {
  priced: { input: 3, output: 15, cacheRead: 0.3 },
};

describe('estimateCosts', () => {
  it('prices usage without a reported cost, including cache reads, per iteration', () => {
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
    const iterations = results[0]!.iterationResults!;
    expect(iterations[0]!.hostUsage!.estimatedCostUsd).toBeCloseTo(0.0048, 9);
    expect(iterations[1]!.hostUsage!.estimatedCostUsd).toBeCloseTo(0.0045, 9);
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
    expect(reported.hostUsage).not.toHaveProperty('estimatedCostUsd');
    expect(unpriced.hostUsage).not.toHaveProperty('estimatedCostUsd');
    expect(costSource([reported])).toBe('host');
    expect(costSource([unpriced])).toBeUndefined();
    estimateCosts([unpriced], () => 'priced', pricing);
    expect(costSource([reported, unpriced])).toBe('mixed');
  });
});

describe('call counts', () => {
  it('counts MCP calls and host-native events separately, per trial', () => {
    const traced: EvalCaseResult = {
      ...result('t', undefined),
      trace: {
        evidence: 'structured',
        events: [
          { kind: 'tool_call', source: 'mcp', name: 'search', server: 'docs' },
          { kind: 'tool_call', source: 'mcp', name: 'read', server: 'docs' },
          { kind: 'tool_call', source: 'host', name: 'ToolSearch' },
          { kind: 'skill', source: 'host', name: 'summarize' },
        ],
      },
    };
    expect(
      computeMetrics(['mcp_call_count', 'host_event_count'], [traced])
        .aggregated
    ).toEqual({ mcp_call_count_mean: 2, host_event_count_mean: 2 });
  });
});
