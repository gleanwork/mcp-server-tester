import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletionAdapter } from './llmJudge.js';
import {
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_JUDGE_TEMPERATURE,
  loadJudgeSdk,
  requireJudgeCredential,
} from './adapterSupport.js';
import { resolveLLMEndpoint } from '../llm/endpoint.js';

interface OpenAISdk {
  default: new (options: { apiKey: string; baseURL: string }) => {
    chat: {
      completions: {
        create(request: {
          model: string;
          max_tokens: number;
          temperature: number;
          messages: Array<{ role: 'system' | 'user'; content: string }>;
        }): Promise<{
          choices: Array<{ message: { content?: string | null } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        }>;
      };
    };
  };
}

/**
 * OpenAI Chat Completions adapter.
 * Requires the `openai` package and an OpenAI API key (or the gateway auth
 * command; see docs/llm-gateways.md).
 */
export function openaiCompletion(
  config: JudgeConfig = {}
): JudgeCompletionAdapter {
  const options = { apiKeyEnvVar: config.apiKeyEnvVar };
  requireJudgeCredential('OpenAI', 'openai', options);
  return async ({ system, prompt }) => {
    const sdk = await loadJudgeSdk<OpenAISdk>(
      // @ts-expect-error - optional: npm install openai
      () => import('openai'),
      'OpenAI',
      'openai'
    );
    const endpoint = await resolveLLMEndpoint('openai', options);
    const completion = await new sdk.default({
      apiKey: endpoint.apiKey ?? '',
      baseURL: endpoint.baseURL,
    }).chat.completions.create({
      model: config.model ?? 'gpt-4o',
      max_tokens: config.maxTokens ?? DEFAULT_JUDGE_MAX_TOKENS,
      temperature: config.temperature ?? DEFAULT_JUDGE_TEMPERATURE,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    });
    return {
      text: completion.choices[0]?.message.content ?? '',
      usage: {
        inputTokens: completion.usage?.prompt_tokens,
        outputTokens: completion.usage?.completion_tokens,
      },
    };
  };
}
