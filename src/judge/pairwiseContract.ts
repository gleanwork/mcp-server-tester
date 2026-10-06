/**
 * The pairwise judge contract.
 *
 * A pairwise judge compares two runs of the same case: a baseline and a
 * candidate. It is called as `compare({ case, baseline, candidate }, options)`,
 * once per rep:
 *
 * - `case` is what the dataset author wrote, as for a pointwise judge.
 * - `baseline` and `candidate` are the two observed runs, as `JudgeTrial`s.
 * - `options` is how this judge compares, parsed by the judge's schema.
 *
 * A pairwise verdict is a preference, not a score against a threshold, so it
 * is kept apart from pointwise judges: pointwise judges decide whether a case
 * passes; pairwise judges decide which arm did better.
 */

import type { ZodType } from 'zod';
import type { UsageMetrics } from './judgeTypes.js';
import type { JudgeCase, JudgeSubScore, JudgeTrial } from './judgeContract.js';

/** The argument of `compare`. */
export interface PairwiseJudgeInput {
  case: JudgeCase;
  baseline: JudgeTrial;
  candidate: JudgeTrial;
}

/** Which run the judge prefers. */
export type PairwisePreference = 'baseline' | 'candidate' | 'tie';

/** What a pairwise judge returns for one rep. Only `preference` is required. */
export interface PairwiseVerdict {
  preference: PairwisePreference;
  /**
   * How strongly, from 0 (no preference) to 1 (decisive). A judge that
   * reports a graded margin (for example a 7-point scale) maps it here.
   */
  strength?: number;
  reasoning?: string;
  /**
   * The judge cannot compare this case, for example because one run left no
   * evidence. A skipped comparison is recorded but excluded from win rates.
   */
  skipped?: boolean;
  /** Named per-dimension preferences, such as correctness or task completion. */
  dimensions?: Record<string, PairwiseDimension>;
  /** Token usage and cost of the judge's own model calls. */
  usage?: Partial<UsageMetrics>;
  provider?: string;
  model?: string;
  /** Judge version that produced the verdict, such as a frozen prompt hash. */
  version?: string;
  /** Other structured output, kept in results as-is. Must be JSON-serializable. */
  metadata?: Record<string, unknown>;
}

/** One dimension of a pairwise verdict. */
export interface PairwiseDimension {
  preference: PairwisePreference;
  strength?: number;
  reasoning?: string;
  /** Pointwise scores of each side on this dimension, when the judge has them. */
  baseline?: JudgeSubScore;
  candidate?: JudgeSubScore;
}

/** Public pairwise judge extension point. */
export interface PairwiseJudgeDefinition {
  /** Parses the judge's options. */
  readonly schema: ZodType;
  /**
   * Paths in the input this judge needs, such as `case.expected.answer`.
   * When one is missing or empty, the comparison is recorded as skipped.
   * Paths start with `case.`, `baseline.` or `candidate.`.
   */
  readonly requires?: readonly string[];
  /**
   * Whether to also compare with the runs swapped and reconcile the two
   * verdicts, to cancel position bias. Default true. A judge that already
   * randomizes or debiases order itself sets false.
   */
  readonly swapPositions?: boolean;
  compare: (
    input: PairwiseJudgeInput,
    options: Record<string, unknown>
  ) => Promise<PairwiseVerdict>;
}
