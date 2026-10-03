import {
  DEFAULT_JUDGE_PROVIDER,
  type Judge,
  type JudgeConfig,
  type ProviderKind,
} from './judgeTypes.js';
import { createLLMJudge, type JudgeCompletionAdapter } from './llmJudge.js';
import { anthropicCompletion } from './anthropicJudge.js';
import { vertexAnthropicCompletion } from './vertexAnthropicJudge.js';
import { claudeAgentCompletion } from './claudeAgentJudge.js';
import { openaiCompletion } from './openaiJudge.js';
import { googleCompletion } from './googleJudge.js';

/**
 * Every judge provider's completion adapter. Typing this as a full record
 * makes a new `ProviderKind` a compile error until its adapter is added.
 */
const JUDGE_PROVIDERS: Record<
  ProviderKind,
  (config: JudgeConfig) => JudgeCompletionAdapter
> = {
  anthropic: anthropicCompletion,
  'vertex-anthropic': vertexAnthropicCompletion,
  'anthropic-agent-sdk': claudeAgentCompletion,
  openai: openaiCompletion,
  google: googleCompletion,
};

/**
 * Creates an LLM judge for evaluating tool responses.
 *
 * Every provider shares one prompt, one response parser and the
 * `maxToolOutputSize` guard; the provider only supplies the completion.
 *
 * @param config - Judge configuration
 * @returns Judge instance
 * @throws {Error} If the provider is unsupported or its API key is missing
 *
 * @example
 * // Default Anthropic judge
 * const judge = createJudge();
 *
 * @example
 * // With configuration
 * const judge = createJudge({
 *   model: 'claude-sonnet-4-20250514',
 *   maxToolOutputSize: 50000, // Fail if response > 50KB
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
 * console.log('Tokens:', result.usage?.inputTokens, result.usage?.outputTokens);
 */
export function createJudge(config: JudgeConfig = {}): Judge {
  const provider: ProviderKind = config.provider ?? DEFAULT_JUDGE_PROVIDER;
  const completion = Object.hasOwn(JUDGE_PROVIDERS, provider)
    ? JUDGE_PROVIDERS[provider]
    : undefined;
  if (!completion)
    throw new Error(
      `Unsupported LLM provider: ${String(provider)}. Valid providers: ${Object.keys(
        JUDGE_PROVIDERS
      )
        .map((kind) => `'${kind}'`)
        .join(', ')}`
    );
  return createLLMJudge(completion(config), {
    maxToolOutputSize: config.maxToolOutputSize,
  });
}
