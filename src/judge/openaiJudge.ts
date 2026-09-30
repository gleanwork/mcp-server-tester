/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletionAdapter } from './llmJudge.js';
import { missingJudgePackage, requireJudgeApiKey } from './optionalPackage.js';

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
    let sdk: any;
    try {
      // @ts-expect-error - optional: npm install openai
      sdk = await import('openai');
    } catch (err) {
      throw missingJudgePackage('OpenAI', 'openai', err);
    }
    const completion = await new sdk.default({
      apiKey,
    }).chat.completions.create({
      model: config.model ?? 'gpt-4o',
      max_tokens: config.maxTokens ?? 1000,
      temperature: config.temperature ?? 0.0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    });
    return {
      text:
        (completion.choices[0]?.message.content as string | null | undefined) ??
        '',
      usage: {
        inputTokens: completion.usage?.prompt_tokens as number | undefined,
        outputTokens: completion.usage?.completion_tokens as number | undefined,
      },
    };
  };
}
