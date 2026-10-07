import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import { sumUsage } from '../utils/usageUtils.js';
import type { ModelPricing } from './evalConfig.js';

/** USD for one trial's usage at `price` (per million tokens). */
function costOf(usage: UsageMetrics, price: ModelPricing): number {
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheReadInputTokens ?? 0) * (price.cacheRead ?? price.input) +
      (usage.cacheCreationInputTokens ?? 0) *
        (price.cacheWrite ?? price.input)) /
    1_000_000
  );
}

/** What pricing a variant's usage did and didn't get. */
export interface PricingOutcome {
  /** The prices applied, by model: the record that makes an estimate auditable. */
  applied: Record<string, ModelPricing>;
  /** Models whose usage had no reported cost and no price. */
  unpriced: string[];
}

/**
 * Give each trial whose host reported tokens but no cost an estimate, at the
 * price of the model it ran (`modelOf`). A multi-iteration case's usage is
 * re-summed from its iterations, so it agrees with them.
 */
export function estimateCosts(
  results: EvalCaseResult[],
  modelOf: (result: EvalCaseResult) => string | undefined,
  pricing: Record<string, ModelPricing> | undefined
): PricingOutcome {
  const applied: Record<string, ModelPricing> = {};
  const unpriced = new Set<string>();
  const price = (
    usage: UsageMetrics | undefined,
    model: string | undefined
  ) => {
    if (!usage || usage.totalCostUsd !== undefined) return;
    const entry = model === undefined ? undefined : pricing?.[model];
    if (!entry) {
      if (model !== undefined) unpriced.add(model);
      return;
    }
    usage.estimatedCostUsd = costOf(usage, entry);
    applied[model!] = entry;
  };
  for (const result of results) {
    const model = modelOf(result);
    if (result.iterationResults?.length) {
      for (const iteration of result.iterationResults)
        price(iteration.hostUsage, model);
      result.hostUsage = result.iterationResults.reduce<
        UsageMetrics | undefined
      >((sum, iteration) => sumUsage(sum, iteration.hostUsage), undefined);
    } else {
      price(result.hostUsage, model);
    }
  }
  return { applied, unpriced: [...unpriced].sort() };
}

/** Where a variant's cost comes from: the hosts, the eval config's pricing, or both. */
export function costSource(
  results: EvalCaseResult[]
): 'host' | 'pricing' | 'mixed' | undefined {
  // The trials metrics count: infrastructure failures aren't trials.
  const usages = results.flatMap((result) =>
    result.iterationResults?.length
      ? result.iterationResults
          .filter((iteration) => !iteration.isInfrastructureError)
          .map((iteration) => iteration.hostUsage)
      : [result.hostUsage]
  );
  const reported = usages.some((usage) => usage?.totalCostUsd !== undefined);
  const estimated = usages.some(
    (usage) =>
      usage?.totalCostUsd === undefined && usage?.estimatedCostUsd !== undefined
  );
  return reported && estimated
    ? 'mixed'
    : reported
      ? 'host'
      : estimated
        ? 'pricing'
        : undefined;
}
