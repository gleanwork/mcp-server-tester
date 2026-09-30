/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletionAdapter } from './llmJudge.js';
import { missingJudgePackage, requireJudgeApiKey } from './optionalPackage.js';

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
    let sdk: any;
    try {
      // @ts-expect-error - optional: npm install @google/generative-ai
      sdk = await import('@google/generative-ai');
    } catch (err) {
      throw missingJudgePackage('Google', '@google/generative-ai', err);
    }
    const gemini = new sdk.GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: config.model ?? 'gemini-2.0-flash',
      generationConfig: {
        maxOutputTokens: config.maxTokens ?? 1000,
        temperature: config.temperature ?? 0.0,
      },
      systemInstruction: system,
    });
    const result = await gemini.generateContent(prompt);
    return {
      text: result.response.text() as string,
      usage: {
        inputTokens: result.response.usageMetadata?.promptTokenCount as
          | number
          | undefined,
        outputTokens: result.response.usageMetadata?.candidatesTokenCount as
          | number
          | undefined,
      },
    };
  };
}
