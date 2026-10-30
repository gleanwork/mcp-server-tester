import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MstClientSimulationResult, LLMToolCall } from '../../types.js';
import type { ModelCall } from '../../../evalFrameworkTypes.js';
import {
  mstScratchRoots,
  resolvePersistedOutput,
} from '../../../persistedToolOutput.js';
import type { UsageMetrics } from '../../../../types/index.js';
import {
  claudeModelCalls,
  claudeThinkingTokens,
  splitClaudeMcpName,
  typeClaudeCodeCall,
  type ClaudeMessageEvent,
} from '../../../claudeCodeEvents.js';

/**
 * The model requests in Claude Code's session transcripts under its config
 * directory (`projects/<project>/<session>.jsonl`), with their final usage.
 * None when it has none or they can't be read.
 */
export function claudeTranscriptModelCalls(configDir: string): ModelCall[] {
  const root = join(configDir, 'projects');
  let files: string[];
  try {
    files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.jsonl')
    );
  } catch {
    return [];
  }
  const events: ClaudeMessageEvent[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as ClaudeMessageEvent);
      } catch {
        // A line being written, or not JSON.
      }
    }
  }
  return claudeModelCalls(events);
}

/**
 * When each non-blank line of a process's output arrived (epoch ms), in
 * order: `parseStreamJson`'s `lineTimes`. A line arrives with the chunk that
 * ends it.
 */
export class LineClock {
  readonly times: number[] = [];
  private partial = '';

  push(chunk: Buffer | string): void {
    const lines = (this.partial + chunk.toString()).split('\n');
    this.partial = lines.pop() ?? '';
    const now = Date.now();
    for (const line of lines) if (line.trim().length > 0) this.times.push(now);
  }

  /** The output ended: its last line, if it had no newline, arrived now. */
  end(): readonly number[] {
    if (this.partial.trim().length > 0) this.times.push(Date.now());
    this.partial = '';
    return this.times;
  }
}

/**
 * Parses NDJSON (stream-json) output from CLI clients. With `lineTimes`
 * (a `LineClock`'s), tool calls and model requests get times: a tool call
 * from its request's line to its result's.
 */
export function parseStreamJson(
  stdout: string,
  lineTimes?: readonly number[]
): MstClientSimulationResult {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  const timed = lineTimes !== undefined && lineTimes.length === lines.length;
  const messages: ClaudeMessageEvent[] = [];
  const toolCalls: LLMToolCall[] = [];
  const textParts: string[] = [];
  let usage: UsageMetrics | undefined;
  const conversationHistory: Array<{
    role: 'user' | 'assistant' | 'tool';
    content?: string;
    toolCallId?: string;
  }> = [];

  for (const [index, line] of lines.entries()) {
    let event: StreamJsonEvent;
    try {
      event = JSON.parse(line) as StreamJsonEvent;
    } catch {
      // Skip non-JSON lines (e.g., debug output)
      continue;
    }
    const at = timed ? lineTimes[index] : undefined;
    const atIso = at !== undefined ? new Date(at).toISOString() : undefined;
    messages.push({ ...(event as ClaudeMessageEvent), at });

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name) {
          const rawName = block.name;
          const mcp = splitClaudeMcpName(rawName);
          toolCalls.push({
            name: mcp ? mcp.name : rawName,
            source: mcp ? 'mcp' : 'builtin',
            ...(mcp ? { server: mcp.server } : {}),
            rawName,
            arguments: block.input ?? {},
            id: block.id,
            ...(atIso ? { startedAt: atIso } : {}),
          });
        }

        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        }
      }
    }

    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const content =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
          const call = block.tool_use_id
            ? toolCalls.find((tc) => tc.id === block.tool_use_id)
            : undefined;
          if (call) {
            if (atIso) {
              call.completedAt = atIso;
              if (call.startedAt)
                call.durationMs = Math.max(
                  0,
                  at! - new Date(call.startedAt).getTime()
                );
            }
            // Store the payload once on the call; the transcript just references it.
            // A large result is a placeholder; the file it names holds it,
            // in the config directory MST made for this run (mst-claude-*).
            call.output = resolvePersistedOutput(
              content,
              call.id,
              mstScratchRoots('mst-claude-')
            );
            conversationHistory.push({ role: 'tool', toolCallId: call.id });
          } else {
            // Orphan result (no matching tool_use) — keep inline so nothing is lost.
            conversationHistory.push({ role: 'tool', content });
          }
        }
      }
    }

    if (event.type === 'result') {
      if (typeof event.result === 'string' && textParts.length === 0) {
        textParts.push(event.result);
      }

      if (event.usage) {
        usage = {
          inputTokens: event.usage.input_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
          totalCostUsd: event.total_cost_usd,
          durationMs: event.duration_ms ?? 0,
          durationApiMs: event.duration_api_ms,
          cacheReadInputTokens: event.usage.cache_read_input_tokens,
          cacheCreationInputTokens: event.usage.cache_creation_input_tokens,
          ...thinking(event),
        };
      }
    }

    if (event.type === 'result' && event.is_error === true) {
      const modelCalls = claudeModelCalls(messages);
      return {
        success: false,
        toolCalls: toolCalls.map(typeClaudeCodeCall),
        ...(modelCalls.length ? { modelCalls } : {}),
        error:
          typeof event.result === 'string'
            ? event.result
            : 'CLI client reported an error',
        usage,
      };
    }
  }

  const response = textParts.join('');

  if (response) {
    conversationHistory.push({ role: 'assistant', content: response });
  }

  const modelCalls = claudeModelCalls(messages);
  return {
    success: true,
    toolCalls: toolCalls.map(typeClaudeCodeCall),
    ...(modelCalls.length ? { modelCalls } : {}),
    response: response || undefined,
    conversationHistory:
      conversationHistory.length > 0 ? conversationHistory : undefined,
    usage,
  };
}

/** Creates a parser for CLIs that output a single JSON object with configurable paths. */
export function createJsonParser(paths: {
  toolCalls: string;
  response: string;
  success?: string;
}): (stdout: string) => MstClientSimulationResult {
  return (stdout: string): MstClientSimulationResult => {
    const data = JSON.parse(stdout) as Record<string, unknown>;

    const rawToolCalls = getNestedValue(data, paths.toolCalls);
    const toolCalls: LLMToolCall[] = Array.isArray(rawToolCalls)
      ? rawToolCalls.map((tc: Record<string, unknown>) => ({
          name: typeof tc.name === 'string' ? tc.name : '',
          ...(tc.source === 'mcp' || tc.source === 'builtin'
            ? { source: tc.source }
            : {}),
          ...(typeof tc.server === 'string' ? { server: tc.server } : {}),
          ...(typeof tc.rawName === 'string' ? { rawName: tc.rawName } : {}),
          ...(typeof tc.id === 'string' ? { id: tc.id } : {}),
          ...(typeof tc.output === 'string' ? { output: tc.output } : {}),
          arguments: (tc.arguments ?? tc.args ?? {}) as Record<string, unknown>,
        }))
      : [];

    const response = getNestedValue(data, paths.response);
    const success = paths.success
      ? Boolean(getNestedValue(data, paths.success))
      : true;

    return {
      success,
      toolCalls,
      response: typeof response === 'string' ? response : undefined,
    };
  };
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
}

interface StreamJsonEvent {
  type: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
    content?: ContentBlock[];
  };
  result?: string;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
}

/** A result's thinking tokens, when it reports them. */
function thinking(event: StreamJsonEvent): Partial<UsageMetrics> {
  const tokens = claudeThinkingTokens(event.usage, event.modelUsage);
  return tokens !== undefined ? { reasoningOutputTokens: tokens } : {};
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current !== null && typeof current === 'object') {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
