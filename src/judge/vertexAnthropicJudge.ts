import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletionAdapter } from './llmJudge.js';
import {
  anthropicMessageCompletion,
  anthropicMessageRequest,
  type AnthropicMessage,
  type AnthropicMessageRequest,
} from './anthropicJudge.js';
import { loadJudgeSdk } from './adapterSupport.js';

interface VertexSdk {
  AnthropicVertex: new (options: {
    projectId: string | undefined;
    region: string;
  }) => {
    messages: {
      create(request: AnthropicMessageRequest): Promise<AnthropicMessage>;
    };
  };
}

/**
 * Anthropic on Google Vertex AI completion adapter.
 * Requires the `@anthropic-ai/vertex-sdk` package and Application Default
 * Credentials; reads GOOGLE_VERTEX_PROJECT and GOOGLE_VERTEX_LOCATION.
 */
export function vertexAnthropicCompletion(
  config: JudgeConfig = {}
): JudgeCompletionAdapter {
  return async ({ system, prompt }) => {
    const sdk = await loadJudgeSdk<VertexSdk>(
      // @ts-expect-error - optional: npm install @anthropic-ai/vertex-sdk
      () => import('@anthropic-ai/vertex-sdk'),
      'Vertex Anthropic',
      '@anthropic-ai/vertex-sdk'
    );
    const client = new sdk.AnthropicVertex({
      projectId:
        process.env.GOOGLE_VERTEX_PROJECT ?? process.env.CLOUD_ML_PROJECT_ID,
      region: process.env.GOOGLE_VERTEX_LOCATION ?? 'us-east5',
    });
    return anthropicMessageCompletion(
      await client.messages.create(
        anthropicMessageRequest(config, system, prompt)
      )
    );
  };
}
