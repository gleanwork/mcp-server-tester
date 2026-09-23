import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { UsageMetrics } from '../../../types/index.js';
import type {
  LLMToolCall,
  MCPHostSimulationResult,
} from '../../mcpHost/mcpHostTypes.js';
import type { ExternalHostTelemetry } from '../types.js';

const MAX_FILES = 10_000;
const MAX_BYTES = 32 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;

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
  promptMatch?: 'exact' | 'native_terminal_lf';
  nativePromptSha256?: string;
  sessionId: string;
  turnId: string;
  model?: string;
  reasoningEffort?: string;
  startedAt?: string;
  completedAt?: string;
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

const MAX_DIAGNOSTIC_FILES = 16;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_USER_MESSAGES = 64;

export interface ChatgptBindingDiagnostics {
  status: 'UNVERIFIED';
  authoritative: false;
  rootExists: boolean;
  baselineFileCount: number;
  currentFileCount: number;
  freshFileCount: number;
  modifiedBaselineCount: number;
  submittedSha256: string;
  expectedRootRelativeToHome?: string;
  metadataRead: 'disabled' | 'isolated-linux' | 'unavailable';
  truncated: boolean;
  skippedFileCount: number;
  originatorCount: Record<string, number>;
  recordTypes: Record<string, number>;
  nativeUserMessageCount: number;
  userTurnCount: number;
  nativeUserMessageSha256: string[];
  malformedRecordCount: number;
}

/** Diagnostic evidence only. Never feed these candidates into native acceptance. */
export async function diagnoseChatgptBinding(
  root: string,
  baseline: ChatgptSessionSnapshot,
  submittedPrompt: string,
  options: { isolatedLinuxHome?: string; expectedRoot?: string } = {}
): Promise<{ metadata: ChatgptBindingDiagnostics; candidatePaths: string[] }> {
  const metadata: ChatgptBindingDiagnostics = {
    status: 'UNVERIFIED',
    authoritative: false,
    rootExists: false,
    baselineFileCount: baseline.size,
    currentFileCount: 0,
    freshFileCount: 0,
    modifiedBaselineCount: 0,
    submittedSha256: createHash('sha256')
      .update(submittedPrompt, 'utf8')
      .digest('hex'),
    metadataRead: 'disabled',
    truncated: false,
    skippedFileCount: 0,
    originatorCount: {},
    recordTypes: {},
    nativeUserMessageCount: 0,
    userTurnCount: 0,
    nativeUserMessageSha256: [],
    malformedRecordCount: 0,
  };
  const candidatePaths: string[] = [];
  try {
    const home = options.isolatedLinuxHome;
    if (home) {
      if (
        !options.expectedRoot ||
        resolve(root) !== resolve(options.expectedRoot)
      )
        throw new Error('Unexpected diagnostic root.');
      const subpath = relative(home, root);
      if (
        !subpath ||
        subpath.startsWith(`..${sep}`) ||
        subpath === '..' ||
        isAbsolute(subpath)
      )
        throw new Error('Diagnostic root is outside isolated HOME.');
      metadata.expectedRootRelativeToHome = subpath;
      await assertOwnedDiagnosticPath(home, root, true);
    }
    let rootInfo;
    try {
      rootInfo = await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { metadata, candidatePaths };
      throw error;
    }
    metadata.rootExists = true;
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new Error('Unsafe diagnostic root.');
    const current = await snapshotChatgptSessions(root);
    metadata.currentFileCount = current.size;
    const candidates: Array<[string, { size: number; mtimeMs: number }]> = [];
    for (const [path, info] of current) {
      const old = baseline.get(path);
      if (!old) metadata.freshFileCount++;
      else if (old.size !== info.size || old.mtimeMs !== info.mtimeMs)
        metadata.modifiedBaselineCount++;
      else continue;
      candidates.push([path, info]);
    }
    // macOS and non-attested homes get filesystem metadata only, including baseline files.
    if (!home) return { metadata, candidatePaths };
    metadata.metadataRead = 'isolated-linux';
    const canonicalHome = await realpath(home);
    let totalBytes = 0;
    const turns = new Set<string>();
    for (const [index, [path, info]] of candidates.entries()) {
      if (
        index >= MAX_DIAGNOSTIC_FILES ||
        info.size > MAX_DIAGNOSTIC_BYTES ||
        totalBytes + info.size > MAX_DIAGNOSTIC_TOTAL_BYTES
      ) {
        metadata.skippedFileCount++;
        metadata.truncated = true;
        continue;
      }
      try {
        await assertOwnedDiagnosticPath(home, path);
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
          const opened = await file.stat();
          const checked = await lstat(path);
          await assertOwnedDiagnosticPath(home, path);
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.ino !== checked.ino ||
            opened.dev !== checked.dev ||
            opened.size > MAX_DIAGNOSTIC_BYTES ||
            totalBytes + opened.size > MAX_DIAGNOSTIC_TOTAL_BYTES
          )
            throw new Error('Unsafe diagnostic candidate.');
          const expectedPath = join(canonicalHome, relative(home, path));
          if ((await realpath(path)) !== expectedPath)
            throw new Error('Diagnostic candidate escaped its owned root.');
          // Linux validates the opened object too, not just the requested pathname.
          if (
            process.platform === 'linux' &&
            (await realpath(`/proc/self/fd/${file.fd}`)) !== expectedPath
          )
            throw new Error('Diagnostic candidate changed.');
          const buffer = Buffer.alloc(opened.size);
          totalBytes += opened.size;
          const { bytesRead } = await file.read(buffer, 0, opened.size, 0);
          const content = buffer.subarray(0, bytesRead).toString('utf8');
          candidatePaths.push(path);
          const lines = content.split('\n');
          if (content.length > 0 && !content.endsWith('\n')) {
            lines.pop();
            metadata.truncated = true;
          }
          let activeTurn: string | undefined;
          for (const line of lines) {
            if (!line.trim()) continue;
            let raw;
            try {
              raw = object(JSON.parse(line)) ?? {};
            } catch {
              metadata.malformedRecordCount++;
              continue;
            }
            const payload = object(raw.payload) ?? {};
            incrementDiagnosticCount(metadata.recordTypes, raw.type, [
              'session_meta',
              'turn_context',
              'event_msg',
              'response_item',
              'token_usage_record',
            ]);
            if (raw.type === 'session_meta')
              incrementDiagnosticCount(
                metadata.originatorCount,
                payload.originator,
                ['codex_work_desktop', 'codex_cli']
              );
            if (
              raw.type === 'turn_context' ||
              (raw.type === 'event_msg' && payload.type === 'task_started')
            )
              activeTurn = string(payload.turn_id);
            const item = object(payload.item);
            if (
              raw.type !== 'event_msg' ||
              payload.type !== 'item_completed' ||
              item?.type !== 'UserMessage'
            )
              continue;
            metadata.nativeUserMessageCount++;
            const turnId =
              string(payload.turn_id) ??
              string(
                object(payload.internal_chat_message_metadata_passthrough)
                  ?.turn_id
              ) ??
              activeTurn;
            if (turnId) turns.add(`${index}:${turnId}`);
            if (
              metadata.nativeUserMessageSha256.length <
              MAX_DIAGNOSTIC_USER_MESSAGES
            )
              metadata.nativeUserMessageSha256.push(
                createHash('sha256')
                  .update(contentText(item.content), 'utf8')
                  .digest('hex')
              );
            else metadata.truncated = true;
          }
        } finally {
          await file.close();
        }
      } catch {
        metadata.skippedFileCount++;
        metadata.truncated = true;
      }
    }
    metadata.userTurnCount = turns.size;
  } catch {
    // Diagnostics must not mask the original failure or emit paths/errors from private profiles.
    metadata.metadataRead = 'unavailable';
    metadata.truncated = true;
  }
  return { metadata, candidatePaths };
}

function incrementDiagnosticCount(
  counts: Record<string, number>,
  value: unknown,
  allowlist: string[]
): void {
  const key =
    typeof value === 'string' && allowlist.includes(value) ? value : 'other';
  counts[key] = (counts[key] ?? 0) + 1;
}

async function assertOwnedDiagnosticPath(
  home: string,
  path: string,
  allowMissing = false
): Promise<void> {
  if (!isAbsolute(home) || resolve(home) === '/')
    throw new Error('Invalid isolated HOME.');
  const parts = relative(home, path).split(sep);
  if (parts.includes('..') || isAbsolute(relative(home, path)))
    throw new Error('Outside isolated HOME.');
  let current = resolve(home);
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return;
      throw error;
    }
    if (
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('Unowned or symlinked diagnostic path.');
  }
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
  options: {
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
      options.observedBeforeMs
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
  observedBeforeMs = Infinity
): ChatgptTrace | undefined {
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
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: ObjectValue;
    try {
      raw = object(JSON.parse(line)) ?? {};
    } catch {
      throw new Error('Malformed complete JSONL record in ChatGPT transcript.');
    }
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
          (text === selector.prompt || text === `${selector.prompt}\n`);
    if (
      turnId &&
      time(event.timestamp) >= startedAfterMs &&
      time(event.timestamp) <= observedBeforeMs &&
      promptMatches
    )
      matches.add(turnId);
  }
  if (!sessionId || originator !== 'codex_work_desktop' || matches.size === 0)
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
          promptMatch:
            nativePrompt === selector.prompt
              ? ('exact' as const)
              : ('native_terminal_lf' as const),
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
  const toolCalls = [...calls.values()].sort(
    (a, b) => time(a.startedAt) - time(b.startedAt)
  );
  const durationMs = number(end?.payload.duration_ms);
  const usage = usageFromRecords(turnUsage, usageRecords, durationMs);
  const mcpCalls = toolCalls.filter((call) => call.source === 'mcp');
  const hostCalls = toolCalls.filter((call) => call.source === 'host');
  const mcpDurationMs = sumToolDuration(mcpCalls);
  const mcpIntervals = intervals.filter(
    (interval) => interval.source === 'mcp'
  );
  const mcpWallDurationMs =
    mcpIntervals.length === mcpCalls.length
      ? intervalUnion(mcpIntervals.map((interval) => interval.span))
      : undefined;
  const toolWallDurationMs =
    intervals.length === toolCalls.length
      ? intervalUnion(intervals.map((interval) => interval.span))
      : undefined;
  const limitations = [
    'The host does not report USD cost; cost is omitted, not zero.',
    'LLM duration is turn elapsed time minus the union of all native tool intervals; it includes host overhead.',
    'Conversation history contains user/assistant messages and native tool results, not hidden reasoning.',
    'Confirmed ChatGPT Work cua_repl.js, CommandExecution, and Extension.web.search actions are host tools; unknown native MCP namespaces remain external MCP calls.',
  ];
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
    complete: !!end || !!aborted,
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
      })),
    },
    limitations,
  };
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
