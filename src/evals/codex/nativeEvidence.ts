import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { HostEvent, HostRunResult } from '../evalFrameworkTypes.js';
import {
  inspectReadonlySqliteTrace,
  type ReadonlySqliteTraceDatabase,
} from '../externalHost/sqliteTrace.js';
import type { CodexProfile } from './profile.js';
import { CODEX_DESKTOP_BUILD } from './version.js';

export { CODEX_DESKTOP_BUILD } from './version.js';
const CODEX_STATE_DATABASE = 'state_5.sqlite';
const CODEX_HISTORY_DATABASE = 'thread_history_1.sqlite';
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const MAX_ROWS = 4096;
const NATIVE_FORMAT = 'codex-desktop-sqlite-v1';
const QUALIFIED =
  'Codex desktop native SQLite evidence is correlated and complete.';

export interface CodexNativeRequest {
  profileId: string;
  appVersion: string;
  workspace: string;
  promptSha256: string;
  servers: string[];
}

interface CodexNativeEvidenceBase {
  reason: string;
  profileId: string;
  appVersion: string;
  promptSha256: string;
}

export interface QualifiedCodexNativeEvidence extends CodexNativeEvidenceBase {
  qualification: 'qualified';
  sessionId: string;
  workspace: string;
  terminal: true;
  trace: HostRunResult;
}

export interface UnqualifiedCodexNativeEvidence extends CodexNativeEvidenceBase {
  qualification: 'unqualified';
  sessionId?: never;
  workspace?: never;
  terminal: false;
  trace?: never;
}

export type CodexNativeEvidence =
  | QualifiedCodexNativeEvidence
  | UnqualifiedCodexNativeEvidence;

export interface CodexNativeBaseline {
  profileId: string;
  appVersion: string;
  root: string;
  workspace: string;
  threadIds: string[];
  capturedAt: string;
}

export interface CodexNativeCollection {
  evidence: CodexNativeEvidence;
  database: {
    format: typeof NATIVE_FORMAT;
    state: typeof CODEX_STATE_DATABASE;
    history: typeof CODEX_HISTORY_DATABASE;
  };
}

interface StateThread {
  id: unknown;
  rollout_path: unknown;
  created_at_ms: unknown;
  updated_at_ms: unknown;
  source: unknown;
  thread_source: unknown;
  cwd: unknown;
  has_user_event: unknown;
}

interface TurnRow {
  thread_id: unknown;
  turn_id: unknown;
  rollout_ordinal: unknown;
  status: unknown;
  first_user_item_id: unknown;
  final_agent_item_id: unknown;
  rollout_end_ordinal: unknown;
}

interface ItemRow {
  thread_id: unknown;
  turn_id: unknown;
  item_id: unknown;
  rollout_ordinal: unknown;
  item_json: unknown;
  item_type: unknown;
}

type SqlValue = string | number | bigint | Uint8Array | null;
type ReadOnlyDatabase = ReadonlySqliteTraceDatabase;

/** Capture only new thread IDs for the owned workspace, before opening a chat. */
export async function baselineCodexNativeState(
  profile: CodexProfile,
  workspace: string,
  appVersion = CODEX_DESKTOP_BUILD
): Promise<CodexNativeBaseline> {
  assertRequestIdentity(profile.id, appVersion, workspace, '');
  return inspectReadonlySqliteTrace(codexTraceSource(profile), (snapshot) => {
    const state = snapshot.database('state');
    verifyStateSchema(state);
    const threads = readStateThreads(state, workspace);
    return {
      profileId: profile.id,
      appVersion,
      root: profile.paths.codex,
      workspace,
      threadIds: threads.map((thread) => stringValue(thread.id, 'thread ID')),
      capturedAt: new Date().toISOString(),
    };
  });
}

export async function collectCodexNativeEvidence(
  profile: CodexProfile,
  baseline: CodexNativeBaseline,
  request: CodexNativeRequest
): Promise<CodexNativeCollection> {
  const database = {
    format: NATIVE_FORMAT,
    state: CODEX_STATE_DATABASE,
    history: CODEX_HISTORY_DATABASE,
  } as const;
  try {
    assertRequestIdentity(
      request.profileId,
      request.appVersion,
      request.workspace,
      request.promptSha256
    );
    if (
      baseline.profileId !== profile.id ||
      baseline.appVersion !== request.appVersion ||
      baseline.root !== profile.paths.codex ||
      baseline.workspace !== request.workspace
    )
      throw new Error('Native baseline/profile/request mismatch.');
    if (request.appVersion !== CODEX_DESKTOP_BUILD)
      throw new Error('Unsupported Codex desktop build.');

    return await inspectReadonlySqliteTrace(
      codexTraceSource(profile),
      (snapshot) => {
        const state = snapshot.database('state');
        const history = snapshot.database('history');
        verifyStateSchema(state);
        verifyHistorySchema(history);
        const baselineIds = new Set(baseline.threadIds);
        const candidates = readStateThreads(state, request.workspace).filter(
          (thread) => !baselineIds.has(stringValue(thread.id, 'thread ID'))
        );
        if (candidates.length !== 1)
          return {
            evidence: rejected(
              request,
              candidates.length === 0
                ? 'No new native SQLite thread matches the exact workspace.'
                : 'Multiple new native SQLite threads match the exact workspace.'
            ),
            database,
          };
        const thread = validateStateThread(candidates[0]!, profile, request);
        const evidence = inspectCodexNativeThread(history, thread, request);
        return { evidence, database };
      }
    );
  } catch (error) {
    return {
      evidence: rejected(
        request,
        error instanceof Error
          ? error.message
          : 'Native SQLite evidence failed.'
      ),
      database,
    };
  }
}

function inspectCodexNativeThread(
  history: ReadOnlyDatabase,
  thread: StateThread,
  request: CodexNativeRequest
): CodexNativeEvidence {
  const threadId = stringValue(thread.id, 'thread ID');
  const turns = rows<TurnRow>(
    history,
    `SELECT thread_id, turn_id, rollout_ordinal, status,
            first_user_item_id, final_agent_item_id, rollout_end_ordinal
       FROM thread_turns
      WHERE thread_id = ?
      ORDER BY rollout_ordinal`,
    [threadId]
  );
  if (turns.length !== 1)
    return rejected(request, 'Native turn count is ambiguous.');
  const turn = turns[0]!;
  const turnId = stringValue(turn.turn_id, 'turn ID');
  if (
    stringValue(turn.thread_id, 'turn thread ID') !== threadId ||
    turn.status !== 'completed' ||
    !Number.isSafeInteger(turn.rollout_ordinal) ||
    !Number.isSafeInteger(turn.rollout_end_ordinal) ||
    Number(turn.rollout_end_ordinal) < Number(turn.rollout_ordinal)
  )
    return rejected(request, 'Native turn is not a complete terminal turn.');

  const items = rows<ItemRow>(
    history,
    `SELECT thread_id, turn_id, item_id, rollout_ordinal, item_json, item_type
       FROM thread_items
      WHERE thread_id = ? AND turn_id = ?
      ORDER BY rollout_ordinal`,
    [threadId, turnId]
  );
  if (items.length === 0 || items.length > MAX_ROWS)
    return rejected(request, 'Native thread item count is invalid.');
  if (
    items.some((item) => item.thread_id !== threadId || item.turn_id !== turnId)
  )
    return rejected(request, 'Native item thread provenance is invalid.');

  const parsed = items.map((item) => parseItem(item));
  const itemIds = new Set<string>();
  const itemOrdinals = new Set<number>();
  const turnStart = Number(turn.rollout_ordinal);
  const turnEnd = Number(turn.rollout_end_ordinal);
  for (const [index, item] of parsed.entries()) {
    if (itemIds.has(item.id) || itemOrdinals.has(item.ordinal))
      return rejected(request, 'Native item identity is ambiguous.');
    itemIds.add(item.id);
    itemOrdinals.add(item.ordinal);
    if (item.ordinal < turnStart || item.ordinal > turnEnd)
      return rejected(request, 'Native item lies outside its turn bounds.');
    if (index > 0 && parsed[index - 1]!.ordinal >= item.ordinal)
      return rejected(request, 'Native item row order is not strict.');
  }
  const users = parsed.filter((item) => item.kind === 'user');
  const assistants = parsed.filter((item) => item.kind === 'assistant');
  const finals = assistants.filter((item) => item.phase === 'final_answer');
  const calls = parsed.filter((item) => item.kind === 'mcp');
  if (
    assistants.some(
      (item) => item.phase !== 'commentary' && item.phase !== 'final_answer'
    ) ||
    users.length !== 1 ||
    finals.length !== 1 ||
    calls.length === 0
  )
    return rejected(
      request,
      'Native user, tool, or terminal item count is invalid.'
    );
  const user = users[0]!;
  const final = finals[0]!;
  if (
    typeof turn.first_user_item_id !== 'string' ||
    turn.first_user_item_id !== user.id ||
    typeof turn.final_agent_item_id !== 'string' ||
    turn.final_agent_item_id !== final.id ||
    final.ordinal !== Math.max(...parsed.map((item) => item.ordinal)) ||
    calls.some(
      (call) => user.ordinal >= call.ordinal || call.ordinal >= final.ordinal
    )
  )
    return rejected(request, 'Native terminal item provenance is ambiguous.');
  if (!matchesPromptHash(user.text, request.promptSha256))
    return rejected(
      request,
      'Native user message does not match the exact prompt hash.'
    );

  const events: HostEvent[] = [];
  for (const call of calls.sort(
    (left, right) => left.ordinal - right.ordinal
  )) {
    if (!request.servers.includes(call.server))
      return rejected(
        request,
        'Native MCP server provenance is not allowlisted.'
      );
    const hasResult = call.result !== undefined && call.result !== null;
    const hasError = call.error !== undefined && call.error !== null;
    if (hasResult === hasError)
      return rejected(
        request,
        'Native MCP call lacks an exclusive result or error.'
      );
    if (hasResult) {
      const normalizedResult = normalizeNativeToolResult(
        call.result,
        call.status === 'failed'
      );
      const result = CallToolResultSchema.safeParse(normalizedResult);
      if (
        !result.success ||
        (result.data.isError === true
          ? call.status !== 'failed'
          : call.status !== 'completed')
      )
        return rejected(request, 'Native MCP result is invalid.');
      events.push({
        kind: 'tool_call',
        source: 'mcp',
        server: call.server,
        name: call.tool,
        arguments: call.arguments,
        output: JSON.stringify(normalizedResult),
        id: call.id,
      });
    } else {
      if (call.status !== 'failed')
        return rejected(request, 'Native MCP error status is invalid.');
      events.push({
        kind: 'tool_call',
        source: 'mcp',
        server: call.server,
        name: call.tool,
        arguments: call.arguments,
        error: JSON.stringify(call.error),
        id: call.id,
      });
    }
  }

  return {
    qualification: 'qualified',
    reason: QUALIFIED,
    profileId: request.profileId,
    appVersion: request.appVersion,
    sessionId: thread.id as string,
    workspace: request.workspace,
    promptSha256: request.promptSha256,
    terminal: true,
    trace: {
      finalText: final.text,
      events,
    },
  };
}

interface ParsedUser {
  kind: 'user';
  id: string;
  ordinal: number;
  text: string;
}
interface ParsedAssistant {
  kind: 'assistant';
  id: string;
  ordinal: number;
  text: string;
  phase: string;
}
interface ParsedMcp {
  kind: 'mcp';
  id: string;
  ordinal: number;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: string;
  result: unknown;
  error: unknown;
}
type ParsedItem =
  | ParsedUser
  | ParsedAssistant
  | ParsedMcp
  | { kind: 'reasoning'; id: string; ordinal: number };

function parseItem(row: ItemRow): ParsedItem {
  const ordinal = integerValue(row.rollout_ordinal, 'item ordinal');
  const id = stringValue(row.item_id, 'item ID');
  const itemType = stringValue(row.item_type, 'item type');
  const item = parseRecord(row.item_json, 'native item JSON');
  if (itemType === 'reasoning') return { kind: 'reasoning', id, ordinal };
  if (itemType === 'userMessage') {
    const content = item.content;
    if (!Array.isArray(content) || content.length !== 1)
      throw new Error('Native user content is invalid.');
    const part = recordValue(content[0], 'native user content');
    if (part.type !== 'text' || typeof part.text !== 'string')
      throw new Error('Native user text is invalid.');
    return { kind: 'user', id, ordinal, text: part.text };
  }
  if (itemType === 'agentMessage') {
    if (typeof item.text !== 'string' || typeof item.phase !== 'string')
      throw new Error('Native assistant message is invalid.');
    return {
      kind: 'assistant',
      id,
      ordinal,
      text: item.text,
      phase: item.phase,
    };
  }
  if (itemType === 'mcpToolCall') {
    if (
      typeof item.server !== 'string' ||
      typeof item.tool !== 'string' ||
      typeof item.status !== 'string'
    )
      throw new Error('Native MCP identity is invalid.');
    return {
      kind: 'mcp',
      id,
      ordinal,
      server: item.server,
      tool: item.tool,
      arguments: recordValue(item.arguments, 'native MCP arguments'),
      status: item.status,
      result: item.result,
      error: item.error,
    };
  }
  throw new Error('Unsupported native thread item type.');
}

function matchesPromptHash(text: string, expected: string): boolean {
  if (sha256(text) === expected) return true;
  // Build 26.903.71938 persists markdown escapes and one editor newline.
  const escapedUnderscore = `${String.fromCharCode(92)}_`;
  const decoded = text.replaceAll(escapedUnderscore, '_');
  const normalized = decoded.endsWith('\n') ? decoded.slice(0, -1) : decoded;
  return sha256(normalized) === expected;
}

function normalizeNativeToolResult(
  value: unknown,
  inferredIsError = false
): unknown {
  if (!isRecord(value)) return value;
  const normalized = { ...value };
  if ('_meta' in normalized && normalized._meta === null)
    delete normalized._meta;
  if (!('isError' in normalized)) normalized.isError = inferredIsError;
  return normalized;
}

export interface NativeToolResultWitness {
  server: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** Compare complete native result/error payloads with independent wire evidence. */
export function assertCodexNativeToolResults(
  events: HostEvent[],
  witnesses: NativeToolResultWitness[]
): void {
  if (events.length !== witnesses.length)
    throw new Error('Native/ledger result count mismatch.');
  for (const [index, witness] of witnesses.entries()) {
    const event = events[index]!;
    if (
      event.kind !== 'tool_call' ||
      event.source !== 'mcp' ||
      event.server !== witness.server ||
      event.name !== witness.name ||
      !isDeepStrictEqual(event.arguments, witness.arguments)
    )
      throw new Error(
        'Native tool provenance does not match independent ledger.'
      );
    const eventHasOutput = event.output !== undefined;
    const eventHasError = event.error !== undefined;
    const witnessHasResult = witness.result !== undefined;
    const witnessHasError = witness.error !== undefined;
    if (
      eventHasOutput !== witnessHasResult ||
      eventHasError !== witnessHasError
    )
      throw new Error('Native and ledger result/error shapes differ.');
    if (eventHasOutput) {
      const output = parseJson(event.output!, 'native tool result');
      if (!isDeepStrictEqual(output, normalizeNativeToolResult(witness.result)))
        throw new Error(
          'Native tool result does not match independent ledger.'
        );
    } else if (
      !isDeepStrictEqual(
        parseJson(event.error!, 'native tool error'),
        witness.error
      )
    ) {
      throw new Error('Native tool error does not match independent ledger.');
    }
  }
}

function codexTraceSource(profile: CodexProfile) {
  return {
    root: profile.paths.codex,
    databases: [
      {
        name: 'state',
        relativePath: CODEX_STATE_DATABASE,
        sidecars: 'required' as const,
        maxFileBytes: MAX_DATABASE_BYTES,
      },
      {
        name: 'history',
        relativePath: CODEX_HISTORY_DATABASE,
        sidecars: 'required' as const,
        maxFileBytes: MAX_DATABASE_BYTES,
      },
    ],
    maxRows: MAX_ROWS,
  };
}

function verifyStateSchema(database: ReadOnlyDatabase): void {
  const message = 'SQLite trace has an unsupported Codex state SQLite schema.';
  verifyRequiredTables(
    database,
    ['threads', 'thread_sections', 'thread_dynamic_tools'],
    message
  );
  verifyRequiredColumns(
    database,
    'threads',
    [
      'id',
      'rollout_path',
      'created_at_ms',
      'updated_at_ms',
      'source',
      'thread_source',
      'cwd',
      'has_user_event',
    ],
    message
  );
}

function verifyHistorySchema(database: ReadOnlyDatabase): void {
  const message =
    'SQLite trace has an unsupported Codex thread-history SQLite schema.';
  verifyRequiredTables(database, ['thread_turns', 'thread_items'], message);
  verifyRequiredColumns(
    database,
    'thread_turns',
    [
      'thread_id',
      'turn_id',
      'rollout_ordinal',
      'status',
      'first_user_item_id',
      'final_agent_item_id',
      'rollout_end_ordinal',
    ],
    message
  );
  verifyRequiredColumns(
    database,
    'thread_items',
    [
      'thread_id',
      'turn_id',
      'item_id',
      'rollout_ordinal',
      'item_json',
      'item_type',
    ],
    message
  );
}

function verifyRequiredTables(
  database: ReadOnlyDatabase,
  tableNames: string[],
  message: string
): void {
  const required = new Set(tableNames);
  const names = rows<{ name: unknown }>(
    database,
    `SELECT name FROM sqlite_schema WHERE type = 'table'`,
    []
  );
  for (const row of names)
    required.delete(stringValue(row.name, 'schema table'));
  if (required.size > 0) throw new Error(message);
}

function verifyRequiredColumns(
  database: ReadOnlyDatabase,
  tableName: 'threads' | 'thread_turns' | 'thread_items',
  columnNames: string[],
  message: string
): void {
  const required = new Set(columnNames);
  const columns = rows<{ name: unknown }>(
    database,
    `SELECT name FROM pragma_table_info('${tableName}')`,
    []
  );
  for (const row of columns)
    required.delete(stringValue(row.name, 'schema column'));
  if (required.size > 0) throw new Error(message);
}

function readStateThreads(
  database: ReadOnlyDatabase,
  workspace: string
): StateThread[] {
  return rows<StateThread>(
    database,
    `SELECT id, rollout_path, created_at_ms, updated_at_ms, source,
            thread_source, cwd, has_user_event
       FROM threads
      WHERE cwd = ?
      ORDER BY created_at_ms, id
      LIMIT ?`,
    [workspace, MAX_ROWS]
  );
}

function validateStateThread(
  thread: StateThread,
  profile: CodexProfile,
  request: CodexNativeRequest
): StateThread {
  if (
    stringValue(thread.cwd, 'thread cwd') !== request.workspace ||
    stringValue(thread.source, 'thread source') !== 'vscode' ||
    typeof thread.rollout_path !== 'string' ||
    !thread.rollout_path.startsWith(`${profile.paths.codex}/sessions/`)
  )
    throw new Error('Native thread lacks exact desktop provenance.');
  return thread;
}

function assertRequestIdentity(
  profileId: string,
  appVersion: string,
  workspace: string,
  promptSha256: string
): void {
  if (
    !profileId ||
    appVersion !== CODEX_DESKTOP_BUILD ||
    !workspace.startsWith('/') ||
    (promptSha256 !== '' && !/^[a-f0-9]{64}$/.test(promptSha256))
  )
    throw new Error('Invalid or unsupported native evidence request.');
}

function rows<T>(
  database: ReadOnlyDatabase,
  sql: string,
  parameters: SqlValue[]
): T[] {
  return database.rows<T>(sql, parameters, { maxRows: MAX_ROWS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${description} is not an object.`);
  return value;
}

function parseRecord(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error(`${description} is not text.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
  return recordValue(parsed, description);
}

function stringValue(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${description} is invalid.`);
  return value;
}

function integerValue(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`${description} is invalid.`);
  return value;
}

function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rejected(
  request: CodexNativeRequest,
  reason: string
): CodexNativeEvidence {
  return {
    qualification: 'unqualified',
    reason,
    profileId: request.profileId,
    appVersion: request.appVersion,
    promptSha256: request.promptSha256,
    terminal: false,
  };
}
