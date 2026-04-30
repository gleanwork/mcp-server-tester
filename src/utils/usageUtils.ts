import type { UsageMetrics } from '../types/index.js';

function optionalSum(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export function sumUsage(
  a: UsageMetrics | undefined,
  b: UsageMetrics | undefined
): UsageMetrics | undefined {
  if (!a && !b) return undefined;
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalCostUsd: a.totalCostUsd + b.totalCostUsd,
    durationMs: a.durationMs + b.durationMs,
    durationApiMs: optionalSum(a.durationApiMs, b.durationApiMs),
    cacheReadInputTokens: optionalSum(
      a.cacheReadInputTokens,
      b.cacheReadInputTokens
    ),
    cacheCreationInputTokens: optionalSum(
      a.cacheCreationInputTokens,
      b.cacheCreationInputTokens
    ),
  };
}
