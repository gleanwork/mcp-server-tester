import type { Judge, JudgeConfig, ProviderKind } from './judgeTypes.js';
import { createAnthropicJudge } from './anthropicJudge.js';
import { createVertexAnthropicJudge } from './vertexAnthropicJudge.js';
import { createClaudeAgentJudge } from './claudeAgentJudge.js';
import { createOpenAIJudge } from './openaiJudge.js';
import { createGoogleJudge } from './googleJudge.js';

/**
 * Creates an LLM judge for evaluating tool responses
 *
 * Uses Claude Agent SDK for evaluation with usage metrics tracking.
 *
 * @param config - Judge configuration
 * @returns Judge instance
 * @throws {Error} If provider is unsupported or configuration is invalid
 *
 * @example
 * // Default Claude judge
 * const judge = createJudge();
 *
 * @example
 * // With configuration
 * const judge = createJudge({
 *   model: 'claude-sonnet-4-20250514',
 *   maxToolOutputSize: 50000, // Fail if response > 50KB
 *   maxBudgetUsd: 0.05,
 * });
 *
 * // Evaluate a response
 * const result = await judge.evaluate(
 *   candidateResponse,
 *   referenceResponse,
 *   'Evaluate for accuracy and completeness'
 * );
 *
 * // Access usage metrics
 * console.log('Cost:', result.usage?.totalCostUsd);
 * console.log('Tokens:', result.usage?.inputTokens, result.usage?.outputTokens);
 */
export function createJudge(config: JudgeConfig = {}): Judge {
  const provider: ProviderKind = config.provider ?? 'anthropic';

  switch (provider) {
    case 'anthropic':
      return createAnthropicJudge(config);

    case 'vertex-anthropic':
      return createVertexAnthropicJudge(config);

    case 'anthropic-agent-sdk':
      return createClaudeAgentJudge(config);

    case 'openai':
      return createOpenAIJudge(config);

    case 'google':
      return createGoogleJudge(config);

    default:
      throw new Error(
        `Unsupported LLM provider: ${String(provider)}. Valid providers: 'anthropic', 'vertex-anthropic', 'anthropic-agent-sdk', 'openai', 'google'`
      );
  }
}
