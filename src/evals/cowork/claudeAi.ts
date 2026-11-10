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
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CoworkDesktop } from './desktop.js';
import type { MCPConfig } from '../../config/mcpConfig.js';
import { bindFirstPartyServers } from './firstParty.js';
import {
  CloudConnectorSnapshotSchema,
  CloudPermissionStateSchema,
  configureCloudConnectors,
  verifyCloudConnectorEvents,
  type CloudConnectorConfig,
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
}

/**
 * Runs inside the signed-in claude.ai page, so the page's own cookies and
 * active organization authorize the request. Plain JavaScript: it is sent as
 * source text.
 */
const PAGE_PROGRAM = `async ({ action, sessionId, limit, pageLimit, maxPages, patch, expected, identity }) => {
  if (location.origin !== 'https://claude.ai') return { status: 'wrong_origin' };
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
    if (!org) return {status:'no_active_organization'};
    const bootstrap = await get('/api/bootstrap');
    if (bootstrap.status !== 200) return {status:bootstrap.status};
    const account = bootstrap.body?.account;
    const state = {accountId:account?.uuid, organizationId:decodeURIComponent(org), permissions:account?.settings?.enabled_mcp_tools ?? {}};
    if (action === 'permissions') return {status:200,state};
    if (action === 'patch-permissions') {
      if (identity.accountId !== state.accountId || identity.organizationId !== state.organizationId) return {status:'account_changed'};
      for (const key of Object.keys(patch)) {
        const current = Object.hasOwn(state.permissions,key) ? state.permissions[key] : null;
        if (current !== expected[key]) return {status:'permissions_changed_concurrently'};
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
    if (!data.length || next === undefined || next === null || String(next) === cursor) break;
    cursor = String(next);
  }
  return { status: 200, events };
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

async function fetchCloudEvents(
  port: number,
  sessionId: string
): Promise<CloudSessionEvent[]> {
  const result = await inClaudePage(port, {
    action: 'events',
    sessionId,
    pageLimit: 200,
    maxPages: 50,
  });
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
  requireOk(result, 'updating connector permissions');
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
      // Prewarming emits a successful zero-turn result for setup messages.
      // It is not completion of the queried prompt, which may still be running.
      if (
        payload.type === 'result' &&
        payload.subtype === 'success' &&
        payload.is_error === false &&
        payload.num_turns === 0 &&
        payload.result === '' &&
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
}): { stop(): Promise<void>; lastError(): string | undefined } {
  const written = new Map<string, number>();
  let stopped = false;
  let error: string | undefined;
  const sync = async () => {
    const sessions = await listCloudSessions(options.port, 10);
    for (const session of sessions) {
      const activity = Date.parse(
        session.last_event_at ?? session.created_at ?? ''
      );
      if (!Number.isFinite(activity) || activity < options.sinceMs - 5_000)
        continue;
      if (!/^cse_[0-9A-Za-z_]+$/.test(session.id)) continue;
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
    }
  };
  const loop = (async () => {
    while (!stopped) {
      try {
        await sync();
        error = undefined;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
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
    lastError: () => error,
  };
}

const APP_PATH = '/Applications/Claude.app';

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
  const dir = join(homedir(), '.mcp-server-tester', 'cowork-claude-ai');
  const journal = join(
    homedir(),
    '.mcp-server-tester',
    'cowork-claude-ai-connectors.json'
  );
  let configuration:
    | Awaited<ReturnType<typeof configureCloudConnectors>>
    | undefined;
  let remoteServerNames: string[] = [];
  let serverLabels: Record<string, string> = {};
  let effectiveConnectors = connectors;
  return {
    dataDirectory: () => dir,
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
      const inspect = async () => {
        const snapshot = await inspectCloudConnectors(port);
        remoteServerNames = snapshot.servers.map((server) => server.nativeName);
        return snapshot;
      };
      configuration = await configureCloudConnectors(
        {
          inspect,
          read: () => readCloudPermissions(port),
          patch: (identity, patch, expected) =>
            patchCloudPermissions(port, identity, patch, expected),
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
            `Preparing ${dir} failed and restoring connector permissions failed; inspect ${journal}.`
          );
        }
        throw error;
      }
      const mirror = mirrorCloudSessions({ port, dir, sinceMs: Date.now() });
      process.stderr.write(
        `[mst:cowork] claude.ai mode: Claude ${version}, reading Cowork sessions through Chrome on port ${port}\n`
      );
      return {
        appPath,
        app: { name: 'Claude', version, source: 'installed' as const },
        async restart() {
          await run('/usr/bin/osascript', [
            '-e',
            'tell application "Claude" to quit',
          ]).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          await run('/usr/bin/open', ['-a', appPath]);
          await new Promise((resolve) => setTimeout(resolve, 8_000));
        },
        async dispose() {
          try {
            await mirror.stop();
          } finally {
            await configuration?.restore();
            configuration = undefined;
          }
        },
      };
    },
    async recover() {
      return undefined;
    },
    ...(base.reset ? { reset: (options) => base.reset!(options) } : {}),
    // Signed in to claude.ai, Claude Desktop opens on Chat with Cowork one
    // tab away, so the planner can spend its actions looking for the
    // composer. Claude's own deep link opens a fresh Cowork task first.
    async submit(query, options) {
      await run('/usr/bin/open', [NEW_COWORK_TASK_URL]);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return base.submit(query, options);
    },
    async validateTranscript(transcript) {
      if (!configuration) return;
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
