/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import type { Judge, JudgeConfig, JudgeResult } from './judgeTypes.js';
import { JudgeResponseSchema } from './judgeTypes.js';

/**
 * Creates an Anthropic-backed LLM judge using the Anthropic SDK directly.
 *
 * When `vertex` is true, uses `AnthropicVertex` from `@anthropic-ai/vertex-sdk`
 * which routes through Google Vertex AI (requires Application Default Credentials
 * and GOOGLE_VERTEX_PROJECT / GOOGLE_VERTEX_LOCATION env vars).
 *
 * When `vertex` is false, uses `Anthropic` from `@anthropic-ai/sdk` which
 * connects to api.anthropic.com (requires ANTHROPIC_API_KEY).
 */
export function createAnthropicJudge(
  config: JudgeConfig,
  vertex: boolean
): Judge {
  const model = config.model ?? 'claude-sonnet-4-20250514';
  const maxTokens = config.maxTokens ?? 1000;
  const temperature = config.temperature ?? 0.0;
  const maxToolOutputSize = config.maxToolOutputSize;

  if (!vertex) {
    const apiKeyEnvVar = config.apiKeyEnvVar ?? 'ANTHROPIC_API_KEY';
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey) {
      throw new Error(
        `Anthropic judge requires an API key. Set the ${apiKeyEnvVar} environment variable.`
      );
    }
  }

  return {
    async evaluate(candidate, reference, rubric): Promise<JudgeResult> {
      const candidateStr =
        typeof candidate === 'string'
          ? candidate
          : JSON.stringify(candidate, null, 2);
      const candidateSizeBytes = Buffer.byteLength(candidateStr, 'utf8');

      // Check maxToolOutputSize threshold before calling API (fail fast)
      if (
        maxToolOutputSize !== undefined &&
        candidateSizeBytes > maxToolOutputSize
      ) {
        return {
          pass: false,
          score: 0,
          reasoning: `Tool output size (${candidateSizeBytes} bytes) exceeds maximum allowed size (${maxToolOutputSize} bytes)`,
          candidateSizeBytes,
          exceedsMaxToolOutputSize: true,
        };
      }

      let client: any;

      if (vertex) {
        let vertexModule: any;
        try {
          // @ts-expect-error - optional: npm install @anthropic-ai/vertex-sdk
          vertexModule = await import('@anthropic-ai/vertex-sdk');
        } catch (err) {
          throw new Error(
            'Vertex Anthropic judge requires the `@anthropic-ai/vertex-sdk` package. ' +
              'Install it with: npm install @anthropic-ai/vertex-sdk\n' +
              `Original error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        client = new vertexModule.AnthropicVertex({
          projectId:
            process.env.GOOGLE_VERTEX_PROJECT ??
            process.env.CLOUD_ML_PROJECT_ID,
          region: process.env.GOOGLE_VERTEX_LOCATION ?? 'us-east5',
        });
      } else {
        let anthropicModule: any;
        try {
          // @ts-expect-error - optional: npm install @anthropic-ai/sdk
          anthropicModule = await import('@anthropic-ai/sdk');
        } catch (err) {
          throw new Error(
            'Anthropic judge requires the `@anthropic-ai/sdk` package. ' +
              'Install it with: npm install @anthropic-ai/sdk\n' +
              `Original error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        const apiKeyEnvVar = config.apiKeyEnvVar ?? 'ANTHROPIC_API_KEY';
        client = new anthropicModule.default({
          apiKey: process.env[apiKeyEnvVar],
        });
      }

      const prompt = buildJudgePrompt(candidate, reference, rubric);

      const startTime = Date.now();
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system:
          'You are an expert evaluator. Respond with valid JSON only: {"pass": true|false, "score": 0.0-1.0, "reasoning": "explanation"}',
        messages: [{ role: 'user', content: prompt }],
      });
      const durationMs = Date.now() - startTime;

      const textBlock = (response.content as any[]).find(
        (b: any) => b.type === 'text'
      );
      const text = (textBlock?.text as string) ?? '';
      const parsed = parseJudgeResponse(text);

      return {
        pass: parsed.pass,
        score: parsed.score,
        reasoning: parsed.reasoning,
        candidateSizeBytes,
        exceedsMaxToolOutputSize: false,
        usage: {
          inputTokens: (response.usage?.input_tokens as number) ?? 0,
          outputTokens: (response.usage?.output_tokens as number) ?? 0,
          totalCostUsd: 0,
          durationMs,
        },
      };
    },
  };
}

function buildJudgePrompt(
  candidate: unknown,
  reference: unknown,
  rubric: string
): string {
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

  return (
    `Rubric:\n${rubric}\n\n` +
    `<candidate_response>\n${candidateStr}\n</candidate_response>\n\n` +
    `<reference_answer>\n${referenceStr ?? 'No reference provided.'}\n</reference_answer>\n\n` +
    `Evaluate and return JSON: {"pass": boolean, "score": number (0-1), "reasoning": string}`
  );
}

function parseJudgeResponse(text: string): {
  pass: boolean;
  score: number;
  reasoning: string;
} {
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*"pass"[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`Failed to parse judge response as JSON: ${text}`);
    }
  }

  const result = JudgeResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Judge returned invalid response. Expected {pass, score, reasoning} but got: ${cleaned.slice(0, 500)}\nValidation errors: ${JSON.stringify(result.error.issues)}`
    );
  }
  return result.data;
}
