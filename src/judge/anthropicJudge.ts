import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletion, JudgeCompletionAdapter } from './llmJudge.js';
import {
  DEFAULT_CLAUDE_JUDGE_MODEL,
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_JUDGE_TEMPERATURE,
  loadJudgeSdk,
  requireJudgeApiKey,
} from './adapterSupport.js';

/** The part of an Anthropic Messages API response a judge reads. */
export interface AnthropicMessage {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The Messages API request a judge sends (Anthropic and Vertex). */
export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
}

interface AnthropicSdk {
  default: new (options: { apiKey: string }) => {
    messages: {
      create(request: AnthropicMessageRequest): Promise<AnthropicMessage>;
    };
  };
}

/** The Messages API request for a judge prompt. */
export function anthropicMessageRequest(
  config: JudgeConfig,
  system: string,
  prompt: string
): AnthropicMessageRequest {
  return {
    model: config.model ?? DEFAULT_CLAUDE_JUDGE_MODEL,
    max_tokens: config.maxTokens ?? DEFAULT_JUDGE_MAX_TOKENS,
    temperature: config.temperature ?? DEFAULT_JUDGE_TEMPERATURE,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
}

/** Text and usage from a Messages API response. */
export function anthropicMessageCompletion(
  response: AnthropicMessage
): JudgeCompletion {
  return {
    text: response.content.find((block) => block.type === 'text')?.text ?? '',
    usage: {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    },
  };
}

/**
 * Anthropic Messages API completion adapter.
 * Requires the `@anthropic-ai/sdk` package and an Anthropic API key.
 */
export function anthropicCompletion(
  config: JudgeConfig = {}
): JudgeCompletionAdapter {
  const apiKey = requireJudgeApiKey(
    'Anthropic',
    config.apiKeyEnvVar ?? 'ANTHROPIC_API_KEY'
  );
  return async ({ system, prompt }) => {
    const sdk = await loadJudgeSdk<AnthropicSdk>(
      // @ts-expect-error - optional: npm install @anthropic-ai/sdk
      () => import('@anthropic-ai/sdk'),
      'Anthropic',
      '@anthropic-ai/sdk'
    );
    const response = await new sdk.default({ apiKey }).messages.create(
      anthropicMessageRequest(config, system, prompt)
    );
    return anthropicMessageCompletion(response);
  };
}
