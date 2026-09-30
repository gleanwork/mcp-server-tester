import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletionAdapter } from './llmJudge.js';
import {
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_JUDGE_TEMPERATURE,
  loadJudgeSdk,
  requireJudgeApiKey,
} from './adapterSupport.js';

interface OpenAISdk {
  default: new (options: { apiKey: string }) => {
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
 * Requires the `openai` package and an OpenAI API key.
 */
export function openaiCompletion(
  config: JudgeConfig = {}
): JudgeCompletionAdapter {
  const apiKey = requireJudgeApiKey(
    'OpenAI',
    config.apiKeyEnvVar ?? 'OPENAI_API_KEY'
  );
  return async ({ system, prompt }) => {
    const sdk = await loadJudgeSdk<OpenAISdk>(
      // @ts-expect-error - optional: npm install openai
      () => import('openai'),
      'OpenAI',
      'openai'
    );
    const completion = await new sdk.default({
      apiKey,
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
