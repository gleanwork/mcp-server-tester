/**
 * The LLM judge: one prompt, one parser, one size guard and one usage record
 * for every provider. Providers only supply a completion adapter (prompt in,
 * text and tokens out), so what a judge sees and how its answer is read
 * can't drift between providers.
 */
import type { Judge, JudgeResponse, UsageMetrics } from './judgeTypes.js';
import { JudgeResponseSchema } from './judgeTypes.js';

/** The system prompt every provider's judge receives. */
export const JUDGE_SYSTEM_PROMPT =
  'You are an expert evaluator. Respond with valid JSON only: {"pass": true|false, "score": 0.0-1.0, "reasoning": "explanation"}';

/** What a completion adapter is asked to complete. */
export interface JudgeCompletionRequest {
  system: string;
  prompt: string;
}

/** A provider's answer: the model's text and whatever usage it reports. */
export interface JudgeCompletion {
  text: string;
  /** Missing token counts default to 0, cost to 0 and duration to wall-clock time. */
  usage?: Partial<UsageMetrics>;
}

/** Sends one judge prompt to a provider. */
export type JudgeCompletionAdapter = (
  request: JudgeCompletionRequest
) => Promise<JudgeCompletion>;

export interface LLMJudgeOptions {
  /** Fail without calling the provider when the candidate is larger (bytes). */
  maxToolOutputSize?: number;
}

function serialize(value: unknown): string {
  return typeof value === 'string'
    ? value
    : (JSON.stringify(value, null, 2) ?? String(value));
}

/** The user prompt: rubric, candidate and (optional) reference. */
export function buildJudgePrompt(
  candidate: unknown,
  reference: unknown,
  rubric: string
): string {
  const referenceStr =
    reference !== null && reference !== undefined ? serialize(reference) : null;
  return (
    `Rubric:\n${rubric}\n\n` +
    `<candidate_response>\n${serialize(candidate)}\n</candidate_response>\n\n` +
    `<reference_answer>\n${referenceStr ?? 'No reference provided.'}\n</reference_answer>\n\n` +
    `Evaluate and return JSON: {"pass": boolean, "score": number (0-1), "reasoning": string}`
  );
}

/**
 * Reads a judge's answer: strips a surrounding Markdown code fence, falls
 * back to the JSON object embedded in surrounding prose, and validates the
 * shape. Fences inside the JSON (e.g. in `reasoning`) are left alone.
 */
export function parseJudgeResponse(text: string): JudgeResponse {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Models sometimes wrap the JSON object in prose.
    const embedded = cleaned.match(/\{[\s\S]*"pass"[\s\S]*\}/);
    try {
      parsed = embedded ? JSON.parse(embedded[0]) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined)
      throw new Error(`Failed to parse judge response as JSON: ${text}`);
  }

  const result = JudgeResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Judge returned invalid response. Expected {pass, score, reasoning} but got: ${cleaned.slice(0, 500)}\nValidation errors: ${JSON.stringify(result.error.issues)}`
    );
  }
  return result.data;
}

/** A judge that sends the shared prompt through a provider's completion adapter. */
export function createLLMJudge(
  complete: JudgeCompletionAdapter,
  options: LLMJudgeOptions = {}
): Judge {
  return {
    async evaluate(candidate, reference, rubric) {
      const candidateSizeBytes = Buffer.byteLength(
        serialize(candidate),
        'utf8'
      );
      const { maxToolOutputSize } = options;
      // Fail fast (and free) when the candidate is too large to judge.
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

      const startTime = Date.now();
      const completion = await complete({
        system: JUDGE_SYSTEM_PROMPT,
        prompt: buildJudgePrompt(candidate, reference, rubric),
      });
      const durationMs = Date.now() - startTime;
      const parsed = parseJudgeResponse(completion.text);
      // Only what the provider reported overrides the defaults.
      const reported = Object.fromEntries(
        Object.entries(completion.usage ?? {}).filter(
          ([, value]) => value !== undefined
        )
      ) as Partial<UsageMetrics>;

      return {
        pass: parsed.pass,
        score: parsed.score,
        reasoning: parsed.reasoning,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalCostUsd: 0,
          durationMs,
          ...reported,
        },
        candidateSizeBytes,
        exceedsMaxToolOutputSize: false,
      };
    },
  };
}
