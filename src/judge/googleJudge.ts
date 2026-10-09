import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletionAdapter } from './llmJudge.js';
import {
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_JUDGE_TEMPERATURE,
  loadJudgeSdk,
  requireJudgeApiKey,
} from './adapterSupport.js';

interface GoogleSdk {
  GoogleGenerativeAI: new (apiKey: string) => {
    getGenerativeModel(options: {
      model: string;
      generationConfig: { maxOutputTokens: number; temperature: number };
      systemInstruction: string;
    }): {
      generateContent(prompt: string): Promise<{
        response: {
          text(): string;
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
          };
        };
      }>;
    };
  };
}

/** Loads the optional `@google/generative-ai` package, or throws naming how to install it. */
export function loadGoogleSdk(): Promise<GoogleSdk> {
  return loadJudgeSdk<GoogleSdk>(
    // @ts-expect-error - optional: npm install @google/generative-ai
    () => import('@google/generative-ai'),
    'Google',
    '@google/generative-ai'
  );
}

/**
 * Google Gemini completion adapter.
 * Requires the `@google/generative-ai` package and a Google API key.
 */
export function googleCompletion(
  config: JudgeConfig = {}
): JudgeCompletionAdapter {
  const apiKey = requireJudgeApiKey(
    'Google',
    config.apiKeyEnvVar ?? 'GOOGLE_API_KEY'
  );
  return async ({ system, prompt }) => {
    const sdk = await loadGoogleSdk();
    const gemini = new sdk.GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: config.model ?? 'gemini-2.0-flash',
      generationConfig: {
        maxOutputTokens: config.maxTokens ?? DEFAULT_JUDGE_MAX_TOKENS,
        temperature: config.temperature ?? DEFAULT_JUDGE_TEMPERATURE,
      },
      systemInstruction: system,
    });
    const { response } = await gemini.generateContent(prompt);
    return {
      text: response.text(),
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
    };
  };
}
