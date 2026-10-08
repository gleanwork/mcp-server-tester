/**
 * Each variant against the first (the baseline): pass rates and every
 * numeric metric both report, as variant minus baseline. Shared by
 * `runEval` and the MCP Playwright reporter.
 */
import type { EvaluationVariantResult } from './evalFrameworkTypes.js';
import { passRate } from './evalRunComparison.js';

/** The variant's share of passing trials, averaged over its cases. */
function trialPassRate(variant: EvaluationVariantResult): number | undefined {
  const value = variant.metrics?.trial_pass_rate;
  return typeof value === 'number' ? value : undefined;
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'number')
  );
}

/** Every numeric metric both variants report, as variant minus baseline (per judge for scores). */
function metricDeltas(
  variant: EvaluationVariantResult,
  baseline: EvaluationVariantResult
): Record<string, number | Record<string, number>> {
  const deltas: Record<string, number | Record<string, number>> = {};
  for (const [key, value] of Object.entries(variant.metrics ?? {})) {
    const before = baseline.metrics?.[key];
    if (typeof value === 'number' && typeof before === 'number') {
      deltas[key] = value - before;
    } else if (isNumberRecord(value) && isNumberRecord(before)) {
      // Per-judge scores: a delta for each judge both variants ran.
      const shared = Object.keys(value).filter((name) => name in before);
      if (shared.length > 0)
        deltas[key] = Object.fromEntries(
          shared.map((name) => [name, value[name]! - before[name]!])
        );
    }
  }
  return deltas;
}

/** Every variant but the baseline, compared with the baseline. */
export function buildVariantDeltas(
  variants: EvaluationVariantResult[]
): Record<string, Record<string, unknown>> {
  const baseline = variants[0]?.result;
  if (!baseline || baseline.total === 0) return {};
  const baselineRate = passRate(baseline);
  const baselineTrialRate = trialPassRate(variants[0]!);
  return Object.fromEntries(
    variants.slice(1).map((variant) => {
      const rate = variant.result ? passRate(variant.result) : 0;
      const trials = trialPassRate(variant);
      return [
        variant.name,
        {
          passRate: rate,
          passRateDelta: rate - baselineRate,
          ...(trials !== undefined && baselineTrialRate !== undefined
            ? {
                trialPassRate: trials,
                trialPassRateDelta: trials - baselineTrialRate,
              }
            : {}),
          metricDeltas: metricDeltas(variant, variants[0]!),
          baseline: variants[0]?.name,
        },
      ];
    })
  );
}
