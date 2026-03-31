/**
 * toPassToolJudge Matcher
 *
 * Validates that a response passes LLM-as-judge evaluation.
 * Delegates evaluation logic to validateJudge() for consistency
 * with the validator/matcher duality pattern.
 *
 * Supports two call signatures:
 *   - toPassToolJudge(rubric, options?)        — built-in LLM judge with rubric
 *   - toPassToolJudge({ judge: 'name', ... })  — named custom judge
 */

import { validateJudge } from '../validators/judge.js';
import type { RubricSpec } from '../../judge/rubrics.js';
import type { JudgeMatcherOptions } from './types.js';

// Default passing threshold
const DEFAULT_PASSING_THRESHOLD = 0.7;

/**
 * The toPassToolJudge matcher function.
 *
 * Accepts either:
 *   (received, rubric, options?) — rubric-based LLM judge
 *   (received, options)          — named custom judge (options.judge required)
 */
export async function toPassToolJudge(
  this: { isNot: boolean },
  received: unknown,
  rubricOrOptions: RubricSpec | JudgeMatcherOptions,
  maybeOptions?: JudgeMatcherOptions
): Promise<{ pass: boolean; message: () => string }> {
  let rubric: RubricSpec | undefined;
  let options: JudgeMatcherOptions;

  if (
    typeof rubricOrOptions === 'string' ||
    (typeof rubricOrOptions === 'object' &&
      rubricOrOptions !== null &&
      'text' in rubricOrOptions)
  ) {
    // Called as toPassToolJudge(rubric, options?)
    rubric = rubricOrOptions as RubricSpec;
    options = maybeOptions ?? {};
  } else {
    // Called as toPassToolJudge({ judge: 'name', ... })
    options = rubricOrOptions;
  }

  const {
    reference = null,
    passingThreshold = DEFAULT_PASSING_THRESHOLD,
    reps,
    provider,
    model,
    judge,
  } = options;

  const validation = await validateJudge(received, {
    ...(rubric !== undefined && { rubric }),
    reference: reference ?? undefined,
    threshold: passingThreshold,
    ...(reps !== undefined && { reps }),
    ...(provider !== undefined && { provider }),
    ...(model !== undefined && { model }),
    ...(judge !== undefined && { judge }),
  });

  if (this.isNot) {
    return {
      pass: !validation.pass,
      message: () =>
        validation.pass
          ? `Expected judge evaluation to fail, but it passed`
          : `Judge evaluation failed as expected`,
    };
  }

  return {
    pass: validation.pass,
    message: () => validation.message,
  };
}
