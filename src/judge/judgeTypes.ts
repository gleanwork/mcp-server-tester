import { z } from 'zod';

/**
 * Zod schema for validating judge LLM responses.
 * Ensures the response has the required structure before it is used.
 */
export const JudgeResponseSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  reasoning: z.string(),
});

/**
 * The validated shape returned by a judge LLM.
 */
export type JudgeResponse = z.infer<typeof JudgeResponseSchema>;

/**
 * Usage metrics from Claude Agent SDK response
 */
export interface UsageMetrics {
  /**
   * Number of input tokens consumed
   */
  inputTokens: number;

  /**
   * Number of output tokens generated
   */
  outputTokens: number;

  /**
   * Total cost in USD
   */
  totalCostUsd: number;

  /**
   * Execution duration in milliseconds
   */
  durationMs: number;

  /**
   * API call duration in milliseconds (excluding network overhead)
   */
  durationApiMs?: number;

  /**
   * Number of tokens read from cache
   */
  cacheReadInputTokens?: number;

  /**
   * Number of tokens written to cache
   */
  cacheCreationInputTokens?: number;
}

/** Valid LLM judge provider kinds. */
export type ProviderKind = 'claude' | 'anthropic' | 'openai' | 'google';

/**
 * Configuration for an LLM judge
 */
export interface JudgeConfig {
  /**
   * LLM provider to use
   * @default 'claude'
   */
  provider?: ProviderKind;

  /**
   * Environment variable name containing the API key
   * @default 'ANTHROPIC_API_KEY'
   */
  apiKeyEnvVar?: string;

  /**
   * Model to use for judging
   * @default 'claude-sonnet-4-20250514'
   */
  model?: string;

  /**
   * Maximum tokens for response
   * @default 1000
   */
  maxTokens?: number;

  /**
   * Temperature (0-1, lower is more deterministic)
   * @default 0.0
   */
  temperature?: number;

  /**
   * Maximum budget in USD for the judge evaluation
   * @default 0.10
   */
  maxBudgetUsd?: number;

  /**
   * Maximum size (in bytes) for tool output before failing the test
   * When set, the judge will fail if the candidate response exceeds this size
   */
  maxToolOutputSize?: number;
}

/**
 * Result from LLM judge evaluation
 */
export interface JudgeResult {
  /**
   * Whether the evaluation passed
   */
  pass: boolean;

  /**
   * Numeric score (0-1, where 1 is best)
   */
  score?: number;

  /**
   * Reasoning/explanation from the judge
   */
  reasoning?: string;

  /**
   * Usage metrics from the Claude Agent SDK
   */
  usage?: UsageMetrics;

  /**
   * Size of the candidate response in bytes (for maxToolOutputSize tracking)
   */
  candidateSizeBytes?: number;

  /**
   * Whether the candidate exceeded maxToolOutputSize
   */
  exceedsMaxToolOutputSize?: boolean;

  /**
   * Standard deviation of individual rep scores.
   * Only populated when the judge was run with reps > 1.
   */
  scoreStdDev?: number;

  /**
   * True when the standard deviation across reps exceeds 0.2, indicating
   * that the rubric may be ambiguous or the judge is non-deterministic.
   * Only populated when the judge was run with reps > 1.
   */
  highVariance?: boolean;

  /**
   * Individual scores from each judge rep.
   * Only populated when the judge was run with reps > 1.
   */
  scores?: number[];
}

export type { BuiltInRubric, RubricSpec } from './rubrics.js';
export { BUILT_IN_RUBRICS, resolveRubric, isBuiltInRubric } from './rubrics.js';

/**
 * LLM judge client interface
 */
export interface Judge {
  /**
   * Evaluates a candidate response against a reference
   *
   * @param candidate - The actual response to evaluate
   * @param reference - The expected/reference response (or null if not applicable)
   * @param rubric - The evaluation rubric/criteria
   * @returns Evaluation result with usage metrics
   */
  evaluate(
    candidate: unknown,
    reference: unknown,
    rubric: string
  ): Promise<JudgeResult>;
}
