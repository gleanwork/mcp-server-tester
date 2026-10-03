/**
 * Judge Validator
 *
 * Validates a response with a judge: the built-in `rubric` LLM judge or a
 * plugin judge. Both run through `evaluateJudge`.
 */

import type { ValidationResult } from './types.js';
import type { ProviderKind } from '../../judge/judgeTypes.js';
import type { RubricSpec } from '../../judge/rubrics.js';
import {
  DEFAULT_JUDGE_THRESHOLD,
  evaluateJudge,
  type JudgeRun,
  judgeError,
  judgeOwnOptions,
  type JudgeRequest,
} from '../../judge/evaluateJudge.js';

export { DEFAULT_JUDGE_THRESHOLD, type JudgeRun };

/**
 * Configuration for the judge validator
 */
export interface JudgeValidatorConfig {
  /** The judge's options, parsed by its schema. */
  options?: Record<string, unknown>;
  /** Flat fields other than the assertion's own are the judge's options. */
  [key: string]: unknown;
  /**
   * The evaluation rubric: a built-in name or custom { text: string }.
   * Shorthand for the built-in `rubric` judge; required when no `judge` is
   * specified.
   */
  rubric?: RubricSpec;
  /** Optional reference response to compare against */
  reference?: unknown;
  /** Minimum score required to pass (0-1, default: 0.7) */
  threshold?: number;
  /** Number of judge evaluations to run. Scores averaged. @default 1 */
  reps?: number;
  /** The rubric judge's provider. @default 'anthropic' */
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
   * The judge to run: the built-in `rubric`, or `namespace/name` from a
   * plugin. It returns a normalized score; `threshold` decides pass/fail and
   * `reps` how many times it scores the response.
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
export async function validateJudge(
  response: unknown,
  config: JudgeValidatorConfig,
  /** The case and run, from which the judge's `{ case, trial }` input is built. */
  run: JudgeRun = {}
): Promise<ValidationResult> {
  const request = judgeRequest(config);
  return typeof request === 'string'
    ? judgeError(request)
    : evaluateJudge(response, request, run);
}

/**
 * The name results give the judge an assertion runs (`correctness`,
 * `acme/completeness`), or undefined when it names none. Suite manifests
 * match case overrides on it.
 */
export function judgeNameOf(config: JudgeValidatorConfig): string | undefined {
  const request = judgeRequest(config);
  return typeof request === 'string' ? undefined : request.label;
}

/** The judge request an assertion means, or why it names no judge. */
function judgeRequest(config: JudgeValidatorConfig): JudgeRequest | string {
  const assertion = {
    reference: config.reference ?? undefined,
    threshold: config.threshold ?? DEFAULT_JUDGE_THRESHOLD,
    reps: config.reps ?? 1,
  };
  if (config.judge !== undefined) {
    // `options`, when given, is the judge's whole option set.
    const options = config.options ?? judgeOwnOptions(config);
    return {
      ...assertion,
      judge: config.judge,
      label: judgeLabel(config.judge, options),
      options,
    };
  }
  if (config.rubric === undefined)
    return 'Judge evaluation failed: either "judge" or "rubric" must be provided';
  // `rubric` (with any LLM settings) is shorthand for the built-in judge.
  // The shorthand keeps `rubric` flat, so flat fields and `options` merge.
  const options = { ...judgeOwnOptions(config), ...config.options };
  return {
    ...assertion,
    judge: 'rubric',
    label: judgeLabel('rubric', options),
    options,
  };
}

/**
 * What results call a judge. The rubric judge goes by its built-in rubric's
 * name (`correctness`), however it was declared, so metrics key it once.
 */
function judgeLabel(judge: string, options: Record<string, unknown>): string {
  return judge === 'rubric' && typeof options.rubric === 'string'
    ? options.rubric
    : judge;
}
