/**
 * Judge Validator
 *
 * Validates a response using an LLM-as-a-judge evaluation.
 */

import type { ValidationResult } from './types.js';
import type { ProviderKind } from '../../judge/judgeTypes.js';
import type { RubricSpec } from '../../judge/rubrics.js';
import { createJudge } from '../../judge/judgeClient.js';
import { resolveRubric } from '../../judge/rubrics.js';
import { getRegisteredJudge } from '../../judge/judgeRegistry.js';

/**
 * Configuration for the judge validator
 */
export interface JudgeValidatorConfig {
  /**
   * The evaluation rubric: a built-in name or custom { text: string }.
   * Required when no named `judge` is specified.
   */
  rubric?: RubricSpec;
  /** Optional reference response to compare against */
  reference?: unknown;
  /** Minimum score required to pass (0-1, default: 0.7) */
  threshold?: number;
  /** Number of judge evaluations to run. Scores averaged. @default 1 */
  reps?: number;
  /** Judge provider. @default 'claude' */
  provider?: ProviderKind;
  /** Model override (e.g., 'claude-opus-4-20250514') */
  model?: string;
  /** Environment variable name for API key */
  apiKeyEnvVar?: string;
  /** Max tokens for judge response */
  maxTokens?: number;
  /** Temperature for judge LLM (0–1) */
  temperature?: number;
  /** Max budget in USD per evaluation */
  maxBudgetUsd?: number;
  /** Fail if response exceeds this size in bytes before judging */
  maxToolOutputSize?: number;
  /**
   * Name of a registered custom judge executor.
   * When set, the named judge handles the entire evaluation pipeline
   * and returns a normalized score. The `threshold` determines pass/fail.
   * Register judges with `registerJudge()` before tests run.
   */
  judge?: string;
}

/**
 * Validates a response using an LLM-as-a-judge evaluation
 *
 * Calls the configured judge with the response and rubric, then checks whether
 * the resulting score meets the threshold. Returns a ValidationResult compatible
 * with the unified assertion architecture.
 *
 * @param response - The response to evaluate
 * @param config - Judge evaluation configuration (rubric, reference, threshold, provider, model, etc.)
 * @returns Validation result indicating pass/fail with judge reasoning
 *
 * @example
 * ```typescript
 * const result = await validateJudge(
 *   response,
 *   { rubric: 'Does the response accurately describe the weather?' }
 * );
 * if (!result.pass) {
 *   console.log(result.message);
 * }
 *
 * // With inline judge config and threshold
 * const result2 = await validateJudge(
 *   response,
 *   { rubric: 'Is this helpful?', threshold: 0.9, model: 'claude-opus-4-20250514', temperature: 0 }
 * );
 * ```
 */
/**
 * Computes population standard deviation of an array of scores.
 * Returns 0 when there are fewer than 2 values.
 */
function computeStdDev(scores: number[], mean: number): number {
  if (scores.length <= 1) return 0;
  const variance =
    scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

export async function validateJudge(
  response: unknown,
  config: JudgeValidatorConfig
): Promise<ValidationResult> {
  const {
    judge: judgeName,
    rubric,
    reference,
    threshold = 0.7,
    reps = 1,
    provider,
    model,
    apiKeyEnvVar,
    maxTokens,
    temperature,
    maxBudgetUsd,
    maxToolOutputSize,
  } = config;

  // Named custom judge — executor returns a score, threshold determines pass/fail
  if (judgeName !== undefined) {
    try {
      const executor = getRegisteredJudge(judgeName);
      const judgeResult = await executor(response, reference ?? undefined);

      const score = judgeResult.score;
      const passed = score >= threshold;

      return {
        pass: passed,
        message: passed
          ? `Custom judge "${judgeName}" passed with score ${score.toFixed(2)}`
          : `Custom judge "${judgeName}" failed with score ${score.toFixed(2)} (threshold: ${threshold}). ${judgeResult.reasoning ?? ''}`,
      };
    } catch (err) {
      return {
        pass: false,
        message: `Custom judge "${judgeName}" error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Built-in LLM judge — requires rubric
  if (rubric === undefined) {
    return {
      pass: false,
      message:
        'Judge evaluation failed: either "judge" or "rubric" must be provided',
    };
  }

  const resolvedRubric = resolveRubric(rubric);

  const judgeConfig = {
    ...(provider !== undefined && { provider }),
    ...(model !== undefined && { model }),
    ...(apiKeyEnvVar !== undefined && { apiKeyEnvVar }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(temperature !== undefined && { temperature }),
    ...(maxBudgetUsd !== undefined && { maxBudgetUsd }),
    ...(maxToolOutputSize !== undefined && { maxToolOutputSize }),
  };

  try {
    const judge = createJudge(judgeConfig);

    const scores: number[] = [];
    let lastReasoning: string | undefined;

    for (let i = 0; i < reps; i++) {
      const judgeResult = await judge.evaluate(
        response,
        reference ?? null,
        resolvedRubric
      );
      scores.push(judgeResult.score ?? (judgeResult.pass ? 1.0 : 0.0));
      lastReasoning = judgeResult.reasoning;
    }

    if (scores.length === 0) {
      return {
        pass: false,
        message: 'Judge evaluation failed: no scores collected',
      };
    }

    const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const passed = meanScore >= threshold;
    const repNote =
      reps > 1
        ? ` (mean of ${reps} reps: [${scores.map((s) => s.toFixed(2)).join(', ')}])`
        : '';

    let stdDev: number | undefined;
    let highVariance: boolean | undefined;

    if (reps > 1) {
      stdDev = computeStdDev(scores, meanScore);
      highVariance = stdDev > 0.2;

      if (highVariance) {
        console.warn(
          `[mcp-server-tester] Judge scores have high variance ` +
            `(stdDev=${stdDev.toFixed(2)}, scores=[${scores.map((s) => s.toFixed(2)).join(', ')}]). ` +
            `The rubric may be ambiguous.`
        );
      }
    }

    return {
      pass: passed,
      message: passed
        ? `Judge passed with score ${meanScore.toFixed(2)}${repNote}`
        : `Judge failed with score ${meanScore.toFixed(2)} (threshold: ${threshold})${repNote}. ${lastReasoning ?? ''}`,
      details:
        reps > 1
          ? {
              scores,
              scoreStdDev: stdDev,
              highVariance,
            }
          : undefined,
    };
  } catch (err) {
    return {
      pass: false,
      message: `Judge evaluation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
