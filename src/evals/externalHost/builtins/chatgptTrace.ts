import { open, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { UsageMetrics } from '../../../types/index.js';
import type {
  LLMToolCall,
  MCPHostSimulationResult,
} from '../../mcpHost/mcpHostTypes.js';
import type { ExternalHostTelemetry } from '../types.js';
import type { ChatgptSurface } from '../../chatgpt/driver.js';

const MAX_FILES = 10_000;
const MAX_BYTES = 32 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;

/** Fixed observed native identities. The caller selects the surface, never the transcript. */
export function expectedChatgptOriginator(
  surface: ChatgptSurface = 'chatgpt-work'
): 'codex_work_desktop' | 'Codex Desktop' {
  switch (surface) {
    case 'chatgpt-work':
      return 'codex_work_desktop';
    case 'codex':
      return 'Codex Desktop';
    default:
      throw new Error('ChatGPT surface must be chatgpt-work or codex.');
  }
}

export interface ChatgptTracePolicy {
  /** Defaults to Work for existing macOS and marker-based callers. */
  surface?: ChatgptSurface;
  /** Configured MCP labels; native `mcp__<label>` namespaces map back to them. */
  mcpServers?: readonly string[];
  /**
   * Linux only: the app stores the prompt with Markdown punctuation
   * backslash-escaped. Accept exactly that form (`native_markdown_escaped`).
   */
  nativeMarkdownEscapes?: boolean;
}

/** The app's namespace form of an MCP label: every non-alphanumeric character becomes `_`. */
export function chatgptMcpNamespace(label: string): string {
  return `mcp__${label.replace(/[^A-Za-z0-9]/g, '_')}`;
}

/**
 * Split a native `mcp__<label>__<tool>` name. Configured labels win (longest
 * first) so labels with `-` or `__` map back to their configured form; other
 * names split at the first `__` and remain external MCP servers.
 */
function splitMcpName(
  qualified: string,
  configured: readonly string[]
): { server: string; tool: string } | undefined {
  for (const label of [...configured].sort((a, b) => b.length - a.length)) {
    const prefix = `${chatgptMcpNamespace(label)}__`;
    if (qualified.startsWith(prefix) && qualified.length > prefix.length)
      return { server: label, tool: qualified.slice(prefix.length) };
  }
  const match = /^mcp__(.+?)__(.+)$/.exec(qualified);
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
}

/** Confirmed ChatGPT Work built-in namespace; never allow a configured MCP server to impersonate it. */
export function isChatgptBuiltinServer(server: string): boolean {
  return server === 'cua_repl';
}
interface Event {
  timestamp?: string;
  type: string;
  payload: ObjectValue;
  turnId?: string;
}
export interface ChatgptTrace {
  promptMatch?: ChatgptPromptMatch;
  nativePromptSha256?: string;
  sessionId: string;
  turnId: string;
  model?: string;
  reasoningEffort?: string;
  startedAt?: string;
  completedAt?: string;
  /** Terminal, not necessarily successful: an aborted turn also has error set. */
  complete: boolean;
  error?: string;
  response?: string;
  toolCalls: LLMToolCall[];
  conversationHistory: NonNullable<
    MCPHostSimulationResult['conversationHistory']
  >;
  usage?: UsageMetrics;
  telemetry: ExternalHostTelemetry;
  mcpDurationMs?: number;
  llmDurationMs?: number;
  limitations: string[];
}
export type ChatgptSessionSnapshot = Map<
  string,
  { size: number; mtimeMs: number }
>;

/** Metadata-only baseline: never inspect old conversations to discover this run. */
export async function snapshotChatgptSessions(
  root: string
): Promise<ChatgptSessionSnapshot> {
  const files: ChatgptSessionSnapshot = new Map();
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (++visited > MAX_FILES)
        throw new Error(
          'ChatGPT session discovery exceeded its bounded file limit.'
        );
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name))
        await walk(path, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const info = await stat(path);
        files.set(path, { size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  await walk(root, 0);
  return files;
}

export type ChatgptTraceSelector =
  | string
  | { strategy: 'exact_prompt'; prompt: string };
export interface ChatgptTraceBinding {
  path: string;
  sessionId: string;
  turnId: string;
}

/** Exact-prompt discovery never reads a session that existed at the baseline. */
export async function findChatgptTrace(
  root: string,
  baseline: ChatgptSessionSnapshot,
  selector: ChatgptTraceSelector,
  startedAfterMs: number,
  options: ChatgptTracePolicy & {
    requireFreshSession?: boolean;
    observedBeforeMs?: number;
    bound?: ChatgptTraceBinding;
  } = {}
): Promise<{ path: string; trace: ChatgptTrace } | undefined> {
  const current = await snapshotChatgptSessions(root);
  const matches: Array<{ path: string; trace: ChatgptTrace }> = [];
  for (const [path, info] of current) {
    const old = baseline.get(path);
    if (old && typeof selector !== 'string') continue;
    if (old?.size === info.size && old.mtimeMs === info.mtimeMs) continue;
    if (info.size > MAX_BYTES)
      throw new Error('ChatGPT transcript exceeds the 32 MiB safety limit.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: string;
    try {
      const size = (await file.stat()).size;
      if (size > MAX_BYTES)
        throw new Error('ChatGPT transcript exceeds the 32 MiB safety limit.');
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, 0);
      content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
    const trace = parseChatgptTrace(
      content,
      selector,
      startedAfterMs,
      options.observedBeforeMs,
      options
    );
    if (trace && old && options.requireFreshSession)
      throw new Error(
        'ChatGPT submitted into an existing native session instead of a fresh chat.'
      );
    if (trace) matches.push({ path, trace });
  }
  if (matches.length > 1)
    throw new Error('Ambiguous matching ChatGPT sessions for this query.');
  const match = matches[0];
  if (
    options.bound &&
    (!match ||
      match.path !== options.bound.path ||
      match.trace.sessionId !== options.bound.sessionId ||
      match.trace.turnId !== options.bound.turnId)
  )
    throw new Error(
      'Bound ChatGPT session/turn changed or no longer matches the query.'
    );
  return match;
}

export function parseChatgptTrace(
  content: string,
  selector: ChatgptTraceSelector,
  startedAfterMs = 0,
  observedBeforeMs = Infinity,
  options: ChatgptTracePolicy = {}
): ChatgptTrace | undefined {
  const expectedOriginator = expectedChatgptOriginator(options.surface);
  if (typeof selector !== 'string' && !selector.prompt.trim())
    throw new Error('Exact-prompt correlation requires a non-empty prompt.');
  const events: Event[] = [];
  let activeTurn: string | undefined;
  let sessionId: string | undefined;
  let originator: string | undefined;
  const matches = new Set<string>();
  const userTurns: string[] = [];
  const userTexts = new Map<string, Set<string>>();
  const lines = content.split('\n');
  // The writer may be in the middle of its last JSONL record.
  if (!content.endsWith('\n')) lines.pop();
  // The native writer can leave a truncated record and then rewrite it whole
  // under the same ordinal. Skip a malformed line only when that happens.
  let lastOrdinal: number | undefined;
  let pendingMalformed = false;
  let supersededRecords = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: ObjectValue;
    try {
      raw = object(JSON.parse(line)) ?? {};
    } catch {
      if (pendingMalformed || lastOrdinal === undefined)
        throw new Error(
          'Malformed complete JSONL record in ChatGPT transcript.'
        );
      pendingMalformed = true;
      continue;
    }
    const ordinal = number(raw.ordinal);
    if (pendingMalformed) {
      if (ordinal === undefined || ordinal !== lastOrdinal! + 1)
        throw new Error(
          'Malformed complete JSONL record in ChatGPT transcript.'
        );
      pendingMalformed = false;
      supersededRecords += 1;
    }
    if (ordinal !== undefined) lastOrdinal = ordinal;
    const payload = object(raw.payload) ?? {};
    if (raw.type === 'session_meta') {
      sessionId = string(payload.id);
      originator = string(payload.originator);
    }
    if (
      raw.type === 'turn_context' ||
      (raw.type === 'event_msg' && payload.type === 'task_started')
    ) {
      activeTurn = string(payload.turn_id);
    }
    const turnId =
      string(payload.turn_id) ??
      string(
        object(payload.internal_chat_message_metadata_passthrough)?.turn_id
      ) ??
      activeTurn;
    const event: Event = {
      timestamp: string(raw.timestamp),
      type: string(raw.type) ?? '',
      payload,
      turnId,
    };
    events.push(event);
    const item = object(payload.item);
    const isUserItem =
      raw.type === 'event_msg' &&
      payload.type === 'item_completed' &&
      item?.type === 'UserMessage';
    const isUserMessage =
      raw.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user';
    const text = isUserItem
      ? contentText(item?.content)
      : isUserMessage
        ? contentText(payload.content)
        : '';
    if (isUserItem && turnId) {
      if (!userTexts.has(turnId)) {
        userTurns.push(turnId);
        userTexts.set(turnId, new Set());
      }
      userTexts.get(turnId)!.add(text);
    }
    const promptMatches =
      typeof selector === 'string'
        ? (isUserItem || isUserMessage) &&
          unescapeMarkdown(text).includes(`[eval-run-marker:${selector}]`)
        : isUserItem &&
          promptMatchKind(text, selector.prompt, options) !== undefined;
    if (
      turnId &&
      time(event.timestamp) >= startedAfterMs &&
      time(event.timestamp) <= observedBeforeMs &&
      promptMatches
    )
      matches.add(turnId);
  }
  if (pendingMalformed)
    throw new Error('Malformed complete JSONL record in ChatGPT transcript.');
  if (!sessionId || originator !== expectedOriginator || matches.size === 0)
    return undefined;
  if (matches.size > 1)
    throw new Error('Ambiguous matching ChatGPT turns for this query.');
  const turnId = [...matches][0]!;
  if (
    typeof selector !== 'string' &&
    (userTurns[0] !== turnId || userTexts.get(turnId)?.size !== 1)
  )
    throw new Error(
      'Exact-prompt match is not the unique initial user message of a fresh ChatGPT session.'
    );
  const nativePrompt = userTexts.get(turnId)?.values().next().value;
  const promptEvidence =
    typeof selector !== 'string' && nativePrompt !== undefined
      ? {
          promptMatch: promptMatchKind(nativePrompt, selector.prompt, options)!,
          nativePromptSha256: createHash('sha256')
            .update(nativePrompt, 'utf8')
            .digest('hex'),
        }
      : {};
  const turn = events.filter((event) => event.turnId === turnId);
  const context = turn.find((event) => event.type === 'turn_context')?.payload;
  const start = turn.find((event) => event.payload.type === 'task_started');
  const end = [...turn]
    .reverse()
    .find((event) => event.payload.type === 'task_complete');
  const aborted = [...turn]
    .reverse()
    .find((event) => event.payload.type === 'turn_aborted');
  const calls = new Map<string, LLMToolCall>();
  const nativeItemTypes = new Map<string, string>();
  const intervals: Array<{ source: 'mcp' | 'host'; span: [number, number] }> =
    [];
  const history: ChatgptTrace['conversationHistory'] = [];
  const seenItems = new Set<string>();
  const nativeMessageIds = new Set(
    turn
      .filter((event) => event.payload.type === 'item_completed')
      .map((event) => string(object(event.payload.item)?.id))
      .filter(Boolean)
  );
  const outputs = new Map<string, Event>();
  for (const event of turn)
    if (
      event.type === 'response_item' &&
      (event.payload.type === 'function_call_output' ||
        event.payload.type === 'custom_tool_call_output') &&
      string(event.payload.call_id)
    )
      outputs.set(string(event.payload.call_id)!, event);
  const pendingIds = new Set<string>();
  const nestedIds = new Set<string>();
  let response: string | undefined;
  const usageRecords = new Map<string, ObjectValue>();
  let turnUsage: ObjectValue | undefined;
  for (const event of turn) {
    const p = event.payload;
    if (event.type === 'token_usage_record' && string(p.turn_id) === turnId) {
      const id = string(p.response_id);
      const usage = object(p.usage);
      if (id && usage) usageRecords.set(id, usage);
      const cumulative = object(p.turn_token_usage);
      if (
        cumulative &&
        (!turnUsage ||
          ((number(cumulative.input_tokens) ?? -1) >=
            (number(turnUsage.input_tokens) ?? 0) &&
            (number(cumulative.output_tokens) ?? -1) >=
              (number(turnUsage.output_tokens) ?? 0)))
      )
        turnUsage = cumulative;
    }
    if (event.type === 'event_msg' && p.type === 'item_completed') {
      const item = object(p.item);
      const id = string(item?.id);
      if (!item || !id || seenItems.has(id)) continue;
      seenItems.add(id);
      const isMcp = item.type === 'McpToolCall';
      const isCommand = item.type === 'CommandExecution';
      const isWeb = item.type === 'Extension' && item.kind === 'web.search';
      if (isMcp || isCommand || isWeb) {
        const name = isMcp
          ? string(item.tool)
          : isCommand
            ? 'CommandExecution'
            : 'web.search';
        const server = isMcp ? string(item.server) : undefined;
        const argumentsValue = isMcp
          ? object(item.arguments)
          : isCommand
            ? { command: item.command, cwd: item.cwd, source: item.source }
            : { query: item.query, action: item.action };
        if (!name || (isMcp && !server) || !argumentsValue)
          throw new Error('Malformed native MCP call in ChatGPT transcript.');
        if (
          isCommand &&
          !(
            typeof item.command === 'string' ||
            (Array.isArray(item.command) &&
              item.command.every((part) => typeof part === 'string'))
          )
        )
          throw new Error(
            'Malformed native host command in ChatGPT transcript.'
          );
        if (isWeb && !object(item.action))
          throw new Error(
            'Malformed native host web action in ChatGPT transcript.'
          );
        nativeItemTypes.set(
          id,
          isMcp ? 'McpToolCall' : isCommand ? 'CommandExecution' : 'Extension'
        );
        const duration = object(item.duration);
        const started = number(p.started_at_ms);
        const completed = number(p.completed_at_ms);
        const durationMs =
          duration &&
          number(duration.secs) !== undefined &&
          number(duration.nanos) !== undefined
            ? number(duration.secs)! * 1000 + number(duration.nanos)! / 1e6
            : started !== undefined && completed !== undefined
              ? Math.max(0, completed - started)
              : undefined;
        const result = isMcp
          ? (item.result ?? item.error)
          : isCommand
            ? {
                stdout: item.stdout,
                stderr: item.stderr,
                aggregated_output: item.aggregated_output,
                exit_code: item.exit_code,
                error: item.error,
              }
            : { results: item.results, status: item.status, error: item.error };
        // Native event types, and the confirmed app-owned server/tool pair, define
        // host provenance. Generic names or untrusted tool-result metadata do not.
        const source =
          !isMcp || (isChatgptBuiltinServer(server!) && name === 'js')
            ? 'host'
            : 'mcp';
        calls.set(id, {
          source,
          id,
          name,
          server,
          ...(source === 'host'
            ? {
                rawName: isMcp
                  ? `${server}.${name}`
                  : isWeb
                    ? 'Extension.web.search'
                    : 'CommandExecution',
              }
            : {}),
          arguments: argumentsValue,
          output: result === undefined ? undefined : JSON.stringify(result),
          durationMs,
          startedAt:
            started === undefined ? undefined : new Date(started).toISOString(),
          completedAt:
            completed === undefined
              ? undefined
              : new Date(completed).toISOString(),
          isError:
            (isCommand &&
              typeof item.exit_code === 'number' &&
              item.exit_code !== 0) ||
            item.status === 'failed' ||
            item.error != null ||
            object(item.result)?.isError === true,
        });
        if (
          started !== undefined &&
          completed !== undefined &&
          completed >= started
        )
          intervals.push({ source, span: [started, completed] });
        history.push({ role: 'tool', toolCallId: id });
      } else if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
        const text =
          item.type === 'UserMessage'
            ? unescapeMarkdown(contentText(item.content))
            : contentText(item.content);
        const role = item.type === 'UserMessage' ? 'user' : 'assistant';
        if (text) history.push({ role, content: text });
        if (item.type === 'AgentMessage' && item.phase === 'final_answer')
          response = text;
      }
    } else if (
      event.type === 'response_item' &&
      (p.type === 'function_call' || p.type === 'custom_tool_call')
    ) {
      const id = string(p.call_id) ?? string(p.id);
      // item_completed records (other builds) own an id they share with a call.
      if (
        !id ||
        calls.has(id) ||
        nativeMessageIds.has(id) ||
        nativeMessageIds.has(string(p.id))
      )
        continue;
      const parsed = nativeResponseCall(
        p,
        id,
        outputs.get(id),
        event.timestamp,
        options.mcpServers ?? []
      );
      for (const [index, call] of parsed.calls.entries()) {
        calls.set(call.id!, call);
        nativeItemTypes.set(call.id!, string(p.type)!);
        if (index > 0) nestedIds.add(call.id!);
      }
      if (parsed.pending) pendingIds.add(id);
      if (parsed.span)
        intervals.push({ source: parsed.calls[0]!.source!, span: parsed.span });
      history.push({ role: 'tool', toolCallId: id });
    } else if (
      event.type === 'response_item' &&
      p.type === 'message' &&
      p.role === 'assistant' &&
      !nativeMessageIds.has(string(p.id))
    ) {
      const text = contentText(p.content);
      if (text) history.push({ role: 'assistant', content: text });
      if (p.phase === 'final_answer') response = text;
    }
  }
  response = string(end?.payload.last_agent_message) ?? response;
  // Builds that record nested MCP calls as timed McpToolCall items make the
  // references synthesized from exec input redundant; keep the native items.
  if (nestedIds.size && [...nativeItemTypes.values()].includes('McpToolCall')) {
    for (const id of nestedIds) {
      calls.delete(id);
      nativeItemTypes.delete(id);
    }
    nestedIds.clear();
  }
  // Untimed code-mode nested calls sort with their exec call.
  const sortKey = (call: LLMToolCall) =>
    time(
      call.startedAt ??
        (nestedIds.has(call.id!)
          ? calls.get(call.id!.replace(/#\d+$/, ''))?.startedAt
          : undefined)
    );
  const toolCalls = [...calls.values()].sort((a, b) => sortKey(a) - sortKey(b));
  const complete = !!end || !!aborted;
  const durationMs = number(end?.payload.duration_ms);
  // Partial turns: aborted duration, else elapsed native time so far.
  const lastMs = Math.max(...turn.map((event) => time(event.timestamp)));
  const partialDurationMs = end
    ? undefined
    : (number(aborted?.payload.duration_ms) ??
      (start?.timestamp ? Math.max(0, lastMs - time(start.timestamp)) : 0));
  const usage = usageFromRecords(
    turnUsage,
    usageRecords,
    durationMs ?? partialDurationMs
  );
  const mcpCalls = toolCalls.filter((call) => call.source === 'mcp');
  const hostCalls = toolCalls.filter((call) => call.source === 'host');
  // Code-mode nested calls have no own timing; their time is inside the exec call.
  const mcpDurationMs = sumToolDuration(mcpCalls);
  const mcpIntervals = intervals.filter(
    (interval) => interval.source === 'mcp'
  );
  const mcpWallDurationMs =
    mcpIntervals.length === mcpCalls.length
      ? intervalUnion(mcpIntervals.map((interval) => interval.span))
      : undefined;
  const toolWallDurationMs =
    intervals.length === toolCalls.length - nestedIds.size
      ? intervalUnion(intervals.map((interval) => interval.span))
      : undefined;
  const limitations = [
    'The host does not report USD cost; cost is omitted, not zero.',
    'LLM duration is turn elapsed time minus the union of all native tool intervals; it includes host overhead.',
    'Conversation history contains user/assistant messages and native tool results, not hidden reasoning.',
    'Confirmed ChatGPT Work cua_repl.js, CommandExecution, and Extension.web.search actions are host tools; unknown native MCP namespaces remain external MCP calls.',
  ];
  if (supersededRecords)
    limitations.push(
      `${supersededRecords} truncated native record(s) were rewritten by the host under the same ordinal; the rewritten record was used.`
    );
  if (nestedIds.size)
    limitations.push(
      'Some MCP calls were made through the code-mode exec runner; per-call arguments and latency are not separately reported, and nested calls are counted once per observed reference.'
    );
  if (!end)
    limitations.push(
      'Turn did not complete; tool calls and usage are partial.'
    );
  if (pendingIds.size)
    limitations.push(
      'Some native tool calls have no recorded output and are pending.'
    );
  if (!usage)
    limitations.push(
      'No complete native token-usage record was available for this turn.'
    );
  return {
    ...promptEvidence,
    sessionId,
    turnId,
    model: string(context?.model),
    reasoningEffort: string(context?.effort),
    startedAt: start?.timestamp,
    completedAt: end?.timestamp ?? aborted?.timestamp,
    complete,
    error: aborted ? 'ChatGPT turn was aborted.' : undefined,
    response,
    toolCalls,
    conversationHistory: history,
    usage,
    mcpDurationMs,
    llmDurationMs:
      durationMs !== undefined && toolWallDurationMs !== undefined
        ? Math.max(0, durationMs - toolWallDurationMs)
        : undefined,
    telemetry: {
      models: string(context?.model) ? [string(context?.model)!] : undefined,
      reasoningEffort: string(context?.effort),
      ...(end ? {} : { partial: true }),
      resultCount: end ? 1 : 0,
      apiCallCount: usageRecords.size || undefined,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cacheReadInputTokens: usage?.cacheReadInputTokens,
      cacheCreationInputTokens: usage?.cacheCreationInputTokens,
      reasoningOutputTokens: usage?.reasoningOutputTokens,
      durationMs,
      timeToFirstTokenMs: number(end?.payload.time_to_first_token_ms),
      mcpWallDurationMs,
      toolCallCount: toolCalls.length,
      toolErrorCount: toolCalls.filter((call) => call.isError).length,
      mcpToolCallCount: mcpCalls.length,
      mcpToolErrorCount: mcpCalls.filter((call) => call.isError).length,
      hostToolCallCount: hostCalls.length,
      hostToolErrorCount: hostCalls.filter((call) => call.isError).length,
      hostToolDurationMs: sumToolDuration(hostCalls),
      toolWallDurationMs,
      toolProvenance: toolCalls.map((call) => ({
        id: call.id,
        source: call.source!,
        nativeServer: call.server,
        nativeTool: call.name,
        nativeItemType: nativeItemTypes.get(call.id!),
        ...(pendingIds.has(call.id!) ? { pending: true } : {}),
        ...(nestedIds.has(call.id!) ? { viaCodeMode: true } : {}),
      })),
    },
    limitations,
  };
}

/**
 * Convert a native `function_call` / `custom_tool_call` and its paired output.
 * Attribution uses only the native namespace, name, and executed_tool_calls;
 * tool-result text never changes provenance. The first call is the native call;
 * later calls are MCP calls referenced inside a code-mode `exec` runner.
 */
function nativeResponseCall(
  p: ObjectValue,
  id: string,
  outputEvent: Event | undefined,
  timestamp: string | undefined,
  configured: readonly string[]
): { calls: LLMToolCall[]; span?: [number, number]; pending: boolean } {
  const name = string(p.name);
  if (!name)
    throw new Error('Malformed native tool call in ChatGPT transcript.');
  const out = outputEvent?.payload;
  const outMeta = object(out?.internal_chat_message_metadata_passthrough);
  const executed = (
    Array.isArray(outMeta?.executed_tool_calls)
      ? outMeta.executed_tool_calls
      : []
  )
    .map((entry) => object(entry))
    .filter((entry): entry is ObjectValue => !!string(entry?.name));
  const startSec = number(
    object(p.internal_chat_message_metadata_passthrough)?.create_time
  );
  const endSec = number(outMeta?.create_time);
  const started =
    startSec !== undefined
      ? startSec * 1000
      : timestamp
        ? time(timestamp)
        : undefined;
  const completed =
    out === undefined
      ? undefined
      : endSec !== undefined
        ? endSec * 1000
        : outputEvent?.timestamp
          ? time(outputEvent.timestamp)
          : undefined;
  const span: [number, number] | undefined =
    started !== undefined && completed !== undefined && completed >= started
      ? [started, completed]
      : undefined;
  const output =
    out === undefined
      ? undefined
      : typeof out.output === 'string'
        ? out.output
        : JSON.stringify(out.output);
  const timing = {
    durationMs: span ? span[1] - span[0] : undefined,
    startedAt:
      started === undefined ? undefined : new Date(started).toISOString(),
    completedAt: span ? new Date(span[1]).toISOString() : undefined,
  };
  const isError = p.status === 'failed' || out?.status === 'failed';
  if (p.type === 'function_call') {
    const namespace = string(p.namespace);
    const split = namespace?.startsWith('mcp__')
      ? splitMcpName(`${namespace}__${name}`, configured)
      : undefined;
    const confirmed = executed.map((entry) =>
      splitMcpName(string(entry.name)!, configured)
    );
    if (
      split &&
      confirmed.some(
        (entry) =>
          entry && (entry.server !== split.server || entry.tool !== split.tool)
      )
    )
      throw new Error('Malformed native MCP call in ChatGPT transcript.');
    const parsedArgs = parseArguments(p.arguments);
    const argumentsValue =
      parsedArgs ?? object(executed[0]?.arguments) ?? ({} as ObjectValue);
    const source =
      !split || (isChatgptBuiltinServer(split.server) && split.tool === 'js')
        ? 'host'
        : 'mcp';
    return {
      calls: [
        {
          source,
          id,
          name: split?.tool ?? name,
          server: split?.server,
          ...(source === 'host'
            ? {
                rawName: split
                  ? `${split.server}.${split.tool}`
                  : namespace
                    ? `${namespace}.${name}`
                    : name,
              }
            : {}),
          arguments: argumentsValue,
          output,
          ...timing,
          isError,
        },
      ],
      span,
      pending: out === undefined,
    };
  }
  // custom_tool_call: never retain raw input (exec input is model-authored code).
  const input = string(p.input) ?? '';
  const referenced = [...input.matchAll(/\btools\.([A-Za-z0-9_]+)/g)].map(
    (match) => match[1]!
  );
  const executedNames = executed.map((entry) => string(entry.name)!);
  const nestedNames = [...new Set([...referenced, ...executedNames])];
  const nested: LLMToolCall[] = [];
  if (name === 'exec') {
    const mcpNames = nestedNames.filter((nestedName) =>
      splitMcpName(nestedName, configured)
    );
    for (const qualified of mcpNames) {
      const split = splitMcpName(qualified, configured)!;
      const runs = executed.filter((entry) => entry.name === qualified);
      for (const run of runs.length ? runs : [undefined]) {
        const builtin =
          isChatgptBuiltinServer(split.server) && split.tool === 'js';
        nested.push({
          source: builtin ? 'host' : 'mcp',
          id: `${id}#${nested.length + 1}`,
          name: split.tool,
          server: split.server,
          rawName: builtin
            ? `${split.server}.${split.tool}`
            : `exec:${qualified}`,
          arguments: object(run?.arguments) ?? {},
          isError,
        });
      }
    }
  }
  return {
    calls: [
      {
        source: 'host',
        id,
        name,
        rawName: name,
        arguments: {
          ...(name === 'exec'
            ? {
                nestedTools: nestedNames.filter(
                  (nestedName) => !splitMcpName(nestedName, configured)
                ),
              }
            : {}),
          inputLength: input.length,
          inputSha256: createHash('sha256').update(input, 'utf8').digest('hex'),
        },
        output,
        ...timing,
        isError,
      },
      ...nested,
    ],
    span,
    pending: out === undefined,
  };
}

function parseArguments(value: unknown): ObjectValue | undefined {
  if (typeof value !== 'string') return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function usageFromRecords(
  cumulative: ObjectValue | undefined,
  records: Map<string, ObjectValue>,
  durationMs: number | undefined
): UsageMetrics | undefined {
  let tokens = cumulative;
  if (!tokens && records.size) {
    tokens = {};
    for (const key of [
      'input_tokens',
      'output_tokens',
      'cached_input_tokens',
      'cache_write_input_tokens',
      'reasoning_output_tokens',
    ]) {
      const values = [...records.values()].map((record) => number(record[key]));
      if (values.every((value) => value !== undefined))
        tokens[key] = values.reduce((sum, value) => sum + value, 0);
    }
  }
  if (
    !tokens ||
    number(tokens.input_tokens) === undefined ||
    number(tokens.output_tokens) === undefined ||
    durationMs === undefined
  )
    return undefined;
  return {
    inputTokens: number(tokens.input_tokens)!,
    outputTokens: number(tokens.output_tokens)!,
    durationMs,
    cacheReadInputTokens: number(tokens.cached_input_tokens),
    cacheCreationInputTokens: number(tokens.cache_write_input_tokens),
    reasoningOutputTokens: number(tokens.reasoning_output_tokens),
  };
}
function sumToolDuration(calls: LLMToolCall[]): number | undefined {
  return calls.every((call) => call.durationMs !== undefined)
    ? calls.reduce((sum, call) => sum + call.durationMs!, 0)
    : undefined;
}

function intervalUnion(intervals: Array<[number, number]>): number {
  let total = 0;
  let end = 0;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value)
    ? value.map((part) => string(object(part)?.text) ?? '').join('\n')
    : '';
}
/**
 * How the host's stored user message equals the submitted prompt. The app may
 * add one terminal LF. On Linux it may also backslash-escape Markdown
 * punctuation (observed: `ALL_TOOLS` stored as `ALL\\_TOOLS`). Any other
 * difference is not a match.
 */
export type ChatgptPromptMatch =
  | 'exact'
  | 'native_terminal_lf'
  | 'native_markdown_escaped';
function promptMatchKind(
  stored: string,
  prompt: string,
  options: ChatgptTracePolicy
): ChatgptPromptMatch | undefined {
  if (stored === prompt) return 'exact';
  const body = stored.endsWith('\n') ? stored.slice(0, -1) : stored;
  if (body === prompt) return 'native_terminal_lf';
  if (!options.nativeMarkdownEscapes) return undefined;
  // Every stored backslash must start a Markdown escape; the unescaped text
  // must then equal the prompt exactly.
  if (body.replace(/\\[\\`*_{}[\]()#+.!:>-]/g, '').includes('\\'))
    return undefined;
  return unescapeMarkdown(body) === prompt
    ? 'native_markdown_escaped'
    : undefined;
}
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+.!:>-])/g, '$1');
}
function object(value: unknown): ObjectValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function time(value: string | undefined): number {
  return value ? Date.parse(value) : 0;
}
