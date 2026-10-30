import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletion, JudgeCompletionAdapter } from './llmJudge.js';
import {
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_JUDGE_TEMPERATURE,
  DEFAULT_OPENAI_JUDGE_MODEL,
  loadJudgeSdk,
  requireJudgeCredential,
} from './adapterSupport.js';
import { resolveLLMEndpoint } from '../llm/endpoint.js';

interface OpenAIClient {
  chat: {
    completions: {
      create(request: {
        model: string;
        max_tokens: number;
        temperature: number;
        messages: Array<{ role: 'system' | 'user'; content: string }>;
      }): Promise<{
        choices: Array<{
          message: { content?: string | null };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
  responses: {
    create(request: {
      model: string;
      instructions: string;
      input: string;
      reasoning: { effort: string };
      max_output_tokens: number;
    }): Promise<{
      output_text?: string;
      status?: string;
      incomplete_details?: { reason?: string } | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

interface OpenAISdk {
  default: new (options: { apiKey: string; baseURL: string }) => OpenAIClient;
}

/** Loads the optional `openai` package, or throws naming how to install it. */
export function loadOpenAISdk(): Promise<OpenAISdk> {
  return loadJudgeSdk<OpenAISdk>(
    // @ts-expect-error - optional: npm install openai
    () => import('openai'),
    'OpenAI',
    'openai'
  );
}

/**
 * OpenAI adapter: Chat Completions, or the Responses API when `effort` is
 * set (reasoning models take an effort and no temperature).
 * Requires the `openai` package and an OpenAI API key (or the gateway auth
 * command; see docs/llm-gateways.md).
 */
export function openaiCompletion(
  config: JudgeConfig = {}
): JudgeCompletionAdapter {
  const options = { apiKeyEnvVar: config.apiKeyEnvVar };
  requireJudgeCredential('OpenAI', 'openai', options);
  return async ({ system, prompt }) => {
    const sdk = await loadOpenAISdk();
    const endpoint = await resolveLLMEndpoint('openai', options);
    const client = new sdk.default({
      apiKey: endpoint.apiKey ?? '',
      baseURL: endpoint.baseURL,
    });
    const model = config.model ?? DEFAULT_OPENAI_JUDGE_MODEL;
    const maxTokens = config.maxTokens ?? DEFAULT_JUDGE_MAX_TOKENS;
    if (config.effort !== undefined)
      return responsesCompletion(client, {
        model,
        instructions: system,
        input: prompt,
        reasoning: { effort: config.effort },
        max_output_tokens: maxTokens,
      });
    const completion = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
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
      ...(completion.choices[0]?.finish_reason === 'length'
        ? { truncated: true }
        : {}),
    };
  };
}

async function responsesCompletion(
  client: OpenAIClient,
  request: Parameters<OpenAIClient['responses']['create']>[0]
): Promise<JudgeCompletion> {
  const response = await client.responses.create(request);
  return {
    text: response.output_text ?? '',
    usage: {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    },
    ...(response.status === 'incomplete' &&
    response.incomplete_details?.reason === 'max_output_tokens'
      ? { truncated: true }
      : {}),
  };
}
