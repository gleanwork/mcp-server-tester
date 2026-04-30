import { describe, it, expect } from 'vitest';
import { sumUsage } from './usageUtils.js';
import type { UsageMetrics } from '../types/index.js';

describe('sumUsage', () => {
  const base: UsageMetrics = {
    inputTokens: 100,
    outputTokens: 50,
    totalCostUsd: 0.01,
    durationMs: 500,
  };

  it('returns undefined when both are undefined', () => {
    expect(sumUsage(undefined, undefined)).toBeUndefined();
  });

  it('returns a copy of b when a is undefined', () => {
    const result = sumUsage(undefined, base);
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
  });

  it('returns a copy of a when b is undefined', () => {
    const result = sumUsage(base, undefined);
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
  });

  it('sums all required fields', () => {
    const other: UsageMetrics = {
      inputTokens: 200,
      outputTokens: 100,
      totalCostUsd: 0.02,
      durationMs: 300,
    };
    expect(sumUsage(base, other)).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalCostUsd: 0.03,
      durationMs: 800,
    });
  });

  it('sums optional fields when both present', () => {
    const a: UsageMetrics = {
      ...base,
      durationApiMs: 400,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    };
    const b: UsageMetrics = {
      ...base,
      durationApiMs: 200,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 15,
    };
    const result = sumUsage(a, b)!;
    expect(result.durationApiMs).toBe(600);
    expect(result.cacheReadInputTokens).toBe(30);
    expect(result.cacheCreationInputTokens).toBe(20);
  });

  it('treats missing optional fields as zero when the other side has them', () => {
    const a: UsageMetrics = { ...base, durationApiMs: 400 };
    const b: UsageMetrics = { ...base };
    const result = sumUsage(a, b)!;
    expect(result.durationApiMs).toBe(400);
  });

  it('omits optional fields when neither side has them', () => {
    const result = sumUsage(base, base)!;
    expect(result.durationApiMs).toBeUndefined();
    expect(result.cacheReadInputTokens).toBeUndefined();
    expect(result.cacheCreationInputTokens).toBeUndefined();
  });
});
