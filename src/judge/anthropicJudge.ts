/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletionAdapter } from './llmJudge.js';
import { missingJudgePackage, requireJudgeApiKey } from './optionalPackage.js';

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
    let sdk: any;
    try {
      // @ts-expect-error - optional: npm install @anthropic-ai/sdk
      sdk = await import('@anthropic-ai/sdk');
    } catch (err) {
      throw missingJudgePackage('Anthropic', '@anthropic-ai/sdk', err);
    }
    const response = await new sdk.default({ apiKey }).messages.create({
      model: config.model ?? 'claude-sonnet-4-20250514',
      max_tokens: config.maxTokens ?? 1000,
      temperature: config.temperature ?? 0.0,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    return anthropicMessageCompletion(response);
  };
}

/** Text and usage from an Anthropic Messages API response (also used by Vertex). */
export function anthropicMessageCompletion(response: any): {
  text: string;
  usage: { inputTokens?: number; outputTokens?: number };
} {
  const textBlock = (response.content as any[]).find(
    (block: any) => block.type === 'text'
  );
  return {
    text: (textBlock?.text as string | undefined) ?? '',
    usage: {
      inputTokens: response.usage?.input_tokens as number | undefined,
      outputTokens: response.usage?.output_tokens as number | undefined,
    },
  };
}
