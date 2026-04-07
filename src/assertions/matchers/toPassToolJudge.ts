/**
 * toPassToolJudge Matcher
 *
 * Validates that a response passes LLM-as-judge evaluation.
 * Delegates evaluation logic to validateJudge() for consistency
 * with the validator/matcher duality pattern.
 *
 * Supports three call signatures:
 *   - toPassToolJudge(rubric, options?)        — built-in LLM judge with rubric
 *   - toPassToolJudge({ judge: 'name', ... })  — named custom judge
 *   - toPassToolJudge([...judges])             — multi-judge (all must pass)
 */

import { validateJudge } from '../validators/judge.js';
import type { RubricSpec } from '../../judge/rubrics.js';
import type { JudgeMatcherOptions } from './types.js';

// Default passing threshold
const DEFAULT_PASSING_THRESHOLD = 0.7;

/**
 * Runs a single judge evaluation and returns the result.
 */
async function runSingleJudge(
  received: unknown,
  rubric: RubricSpec | undefined,
  options: JudgeMatcherOptions
): Promise<{ pass: boolean; message: string }> {
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

  return { pass: validation.pass, message: validation.message };
}

/**
 * The toPassToolJudge matcher function.
 *
 * Accepts either:
 *   (received, rubric, options?) — rubric-based LLM judge
 *   (received, options)          — named custom judge (options.judge required)
 *   (received, judges[])         — multi-judge (all must pass)
 */
export async function toPassToolJudge(
  this: { isNot: boolean },
  received: unknown,
  rubricOrOptions:
    | RubricSpec
    | JudgeMatcherOptions
    | Array<JudgeMatcherOptions & { rubric?: RubricSpec }>,
  maybeOptions?: JudgeMatcherOptions
): Promise<{ pass: boolean; message: () => string }> {
  // Multi-judge: array of judge configs
  if (Array.isArray(rubricOrOptions)) {
    const results = await Promise.all(
      rubricOrOptions.map(async (judgeConfig) => {
        const { rubric: r, ...opts } = judgeConfig;
        return runSingleJudge(received, r, opts);
      })
    );

    const allPassed = results.every((r) => r.pass);
    const passCount = results.filter((r) => r.pass).length;
    const summary = `${passCount}/${results.length} judges passed`;
    const details = results.map((r) => r.message).join('\n');

    if (this.isNot) {
      return {
        pass: !allPassed,
        message: () =>
          allPassed
            ? `Expected all judges to fail, but ${summary}`
            : `Judges failed as expected: ${summary}`,
      };
    }

    return {
      pass: allPassed,
      message: () => `${summary}\n${details}`,
    };
  }

  // Single judge
  let rubric: RubricSpec | undefined;
  let options: JudgeMatcherOptions;

  if (
    typeof rubricOrOptions === 'string' ||
    (typeof rubricOrOptions === 'object' &&
      rubricOrOptions !== null &&
      'text' in rubricOrOptions)
  ) {
    rubric = rubricOrOptions as RubricSpec;
    options = maybeOptions ?? {};
  } else {
    options = rubricOrOptions;
  }

  const result = await runSingleJudge(received, rubric, options);

  if (this.isNot) {
    return {
      pass: !result.pass,
      message: () =>
        result.pass
          ? `Expected judge evaluation to fail, but it passed`
          : `Judge evaluation failed as expected`,
    };
  }

  return {
    pass: result.pass,
    message: () => result.message,
  };
}
