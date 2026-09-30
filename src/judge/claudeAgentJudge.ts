import { query } from '@anthropic-ai/claude-agent-sdk';
import type { JudgeConfig } from './judgeTypes.js';
import type { JudgeCompletionAdapter } from './llmJudge.js';

/** The SDK's final result message, as far as the judge reads it. */
interface AgentResultMessage {
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

/**
 * Claude Agent SDK completion adapter: one response-only turn with no tools.
 * Reports the SDK's own cost, duration and cache usage.
 */
export function claudeAgentCompletion(
  config: JudgeConfig = {}
): JudgeCompletionAdapter {
  return async ({ system, prompt }) => {
    try {
      let result: AgentResultMessage | undefined;
      for await (const message of query({
        prompt,
        options: {
          model: config.model ?? 'claude-sonnet-4-20250514',
          maxBudgetUsd: config.maxBudgetUsd ?? 0.1,
          // No tools, so nothing needs permission.
          tools: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: system,
          maxTurns: 1,
        },
      })) {
        if (message.type === 'result')
          result = message as unknown as AgentResultMessage;
      }
      if (!result)
        throw new Error('No result message received from Claude Agent SDK');
      if (result.subtype !== 'success' && result.errors?.length)
        throw new Error(`Claude Agent SDK error: ${result.errors.join(', ')}`);
      return {
        text: result.result ?? '',
        usage: {
          inputTokens: result.usage?.input_tokens,
          outputTokens: result.usage?.output_tokens,
          totalCostUsd: result.total_cost_usd,
          durationMs: result.duration_ms,
          durationApiMs: result.duration_api_ms,
          cacheReadInputTokens: result.usage?.cache_read_input_tokens,
          cacheCreationInputTokens: result.usage?.cache_creation_input_tokens,
        },
      };
    } catch (error) {
      throw new Error(
        `Claude Agent judge evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
}
