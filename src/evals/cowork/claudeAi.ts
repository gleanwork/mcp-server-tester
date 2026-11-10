/**
 * Cowork signed in to claude.ai (first-party, "1P"): Claude Desktop runs each
 * task as a remote `cse_…` session in Anthropic's cloud, and writes no session
 * folder on the host. MST reads those sessions from claude.ai, through a Chrome
 * profile signed in to the same account with a loopback DevTools port, and
 * mirrors each one into a local folder laid out as Cowork's own
 * (`local_<id>.json` and `local_<id>/audit.jsonl`). Binding, HITL checks and
 * trace parsing then run unchanged.
 *
 * Claude Desktop refuses to start with a debugging switch, so MST cannot read
 * through the app's own sign-in.
 */
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CoworkDesktop } from './desktop.js';
import { parseClaudeTranscript } from './transcript.js';
import { describeError } from '../../utils/describeError.js';
import type { MCPConfig } from '../../config/mcpConfig.js';
import { bindFirstPartyServers } from './firstParty.js';
import {
  CloudConnectorSnapshotSchema,
  CloudPermissionStateSchema,
  CloudPermissionWriteNotSentError,
  configureCloudConnectors,
  recoverCloudConnectorSettings,
  verifyCloudConnectorEvents,
  type CloudConnectorConfig,
  type CloudConnectorIO,
  type CloudConnectorTask,
  type CloudPermissionState,
  type PermissionPatch,
} from './claudeAiConnectors.js';

const run = promisify(execFile);

/** Claude Desktop's deep link to a fresh Cowork task. */
const NEW_COWORK_TASK_URL = 'claude://cowork/new';

/** Where Chrome's DevTools listen: `MST_CLAUDE_AI_DEBUG_PORT`, default 9222. */
export function claudeAiDebugPort(
  env: Record<string, string | undefined>
): number {
  const raw = env.MST_CLAUDE_AI_DEBUG_PORT ?? '9222';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`MST_CLAUDE_AI_DEBUG_PORT is not a port: ${raw}`);
  return port;
}

const CLAUDE_AI_SIGN_IN_HELP =
  'Start Chrome with a profile signed in to the claude.ai account Claude Desktop uses: ' +
  '`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=<dir> ' +
  '--remote-debugging-port=<port> --remote-debugging-address=127.0.0.1 https://claude.ai`, sign in, ' +
  'and set MST_CLAUDE_AI_DEBUG_PORT to that port.';

/** A cloud session's record, as `GET /v1/code/sessions` lists it. */
export interface CloudSessionSummary {
  id: string;
  created_at?: string;
  last_event_at?: string;
  title?: string;
}

/** One event of a cloud session; its payload is a Cowork audit event. */
export interface CloudSessionEvent {
  source?: string;
  created_at?: string;
  payload?: Record<string, unknown>;
}

interface PageResult {
  status: number | string;
  body?: unknown;
  sessions?: CloudSessionSummary[];
  events?: CloudSessionEvent[];
  state?: unknown;
  /** Set only by page preflight, before any permission PATCH is dispatched. */
  permissionWrite?: 'not-sent';
}

/**
 * Runs inside the signed-in claude.ai page, so the page's own cookies and
 * active organization authorize the request. Plain JavaScript: it is sent as
 * source text.
 */
const PAGE_PROGRAM = `async ({ action, sessionId, limit, pageLimit, maxPages, patch, expected, identity }) => {
  const preflightRejection = (status) => ({status,...(action === 'patch-permissions' ? {permissionWrite:'not-sent'} : {})});
  if (location.origin !== 'https://claude.ai') return preflightRejection('wrong_origin');
  const org = document.cookie.split(/;\\s*/).find((c) => c.startsWith('lastActiveOrg='))?.slice('lastActiveOrg='.length);
  const headers = {
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'anthropic-client-feature': 'ccr',
    'anthropic-version': '2023-06-01',
  };
  if (org) headers['x-organization-uuid'] = decodeURIComponent(org);
  const get = async (path) => {
    const response = await fetch(path, { headers, credentials: 'include', signal: AbortSignal.timeout(15000) });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  };
  if (action === 'list') {
    const r = await get('/v1/code/sessions?tags=' + encodeURIComponent('product:cowork-remote') + '&limit=' + limit);
    if (r.status !== 200) return { status: r.status };
    return { status: 200, sessions: Array.isArray(r.body?.data) ? r.body.data.map((s) => ({ id: s.id, created_at: s.created_at, last_event_at: s.last_event_at, title: s.title })) : [] };
  }
  if (['permissions', 'connectors', 'patch-permissions'].includes(action)) {
    if (!org) return preflightRejection('no_active_organization');
    const bootstrap = await get('/api/bootstrap');
    if (bootstrap.status !== 200) return preflightRejection(bootstrap.status);
    const account = bootstrap.body?.account;
    const state = {accountId:account?.uuid, organizationId:decodeURIComponent(org), permissions:account?.settings?.enabled_mcp_tools ?? {}};
    if (action === 'permissions') return {status:200,state};
    if (action === 'patch-permissions') {
      if (identity.accountId !== state.accountId || identity.organizationId !== state.organizationId) return preflightRejection('account_changed');
      for (const key of Object.keys(patch)) {
        const current = Object.hasOwn(state.permissions,key) ? state.permissions[key] : null;
        if (current !== expected[key]) return preflightRejection('permissions_changed_concurrently');
      }
      const response = await fetch('/api/account/settings', {method:'PATCH',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({enabled_mcp_tools:patch}),signal:AbortSignal.timeout(15000)});
      return {status:response.status === 202 ? 200 : response.status};
    }
    const inventory = await get('/api/organizations/' + encodeURIComponent(state.organizationId) + '/mcp/remote_servers_with_connection');
    if (inventory.status !== 200 || !Array.isArray(inventory.body)) return {status:inventory.status === 200 ? 'invalid_inventory' : inventory.status};
    const servers = [];
    for (let offset=0; offset<inventory.body.length; offset+=4) {
      const batch = await Promise.all(inventory.body.slice(offset,offset+4).map(async server => {
        const entry = {id:server.uuid,name:server.name,nativeName:server.name.replace(/[^a-zA-Z0-9_-]/g,'_'),...(typeof server.url === 'string' ? {url:server.url} : {}),connectionState:server.connection_state ?? null,tools:[]};
        if (server.connection_state !== 'connected') return entry;
        const response = await get('/api/organizations/' + encodeURIComponent(state.organizationId) + '/mcp/remote_servers/' + encodeURIComponent(server.uuid) + '/tools');
        if (response.status !== 200 || !Array.isArray(response.body?.tools)) return {...entry,toolDiscoveryError:'Tool inventory HTTP ' + response.status};
        entry.tools = response.body.tools.map(tool => ({name:tool.name,enabledKey:tool.enabled_key,approvalKey:tool.always_approved_key,
          ...(typeof tool.annotations?.readOnlyHint === 'boolean' ? {readOnly:tool.annotations.readOnlyHint} : {}),
          maxPermission:tool.effective_max_permission ?? null,defaultPermission:tool.default_user_permission ?? null}));
        return entry;
      }));
      servers.push(...batch);
    }
    return {status:200,state:{...state,servers}};
  }
  const base = '/v1/code/sessions/' + encodeURIComponent(sessionId);
  const events = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ limit: String(pageLimit), sort_order: 'asc' });
    if (cursor !== null) query.set('cursor', cursor);
    const batch = await get(base + '/events?' + query);
    if (batch.status !== 200) return { status: batch.status };
    const data = batch.body?.data;
    if (!Array.isArray(data)) return { status: 'malformed' };
    events.push(...data);
    const next = batch.body.resume_cursor;
    if (!data.length || next === undefined || next === null) return { status: 200, events };
    if (typeof next !== 'string' && typeof next !== 'number') return { status: 'malformed_cursor' };
    if (seen.has(String(next))) return { status: 'cursor_not_advancing' };
    seen.add(String(next));
    cursor = String(next);
  }
  return { status: 'truncated' };
}`;

interface DevtoolsTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface DevtoolsReply {
  id?: number;
  error?: unknown;
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string };
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Evaluates the page program in the claude.ai tab of the Chrome on `port`. */
async function inClaudePage(
  port: number,
  argument: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<PageResult> {
  let targets: DevtoolsTarget[];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    });
    targets = (await response.json()) as DevtoolsTarget[];
  } catch {
    throw new Error(
      `No Chrome is listening on DevTools port ${port}. ${CLAUDE_AI_SIGN_IN_HELP}`
    );
  }
  const page = targets.find(
    (t) => t.type === 'page' && t.url.startsWith('https://claude.ai/')
  );
  const url = page?.webSocketDebuggerUrl;
  if (!url || !/^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url))
    throw new Error(
      `No claude.ai page is open in the Chrome on port ${port}. ${CLAUDE_AI_SIGN_IN_HELP}`
    );
  const socket = new WebSocket(url);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('Chrome DevTools socket failed')),
        { once: true }
      );
    });
    const reply = await new Promise<DevtoolsReply>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('claude.ai request timed out')),
        timeoutMs
      );
      socket.addEventListener('message', (message) => {
        const data = JSON.parse(String(message.data)) as DevtoolsReply;
        if (data.id !== 1) return;
        clearTimeout(timer);
        resolve(data);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `(${PAGE_PROGRAM})(${JSON.stringify(argument)})`,
            awaitPromise: true,
            returnByValue: true,
          },
        })
      );
    });
    if (reply.error || reply.result?.exceptionDetails || !reply.result?.result)
      throw new Error(
        `claude.ai page script failed: ${JSON.stringify(reply.error ?? reply.result?.exceptionDetails?.text ?? 'no result')}`
      );
    return reply.result.result.value as PageResult;
  } finally {
    socket.close();
  }
}

function requireOk(result: PageResult, what: string): void {
  if (result.status === 200) return;
  if (result.status === 401 || result.status === 403)
    throw new Error(
      `claude.ai refused ${what} (HTTP ${result.status}): sign in again. ${CLAUDE_AI_SIGN_IN_HELP}`
    );
  throw new Error(`claude.ai ${what} failed (${result.status}).`);
}

async function listCloudSessions(
  port: number,
  limit = 10
): Promise<CloudSessionSummary[]> {
  const result = await inClaudePage(port, { action: 'list', limit });
  requireOk(result, 'the Cowork session list');
  return result.sessions ?? [];
}

/** Events per page MST asks claude.ai for. */
const EVENT_PAGE_SIZE = 200;
/** Pages MST reads per session: with the page size, a 10,000-event cap. */
const MAX_EVENT_PAGES = 50;

/**
 * Every event of the session, or an error. A session longer than the cap, or
 * a page cursor that is malformed or repeats, fails instead of returning a
 * prefix: a prefix would be recorded as an unfinished task.
 */
async function fetchCloudEvents(
  port: number,
  sessionId: string
): Promise<CloudSessionEvent[]> {
  const result = await inClaudePage(port, {
    action: 'events',
    sessionId,
    pageLimit: EVENT_PAGE_SIZE,
    maxPages: MAX_EVENT_PAGES,
  });
  const cap = (EVENT_PAGE_SIZE * MAX_EVENT_PAGES).toLocaleString('en-US');
  if (result.status === 'truncated')
    throw new Error(
      `claude.ai session ${sessionId} has more events than MST reads (${MAX_EVENT_PAGES} pages of ${EVENT_PAGE_SIZE}, ${cap} events). ` +
        'MST does not record part of a session. Shorten the case so the task stays under the limit.'
    );
  if (
    result.status === 'malformed_cursor' ||
    result.status === 'cursor_not_advancing'
  )
    throw new Error(
      `claude.ai returned a ${result.status === 'malformed_cursor' ? 'malformed' : 'repeated'} event page cursor for session ${sessionId}. ` +
        'MST does not record part of a session. Retry the trial; if it happens again, the claude.ai events API may have changed.'
    );
  if (result.status === 'malformed')
    throw new Error(
      `claude.ai returned an event page without a data array for session ${sessionId}. ` +
        'MST does not record part of a session. Retry the trial; if it happens again, the claude.ai events API may have changed.'
    );
  requireOk(result, `session ${sessionId}`);
  return result.events ?? [];
}

async function readCloudPermissions(
  port: number
): Promise<CloudPermissionState> {
  const result = await inClaudePage(port, { action: 'permissions' });
  requireOk(result, 'reading connector permissions');
  return CloudPermissionStateSchema.parse(result.state);
}

async function inspectCloudConnectors(port: number) {
  const result = await inClaudePage(port, { action: 'connectors' }, 90_000);
  requireOk(result, 'enumerating connectors');
  return CloudConnectorSnapshotSchema.parse(result.state);
}

async function patchCloudPermissions(
  port: number,
  identity: Pick<CloudPermissionState, 'accountId' | 'organizationId'>,
  patch: PermissionPatch,
  expected: PermissionPatch
): Promise<void> {
  const result = await inClaudePage(port, {
    action: 'patch-permissions',
    identity,
    patch,
    expected,
  });
  try {
    requireOk(result, 'updating connector permissions');
  } catch (error) {
    if (result.permissionWrite === 'not-sent')
      throw new CloudPermissionWriteNotSentError(describeError(error));
    throw error;
  }
}

function cloudInitialEvent(
  events: readonly CloudSessionEvent[]
): CloudSessionEvent | undefined {
  return events.find((e) => {
    const p = e.payload;
    return (
      e.source === 'client' &&
      p?.type === 'user' &&
      p.shouldQuery !== false &&
      p.parent_tool_use_id == null &&
      asRecord(e.payload?.message)?.role === 'user'
    );
  });
}

/** The prompt Cowork sent the model: its first client-sent user message. */
export function cloudInitialMessage(
  events: readonly CloudSessionEvent[]
): string | undefined {
  const event = cloudInitialEvent(events);
  const content = asRecord(event?.payload?.message)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map(asRecord)
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item!.text as string)
      .join('\n');
  return undefined;
}

/** A prewarmed VM is not a submitted task. Bind by its first user event. */
export function cloudTrialMetadata(
  session: CloudSessionSummary,
  events: readonly CloudSessionEvent[],
  sinceMs: number
) {
  const first = cloudInitialEvent(events);
  const createdAt = first?.created_at;
  const submittedAt = Date.parse(createdAt ?? '');
  if (!Number.isFinite(submittedAt) || submittedAt < sinceMs - 5_000)
    return undefined;
  const initialMessage = cloudInitialMessage(events);
  if (initialMessage === undefined) return undefined;
  return {
    sessionId: session.id,
    createdAt,
    cloudCreatedAt: session.created_at,
    ...(session.last_event_at ? { lastActivityAt: session.last_event_at } : {}),
    ...(session.title ? { title: session.title } : {}),
    initialMessage,
  };
}

/** Cloud event payloads are audit events; only the receipt time is outside. */
export function cloudAuditLines(events: readonly CloudSessionEvent[]): string {
  const setupMessages = new Set(
    events.flatMap(({ payload }) =>
      payload?.type === 'user' &&
      payload.shouldQuery === false &&
      typeof payload.uuid === 'string'
        ? [payload.uuid]
        : []
    )
  );
  return events
    .flatMap((event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== 'object') return [];
      const messageIds = Array.isArray(payload.user_message_uuids)
        ? payload.user_message_uuids
        : typeof payload.user_message_uuid === 'string'
          ? [payload.user_message_uuid]
          : [];
      // Results for setup messages (including failed warmup) do not complete
      // the queried prompt, which may still be running.
      if (
        payload.type === 'result' &&
        messageIds.length > 0 &&
        messageIds.every(
          (id) => typeof id === 'string' && setupMessages.has(id)
        )
      )
        return [];
      const line =
        !payload.timestamp && typeof event.created_at === 'string'
          ? { ...payload, timestamp: event.created_at }
          : payload;
      return [JSON.stringify(line)];
    })
    .map((line) => `${line}\n`)
    .join('');
}

/** Re-read the persisted exact cloud task, never infer completion from app state. */
async function assertCloudTaskComplete(
  port: number,
  task: CloudConnectorTask
): Promise<void> {
  const sessionId = task.sessionId;
  if (!sessionId || !/^cse_[0-9A-Za-z_]+$/.test(sessionId))
    throw new Error(
      'Cloud task submission is unbound; refusing reset, permission restoration or another task.'
    );
  const events = await fetchCloudEvents(port, sessionId);
  const initial = cloudInitialEvent(events);
  const submittedAt = Date.parse(initial?.created_at ?? '');
  if (
    !initial ||
    !Number.isFinite(submittedAt) ||
    submittedAt < Date.parse(task.startedAt) - 5_000
  )
    throw new Error(
      `Cloud task ${sessionId} has no readable submitted prompt for this attempt; refusing restoration or another task.`
    );
  // A VM's result before submission is not the task's result. Keep setup
  // messages so cloudAuditLines also excludes their later warmup results.
  const first = events.indexOf(initial);
  const taskEvents = events.filter(
    (event, index) => event.payload?.type !== 'result' || index > first
  );
  const dir = await mkdtemp(join(tmpdir(), 'mst-cloud-task-'));
  try {
    await writeFile(join(dir, 'audit.jsonl'), cloudAuditLines(taskEvents), {
      mode: 0o600,
    });
    const transcript = await parseClaudeTranscript({
      id: sessionId,
      sessionDir: dir,
      metadataPath: join(dir, 'metadata.json'),
      metadata: { sessionId },
      statMtimeMs: 0,
    });
    if (!transcript.auditParsed || !transcript.isComplete)
      throw new Error(
        `Cloud task ${sessionId} has no terminal native result; it may still be running. Refusing reset, permission restoration or another task.`
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Copies Cowork sessions whose first user prompt was sent after `sinceMs`
 * into `dir`, every `intervalMs`, until stopped. Cloud VM creation can
 * precede the prompt. Only submitted tasks are mirrored and bound.
 */
function mirrorCloudSessions(options: {
  port: number;
  dir: string;
  sinceMs: number;
  intervalMs?: number;
}): {
  stop(): Promise<void>;
  bindSession(sessionId?: string): void;
  lastError(): string | undefined;
} {
  const written = new Map<string, number>();
  let stopped = false;
  let listError: string | undefined;
  let sessionErrors = new Map<string, string>();
  let boundSession: string | undefined;
  const sync = async () => {
    let sessions: CloudSessionSummary[] = [];
    try {
      sessions = await listCloudSessions(options.port, 10);
      listError = undefined;
    } catch (error) {
      listError = describeError(error);
    }
    // The bound task is read directly even when absent from the list. Listing
    // at most ten others keeps polls bounded; one failed fetch cannot starve
    // a later healthy trial or contaminate the bound task's diagnostics.
    if (boundSession)
      sessions = [
        sessions.find((session) => session.id === boundSession) ?? {
          id: boundSession,
        },
        ...sessions.filter((session) => session.id !== boundSession),
      ];
    const errors = new Map<string, string>();
    for (const session of sessions) {
      const activity = Date.parse(
        session.last_event_at ?? session.created_at ?? ''
      );
      if (
        session.id !== boundSession &&
        (!Number.isFinite(activity) || activity < options.sinceMs - 5_000)
      )
        continue;
      if (!/^cse_[0-9A-Za-z_]+$/.test(session.id)) continue;
      try {
        const events = await fetchCloudEvents(options.port, session.id);
        if (written.get(session.id) === events.length) continue;
        const metadata = cloudTrialMetadata(session, events, options.sinceMs);
        if (!metadata) continue;
        const id = `local_${session.id}`;
        await mkdir(join(options.dir, id), { recursive: true, mode: 0o700 });
        await writeAtomic(
          join(options.dir, id, 'audit.jsonl'),
          cloudAuditLines(events)
        );
        await writeAtomic(
          join(options.dir, `${id}.json`),
          JSON.stringify(metadata)
        );
        written.set(session.id, events.length);
      } catch (error) {
        const message = describeError(error);
        errors.set(
          session.id,
          message.includes(session.id) ? message : `${session.id}: ${message}`
        );
      }
    }
    sessionErrors = errors;
  };
  const loop = (async () => {
    while (!stopped) {
      await sync();
      await new Promise((resolve) =>
        setTimeout(resolve, options.intervalMs ?? 2_000)
      );
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
    },
    bindSession(sessionId) {
      boundSession = sessionId;
    },
    lastError() {
      if (boundSession) return sessionErrors.get(boundSession);
      const errors = [listError, ...sessionErrors.values()].filter(Boolean);
      return errors.length ? errors.join('; ') : undefined;
    },
  };
}

const APP_PATH = '/Applications/Claude.app';

/**
 * Where 1P keeps its mirrored sessions and its connector-permission journal.
 * Preparation and `restoreClaudeAiConnectors` use the same journal.
 */
function claudeAiPaths(): { dir: string; journal: string } {
  const root = join(homedir(), '.mcp-server-tester');
  return {
    dir: join(root, 'cowork-claude-ai'),
    journal: join(root, 'cowork-claude-ai-connectors.json'),
  };
}

/**
 * The account connector permissions a run reads and writes, through the
 * signed-in claude.ai page of the Chrome on `port`.
 */
function cloudConnectorIO(port: () => number): CloudConnectorIO {
  return {
    inspect: () => inspectCloudConnectors(port()),
    read: () => readCloudPermissions(port()),
    patch: (identity, patch, expected) =>
      patchCloudPermissions(port(), identity, patch, expected),
    assertTaskComplete: (task) => assertCloudTaskComplete(port(), task),
  };
}

/**
 * Undoes the connector permission changes an interrupted 1P run left on the
 * claude.ai account, from the run's journal. Returns false when there is no
 * journal, without contacting Chrome.
 *
 * It only puts back MST's own values: it refuses when the signed-in account or
 * organization is not the journal's, keeps any value someone else changed
 * since (and the journal, with an error), and checks that claude.ai kept the
 * restored values before removing the journal. It never sets new permissions,
 * reads connector tool inventories, submits, restarts the app or mirrors
 * sessions.
 *
 * Precondition: the caller holds the shared macOS Cowork desktop lease, the
 * same one a run holds, so no run on this machine is changing the account.
 * The lease does not cover another machine signed in to the same account.
 */
export async function restoreClaudeAiConnectors(
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const io = cloudConnectorIO(() => claudeAiDebugPort(env));
  return recoverCloudConnectorSettings(
    {
      ...io,
      inspect: () =>
        Promise.reject(
          new Error('Restoring connector permissions reads no inventory.')
        ),
    },
    claudeAiPaths().journal
  );
}

async function installedVersion(appPath: string): Promise<string> {
  const { stdout } = await run('/usr/bin/plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    join(appPath, 'Contents', 'Info.plist'),
  ]);
  return stdout.trim();
}

/**
 * The 1P desktop: Claude Desktop as it is, signed in to claude.ai. MST
 * installs no profile, servers or credential; the variant is the account's
 * connectors. Submission, HITL and reset are macOS Computer Use, unchanged.
 */
export function coworkClaudeAi(
  base: CoworkDesktop,
  firstParty: {
    servers: readonly MCPConfig[];
    connectors?: CloudConnectorConfig;
    writes?: Readonly<Record<string, 'unguarded' | 'live'>>;
  }
): CoworkDesktop {
  const connectors = firstParty.connectors;
  const { dir, journal } = claudeAiPaths();
  let configuration:
    | Awaited<ReturnType<typeof configureCloudConnectors>>
    | undefined;
  let remoteServerNames: string[] = [];
  let serverLabels: Record<string, string> = {};
  let effectiveConnectors = connectors;
  let mirror: ReturnType<typeof mirrorCloudSessions> | undefined;
  let submittedPrompt: string | undefined;
  async function dispose(): Promise<void> {
    await mirror?.stop();
    if (configuration) {
      // restore re-reads the persisted task and refuses unfinished/unbound work.
      await configuration.restore();
      configuration = undefined;
      submittedPrompt = undefined;
      return;
    }
    // prepare can fail before it returns a session, including a transaction
    // whose rollback failed. Its journal still requires the shared lease.
    try {
      await readFile(journal, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new Error(
      `Cowork preparation left connector recovery state at ${journal}; refusing to release the desktop lease. Restore connector settings before another run.`
    );
  }
  return {
    dataDirectory: () => dir,
    dispose,
    mcpServerNames: () => remoteServerNames,
    mcpServerLabels: () => serverLabels,
    async prepare({ env }) {
      if (process.platform !== 'darwin')
        throw new Error('Cowork signed in to claude.ai runs on macOS only.');
      const port = claudeAiDebugPort(env);
      // Fails with the sign-in instructions when claude.ai can't be read.
      await listCloudSessions(port, 1);
      const appPath = env.MST_COWORK_APP_PATH ?? APP_PATH;
      const version = await installedVersion(appPath);
      // The desktop lease also serializes connector changes on this machine.
      // A shared account must not run on another machine at the same time.
      const io = cloudConnectorIO(() => port);
      configuration = await configureCloudConnectors(
        {
          ...io,
          async inspect() {
            const snapshot = await io.inspect();
            remoteServerNames = snapshot.servers.map(
              (server) => server.nativeName
            );
            return snapshot;
          },
        },
        (snapshot) => {
          const binding = bindFirstPartyServers(
            snapshot,
            firstParty.servers,
            connectors,
            firstParty.writes
          );
          serverLabels = binding.labels;
          effectiveConnectors = binding.config;
          return binding.config;
        },
        journal
      );
      try {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true, mode: 0o700 });
      } catch (error) {
        // The session never started: drop its plan, and keep both errors.
        const prepared = configuration;
        configuration = undefined;
        try {
          await prepared.restore();
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Preparing ${dir} failed (${describeError(error)}) and restoring connector permissions failed (${describeError(restoreError)}); inspect ${journal}.`
          );
        }
        throw error;
      }
      mirror = mirrorCloudSessions({ port, dir, sinceMs: Date.now() });
      const recorder = mirror;
      process.stderr.write(
        `[mst:cowork] claude.ai mode: Claude ${version}, reading Cowork sessions through Chrome on port ${port}\n`
      );
      return {
        appPath,
        app: { name: 'Claude', version, source: 'installed' as const },
        recordingError: () => recorder.lastError(),
        async restart() {
          await configuration?.confirmTaskComplete();
          await run('/usr/bin/osascript', [
            '-e',
            'tell application "Claude" to quit',
          ]).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          await run('/usr/bin/open', ['-a', appPath]);
          await new Promise((resolve) => setTimeout(resolve, 8_000));
        },
        dispose,
      };
    },
    async recover() {
      return undefined;
    },
    ...(base.reset
      ? {
          async reset(options) {
            await configuration?.confirmTaskComplete();
            await base.reset!(options);
          },
        }
      : {}),
    // Signed in to claude.ai, Claude Desktop opens on Chat with Cowork one
    // tab away, so the planner can spend its actions looking for the
    // composer. Claude's own deep link opens a fresh Cowork task first.
    async submit(query, options) {
      if (!configuration)
        throw new Error(
          'Prepare the cloud connector transaction before submitting.'
        );
      await configuration.confirmTaskComplete();
      // Record intent before any UI action that might create a cloud task.
      // Even a rejected/timed-out submit stays unbound until proven otherwise.
      await configuration.beginTask();
      submittedPrompt = query;
      mirror?.bindSession(undefined);
      await run('/usr/bin/open', [NEW_COWORK_TASK_URL]);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return base.submit(query, options);
    },
    async bindSession(transcript) {
      const sessionId = transcript.candidate.metadata.sessionId;
      if (
        !configuration ||
        submittedPrompt === undefined ||
        transcript.binding?.kind !== 'exact-initial-prompt' ||
        transcript.candidate.metadata.initialMessage !== submittedPrompt ||
        !sessionId ||
        !/^cse_[0-9A-Za-z_]+$/.test(sessionId)
      )
        throw new Error(
          'Cloud task did not bind an exact submitted prompt and session ID; refusing to guess its identity.'
        );
      await configuration.bindTask(sessionId);
      mirror?.bindSession(sessionId);
    },
    async validateTranscript(transcript) {
      if (!configuration) return;
      // Task liveness and policy validity are independent. Clear a proven
      // terminal task before policy checks that may reject its evidence.
      await configuration.confirmTaskComplete();
      const receipt = {
        requested: connectors,
        mode: 'first-party',
        serverLabels,
        effective: effectiveConnectors,
        expectedAllowedTools: configuration.plan.allowedTools,
        expectedBlockedTools: configuration.plan.blockedTools,
        automaticHitlEnabled: !configuration.plan.failOnApproval,
      };
      const save = (result: Record<string, unknown>) =>
        writeFile(
          join(transcript.candidate.sessionDir, 'connector-policy.json'),
          JSON.stringify({ ...receipt, ...result }, null, 2),
          { mode: 0o600 }
        );
      let settingsVerified = false;
      try {
        await configuration.verify();
        settingsVerified = true;
        const audit = await readFile(
          join(transcript.candidate.sessionDir, 'audit.jsonl'),
          'utf8'
        );
        const events = audit
          .split('\n')
          .filter(Boolean)
          .map((line) => ({
            payload: JSON.parse(line) as Record<string, unknown>,
          }));
        const result = verifyCloudConnectorEvents(configuration.plan, events);
        await save({ ...result, settingsVerified, verification: 'passed' });
      } catch (error) {
        await save({
          settingsVerified,
          verification: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    // Approvals go to automatic HITL only inside a prepared session whose
    // policy asks for them; anything else fails closed.
    handleHitl: (options) =>
      !configuration || configuration.plan.failOnApproval
        ? Promise.resolve({ status: 'hitl_checked' as const, action_count: 0 })
        : base.handleHitl(options),
  };
}
