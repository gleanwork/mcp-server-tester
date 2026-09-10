import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  JudgeConfig,
  Judge,
  JudgeResult,
  UsageMetrics,
} from './judgeTypes.js';
import { JudgeResponseSchema } from './judgeTypes.js';

/**
 * Creates a Claude Agent SDK-based LLM judge client
 *
 * Uses the Claude Agent SDK query() function for evaluation.
 * This is a response-only judge that does not use any tools.
 *
 * @param config - Judge configuration
 * @returns Claude agent judge client
 */
export function createClaudeAgentJudge(config: JudgeConfig): Judge {
  const model = config.model ?? 'claude-sonnet-4-20250514';
  const maxBudgetUsd = config.maxBudgetUsd ?? 0.1;
  const maxToolOutputSize = config.maxToolOutputSize;

  return {
    async evaluate(
      candidate: unknown,
      reference: unknown,
      rubric: string
    ): Promise<JudgeResult> {
      // Calculate candidate size for threshold check
      const candidateStr =
        typeof candidate === 'string'
          ? candidate
          : JSON.stringify(candidate, null, 2);
      const candidateSizeBytes = Buffer.byteLength(candidateStr, 'utf8');

      // Check maxToolOutputSize threshold before calling API (fail fast, save money)
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

      // Build evaluation prompt
      const prompt = buildJudgePrompt(candidate, reference, rubric);

      try {
        // Use query() with no tools for response-only mode
        // Iterate through the generator to get the final result message
        let resultMessage:
          | {
              type: 'result';
              result?: string;
              usage?: {
                input_tokens: number;
                output_tokens: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
              total_cost_usd?: number;
              duration_ms?: number;
              duration_api_ms?: number;
              subtype?: string;
              errors?: string[];
            }
          | undefined;

        for await (const message of query({
          prompt,
          options: {
            model,
            maxBudgetUsd,
            // Use empty tools array for response-only mode
            tools: [],
            // Bypass permissions since we're not using any tools
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            // Use a custom system prompt for JSON output
            systemPrompt: buildSystemPrompt(),
            // Limit to 1 turn since this is a simple evaluation
            maxTurns: 1,
          },
        })) {
          // The final message will be the SDKResultMessage
          if (message.type === 'result') {
            resultMessage = message as unknown as typeof resultMessage;
          }
        }

        if (!resultMessage) {
          throw new Error('No result message received from Claude Agent SDK');
        }

        // Check for errors
        if (
          resultMessage.subtype !== 'success' &&
          resultMessage.errors?.length
        ) {
          throw new Error(
            `Claude Agent SDK error: ${resultMessage.errors.join(', ')}`
          );
        }

        // Extract text response from the result
        const responseText = resultMessage.result ?? '';

        // Parse the JSON response
        const parsed = parseJudgeResponse(responseText);

        // Build usage metrics from SDK response
        const usage: UsageMetrics = {
          inputTokens: resultMessage.usage?.input_tokens ?? 0,
          outputTokens: resultMessage.usage?.output_tokens ?? 0,
          totalCostUsd: resultMessage.total_cost_usd ?? 0,
          durationMs: resultMessage.duration_ms ?? 0,
          durationApiMs: resultMessage.duration_api_ms,
          cacheReadInputTokens: resultMessage.usage?.cache_read_input_tokens,
          cacheCreationInputTokens:
            resultMessage.usage?.cache_creation_input_tokens,
        };

        return {
          pass: parsed.pass,
          score: parsed.score,
          reasoning: parsed.reasoning,
          usage,
          candidateSizeBytes,
          exceedsMaxToolOutputSize: false,
        };
      } catch (error) {
        throw new Error(
          `Claude Agent judge evaluation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}

/**
 * Builds the system prompt for the judge
 */
function buildSystemPrompt(): string {
  return (
    'You are an expert evaluator. Evaluate the candidate response based on the rubric provided. ' +
    'Respond ONLY with valid JSON in this exact format: {"pass": boolean, "score": number (0-1), "reasoning": string}. ' +
    'Do not include any other text, markdown formatting, or code blocks.'
  );
}

/**
 * Builds the user prompt for evaluation
 */
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

  const parts: Array<string> = [];

  parts.push('Rubric:\n');
  parts.push(rubric);
  parts.push('\n\n<candidate_response>\n');
  parts.push(candidateStr);
  parts.push('\n</candidate_response>\n\n');

  parts.push('<reference_answer>\n');
  parts.push(referenceStr ?? 'No reference provided.');
  parts.push('\n</reference_answer>\n\n');

  parts.push(
    'Evaluate the candidate response against the rubric' +
      (referenceStr !== null
        ? ', comparing it with the reference answer if helpful'
        : '') +
      '. Return JSON: {"pass": boolean, "score": number (0-1), "reasoning": string}'
  );

  return parts.join('');
}

/**
 * Parses and validates the JSON response from the judge, handling markdown code blocks.
 * Throws a descriptive error if the response cannot be parsed or fails schema validation.
 */
function parseJudgeResponse(text: string): {
  pass: boolean;
  score: number;
  reasoning: string;
} {
  let jsonText = text.trim();

  // Strip markdown code blocks if present
  if (jsonText.startsWith('```json')) {
    jsonText = jsonText.slice(7);
  }
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.slice(3);
  }
  if (jsonText.endsWith('```')) {
    jsonText = jsonText.slice(0, -3);
  }
  jsonText = jsonText.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // If JSON parsing fails, try to extract from the text
    // Sometimes the model adds extra text before/after JSON
    const jsonMatch = jsonText.match(/\{[\s\S]*"pass"[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`Failed to parse judge response as JSON: ${text}`);
    }
  }

  const result = JudgeResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Judge returned invalid response. Expected {pass, score, reasoning} but got: ${jsonText.slice(0, 500)}\nValidation errors: ${JSON.stringify(result.error.issues)}`
    );
  }
  return result.data;
}
