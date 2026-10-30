/**
 * The `codex` client's trace: what Codex reported while it ran (the SDK's
 * `codex exec --experimental-json` events, each timed as it arrived), joined
 * with the session's rollout file in its `CODEX_HOME`, which records each
 * model response with its usage and the tool calls it asked for.
 *
 * The events are the trace's backbone: every MCP call, shell command, web
 * search and file change, with arguments, result and status. The rollout
 * adds what the events don't carry: one model call per response (its ID,
 * usage and the calls it requested), the tool searches Codex runs to load
 * deferred MCP tools, and native call IDs. A missing or unreadable rollout
 * only loses those; the events alone are a complete trace.
 */
import type { UsageMetrics } from '../types/index.js';
import type { ModelCall, TraceEvent } from './evalFrameworkTypes.js';

type ObjectValue = Record<string, unknown>;

/** One SDK event, with the time MST received it (ISO 8601). */
export interface TimedCodexEvent {
  at: string;
  event: { type: string } & ObjectValue;
}

/** What the trace builder needs to know about the run. */
export interface CodexTraceContext {
  /** Codex's `mcp_servers` keys, mapped back to the eval's server labels. */
  servers: ReadonlyMap<string, string>;
  /** The model the client asked for, when the rollout doesn't say. */
  model?: string;
}

export interface CodexTrace {
  threadId?: string;
  finalText: string;
  events: TraceEvent[];
  modelCalls?: ModelCall[];
  usage?: UsageMetrics;
  startedAt?: string;
  completedAt?: string;
  /** Set when the turn failed, or never completed. */
  error?: string;
  telemetry: Record<string, unknown>;
}

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function ms(at: string | undefined): number {
  return at ? Date.parse(at) : NaN;
}

function between(start?: string, end?: string): number | undefined {
  const span = ms(end) - ms(start);
  return Number.isFinite(span) ? Math.max(0, span) : undefined;
}

/** A Codex MCP namespace (`mcp__<key>`) as the eval's server label. */
function serverOfNamespace(
  namespace: string | undefined,
  servers: ReadonlyMap<string, string>
): string | undefined {
  const key = namespace?.startsWith('mcp__')
    ? namespace.slice('mcp__'.length)
    : undefined;
  return key === undefined ? undefined : (servers.get(key) ?? key);
}

/**
 * An MCP result as the trace keeps it: the text of its text blocks, or the
 * content as JSON when it has other blocks or structured content only.
 */
function mcpOutput(item: ObjectValue): string | undefined {
  const error = string(object(item.error)?.message);
  if (error !== undefined) return error;
  const result = object(item.result);
  if (!result) return undefined;
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.map((block) =>
    object(block)?.type === 'text' ? string(object(block)?.text) : undefined
  );
  if (content.length && texts.every((text) => text !== undefined))
    return texts.join('\n');
  if (content.length) return JSON.stringify(content);
  return result.structured_content == null
    ? ''
    : JSON.stringify(result.structured_content);
}

function arguments_(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return object(JSON.parse(value)) ?? { input: value };
    } catch {
      return { input: value };
    }
  }
  return object(value) ?? {};
}

/** A completed SDK item as a trace event, or undefined for messages and plans. */
function eventOf(
  item: ObjectValue,
  startedAt: string | undefined,
  completedAt: string,
  servers: ReadonlyMap<string, string>
): TraceEvent | undefined {
  const id = string(item.id);
  const timing = {
    ...(startedAt ? { startedAt } : {}),
    completedAt,
    ...(startedAt ? { durationMs: between(startedAt, completedAt) } : {}),
  };
  switch (item.type) {
    case 'mcp_tool_call': {
      const key = string(item.server) ?? '';
      const tool = string(item.tool) ?? '';
      const result = object(item.result);
      return {
        kind: 'tool_call',
        source: 'mcp',
        name: tool,
        server: servers.get(key) ?? key,
        rawName: `mcp__${key}__${tool}`,
        arguments: arguments_(item.arguments),
        output: mcpOutput(item),
        isError:
          item.status === 'failed' ||
          item.error != null ||
          result?.isError === true ||
          result?.is_error === true,
        ...(id ? { id } : {}),
        ...timing,
      };
    }
    case 'command_execution':
      return {
        kind: 'tool_call',
        source: 'builtin',
        name: 'shell',
        rawName: 'command_execution',
        arguments: { command: item.command },
        output: string(item.aggregated_output),
        isError:
          item.status === 'failed' ||
          (typeof item.exit_code === 'number' && item.exit_code !== 0),
        ...(id ? { id } : {}),
        ...timing,
      };
    case 'web_search':
      return {
        kind: 'tool_call',
        source: 'builtin',
        name: 'web_search',
        rawName: 'web_search',
        arguments: { query: item.query },
        ...(id ? { id } : {}),
        ...timing,
      };
    case 'file_change':
      return {
        kind: 'tool_call',
        source: 'builtin',
        name: 'apply_patch',
        rawName: 'file_change',
        arguments: { changes: item.changes },
        isError: item.status === 'failed',
        ...(id ? { id } : {}),
        ...timing,
      };
    default:
      return undefined;
  }
}

/** The non-fatal messages Codex streams while it retries or falls back. */
function isTransient(message: string): boolean {
  return /^Reconnecting\.\.\.|^Falling back from WebSockets/i.test(message);
}

/** What the rollout file adds to the events. */
interface RolloutFacts {
  model?: string;
  reasoningEffort?: string;
  /** Native `call_id`s of MCP calls, in order, per `mcp__<key>__<tool>`. */
  mcpCallIds: Map<string, string[]>;
  toolSearches: TraceEvent[];
  modelCalls: ModelCall[];
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

function assistantText(payload: ObjectValue): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map((block) => string(object(block)?.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

/**
 * Reads a rollout file's JSONL. Lines that don't parse (a record the writer
 * was still writing) are skipped: the rollout only enriches the trace.
 */
export function parseCodexRollout(
  content: string,
  servers: ReadonlyMap<string, string>
): RolloutFacts {
  const facts: RolloutFacts = {
    mcpCallIds: new Map(),
    toolSearches: [],
    modelCalls: [],
  };
  const searches = new Map<string, TraceEvent>();
  let boundary: string | undefined;
  let pendingCalls: string[] = [];
  let pendingText: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record: ObjectValue | undefined;
    try {
      record = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record) continue;
    const at = string(record.timestamp);
    const payload = object(record.payload) ?? {};
    if (record.type === 'turn_context') {
      facts.model ??= string(payload.model);
      facts.reasoningEffort ??= string(payload.effort);
    }
    if (record.type === 'event_msg' && payload.type === 'task_started')
      boundary = at;
    if (record.type === 'event_msg' && payload.type === 'task_complete') {
      facts.durationMs = count(payload.duration_ms);
      facts.timeToFirstTokenMs = count(payload.time_to_first_token_ms);
    }
    if (record.type === 'response_item') {
      const callId = string(payload.call_id);
      if (payload.type === 'function_call' && callId) {
        const server = string(payload.namespace);
        const name = string(payload.name);
        if (server?.startsWith('mcp__') && name) {
          const key = `${server}__${name}`;
          facts.mcpCallIds.set(key, [
            ...(facts.mcpCallIds.get(key) ?? []),
            callId,
          ]);
        }
        pendingCalls.push(callId);
      } else if (payload.type === 'tool_search_call' && callId) {
        const search: TraceEvent = {
          kind: 'tool_search',
          source: 'builtin',
          name: 'tool_search',
          rawName: 'tool_search',
          id: callId,
          arguments: arguments_(payload.arguments),
          ...(at ? { startedAt: at } : {}),
          results: [],
        };
        searches.set(callId, search);
        facts.toolSearches.push(search);
        pendingCalls.push(callId);
      } else if (payload.type === 'tool_search_output' && callId) {
        const search = searches.get(callId);
        if (search) {
          const results: NonNullable<TraceEvent['results']> = [];
          for (const entry of Array.isArray(payload.tools)
            ? payload.tools
            : []) {
            // A namespace of a server's tools, or a single tool.
            const group = object(entry);
            const nested = Array.isArray(group?.tools);
            const server = nested
              ? serverOfNamespace(string(group?.name), servers)
              : undefined;
            for (const tool of nested ? (group.tools as unknown[]) : [group]) {
              const name = string(object(tool)?.name);
              if (name) results.push({ name, ...(server ? { server } : {}) });
            }
          }
          search.results = results;
          search.output = JSON.stringify(results);
          if (at) {
            search.completedAt = at;
            search.durationMs = between(search.startedAt, at);
          }
        }
      } else if (
        (payload.type === 'function_call_output' ||
          payload.type === 'custom_tool_call_output') &&
        at
      ) {
        boundary = at;
      } else if (payload.type === 'message' && payload.role === 'assistant') {
        const text = assistantText(payload);
        if (text) pendingText.push(text);
      }
    }
    if (record.type === 'token_usage_record') {
      const id = string(payload.response_id);
      const usage = object(payload.usage);
      if (id && usage && !seen.has(id)) {
        seen.add(id);
        const input = count(usage.input_tokens);
        const cacheRead = count(usage.cached_input_tokens);
        const cacheWrite = count(usage.cache_write_input_tokens);
        const output = count(usage.output_tokens);
        const reasoning = count(usage.reasoning_output_tokens);
        const durationMs = between(boundary, at);
        facts.modelCalls.push({
          id,
          ...(facts.model ? { model: facts.model } : {}),
          ...(boundary ? { startedAt: boundary } : {}),
          ...(at ? { completedAt: at } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(input !== undefined
            ? {
                inputTokens: Math.max(
                  0,
                  input - (cacheRead ?? 0) - (cacheWrite ?? 0)
                ),
              }
            : {}),
          ...(output !== undefined ? { outputTokens: output } : {}),
          ...(cacheRead !== undefined
            ? { cacheReadInputTokens: cacheRead }
            : {}),
          ...(cacheWrite !== undefined
            ? { cacheCreationInputTokens: cacheWrite }
            : {}),
          ...(reasoning !== undefined
            ? { reasoningOutputTokens: reasoning }
            : {}),
          ...(pendingText.length ? { text: pendingText.join('\n') } : {}),
          ...(pendingCalls.length ? { toolCallIds: pendingCalls } : {}),
        });
      }
      pendingCalls = [];
      pendingText = [];
      if (at) boundary = at;
    }
  }
  return facts;
}

/** The trial's usage from the turn's total, in MST's terms (uncached input). */
function usageOf(
  usage: ObjectValue | undefined,
  durationMs: number
): UsageMetrics | undefined {
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = count(usage?.cached_input_tokens);
  const cacheWrite = count(usage?.cache_write_input_tokens);
  const reasoning = count(usage?.reasoning_output_tokens);
  return {
    inputTokens: Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    outputTokens: output,
    durationMs,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined
      ? { cacheCreationInputTokens: cacheWrite }
      : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
}

/** The union of the events' intervals, in ms. */
function busyMs(events: readonly TraceEvent[]): number {
  const spans = events
    .map((event) => [ms(event.startedAt), ms(event.completedAt)] as const)
    .filter(([start, end]) => Number.isFinite(start) && end >= start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | undefined;
  for (const [start, end] of spans) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else current[1] = Math.max(current[1], end);
  }
  if (current) total += current[1] - current[0];
  return total;
}

/**
 * The trial's trace from Codex's events and, when there is one, its rollout.
 * `startedAt` is when MST started the turn.
 */
export function buildCodexTrace(
  stream: readonly TimedCodexEvent[],
  rollout: string | undefined,
  context: CodexTraceContext & { startedAt: string; endedAt: string }
): CodexTrace {
  const started = new Map<string, string>();
  const events: TraceEvent[] = [];
  const messages: string[] = [];
  let threadId: string | undefined;
  let turnUsage: ObjectValue | undefined;
  let completed = false;
  let failure: string | undefined;
  let lastError: string | undefined;
  let notices = 0;
  for (const { at, event } of stream) {
    switch (event.type) {
      case 'thread.started':
        threadId = string(event.thread_id);
        break;
      case 'item.started': {
        const id = string(object(event.item)?.id);
        if (id && !started.has(id)) started.set(id, at);
        break;
      }
      case 'item.completed': {
        const item = object(event.item);
        if (!item) break;
        if (item.type === 'agent_message') {
          const text = string(item.text);
          if (text !== undefined) messages.push(text);
          break;
        }
        if (item.type === 'error') {
          notices += 1;
          break;
        }
        const id = string(item.id);
        const traced = eventOf(
          item,
          id ? started.get(id) : undefined,
          at,
          context.servers
        );
        if (traced) events.push(traced);
        break;
      }
      case 'turn.completed':
        completed = true;
        turnUsage = object(event.usage);
        break;
      case 'turn.failed':
        failure =
          string(object(event.error)?.message) ?? 'The Codex turn failed.';
        break;
      case 'error': {
        const message = string(event.message) ?? 'Codex reported an error.';
        if (isTransient(message)) notices += 1;
        else lastError = message;
        break;
      }
    }
  }
  const facts = rollout
    ? parseCodexRollout(rollout, context.servers)
    : undefined;
  // Native call IDs, so model calls name the events they asked for.
  if (facts) {
    const next = new Map<string, number>();
    for (const event of events) {
      if (event.source !== 'mcp' || !event.rawName) continue;
      const index = next.get(event.rawName) ?? 0;
      const callId = facts.mcpCallIds.get(event.rawName)?.[index];
      next.set(event.rawName, index + 1);
      if (callId) event.id = callId;
    }
    events.push(...facts.toolSearches);
    events.sort(
      (a, b) =>
        (ms(a.startedAt ?? a.completedAt) || 0) -
        (ms(b.startedAt ?? b.completedAt) || 0)
    );
  }
  const durationMs =
    facts?.durationMs ?? between(context.startedAt, context.endedAt) ?? 0;
  const usage = usageOf(turnUsage, durationMs);
  const error =
    failure ??
    (completed
      ? undefined
      : (lastError ?? 'Codex ended without completing its turn.'));
  const model = facts?.model ?? context.model;
  const mcpCalls = events.filter(
    (event) => event.kind === 'tool_call' && event.source === 'mcp'
  );
  const builtinCalls = events.filter(
    (event) => event.kind === 'tool_call' && event.source === 'builtin'
  );
  return {
    ...(threadId ? { threadId } : {}),
    finalText: messages.at(-1) ?? '',
    events,
    ...(facts?.modelCalls.length ? { modelCalls: facts.modelCalls } : {}),
    ...(usage ? { usage } : {}),
    startedAt: context.startedAt,
    completedAt: context.endedAt,
    ...(error ? { error } : {}),
    telemetry: {
      ...(model ? { models: [model] } : {}),
      ...(facts?.reasoningEffort
        ? { reasoningEffort: facts.reasoningEffort }
        : {}),
      ...(threadId ? { threadId } : {}),
      apiCallCount: facts?.modelCalls.length || undefined,
      durationMs,
      ...(facts?.timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: facts.timeToFirstTokenMs }
        : {}),
      toolCallCount: mcpCalls.length + builtinCalls.length,
      mcpToolCallCount: mcpCalls.length,
      mcpToolErrorCount: mcpCalls.filter((event) => event.isError).length,
      builtinToolCallCount: builtinCalls.length,
      toolSearchCount: facts?.toolSearches.length ?? 0,
      toolWallDurationMs: busyMs(mcpCalls.concat(builtinCalls)),
      ...(notices ? { transientErrorCount: notices } : {}),
      traceSource: facts ? 'codex-events+rollout' : 'codex-events',
    },
  };
}
