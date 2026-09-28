import type { EvalDataset } from './datasetTypes.js';
import {
  runEvalDataset,
  type EvalContext,
  type EvalRunnerOptions,
  type EvalRunnerResult,
} from './evalRunner.js';
import {
  compareEvalRuns,
  type EvalRunComparisonResult,
} from './evalRunComparison.js';
import { computeMetrics } from './metrics.js';
import type { HostSkillsMode } from './mcpHost/mcpHostTypes.js';

/** Options for {@link runSkillsComparison}. */
export interface SkillsComparisonOptions extends EvalRunnerOptions {
  /**
   * Skills modes to run the dataset under. The first is the baseline every
   * other mode is compared against.
   * @default ['off', 'catalog']
   */
  variants?: readonly HostSkillsMode[];
}

/** Aggregates for one skills mode. */
export interface SkillsVariantSummary {
  passRate: number;
  /** Share of cases where a skill was loaded (and verified). */
  skillLoadRate?: number;
  /** Share of cases where a skill was loaded before the first tool call. */
  skillBeforeToolRate?: number;
  /** Share of cases where a skill read failed verification. */
  skillVerificationFailureRate?: number;
}

/** One skills mode's run. */
export interface SkillsComparisonVariant {
  mode: HostSkillsMode;
  result: EvalRunnerResult;
  summary: SkillsVariantSummary;
}

/** Result of {@link runSkillsComparison}. */
export interface SkillsComparisonResult {
  dataset: string;
  variants: SkillsComparisonVariant[];
  /** Each non-baseline mode compared against the baseline mode. */
  comparisons: Array<{
    baseline: HostSkillsMode;
    candidate: HostSkillsMode;
    comparison: EvalRunComparisonResult;
  }>;
}

/** Applies a skills mode to every mcp_host case of a dataset. */
function withSkillsMode(
  dataset: EvalDataset,
  mode: HostSkillsMode
): EvalDataset {
  return {
    ...dataset,
    cases: dataset.cases.map((evalCase) =>
      evalCase.mode === 'mcp_host' && evalCase.mcpHostConfig
        ? {
            ...evalCase,
            mcpHostConfig: { ...evalCase.mcpHostConfig, skills: mode },
          }
        : evalCase
    ),
  };
}

function summarize(result: EvalRunnerResult): SkillsVariantSummary {
  const { aggregated } = computeMetrics(
    ['skill_loaded', 'skill_before_tool', 'skill_verification_failed'],
    result.caseResults
  );
  const rate = (key: string) =>
    typeof aggregated[key] === 'number' ? aggregated[key] : undefined;
  const skillLoadRate = rate('skill_loaded_rate');
  const skillBeforeToolRate = rate('skill_before_tool_rate');
  const skillVerificationFailureRate = rate('skill_verification_failed_rate');
  return {
    passRate: result.total > 0 ? result.passed / result.total : 0,
    ...(skillLoadRate !== undefined ? { skillLoadRate } : {}),
    ...(skillBeforeToolRate !== undefined ? { skillBeforeToolRate } : {}),
    ...(skillVerificationFailureRate !== undefined
      ? { skillVerificationFailureRate }
      : {}),
  };
}

/**
 * Runs the same dataset once per skills mode and compares them: does serving
 * Agent Skills (SEP-2640) change pass rate and tool behavior, and does the
 * model actually load the skills?
 *
 * Only `mcp_host` cases change between variants; other cases run as-is.
 * Variants run one after another so their costs and rate limits don't
 * overlap. Combine with `iterations` / `accuracyThreshold` on cases for
 * stable rates.
 *
 * @example
 * ```ts
 * const result = await runSkillsComparison(
 *   { dataset, variants: ['off', 'catalog', 'preload'] },
 *   { mcp, testInfo }
 * );
 * for (const v of result.variants) console.log(v.mode, v.summary);
 * ```
 */
export async function runSkillsComparison(
  options: SkillsComparisonOptions,
  context: EvalContext
): Promise<SkillsComparisonResult> {
  const { variants = ['off', 'catalog'], ...runnerOptions } = options;
  if (variants.length < 2) {
    throw new Error('runSkillsComparison() needs at least two variants.');
  }
  if (new Set(variants).size !== variants.length) {
    throw new Error('runSkillsComparison() received duplicate variants.');
  }

  const results: SkillsComparisonVariant[] = [];
  for (const mode of variants) {
    const result = await runEvalDataset(
      { ...runnerOptions, dataset: withSkillsMode(options.dataset, mode) },
      context
    );
    results.push({ mode, result, summary: summarize(result) });
  }

  const [baseline, ...candidates] = results;
  return {
    dataset: options.dataset.name,
    variants: results,
    comparisons: candidates.map((candidate) => ({
      baseline: baseline!.mode,
      candidate: candidate.mode,
      comparison: compareEvalRuns({
        baseline: baseline!.result,
        candidate: candidate.result,
        labels: {
          baseline: `skills:${baseline!.mode}`,
          candidate: `skills:${candidate.mode}`,
        },
      }),
    })),
  };
}
