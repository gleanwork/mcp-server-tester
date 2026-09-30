/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletionAdapter } from './llmJudge.js';
import { anthropicMessageCompletion } from './anthropicJudge.js';
import { missingJudgePackage } from './optionalPackage.js';

/**
 * Anthropic on Google Vertex AI completion adapter.
 * Requires the `@anthropic-ai/vertex-sdk` package and Application Default
 * Credentials; reads GOOGLE_VERTEX_PROJECT and GOOGLE_VERTEX_LOCATION.
 */
export function vertexAnthropicCompletion(
  config: JudgeConfig = {}
): JudgeCompletionAdapter {
  return async ({ system, prompt }) => {
    let sdk: any;
    try {
      // @ts-expect-error - optional: npm install @anthropic-ai/vertex-sdk
      sdk = await import('@anthropic-ai/vertex-sdk');
    } catch (err) {
      throw missingJudgePackage(
        'Vertex Anthropic',
        '@anthropic-ai/vertex-sdk',
        err
      );
    }
    const client = new sdk.AnthropicVertex({
      projectId:
        process.env.GOOGLE_VERTEX_PROJECT ?? process.env.CLOUD_ML_PROJECT_ID,
      region: process.env.GOOGLE_VERTEX_LOCATION ?? 'us-east5',
    });
    const response = await client.messages.create({
      model: config.model ?? 'claude-sonnet-4-20250514',
      max_tokens: config.maxTokens ?? 1000,
      temperature: config.temperature ?? 0.0,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    return anthropicMessageCompletion(response);
  };
}
