/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import type { Judge, JudgeConfig, JudgeResult } from './judgeTypes.js';
import { JudgeResponseSchema } from './judgeTypes.js';

/**
 * Creates a Google Gemini-backed LLM judge.
 * Requires the `@google/generative-ai` package and a Google API key.
 */
export function createGoogleJudge(config: JudgeConfig = {}): Judge {
  const apiKeyEnvVar = config.apiKeyEnvVar ?? 'GOOGLE_API_KEY';
  const apiKey = process.env[apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(
      `Google judge requires an API key. Set the ${apiKeyEnvVar} environment variable.`
    );
  }

  const model = config.model ?? 'gemini-2.0-flash';
  const maxTokens = config.maxTokens ?? 1000;

  return {
    async evaluate(candidate, reference, rubric): Promise<JudgeResult> {
      // Dynamic import keeps `@google/generative-ai` an optional runtime dep.
      let googleModule: any;
      try {
        // @ts-expect-error - optional: npm install @google/generative-ai
        googleModule = await import('@google/generative-ai');
      } catch (err) {
        throw new Error(
          'Google judge requires the `@google/generative-ai` package. Install it with: npm install @google/generative-ai\n' +
            `Original error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const genAI = new googleModule.GoogleGenerativeAI(apiKey);
      const gemini = genAI.getGenerativeModel({
        model,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.0,
        },
        systemInstruction:
          'You are an expert evaluator. Respond with valid JSON only: {"pass": true|false, "score": 0.0-1.0, "reasoning": "explanation"}',
      });

      const candidateStr =
        typeof candidate === 'string'
          ? candidate
          : JSON.stringify(candidate, null, 2);

      const referenceStr =
        reference !== null && reference !== undefined
          ? typeof reference === 'string'
            ? reference
            : JSON.stringify(reference, null, 2)
          : null;

      const prompt =
        `Rubric:\n${rubric}\n\n` +
        `<candidate_response>\n${candidateStr}\n</candidate_response>\n\n` +
        `<reference_answer>\n${referenceStr ?? 'No reference provided.'}\n</reference_answer>\n\n` +
        `Evaluate and return JSON: {"pass": boolean, "score": number (0-1), "reasoning": string}`;

      const startTime = Date.now();
      const result = await gemini.generateContent(prompt);
      const durationMs = Date.now() - startTime;

      const text = result.response.text() as string;
      const cleaned = text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      let parsedRaw: unknown;
      try {
        parsedRaw = JSON.parse(cleaned);
      } catch {
        throw new Error(`Failed to parse judge response as JSON: ${text}`);
      }

      const validation = JudgeResponseSchema.safeParse(parsedRaw);
      if (!validation.success) {
        throw new Error(
          `Judge returned invalid response. Expected {pass, score, reasoning} but got: ${cleaned.slice(0, 500)}\nValidation errors: ${JSON.stringify(validation.error.issues)}`
        );
      }
      const { pass, score, reasoning } = validation.data;

      return {
        pass,
        score,
        reasoning,
        usage: {
          inputTokens:
            (result.response.usageMetadata?.promptTokenCount as
              | number
              | undefined) ?? 0,
          outputTokens:
            (result.response.usageMetadata?.candidatesTokenCount as
              | number
              | undefined) ?? 0,
          totalCostUsd: 0,
          durationMs,
        },
      };
    },
  };
}
