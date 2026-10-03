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

import { DEFAULT_JUDGE_THRESHOLD, validateJudge } from '../validators/judge.js';
import type { RubricSpec } from '../../judge/rubrics.js';
import type { JudgeMatcherOptions } from './types.js';

/**
 * Runs a single judge evaluation and returns the result.
 */
async function runSingleJudge(
  received: unknown,
  rubric: RubricSpec | undefined,
  options: JudgeMatcherOptions
): Promise<{ pass: boolean; message: string; error: boolean }> {
  const {
    reference = null,
    passingThreshold = DEFAULT_JUDGE_THRESHOLD,
    reps,
    provider,
    model,
    judge,
    options: judgeOptions,
  } = options;

  const validation = await validateJudge(received, {
    ...(rubric !== undefined && { rubric }),
    reference: reference ?? undefined,
    threshold: passingThreshold,
    ...(reps !== undefined && { reps }),
    ...(provider !== undefined && { provider }),
    ...(model !== undefined && { model }),
    ...(judge !== undefined && { judge }),
    ...(judgeOptions !== undefined && { options: judgeOptions }),
  });

  return {
    pass: validation.pass,
    message: validation.message,
    error: validation.details?.error !== undefined,
  };
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

    // A judge that couldn't score is not a "fail": fail in both directions.
    if (results.some((r) => r.error))
      return { pass: this.isNot, message: () => `${summary}\n${details}` };

    return {
      pass: allPassed,
      message: () =>
        this.isNot
          ? `Expected at least one judge to fail, but ${summary}\n${details}`
          : `${summary}\n${details}`,
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
    rubric = rubricOrOptions;
    options = maybeOptions ?? {};
  } else {
    options = rubricOrOptions;
  }

  const result = await runSingleJudge(received, rubric, options);

  // A judge that couldn't score is not a "fail": fail in both directions.
  if (result.error) return { pass: this.isNot, message: () => result.message };

  return {
    pass: result.pass,
    message: () =>
      this.isNot
        ? `Expected judge evaluation to fail, but it passed: ${result.message}`
        : result.message,
  };
}
