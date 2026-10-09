import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletion, JudgeCompletionAdapter } from './llmJudge.js';
import {
  DEFAULT_CLAUDE_JUDGE_MODEL,
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_JUDGE_TEMPERATURE,
  loadJudgeSdk,
  requireJudgeCredential,
} from './adapterSupport.js';
import { resolveLLMEndpoint } from '../llm/endpoint.js';

/** The part of an Anthropic Messages API response a judge reads. */
export interface AnthropicMessage {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
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
  default: new (options: {
    apiKey: string | null;
    authToken: string | null;
    baseURL: string;
  }) => {
    messages: {
      create(request: AnthropicMessageRequest): Promise<AnthropicMessage>;
    };
  };
}

/** Loads the optional `@anthropic-ai/sdk` package, or throws naming how to install it. */
export function loadAnthropicSdk(): Promise<AnthropicSdk> {
  return loadJudgeSdk<AnthropicSdk>(
    // @ts-expect-error - optional: npm install @anthropic-ai/sdk
    () => import('@anthropic-ai/sdk'),
    'Anthropic',
    '@anthropic-ai/sdk'
  );
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
    ...(response.stop_reason === 'max_tokens' ? { truncated: true } : {}),
  };
}

/**
 * Anthropic Messages API completion adapter.
 * Requires the `@anthropic-ai/sdk` package and an Anthropic credential:
 * an API key, or a gateway bearer token (see docs/llm-gateways.md).
 */
export function anthropicCompletion(
  config: JudgeConfig = {}
): JudgeCompletionAdapter {
  const options = { apiKeyEnvVar: config.apiKeyEnvVar };
  requireJudgeCredential('Anthropic', 'anthropic', options);
  return async ({ system, prompt }) => {
    const sdk = await loadAnthropicSdk();
    const endpoint = await resolveLLMEndpoint('anthropic', options);
    // Explicit nulls stop the SDK reading the other credential from the
    // environment and sending both headers.
    const client = new sdk.default({
      apiKey: endpoint.apiKey ?? null,
      authToken: endpoint.authToken ?? null,
      baseURL: endpoint.baseURL,
    });
    const response = await client.messages.create(
      anthropicMessageRequest(config, system, prompt)
    );
    return anthropicMessageCompletion(response);
  };
}
