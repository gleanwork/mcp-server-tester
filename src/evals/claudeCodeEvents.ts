import type { ModelCall, TraceEvent } from './evalFrameworkTypes.js';
import type { LLMToolCall } from './mstClient/types.js';

/**
 * A Claude message event (Claude Code's stream-json, a Cowork session's
 * audit log) as `claudeModelCalls` reads it, with when it was written or
 * seen (epoch ms), if known.
 */
export interface ClaudeMessageEvent {
  type?: string;
  /** The API request's ID, in a session transcript (`req_…`). */
  requestId?: string;
  /** The record's own ID. */
  uuid?: string;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
    content?: unknown;
  };
  at?: number;
}

/**
 * The model requests in a Claude session's events. Claude writes one
 * `assistant` event per content block of a message, all with the message's
 * ID and its usage so far, so a request is the events with one message ID
 * (the API's response ID): its usage the last one's, its output tokens the
 * most any reported. It started when the event before its first ended (the
 * prompt, a tool's result) and ended at its last.
 *
 * Usage written as a message streams (stream-json, a Cowork audit log) is
 * as of its start; `withFinalUsage` takes it from the session's transcript.
 */
export function claudeModelCalls(
  events: readonly ClaudeMessageEvent[]
): ModelCall[] {
  const calls = new Map<string, ModelCall>();
  let boundary: number | undefined;
  for (const event of events) {
    const id = event.message?.id;
    if (event.type !== 'assistant' || !id) {
      if (event.at !== undefined) boundary = event.at;
      continue;
    }
    let call = calls.get(id);
    if (!call) {
      call = {
        id,
        ...(boundary !== undefined
          ? { startedAt: new Date(boundary).toISOString() }
          : {}),
      };
      calls.set(id, call);
    }
    const message = event.message!;
    if (typeof event.requestId === 'string' && event.requestId)
      call.requestId = event.requestId;
    if (
      typeof event.uuid === 'string' &&
      event.uuid &&
      !call.entryIds?.includes(event.uuid)
    )
      call.entryIds = [...(call.entryIds ?? []), event.uuid];
    if (message.model) call.model = message.model;
    if (message.stop_reason) call.finishReason = message.stop_reason;
    const usage = message.usage ?? {};
    const count = (key: string): number | undefined =>
      typeof usage[key] === 'number' ? usage[key] : undefined;
    const input = count('input_tokens');
    if (input !== undefined) call.inputTokens = input;
    const output = count('output_tokens');
    if (output !== undefined)
      call.outputTokens = Math.max(call.outputTokens ?? 0, output);
    const cacheRead = count('cache_read_input_tokens');
    if (cacheRead !== undefined) call.cacheReadInputTokens = cacheRead;
    const cacheCreation = count('cache_creation_input_tokens');
    if (cacheCreation !== undefined)
      call.cacheCreationInputTokens = cacheCreation;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || typeof block !== 'object') continue;
      const { type, text, id: blockId } = block as Record<string, unknown>;
      if (type === 'text' && typeof text === 'string' && text)
        call.text = (call.text ?? '') + text;
      if (type === 'tool_use' && typeof blockId === 'string')
        call.toolCallIds = [...(call.toolCallIds ?? []), blockId];
    }
    if (event.at !== undefined) {
      call.completedAt = new Date(event.at).toISOString();
      if (call.startedAt)
        call.durationMs = Math.max(
          0,
          event.at - new Date(call.startedAt).getTime()
        );
    }
  }
  return [...calls.values()];
}

/**
 * Times a Claude session's tool calls that have none: each from the event
 * that asked for it (`tool_use`) to the one with its result (`tool_result`).
 */
export function timeClaudeToolCalls(
  calls: LLMToolCall[],
  events: readonly ClaudeMessageEvent[]
): void {
  const started = new Map<string, number>();
  const ended = new Map<string, number>();
  for (const event of events) {
    if (event.at === undefined) continue;
    const content = event.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (!block || typeof block !== 'object') continue;
      const { type, id, tool_use_id } = block as Record<string, unknown>;
      if (type === 'tool_use' && typeof id === 'string' && !started.has(id))
        started.set(id, event.at);
      if (
        type === 'tool_result' &&
        typeof tool_use_id === 'string' &&
        !ended.has(tool_use_id)
      )
        ended.set(tool_use_id, event.at);
    }
  }
  for (const call of calls) {
    if (!call.id || call.startedAt) continue;
    const start = started.get(call.id);
    const end = ended.get(call.id);
    if (start !== undefined) call.startedAt = new Date(start).toISOString();
    if (end !== undefined) call.completedAt = new Date(end).toISOString();
    if (start !== undefined && end !== undefined)
      call.durationMs = Math.max(0, end - start);
  }
}

/** A tool a client's tool search surfaced. */
export type SurfacedTool = NonNullable<TraceEvent['results']>[number];

// An MCP tool name in text, as Claude Code writes them.
const MCP_TOOL_IN_TEXT = /mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_.-]+/g;

/**
 * Splits Claude Code's `mcp__<server>__<tool>` name. The server is the part
 * before the first `__` after the prefix, so a tool name may contain `__`.
 * Every Claude parser splits names this way, so searches and calls agree.
 */
export function splitClaudeMcpName(
  raw: string
): { server: string; name: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(raw);
  return match ? { server: match[1]!, name: match[2]! } : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The tools a tool search returned, from its result: `tool_reference` blocks
 * (`tool_name`), or any `mcp__<server>__<tool>` name in the result text.
 */
export function surfacedTools(output: string | undefined): SurfacedTool[] {
  if (!output) return [];
  const found = new Map<string, SurfacedTool>();
  const add = (name: string) => {
    const tool: SurfacedTool = splitClaudeMcpName(name) ?? { name };
    found.set(`${tool.server ?? ''}\u0000${tool.name}`, tool);
  };
  let referenced = false;
  try {
    const parsed: unknown = JSON.parse(output);
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    for (const block of blocks) {
      if (typeof block === 'string') add(block);
      else if (block && typeof block === 'object') {
        const name = text((block as Record<string, unknown>).tool_name);
        if (name) {
          add(name);
          referenced = true;
        }
      }
    }
  } catch {
    // Not JSON: read MCP tool names from the text.
  }
  // Without tool references, read MCP tool names from the text; a name that
  // ends a sentence keeps its full stop out.
  if (!referenced) {
    for (const match of output.matchAll(MCP_TOOL_IN_TEXT))
      add(match[0].replace(/\.+$/, ''));
  }
  return [...found.values()];
}

/**
 * Types a Claude Code host-native tool call (Claude CLI, Cowork) as the event
 * it is: `Skill` loads a skill, `SlashCommand` runs a command, `Task` and
 * `Agent` start a subagent, and `ToolSearch` searches the tool catalog. MCP
 * calls and other built-in tools stay tool calls. Call it once the call's result
 * is attached, since a tool search's results come from it.
 */
export function typeClaudeCodeCall(call: LLMToolCall): LLMToolCall {
  if (call.source !== 'builtin' || call.kind !== undefined) return call;
  const input = call.arguments ?? {};
  switch (call.name) {
    case 'Skill': {
      const skill = text(input.skill) ?? text(input.command);
      return skill ? { ...call, kind: 'skill', name: skill } : call;
    }
    case 'SlashCommand': {
      // `/review-pr 123` runs `/review-pr`; the arguments stay in `arguments`.
      const command = text(input.command)?.split(/\s+/)[0];
      return command ? { ...call, kind: 'command', name: command } : call;
    }
    case 'Task':
    case 'Agent':
      return {
        ...call,
        kind: 'subagent',
        name: text(input.subagent_type) ?? call.name,
      };
    case 'ToolSearch':
      return {
        ...call,
        kind: 'tool_search',
        results: surfacedTools(call.output),
      };
    default:
      return call;
  }
}

/**
 * Model requests with the usage a later record of them reports: Claude
 * writes a message's usage as it starts (an output count of a token or two)
 * in its stream and audit log, and once it's done in the session's
 * transcript. Each request keeps its own times and text, and takes its usage
 * from the record that saw more of its output.
 */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * A Claude result's thinking tokens: part of its output tokens, which
 * Anthropic reports apart (`usage.output_tokens_details.thinking_tokens`) and
 * Claude's agent repeats per model in `modelUsage[model].thinkingTokens`.
 * Undefined when the result doesn't say.
 */
export function claudeThinkingTokens(
  usage: unknown,
  modelUsage?: unknown
): number | undefined {
  const details =
    usage && typeof usage === 'object'
      ? (usage as Record<string, unknown>).output_tokens_details
      : undefined;
  const reported =
    details && typeof details === 'object'
      ? count((details as Record<string, unknown>).thinking_tokens)
      : undefined;
  if (reported !== undefined) return reported;
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const perModel = Object.values(modelUsage).map((model) =>
    model && typeof model === 'object'
      ? count((model as Record<string, unknown>).thinkingTokens)
      : undefined
  );
  // Every model's, or none: a partial sum would undercount.
  if (!perModel.length || perModel.some((value) => value === undefined))
    return undefined;
  return perModel.reduce<number>((sum, value) => sum + value!, 0);
}

export function withFinalUsage(
  calls: ModelCall[],
  later: readonly ModelCall[]
): ModelCall[] {
  const byId = new Map(later.map((call) => [call.id, call]));
  return calls.map((call) => {
    const other = call.id ? byId.get(call.id) : undefined;
    if (other?.requestId && !call.requestId)
      call = { ...call, requestId: other.requestId };
    const entryIds = [
      ...new Set([...(call.entryIds ?? []), ...(other?.entryIds ?? [])]),
    ];
    if (entryIds.length > (call.entryIds?.length ?? 0))
      call = { ...call, entryIds };
    if (!other || (other.outputTokens ?? 0) <= (call.outputTokens ?? 0))
      return call;
    const usage = {
      inputTokens: other.inputTokens,
      outputTokens: other.outputTokens,
      cacheReadInputTokens: other.cacheReadInputTokens,
      cacheCreationInputTokens: other.cacheCreationInputTokens,
    };
    return {
      ...call,
      ...Object.fromEntries(
        Object.entries(usage).filter(([, value]) => value !== undefined)
      ),
    };
  });
}
