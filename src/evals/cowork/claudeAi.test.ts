import type * as ChildProcess from 'node:child_process';
import type * as FsPromises from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type * as Os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpMCPConfig } from '../../config/mcpConfig.js';
import type {
  CloudConnectorConfig,
  CloudConnectorTask,
} from './claudeAiConnectors.js';
import {
  claudeAiDebugPort,
  cloudAuditLines,
  cloudInitialMessage,
  cloudTrialMetadata,
  coworkClaudeAi,
  restoreClaudeAiConnectors,
} from './claudeAi.js';
import type { CoworkDesktop } from './desktop.js';
import { findMatchingClaudeSessions } from './sessions.js';
import type { ClaudeTranscript } from './transcript.js';

/**
 * Offline. The machine's boundaries are replaced: system commands
 * (`plutil`, `open`, `osascript`), the home directory (a temp dir), filesystem
 * faults on request, Chrome's DevTools HTTP endpoint and socket, and the
 * claude.ai API the page calls. The adapter's own page program runs unchanged
 * in a synthetic claude.ai page. No real account, browser or app is touched.
 */
const host = vi.hoisted(() => ({
  home: '',
  commands: [] as Array<{ file: string; args: string[] }>,
  /** `<operation> <absolute path>`: the error that operation fails with. */
  faults: new Map<string, NodeJS.ErrnoException>(),
  /** `<file> <args joined by spaces>`: the error that command fails with. */
  commandFaults: new Map<string, Error>(),
}));

vi.mock('node:os', async (original) => {
  const actual = await original<typeof Os>();
  const homedir = () => {
    if (!host.home) throw new Error('The test home directory is not set.');
    return host.home;
  };
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  const faulty =
    (operation: 'rm' | 'mkdir' | 'writeFile') =>
    (path: unknown, ...rest: unknown[]) => {
      const fault = host.faults.get(`${operation} ${String(path)}`);
      if (fault) return Promise.reject(fault);
      return (actual[operation] as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest
      );
    };
  return {
    ...actual,
    rm: faulty('rm'),
    mkdir: faulty('mkdir'),
    writeFile: faulty('writeFile'),
  };
});

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], ...rest: unknown[]) => {
      const callback = rest.at(-1) as (
        error: Error | null,
        result?: { stdout: string; stderr: string }
      ) => void;
      host.commands.push({ file, args });
      const stdout = file === '/usr/bin/plutil' ? '1.2.3\n' : '';
      const fault = host.commandFaults.get(`${file} ${args.join(' ')}`);
      setImmediate(() =>
        fault ? callback(fault) : callback(null, { stdout, stderr: '' })
      );
      return {};
    }),
  };
});

describe('claude.ai session adapter', () => {
  it('validates the local Chrome debug port', () => {
    expect(claudeAiDebugPort({})).toBe(9222);
    expect(claudeAiDebugPort({ MST_CLAUDE_AI_DEBUG_PORT: '9334' })).toBe(9334);
    for (const value of ['0', '-1', '65536', 'abc', '1.5']) {
      expect(() =>
        claudeAiDebugPort({ MST_CLAUDE_AI_DEBUG_PORT: value })
      ).toThrow();
    }
  });

  it('binds only to the initial client prompt, not a tool result or subagent', () => {
    expect(
      cloudInitialMessage([
        {
          source: 'server',
          payload: {
            type: 'user',
            message: { role: 'user', content: 'not the prompt' },
          },
        },
        {
          source: 'client',
          payload: {
            type: 'user',
            shouldQuery: false,
            message: { role: 'user', content: 'tool response' },
          },
        },
        {
          source: 'client',
          payload: {
            type: 'user',
            parent_tool_use_id: 'child',
            message: { role: 'user', content: 'child prompt' },
          },
        },
        {
          source: 'client',
          payload: {
            type: 'user',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'exact' },
                { type: 'image' },
                { type: 'text', text: 'prompt' },
              ],
            },
          },
        },
      ])
    ).toBe('exact\nprompt');
    expect(cloudInitialMessage([])).toBeUndefined();
  });

  it('binds a prewarmed session by its first submitted prompt, not VM creation time', () => {
    const session = {
      id: 'cse_draft',
      created_at: '2026-11-09T19:15:15Z',
      last_event_at: '2026-11-09T19:18:43Z',
    };
    const events = [
      {
        source: 'client',
        created_at: '2026-11-09T19:18:36Z',
        payload: {
          type: 'user',
          message: { role: 'user', content: 'smoke prompt' },
        },
      },
    ];
    expect(
      cloudTrialMetadata(session, events, Date.parse('2026-11-09T19:17:43Z'))
    ).toMatchObject({
      sessionId: 'cse_draft',
      cloudCreatedAt: '2026-11-09T19:15:15Z',
      createdAt: '2026-11-09T19:18:36Z',
      initialMessage: 'smoke prompt',
    });
    // An old conversation must not become a new trial because it was updated.
    expect(
      cloudTrialMetadata(session, events, Date.parse('2026-11-09T19:20:00Z'))
    ).toBeUndefined();
    expect(
      cloudTrialMetadata(session, [], Date.parse('2026-11-09T19:17:43Z'))
    ).toBeUndefined();
    expect(
      cloudTrialMetadata(
        session,
        [{ ...events[0], created_at: undefined }],
        Date.parse('2026-11-09T19:17:43Z')
      )
    ).toBeUndefined();
  });

  it('does not treat setup-only results as completion of the submitted prompt', () => {
    const setup = {
      source: 'client',
      payload: {
        type: 'user',
        uuid: 'setup',
        shouldQuery: false,
        message: { role: 'user', content: 'setup context' },
      },
    };
    const prompt = {
      source: 'client',
      payload: {
        type: 'user',
        uuid: 'prompt',
        message: { role: 'user', content: 'smoke prompt' },
      },
    };
    const warmup = {
      payload: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 0,
        result: '',
        user_message_uuids: ['setup'],
      },
    };
    const completion = {
      payload: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        result: 'MST_1P_SMOKE_OK',
        user_message_uuids: ['prompt'],
      },
    };
    const results = (events: Parameters<typeof cloudAuditLines>[0]) =>
      cloudAuditLines(events)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === 'result');
    expect(results([setup, prompt, warmup])).toEqual([]);
    expect(results([setup, prompt, warmup, completion])).toEqual([
      completion.payload,
    ]);
    const failure = {
      payload: {
        ...warmup.payload,
        is_error: true,
        subtype: 'error_during_execution',
      },
    };
    expect(results([setup, prompt, failure])).toEqual([]);
    const mixed = {
      payload: { ...warmup.payload, user_message_uuids: ['setup', 'prompt'] },
    };
    expect(results([setup, prompt, mixed])).toEqual([mixed.payload]);
    // Do not discard an uncorrelated result merely because it is empty.
    expect(results([warmup])).toEqual([warmup.payload]);
  });

  it('preserves audit payloads and uses the cloud receipt time only as a fallback', () => {
    const rows = cloudAuditLines([
      {
        created_at: '2026-11-09T00:00:00Z',
        payload: {
          type: 'assistant',
          message: { role: 'assistant', content: 'MST_1P_SMOKE_OK' },
        },
      },
      {
        created_at: 'later',
        payload: {
          type: 'result',
          timestamp: 'original',
          total_cost_usd: 0.01,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      { created_at: 'ignored' },
    ])
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      timestamp: '2026-11-09T00:00:00Z',
      message: { content: 'MST_1P_SMOKE_OK' },
    });
    expect(rows[1]).toMatchObject({
      timestamp: 'original',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });
});

// ---------------------------------------------------------------------------
// The lifecycle, through coworkClaudeAi's own contract.

const PORT = 9333;
const PROMPT = 'Find the Acme launch plan';
const SERVER: HttpMCPConfig = {
  transport: 'http',
  label: 'acme',
  serverUrl: 'https://mcp.acme.test/mcp',
};

interface AccountTool {
  name: string;
  enabled_key: string;
  always_approved_key: string;
  annotations?: { readOnlyHint?: boolean };
  effective_max_permission?: string | null;
}
interface AccountServer {
  uuid: string;
  name: string;
  url?: string;
  connection_state: string;
  tools?: AccountTool[];
  /** The tool inventory's HTTP status; 200 when unset. */
  toolsStatus?: number;
}
interface CloudEvent {
  source?: string;
  created_at: string;
  payload: Record<string, unknown>;
}
interface CloudSession {
  id: string;
  created_at: string;
  last_event_at?: string;
  events: CloudEvent[];
}
interface PageRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  credentials?: string;
  body?: unknown;
}

function tool(server: string, name: string, readOnly?: boolean): AccountTool {
  return {
    name,
    enabled_key: `${server}:${name}`,
    always_approved_key: `${server}:${name}:always`,
    ...(readOnly === undefined
      ? {}
      : { annotations: { readOnlyHint: readOnly } }),
  };
}

/** A claude.ai account as its web API answers the signed-in page. */
class ClaudeAccount {
  origin = 'https://claude.ai';
  cookie = 'theme=dark; lastActiveOrg=org-acme';
  accountId = 'account-acme';
  listStatus = 200;
  eventsStatus = 200;
  eventsStatusBySession = new Map<string, number>();
  bootstrapStatus = 200;
  /** Replaces fields of an event page: a server whose paging misbehaves. */
  eventPage?: (start: number, end: number) => Record<string, unknown>;
  patchStatus = 202;
  /** Runs after a PATCH is applied: another tab or person editing the account. */
  afterPatch?: () => void;
  requests: PageRequest[] = [];
  beforeRequest?: (request: PageRequest) => void;
  sessions: CloudSession[] = [];
  eventPageSize = 2;
  permissions: Record<string, boolean> = {
    'srv-search:search': false,
    'srv-mail:send_mail': true,
    'srv-mail:send_mail:always': true,
    'srv-wiki:stale_tool': true,
    'srv-archive:legacy': true,
    'unmanaged:tool': true,
  };
  readonly original = structuredClone(this.permissions);
  servers: AccountServer[] = [
    {
      uuid: 'srv-search',
      name: 'Acme Search',
      url: 'https://mcp.acme.test/mcp',
      connection_state: 'connected',
      tools: [
        tool('srv-search', 'search', true),
        tool('srv-search', 'create_doc', false),
      ],
    },
    {
      uuid: 'srv-mail',
      name: 'Acme Mail',
      url: 'https://mail.acme.test/mcp',
      connection_state: 'connected',
      tools: [tool('srv-mail', 'send_mail', false)],
    },
    {
      uuid: 'srv-wiki',
      name: 'Acme Wiki',
      url: 'https://wiki.acme.test/mcp',
      connection_state: 'connected',
      // Its tool was removed; the account still holds the old key.
      tools: [],
    },
    {
      uuid: 'srv-archive',
      name: 'Acme Archive',
      url: 'https://archive.acme.test/mcp',
      connection_state: 'disconnected',
    },
    {
      uuid: 'srv-calendar',
      name: 'Acme Calendar',
      url: 'https://calendar.acme.test/mcp',
      connection_state: 'connected',
      tools: [tool('srv-calendar', 'list_events')],
    },
  ];

  patches(): unknown[] {
    return this.requests
      .filter((request) => request.method === 'PATCH')
      .map((request) => request.body);
  }

  async handle(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      credentials?: string;
      body?: string;
    }
  ): Promise<Response> {
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    this.requests.push({
      method,
      path,
      headers: init.headers ?? {},
      credentials: init.credentials,
      ...(body === undefined ? {} : { body }),
    });
    this.beforeRequest?.(this.requests.at(-1)!);
    const url = new URL(path, 'https://claude.ai');
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (method === 'PATCH' && url.pathname === '/api/account/settings') {
      if (this.patchStatus !== 202) return json({}, this.patchStatus);
      const patch = (body as { enabled_mcp_tools: Record<string, unknown> })
        .enabled_mcp_tools;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete this.permissions[key];
        else this.permissions[key] = value as boolean;
      }
      this.afterPatch?.();
      return json({}, 202);
    }
    if (url.pathname === '/v1/code/sessions') {
      if (this.listStatus !== 200) return json({}, this.listStatus);
      const limit = Number(url.searchParams.get('limit'));
      return json({
        data: this.sessions.slice(0, limit).map(({ events: _, ...s }) => s),
      });
    }
    const events = /^\/v1\/code\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (events) {
      const session = this.sessions.find(
        (s) => s.id === decodeURIComponent(events[1]!)
      );
      if (!session) return json({}, 404);
      const status =
        this.eventsStatusBySession.get(session.id) ?? this.eventsStatus;
      if (status !== 200) return json({}, status);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const end =
        start +
        Math.min(this.eventPageSize, Number(url.searchParams.get('limit')));
      return json({
        data: session.events.slice(start, end),
        resume_cursor: end < session.events.length ? end : null,
        ...this.eventPage?.(start, end),
      });
    }
    if (url.pathname === '/api/bootstrap')
      return json(
        {
          account: {
            uuid: this.accountId,
            settings: { enabled_mcp_tools: structuredClone(this.permissions) },
          },
        },
        this.bootstrapStatus
      );
    const org = '/api/organizations/org-acme/mcp/';
    if (url.pathname === `${org}remote_servers_with_connection`)
      return json(
        this.servers.map(({ tools: _, toolsStatus: __, ...server }) => server)
      );
    const tools = new RegExp(`^${org}remote_servers/([^/]+)/tools$`).exec(
      url.pathname
    );
    const server = this.servers.find((s) => s.uuid === tools?.[1]);
    if (server)
      return server.toolsStatus && server.toolsStatus !== 200
        ? json({}, server.toolsStatus)
        : json({ tools: server.tools ?? [] });
    return json({ error: `unexpected ${method} ${path}` }, 404);
  }
}

/** Chrome's side of DevTools: its target list and each page socket. */
const devtools = {
  account: new ClaudeAccount(),
  listening: true,
  targets: [] as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }>,
  sockets: [] as string[],
};

/** Evaluates `Runtime.evaluate` expressions in a synthetic claude.ai page. */
class FakeDevtoolsSocket {
  private readonly listeners = new Map<
    string,
    Array<(event: { data?: unknown }) => void>
  >();
  constructor(readonly url: string) {
    devtools.sockets.push(url);
    setImmediate(() => this.emit('open', {}));
  }
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void
  ) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    const message = JSON.parse(data) as {
      id: number;
      method: string;
      params: {
        expression: string;
        awaitPromise: boolean;
        returnByValue: boolean;
      };
    };
    expect(message.method).toBe('Runtime.evaluate');
    expect(message.params).toMatchObject({
      awaitPromise: true,
      returnByValue: true,
    });
    void this.evaluate(message.params.expression).then((reply) =>
      this.emit('message', {
        data: JSON.stringify({ id: message.id, ...reply }),
      })
    );
  }
  close() {}
  private async evaluate(expression: string) {
    const account = devtools.account;
    const page = vm.createContext({
      location: { origin: account.origin },
      document: { cookie: account.cookie },
      fetch: (path: string, init?: Parameters<ClaudeAccount['handle']>[1]) =>
        account.handle(String(path), init ?? {}),
      AbortSignal,
      URLSearchParams,
    });
    try {
      const value: unknown = await vm.runInContext(expression, page);
      // returnByValue: the value crosses as JSON.
      return {
        result: {
          result: { type: 'object', value: JSON.parse(JSON.stringify(value)) },
        },
      };
    } catch (error) {
      return {
        result: {
          result: { type: 'undefined' },
          exceptionDetails: { text: String(error) },
        },
      };
    }
  }
  private emit(type: string, event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function chromeFetch(input: string | URL): Promise<Response> {
  const url = String(input);
  if (url !== `http://127.0.0.1:${PORT}/json/list`)
    throw new TypeError(`Unexpected request from MST to ${url}`);
  if (!devtools.listening) throw new TypeError('fetch failed');
  return new Response(JSON.stringify(devtools.targets));
}

/** Advances the adapter's sleeps while real I/O completes. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  for (let step = 0; step < 400 && !settled; step++) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(100);
  }
  return promise;
}

async function eventually<T>(check: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let step = 0; step < 200; step++) {
    try {
      return await check();
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(100);
  }
  throw last;
}

/** Lets the mirror run a few more polls. */
async function pollMirror(): Promise<void> {
  for (let step = 0; step < 60; step++) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(100);
  }
}

function now(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function promptEvents(
  init: { tools: string[]; mcp_servers?: unknown[] },
  work: Record<string, unknown>[] = []
): CloudEvent[] {
  return [
    {
      source: 'client',
      created_at: now(),
      payload: {
        type: 'user',
        uuid: 'prompt',
        message: { role: 'user', content: PROMPT },
      },
    },
    {
      source: 'server',
      created_at: now(),
      payload: { type: 'system', subtype: 'init', ...init },
    },
    ...work.map((payload) => ({
      source: 'server',
      created_at: now(),
      payload,
    })),
    {
      source: 'server',
      created_at: now(),
      payload: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        result: 'Found it.',
        user_message_uuids: ['prompt'],
      },
    },
  ];
}

const SEARCH = 'mcp__Acme_Search__search';
const CREATE = 'mcp__Acme_Search__create_doc';
const SEND = 'mcp__Acme_Mail__send_mail';

function toolUse(id: string, name: string, input: unknown = {}) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  };
}
function toolResult(id: string, content: unknown) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  };
}

describe('coworkClaudeAi lifecycle (offline)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let account: ClaudeAccount;
  let base: CoworkDesktop & {
    submit: ReturnType<typeof vi.fn>;
    handleHitl: ReturnType<typeof vi.fn>;
  };
  let open: Array<() => Promise<void>>;
  const env = {
    MST_CLAUDE_AI_DEBUG_PORT: String(PORT),
    MST_COWORK_APP_PATH: '/Applications/Acme Claude.app',
  };
  const journal = () =>
    join(host.home, '.mcp-server-tester', 'cowork-claude-ai-connectors.json');
  const sessionsDir = () =>
    join(host.home, '.mcp-server-tester', 'cowork-claude-ai');

  beforeEach(async () => {
    host.home = await mkdtemp(join(tmpdir(), 'mst-claude-ai-'));
    host.commands.length = 0;
    host.faults.clear();
    host.commandFaults.clear();
    account = new ClaudeAccount();
    devtools.account = account;
    devtools.listening = true;
    devtools.sockets.length = 0;
    devtools.targets = [
      { type: 'service_worker', url: 'https://claude.ai/sw.js' },
      {
        type: 'page',
        url: 'https://claude.ai/new',
        webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/acme`,
      },
    ];
    open = [];
    base = {
      dataDirectory: () => {
        throw new Error('The base desktop data directory must not be used.');
      },
      prepare: () => {
        throw new Error('The base desktop must not be prepared.');
      },
      recover: async () => undefined,
      submit: vi.fn(async () => ({
        status: 'submitted' as const,
        action_count: 2,
      })),
      handleHitl: vi.fn(async () => ({
        status: 'hitl_checked' as const,
        action_count: 1,
      })),
    };
    Object.defineProperty(process, 'platform', {
      ...platform,
      value: 'darwin',
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', chromeFetch);
    vi.stubGlobal('WebSocket', FakeDevtoolsSocket);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    for (const dispose of open) await drive(dispose()).catch(() => undefined);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', platform);
    await rm(host.home, { recursive: true, force: true });
    host.home = '';
  });

  function adapter(
    connectors?: CloudConnectorConfig,
    writes?: Record<string, 'unguarded' | 'live'>
  ) {
    return coworkClaudeAi(base, {
      servers: [SERVER],
      ...(connectors ? { connectors } : {}),
      ...(writes ? { writes } : {}),
    });
  }

  async function prepare(desktop: CoworkDesktop) {
    const session = await drive(
      desktop.prepare({
        evalConfig: { name: 'acme-1p', datasets: [], servers: [SERVER] },
        env,
      })
    );
    open.push(() => session.dispose());
    return session;
  }

  /** Puts a finished cloud task on the account and waits for its mirror. */
  async function finishTrial(
    desktop: CoworkDesktop,
    events: CloudEvent[],
    startedAtMs: number
  ): Promise<ClaudeTranscript> {
    account.sessions.unshift({
      id: 'cse_trial1',
      created_at: now(-60_000),
      last_event_at: now(),
      events,
    });
    return mirrored(desktop, startedAtMs);
  }

  /** The trial's session as Cowork's own session reader binds it. */
  async function mirrored(
    desktop: CoworkDesktop,
    startedAtMs: number
  ): Promise<ClaudeTranscript> {
    return eventually(async () => {
      const [transcript, ...more] = await findMatchingClaudeSessions({
        dataDir: desktop.dataDirectory({}),
        snapshot: new Map(),
        startedAtMs,
        exactPrompt: PROMPT,
      });
      expect(more).toEqual([]);
      expect(transcript?.isComplete).toBe(true);
      return transcript!;
    });
  }

  async function receipt(transcript: ClaudeTranscript) {
    return JSON.parse(
      await readFile(
        join(transcript.candidate.sessionDir, 'connector-policy.json'),
        'utf8'
      )
    ) as Record<string, unknown>;
  }

  it('binds the selected connector, blocks every other account tool, and restores the account exactly on dispose', async () => {
    const desktop = adapter();
    // The inventory is the account's, so it is unknown until prepare reads it.
    expect(desktop.mcpServerNames?.()).toEqual([]);
    expect(desktop.mcpServerLabels?.()).toEqual({});
    const session = await prepare(desktop);

    expect(session.app).toEqual({
      name: 'Claude',
      version: '1.2.3',
      source: 'installed',
    });
    expect(session.appPath).toBe('/Applications/Acme Claude.app');
    expect(host.commands[0]).toEqual({
      file: '/usr/bin/plutil',
      args: [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '/Applications/Acme Claude.app/Contents/Info.plist',
      ],
    });
    expect(desktop.mcpServerNames?.()).toEqual([
      'Acme_Search',
      'Acme_Mail',
      'Acme_Wiki',
      'Acme_Archive',
      'Acme_Calendar',
    ]);
    expect(desktop.mcpServerLabels?.()).toEqual({ Acme_Search: 'acme' });
    // Read-only by default. Unselected connectors, stale keys of removed
    // tools, and disconnected connectors are all blocked.
    expect(account.permissions).toEqual({
      'srv-search:search': true,
      'srv-search:search:always': true,
      'srv-search:create_doc': false,
      'srv-search:create_doc:always': false,
      'srv-mail:send_mail': false,
      'srv-mail:send_mail:always': false,
      'srv-wiki:stale_tool': false,
      'srv-archive:legacy': false,
      'srv-calendar:list_events': false,
      'srv-calendar:list_events:always': false,
      'unmanaged:tool': true,
    });
    // The page program asks as the page's active organization, with cookies,
    // and never asks a disconnected connector for its tools.
    const reads = account.requests.filter((r) => r.method === 'GET');
    expect(
      reads.every(
        (r) =>
          r.credentials === 'include' &&
          r.headers['x-organization-uuid'] === 'org-acme'
      )
    ).toBe(true);
    expect(
      account.requests.some((r) => r.path.includes('srv-archive/tools'))
    ).toBe(false);
    expect(account.patches()).toHaveLength(1);
    expect(
      new Set(devtools.sockets).size === 1 &&
        devtools.sockets[0] === `ws://127.0.0.1:${PORT}/devtools/page/acme`
    ).toBe(true);
    // The journal records only what changed, so a crash can be undone.
    expect(JSON.parse(await readFile(journal(), 'utf8'))).toMatchObject({
      accountId: 'account-acme',
      organizationId: 'org-acme',
      original: {
        'srv-search:search': false,
        'srv-search:search:always': null,
        'srv-mail:send_mail': true,
      },
    });

    await drive(session.dispose());
    expect(account.permissions).toEqual(account.original);
    await expect(stat(journal())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('mirrors only a submitted task, across event pages, and stops mirroring on dispose', async () => {
    const desktop = adapter();
    const startedAtMs = Date.now();
    const session = await prepare(desktop);
    account.sessions.push(
      {
        id: 'cse_yesterday',
        created_at: now(-86_400_000),
        last_event_at: now(-86_400_000),
        events: [],
      },
      { id: 'cse_bad/../../id', created_at: now(), events: [] }
    );
    // A prewarmed VM: setup only, no submitted prompt yet.
    const prewarmed: CloudSession = {
      id: 'cse_trial1',
      created_at: now(-60_000),
      last_event_at: now(),
      events: [
        {
          source: 'client',
          created_at: now(),
          payload: {
            type: 'user',
            uuid: 'setup',
            shouldQuery: false,
            message: { role: 'user', content: 'workspace context' },
          },
        },
        {
          source: 'server',
          created_at: now(),
          payload: {
            type: 'result',
            subtype: 'success',
            is_error: false,
            num_turns: 0,
            result: '',
            user_message_uuids: ['setup'],
          },
        },
      ],
    };
    account.sessions.unshift(prewarmed);
    await pollMirror();
    expect(await readdir(desktop.dataDirectory({}))).toEqual([]);

    const submitting = desktop.submit(PROMPT, {
      deadlineAt: Date.now() + 60_000,
    });
    await drive(submitting);
    // The deep link opens a fresh Cowork task before the planner types.
    expect(host.commands.at(-1)).toEqual({
      file: '/usr/bin/open',
      args: ['claude://cowork/new'],
    });
    expect(base.submit).toHaveBeenCalledOnce();
    expect(base.submit).toHaveBeenCalledWith(PROMPT, {
      deadlineAt: expect.any(Number),
    });

    prewarmed.events.push(
      ...promptEvents({ tools: [SEARCH] }, [
        toolUse('call-1', SEARCH, { query: 'launch plan' }),
        toolResult('call-1', 'Acme launch plan v2'),
      ])
    );
    prewarmed.last_event_at = now();
    const transcript = await mirrored(desktop, startedAtMs);
    expect(transcript.candidate.id).toBe('local_cse_trial1');
    expect(transcript.binding).toEqual({ kind: 'exact-initial-prompt' });
    await desktop.bindSession!(transcript);
    expect(transcript.toolCalls).toMatchObject([
      {
        name: 'search',
        server: 'Acme_Search',
        arguments: { query: 'launch plan' },
      },
    ]);
    // All 7 events, fetched 2 per page, and the setup-only result dropped.
    const audit = (
      await readFile(
        join(transcript.candidate.sessionDir, 'audit.jsonl'),
        'utf8'
      )
    )
      .trim()
      .split('\n');
    expect(audit).toHaveLength(6);
    expect(account.requests.some((r) => r.path.includes('cursor=6'))).toBe(
      true
    );
    expect(
      account.requests.some((r) => r.path.includes('cse_yesterday/events'))
    ).toBe(false);
    expect(account.requests.some((r) => r.path.includes('cse_bad'))).toBe(
      false
    );
    expect(await readdir(desktop.dataDirectory({}))).toEqual([
      'local_cse_trial1',
      'local_cse_trial1.json',
    ]);

    await drive(session.dispose());
    const requests = account.requests.length;
    account.sessions.unshift({
      id: 'cse_after',
      created_at: now(),
      last_event_at: now(),
      events: promptEvents({ tools: [] }),
    });
    await pollMirror();
    expect(account.requests).toHaveLength(requests);
    expect(await readdir(desktop.dataDirectory({}))).not.toContain(
      'local_cse_after.json'
    );
  });

  it('records a passed policy receipt beside the mirrored session', async () => {
    const desktop = adapter();
    const startedAtMs = Date.now();
    await prepare(desktop);
    const transcript = await finishTrial(
      desktop,
      promptEvents({ tools: ['Read', SEARCH] }, [
        toolUse('call-1', SEARCH),
        toolResult('call-1', 'ok'),
      ]),
      startedAtMs
    );
    await drive(desktop.validateTranscript!(transcript));
    expect(await receipt(transcript)).toMatchObject({
      mode: 'first-party',
      serverLabels: { Acme_Search: 'acme' },
      effective: {
        default: 'block',
        failOnApproval: true,
        servers: { 'srv-search': { policy: 'read-only' } },
      },
      expectedAllowedTools: [SEARCH],
      expectedBlockedTools: ['mcp__Acme_Calendar__list_events', SEND, CREATE],
      automaticHitlEnabled: false,
      settingsVerified: true,
      verification: 'passed',
      observedAllowedTools: [SEARCH],
      catalogComplete: true,
      approvalRequests: 0,
    });
  });

  it('keeps a failed receipt when the task saw a blocked tool, even after the session is mirrored again', async () => {
    const desktop = adapter();
    const startedAtMs = Date.now();
    await prepare(desktop);
    const events = promptEvents(
      {
        tools: [SEARCH],
        mcp_servers: [{ name: 'Acme_Search', status: 'connected' }],
      },
      [
        toolUse('find', 'ToolSearch', { query: 'mail' }),
        toolResult('find', [{ type: 'tool_reference', tool_name: SEND }]),
      ]
    );
    const transcript = await finishTrial(desktop, events, startedAtMs);
    await expect(
      drive(desktop.validateTranscript!(transcript))
    ).rejects.toThrow(`Unexpected: ${SEND}`);
    const failed = await receipt(transcript);
    expect(failed).toMatchObject({
      mode: 'first-party',
      settingsVerified: true,
      verification: 'failed',
      error: expect.stringContaining(SEND),
    });
    // Cloud events keep arriving; the mirror rewrites the session, not the receipt.
    const auditPath = join(transcript.candidate.sessionDir, 'audit.jsonl');
    const before = await readFile(auditPath, 'utf8');
    account.sessions[0]!.events.push({
      source: 'server',
      created_at: now(),
      payload: {
        type: 'assistant',
        message: { role: 'assistant', content: 'late' },
      },
    });
    await eventually(async () =>
      expect(await readFile(auditPath, 'utf8')).not.toBe(before)
    );
    expect(await receipt(transcript)).toEqual(failed);
  });

  it('fails the trial when the account changed mid-run, and leaves the concurrent edit and its journal on dispose', async () => {
    const desktop = adapter();
    const startedAtMs = Date.now();
    const session = await prepare(desktop);
    const transcript = await finishTrial(
      desktop,
      promptEvents({ tools: [SEARCH] }),
      startedAtMs
    );
    // Someone enables the write tool in another tab.
    account.permissions['srv-search:create_doc'] = true;
    await expect(
      drive(desktop.validateTranscript!(transcript))
    ).rejects.toThrow('did not persist');
    expect(await receipt(transcript)).toMatchObject({
      settingsVerified: false,
      verification: 'failed',
      error: expect.stringContaining('did not persist'),
    });

    await expect(drive(session.dispose())).rejects.toThrow(
      `1 concurrent edits. Recovery journal retained at ${journal()}`
    );
    // The other person's value stays; MST's own changes are undone.
    expect(account.permissions).toEqual({
      ...account.original,
      'srv-search:create_doc': true,
    });
    await expect(stat(journal())).resolves.toBeDefined();
  });

  it('accepts a deferred connector inventory without counting its unloaded tools as missing', async () => {
    const desktop = adapter();
    const startedAtMs = Date.now();
    await prepare(desktop);
    const transcript = await finishTrial(
      desktop,
      promptEvents({
        tools: ['Read', 'ToolSearch'],
        mcp_servers: [{ name: 'Acme_Search', status: 'pending' }],
      }),
      startedAtMs
    );
    await drive(desktop.validateTranscript!(transcript));
    expect(await receipt(transcript)).toMatchObject({
      verification: 'passed',
      pendingServers: ['Acme_Search'],
      catalogComplete: false,
      unobservedAllowedTools: [SEARCH],
    });

    // A deferred inventory does not hide a blocked tool ToolSearch loads.
    account.sessions.length = 0;
    await rm(desktop.dataDirectory({}), { recursive: true });
    await mkdir(desktop.dataDirectory({}));
    const loaded = await finishTrial(
      desktop,
      promptEvents(
        {
          tools: ['ToolSearch'],
          mcp_servers: [{ name: 'Acme_Search', status: 'pending' }],
        },
        [
          toolUse('find', 'ToolSearch', { query: 'acme' }),
          toolResult('find', [
            { type: 'tool_reference', tool_name: SEARCH },
            { type: 'tool_reference', tool_name: CREATE },
          ]),
        ]
      ),
      startedAtMs
    );
    await expect(drive(desktop.validateTranscript!(loaded))).rejects.toThrow(
      `Unexpected: ${CREATE}`
    );
    expect(await receipt(loaded)).toMatchObject({ verification: 'failed' });
  });

  it('never hands an approval to automatic HITL under the default failOnApproval', async () => {
    const desktop = adapter();
    const options = { deadlineAt: Date.now() + 60_000 };
    // Not even before a session is prepared or after it is disposed.
    await expect(desktop.handleHitl(options)).resolves.toEqual({
      status: 'hitl_checked',
      action_count: 0,
    });
    const session = await prepare(desktop);
    await expect(desktop.handleHitl(options)).resolves.toEqual({
      status: 'hitl_checked',
      action_count: 0,
    });
    await drive(session.dispose());
    await expect(desktop.handleHitl(options)).resolves.toEqual({
      status: 'hitl_checked',
      action_count: 0,
    });
    expect(base.handleHitl).not.toHaveBeenCalled();
  });

  it('uses automatic HITL only when the eval asks for approvals', async () => {
    const desktop = adapter({
      failOnApproval: false,
      servers: { acme: { policy: 'read-only', tools: { search: 'ask' } } },
    });
    const startedAtMs = Date.now();
    await prepare(desktop);
    expect(account.permissions).toMatchObject({
      'srv-search:search': true,
      'srv-search:search:always': false,
    });
    const options = { deadlineAt: Date.now() + 60_000, task: PROMPT };
    await expect(desktop.handleHitl(options)).resolves.toEqual({
      status: 'hitl_checked',
      action_count: 1,
    });
    expect(base.handleHitl).toHaveBeenCalledWith(options);
    const transcript = await finishTrial(
      desktop,
      promptEvents({ tools: [SEARCH] }),
      startedAtMs
    );
    await drive(desktop.validateTranscript!(transcript));
    expect(await receipt(transcript)).toMatchObject({
      automaticHitlEnabled: true,
      verification: 'passed',
    });
  });

  it('refuses a write-capable policy without a writes declaration before changing the account', async () => {
    const desktop = adapter({ servers: { acme: { policy: 'allow-all' } } });
    await expect(
      drive(
        desktop.prepare({
          evalConfig: { name: 'acme-1p', datasets: [], servers: [SERVER] },
          env,
        })
      )
    ).rejects.toThrow('Declare writes.acme');
    expect(account.patches()).toEqual([]);
    expect(account.permissions).toEqual(account.original);
    await expect(stat(journal())).rejects.toMatchObject({ code: 'ENOENT' });

    const declared = adapter(
      { servers: { acme: { policy: 'allow-all' } } },
      { acme: 'unguarded' }
    );
    const session = await prepare(declared);
    expect(account.permissions).toMatchObject({
      'srv-search:search:always': true,
      'srv-search:create_doc': true,
      'srv-search:create_doc:always': true,
      'srv-mail:send_mail': false,
    });
    await drive(session.dispose());
    expect(account.permissions).toEqual(account.original);
  });

  it('refuses to configure an account whose connected inventory cannot be read', async () => {
    account.servers.find((s) => s.uuid === 'srv-wiki')!.toolsStatus = 500;
    await expect(
      drive(
        adapter().prepare({
          evalConfig: { name: 'acme-1p', datasets: [], servers: [SERVER] },
          env,
        })
      )
    ).rejects.toThrow('Cannot configure Acme Wiki: Tool inventory HTTP 500');
    expect(account.patches()).toEqual([]);
    await expect(stat(journal())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the account when the session folder cannot be prepared', async () => {
    const fault = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    host.faults.set(`rm ${sessionsDir()}`, fault);
    const desktop = adapter({
      failOnApproval: false,
      servers: { acme: { policy: 'read-only', tools: { search: 'ask' } } },
    });
    await expect(
      drive(
        desktop.prepare({
          evalConfig: { name: 'acme-1p', datasets: [], servers: [SERVER] },
          env,
        })
      )
    ).rejects.toBe(fault);
    expect(account.patches()).toHaveLength(2);
    expect(account.permissions).toEqual(account.original);
    await expect(stat(journal())).rejects.toMatchObject({ code: 'ENOENT' });
    // No mirror was left polling the account, and no stale plan approves.
    const requests = account.requests.length;
    await pollMirror();
    expect(account.requests).toHaveLength(requests);
    await expect(
      desktop.handleHitl({ deadlineAt: Date.now() + 60_000 })
    ).resolves.toEqual({ status: 'hitl_checked', action_count: 0 });
    expect(base.handleHitl).not.toHaveBeenCalled();
  });

  it('reports both the setup failure and a failed restore, and keeps the journal', async () => {
    host.faults.set(
      `mkdir ${sessionsDir()}`,
      Object.assign(new Error('ENOSPC: no space left on device'), {
        code: 'ENOSPC',
      })
    );
    // The restore's write is refused.
    account.afterPatch = () => {
      account.patchStatus = 500;
    };
    const failure = await drive(
      adapter().prepare({
        evalConfig: { name: 'acme-1p', datasets: [], servers: [SERVER] },
        env,
      })
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors.map(String);
    expect(errors[0]).toContain('ENOSPC');
    expect(errors[1]).toContain('updating connector permissions failed (500)');
    expect((failure as Error).message).toContain(journal());
    expect((failure as Error).message).toContain('ENOSPC');
    expect((failure as Error).message).toContain(
      'updating connector permissions failed (500)'
    );
    await expect(stat(journal())).resolves.toBeDefined();
  });

  it.each(['identity', 'expected-value', 'bootstrap'] as const)(
    'marks only a proven page preflight %s rejection as not dispatched',
    async (rejection) => {
      let bootstraps = 0;
      account.beforeRequest = (request) => {
        if (request.path !== '/api/bootstrap' || ++bootstraps !== 2) return;
        // Inventory's bootstrap was first; this is PATCH's own preflight.
        if (rejection === 'identity') account.accountId = 'account-other';
        if (rejection === 'expected-value') {
          // A concurrent value that is neither MST's plan nor the original.
          account.permissions['srv-calendar:list_events'] = true;
        }
        if (rejection === 'bootstrap') account.bootstrapStatus = 503;
      };
      await expect(
        drive(
          adapter().prepare({
            evalConfig: { name: 'preflight', datasets: [], servers: [SERVER] },
            env,
          })
        )
      ).rejects.toThrow(
        rejection === 'identity'
          ? 'account_changed'
          : rejection === 'bootstrap'
            ? '503'
            : 'permissions_changed_concurrently'
      );
      // Recovery may retain a conflict/identity failure, but must not report an
      // unknown write: the trusted page proved fetch(PATCH) never ran.
      const retained = await readFile(journal(), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        }
      );
      if (retained) expect(JSON.parse(retained).pendingWrite).toBeUndefined();
      expect(account.patches()).toEqual([]);
    }
  );

  it('retains an unknown permission write after a generic post-dispatch abort instead of accepting matching readback', async () => {
    account.afterPatch = () => {
      throw new Error('AbortError: response lost after dispatch');
    };
    await expect(
      drive(
        adapter().prepare({
          evalConfig: { name: 'unknown', datasets: [], servers: [SERVER] },
          env,
        })
      )
    ).rejects.toThrow('permission write outcome is unknown');
    expect(account.patches()).toHaveLength(1);
    expect(
      JSON.parse(await readFile(journal(), 'utf8')).pendingWrite.purpose
    ).toBe('configure');
    // Even restoring the old values by hand does not waive a delayed write.
    account.permissions = structuredClone(account.original);
    await expect(drive(restoreClaudeAiConnectors(env))).rejects.toThrow(
      'permission write outcome is unknown'
    );
    expect(account.patches()).toHaveLength(1);
  });

  it('undoes a crashed run from its journal before configuring the next one', async () => {
    account.permissions['srv-mail:send_mail'] = false;
    await mkdir(join(host.home, '.mcp-server-tester'), { recursive: true });
    await writeFile(
      journal(),
      JSON.stringify({
        version: 2,
        accountId: 'account-acme',
        organizationId: 'org-acme',
        original: { 'srv-mail:send_mail': true },
        applied: { 'srv-mail:send_mail': false },
      })
    );
    const session = await prepare(adapter());
    expect(account.patches()[0]).toEqual({
      enabled_mcp_tools: { 'srv-mail:send_mail': true },
    });
    await drive(session.dispose());
    expect(account.permissions).toEqual(account.original);
  });

  it('fails with sign-in steps, without touching the account, when claude.ai cannot be read', async () => {
    const attempt = () =>
      drive(
        adapter().prepare({
          evalConfig: { name: 'acme-1p', datasets: [], servers: [SERVER] },
          env,
        })
      );
    account.listStatus = 401;
    await expect(attempt()).rejects.toThrow(
      /refused the Cowork session list \(HTTP 401\): sign in again\. Start Chrome/
    );
    account.listStatus = 200;
    account.origin = 'https://evil.test';
    await expect(attempt()).rejects.toThrow('wrong_origin');
    account.origin = 'https://claude.ai';
    devtools.targets = [
      {
        type: 'page',
        url: 'https://claude.ai/new',
        webSocketDebuggerUrl: `ws://192.0.2.1:${PORT}/devtools/page/acme`,
      },
    ];
    await expect(attempt()).rejects.toThrow(
      `No claude.ai page is open in the Chrome on port ${PORT}`
    );
    devtools.listening = false;
    await expect(attempt()).rejects.toThrow(
      `No Chrome is listening on DevTools port ${PORT}`
    );
    expect(
      devtools.sockets.every((url) => url.startsWith('ws://127.0.0.1'))
    ).toBe(true);
    expect(
      account.requests.filter(
        (r) =>
          r.path !== '/v1/code/sessions?tags=product%3Acowork-remote&limit=1'
      )
    ).toEqual([]);
    expect(host.commands).toEqual([]);
  });

  /** The trial's cloud task, already finished, on the account. */
  function addTrial(events: CloudEvent[]): CloudSession {
    const session = {
      id: 'cse_trial1',
      created_at: now(-60_000),
      last_event_at: now(),
      events,
    };
    account.sessions.unshift(session);
    return session;
  }

  async function unbound(desktop: CoworkDesktop, startedAtMs: number) {
    expect(await readdir(desktop.dataDirectory({}))).toEqual([]);
    expect(
      await findMatchingClaudeSessions({
        dataDir: desktop.dataDirectory({}),
        snapshot: new Map(),
        startedAtMs,
        exactPrompt: PROMPT,
      })
    ).toEqual([]);
  }

  it.each([
    {
      failure: 'Chrome closes',
      fail: () => {
        devtools.listening = false;
      },
      heal: () => {
        devtools.listening = true;
      },
      cause: `No Chrome is listening on DevTools port ${PORT}`,
    },
    {
      failure: 'claude.ai signs out',
      fail: () => {
        account.listStatus = 401;
      },
      heal: () => {
        account.listStatus = 200;
      },
      cause:
        'claude.ai refused the Cowork session list (HTTP 401): sign in again',
    },
    {
      failure: 'the event fetch fails',
      fail: () => {
        account.eventsStatus = 500;
      },
      heal: () => {
        account.eventsStatus = 200;
      },
      cause: 'claude.ai session cse_trial1 failed (500).',
    },
  ])(
    'names why it records nothing when $failure after prepare, and records once it recovers',
    async ({ fail, heal, cause }) => {
      const desktop = adapter();
      const startedAtMs = Date.now();
      const session = await prepare(desktop);
      expect(session.recordingError?.()).toBeUndefined();
      fail();
      addTrial(promptEvents({ tools: [SEARCH] }));
      await eventually(async () =>
        expect(session.recordingError?.()).toContain(cause)
      );
      await pollMirror();
      expect(session.recordingError?.()).toContain(cause);
      await unbound(desktop, startedAtMs);

      heal();
      const transcript = await mirrored(desktop, startedAtMs);
      expect(transcript.candidate.id).toBe('local_cse_trial1');
      await eventually(async () =>
        expect(session.recordingError?.()).toBeUndefined()
      );
      await drive(session.dispose());
      expect(account.permissions).toEqual(account.original);
    }
  );

  it('fails instead of recording part of a session past the 10,000-event cap', async () => {
    account.eventPageSize = 500;
    const desktop = adapter();
    const startedAtMs = Date.now();
    const session = await prepare(desktop);
    const steps = Array.from({ length: 9_998 }, (_, step) => ({
      type: 'assistant',
      message: { role: 'assistant', content: `step ${step}` },
    }));
    const events = promptEvents({ tools: [SEARCH] }, steps);
    expect(events).toHaveLength(10_001);
    addTrial(events);
    await eventually(async () =>
      expect(session.recordingError?.()).toBe(
        'claude.ai session cse_trial1 has more events than MST reads (50 pages of 200, 10,000 events). ' +
          'MST does not record part of a session. Shorten the case so the task stays under the limit.'
      )
    );
    await unbound(desktop, startedAtMs);
    // 50 pages of 200, and never the 51st.
    const pages = account.requests.filter((r) =>
      r.path.startsWith('/v1/code/sessions/cse_trial1/events?')
    );
    expect(pages.every((r) => r.path.includes('limit=200'))).toBe(true);
    expect(pages.some((r) => r.path.includes('cursor=9800'))).toBe(true);
    expect(pages.some((r) => r.path.includes('cursor=10000'))).toBe(false);

    // At the cap exactly, the whole session is recorded.
    events.splice(5, 1);
    const transcript = await mirrored(desktop, startedAtMs);
    const audit = await readFile(
      join(transcript.candidate.sessionDir, 'audit.jsonl'),
      'utf8'
    );
    expect(audit.trim().split('\n')).toHaveLength(10_000);
    await eventually(async () =>
      expect(session.recordingError?.()).toBeUndefined()
    );
  });

  it.each([
    {
      paging: 'repeats a cursor',
      page: (start: number, end: number) => ({
        resume_cursor: start === 0 ? end : start,
      }),
      cause:
        'claude.ai returned a repeated event page cursor for session cse_trial1.',
    },
    {
      paging: 'cycles back to an earlier cursor',
      page: (start: number, end: number) => ({
        resume_cursor: start === 0 ? end : 0,
      }),
      cause:
        'claude.ai returned a repeated event page cursor for session cse_trial1.',
    },
    {
      paging: 'returns a cursor that is not a string or number',
      page: (_start: number, end: number) => ({
        resume_cursor: { offset: end },
      }),
      cause:
        'claude.ai returned a malformed event page cursor for session cse_trial1.',
    },
    {
      paging: 'returns a page without a data array',
      page: () => ({ data: { events: [] } }),
      cause:
        'claude.ai returned an event page without a data array for session cse_trial1.',
    },
  ])('records nothing when claude.ai $paging', async ({ page, cause }) => {
    const desktop = adapter();
    const startedAtMs = Date.now();
    const session = await prepare(desktop);
    account.eventPage = page;
    addTrial(promptEvents({ tools: [SEARCH] }));
    await eventually(async () =>
      expect(session.recordingError?.()).toContain(cause)
    );
    expect(session.recordingError?.()).toContain(
      'MST does not record part of a session.'
    );
    await pollMirror();
    await unbound(desktop, startedAtMs);
  });

  /** Submit once, then bind the real mirror's unique exact-prompt candidate. */
  async function submitAndBind(desktop: CoworkDesktop, events: CloudEvent[]) {
    const startedAtMs = Date.now();
    await drive(desktop.submit(PROMPT, { deadlineAt: Date.now() + 60_000 }));
    addTrial(events);
    const transcript = await eventually(async () => {
      const matches = await findMatchingClaudeSessions({
        dataDir: desktop.dataDirectory({}),
        snapshot: new Map(),
        startedAtMs,
        exactPrompt: PROMPT,
      });
      expect(matches).toHaveLength(1);
      return matches[0]!;
    });
    await desktop.bindSession!(transcript);
    return transcript;
  }

  it('retains an active task across timeout cleanup, reset and restart without restoring or submitting again', async () => {
    base.reset = vi.fn(async () => {});
    const desktop = adapter();
    const session = await prepare(desktop);
    const events = promptEvents({ tools: [SEARCH] });
    const terminal = events.pop()!;
    const bound = await submitAndBind(desktop, events);
    expect(bound.isComplete).toBe(false);
    expect(JSON.parse(await readFile(journal(), 'utf8'))).toMatchObject({
      pendingTask: { sessionId: 'cse_trial1', startedAt: expect.any(String) },
    });
    const commands = host.commands.length;
    const patches = account.patches().length;
    await expect(drive(session.dispose())).rejects.toThrow(
      'no terminal native result'
    );
    await expect(
      drive(desktop.reset!({ deadlineAt: Date.now() + 1_000 }))
    ).rejects.toThrow('no terminal native result');
    await expect(drive(session.restart!())).rejects.toThrow(
      'no terminal native result'
    );
    await expect(
      drive(desktop.submit('another task', { deadlineAt: Date.now() + 1_000 }))
    ).rejects.toThrow('no terminal native result');
    expect(base.reset).not.toHaveBeenCalled();
    expect(base.submit).toHaveBeenCalledOnce();
    expect(host.commands).toHaveLength(commands);
    expect(account.patches()).toHaveLength(patches);
    expect(account.permissions).not.toEqual(account.original);
    await expect(stat(journal())).resolves.toBeDefined();

    // Neither disappearance from the list nor a supplied completion flag proves it.
    account.listStatus = 500;
    await expect(
      drive(desktop.validateTranscript!({ ...bound, isComplete: true }))
    ).rejects.toThrow('no terminal native result');
    events.push(terminal);
    // The exact bound event reader works independently of listing/app state.
    await drive(session.dispose());
    expect(account.permissions).toEqual(account.original);
    await expect(stat(journal())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists unbound intent before submit and never guesses an identity after a rejected submission', async () => {
    base.reset = vi.fn(async () => {});
    base.submit.mockImplementationOnce(async () => {
      expect(JSON.parse(await readFile(journal(), 'utf8'))).toMatchObject({
        pendingTask: { startedAt: expect.any(String) },
      });
      throw new Error(
        'Computer Use permission rejected after possible dispatch'
      );
    });
    const desktop = adapter();
    const session = await prepare(desktop);
    await expect(
      drive(desktop.submit(PROMPT, { deadlineAt: Date.now() + 1_000 }))
    ).rejects.toThrow('permission rejected');
    addTrial(promptEvents({ tools: [SEARCH] }));
    await pollMirror();
    await expect(drive(session.dispose())).rejects.toThrow(/unbound/);
    await expect(
      drive(desktop.reset!({ deadlineAt: Date.now() + 1_000 }))
    ).rejects.toThrow(/unbound/);
    await expect(
      drive(desktop.submit(PROMPT, { deadlineAt: Date.now() + 1_000 }))
    ).rejects.toThrow(/unbound/);
    await expect(drive(restoreClaudeAiConnectors(env))).rejects.toThrow(
      /unbound/
    );
    expect(base.submit).toHaveBeenCalledOnce();
    expect(base.reset).not.toHaveBeenCalled();
    expect(account.patches()).toHaveLength(1);
    expect(
      JSON.parse(await readFile(journal(), 'utf8')).pendingTask.sessionId
    ).toBeUndefined();
  });

  it('refuses a similar-prompt fallback instead of binding the wrong cloud task', async () => {
    const desktop = adapter();
    const session = await prepare(desktop);
    await drive(desktop.submit(PROMPT, { deadlineAt: Date.now() + 60_000 }));
    const events = promptEvents({ tools: [SEARCH] });
    events[0]!.payload.message = { role: 'user', content: `${PROMPT}!` };
    addTrial(events);
    const candidate = await eventually(async () => {
      const matches = await findMatchingClaudeSessions({
        dataDir: desktop.dataDirectory({}),
        snapshot: new Map(),
        startedAtMs: Date.now() - 10_000,
        exactPrompt: PROMPT,
      });
      expect(matches).toHaveLength(1);
      return matches[0]!;
    });
    expect(candidate.binding?.kind).toBe('only-new-session');
    await expect(desktop.bindSession!(candidate)).rejects.toThrow(
      'refusing to guess'
    );
    await expect(drive(session.dispose())).rejects.toThrow(/unbound/);
    expect(account.patches()).toHaveLength(1);
  });

  it.each(['success', 'cancelled'] as const)(
    'accepts a native %s result, clears the task before policy rejection, and permits a reset',
    async (terminal) => {
      base.reset = vi.fn(async () => {});
      const desktop = adapter();
      const session = await prepare(desktop);
      const events = promptEvents({ tools: [SEARCH, SEND] });
      if (terminal === 'cancelled')
        events.at(-1)!.payload = {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'cancelled',
        };
      const transcript = await submitAndBind(desktop, events);
      await expect(
        drive(desktop.validateTranscript!(transcript))
      ).rejects.toThrow('Unexpected:');
      expect(
        JSON.parse(await readFile(journal(), 'utf8')).pendingTask
      ).toBeUndefined();
      await drive(desktop.reset!({ deadlineAt: Date.now() + 1_000 }));
      expect(base.reset).toHaveBeenCalledOnce();
      await drive(session.dispose());
      expect(account.permissions).toEqual(account.original);
    }
  );

  it.each([false, true])(
    'does not accept a setup-only result (is_error: %s) as terminal evidence',
    async (isError) => {
      const desktop = adapter();
      const session = await prepare(desktop);
      const events = promptEvents({ tools: [SEARCH] });
      events.pop();
      events.unshift({
        source: 'client',
        created_at: now(),
        payload: {
          type: 'user',
          uuid: 'setup',
          shouldQuery: false,
          message: { role: 'user', content: 'setup' },
        },
      });
      events.push({
        source: 'server',
        created_at: now(),
        payload: {
          type: 'result',
          subtype: isError ? 'error_during_execution' : 'success',
          is_error: isError,
          num_turns: 0,
          result: '',
          user_message_uuids: ['setup'],
        },
      });
      await submitAndBind(desktop, events);
      await expect(drive(session.dispose())).rejects.toThrow(
        'no terminal native result'
      );
      expect(account.patches()).toHaveLength(1);
    }
  );

  it.each(['http', 'cap'] as const)(
    'isolates an unrelated pre-run %s failure from healthy recording and retains the actual trial error',
    async (failure) => {
      const desktop = adapter();
      const session = await prepare(desktop);
      const old = promptEvents({ tools: [] });
      for (const event of old) event.created_at = now(-60_000);
      if (failure === 'cap') {
        account.eventPageSize = 200;
        old.push(
          ...Array.from({ length: 10_001 }, () => ({
            source: 'server',
            created_at: now(-1_000),
            payload: { type: 'assistant' },
          }))
        );
      } else account.eventsStatusBySession.set('cse_unrelated', 500);
      const unrelated = {
        id: 'cse_unrelated',
        created_at: now(-60_000),
        last_event_at: now(-1_000),
        events: old,
      };
      account.sessions.push(unrelated);
      await eventually(async () =>
        expect(session.recordingError?.()).toContain('cse_unrelated')
      );
      const startedAtMs = Date.now();
      await drive(desktop.submit(PROMPT, { deadlineAt: Date.now() + 60_000 }));
      // Put the broken unrelated session first; it must not starve the trial.
      account.sessions.push({
        id: 'cse_trial1',
        created_at: now(),
        last_event_at: now(),
        events: promptEvents({ tools: [SEARCH] }),
      });
      const transcript = await mirrored(desktop, startedAtMs);
      await desktop.bindSession!(transcript);
      expect(session.recordingError?.()).toBeUndefined();
      await drive(desktop.validateTranscript!(transcript));
      await pollMirror();
      expect(session.recordingError?.()).toBeUndefined();
      account.eventsStatusBySession.set('cse_trial1', 503);
      await eventually(async () =>
        expect(session.recordingError?.()).toContain('cse_trial1 failed (503)')
      );
      expect(session.recordingError?.()).not.toContain('cse_unrelated');
      account.eventsStatusBySession.delete('cse_trial1');
      await drive(session.dispose());
      expect(account.permissions).toEqual(account.original);
    }
  );

  it('restarts by quitting Claude and opening the prepared app path', async () => {
    const session = await prepare(adapter());
    const quit = {
      file: '/usr/bin/osascript',
      args: ['-e', 'tell application "Claude" to quit'],
    };
    const relaunch = {
      file: '/usr/bin/open',
      args: ['-a', '/Applications/Acme Claude.app'],
    };
    host.commands.length = 0;
    const restarting = session.restart!();
    // The durable task check reads the journal before any app action.
    await vi.waitFor(() => expect(host.commands).toEqual([quit]));
    // Claude gets time to quit before it is opened again.
    await vi.advanceTimersByTimeAsync(2_900);
    expect(host.commands).toEqual([quit]);
    await drive(restarting);
    expect(host.commands).toEqual([quit, relaunch]);

    // A Claude that is not running cannot quit; it is still opened.
    host.commands.length = 0;
    host.commandFaults.set(
      `${quit.file} ${quit.args.join(' ')}`,
      new Error('Claude is not running')
    );
    await drive(session.restart!());
    expect(host.commands).toEqual([quit, relaunch]);

    // A failed relaunch fails the restart.
    host.commandFaults.set(
      `${relaunch.file} ${relaunch.args.join(' ')}`,
      new Error('Unable to find application named Acme Claude')
    );
    await expect(drive(session.restart!())).rejects.toThrow(
      'Unable to find application named Acme Claude'
    );
  });

  it('does not hand the prompt to the planner when the Cowork deep link fails', async () => {
    const desktop = adapter();
    await prepare(desktop);
    host.commandFaults.set(
      '/usr/bin/open claude://cowork/new',
      new Error('No application knows how to open claude://cowork/new')
    );
    await expect(
      drive(desktop.submit(PROMPT, { deadlineAt: Date.now() + 60_000 }))
    ).rejects.toThrow('No application knows how to open claude://cowork/new');
    expect(base.submit).not.toHaveBeenCalled();
  });

  describe('restoreClaudeAiConnectors', () => {
    /** What a run that never disposed left: MST's changes, still applied. */
    async function crashedRun(
      original: Record<string, boolean | null>,
      applied: Record<string, boolean | null>,
      pendingTask?: CloudConnectorTask
    ) {
      for (const [key, value] of Object.entries(applied)) {
        if (value === null) delete account.permissions[key];
        else account.permissions[key] = value;
      }
      await mkdir(join(host.home, '.mcp-server-tester'), { recursive: true });
      await writeFile(
        journal(),
        JSON.stringify({
          version: 2,
          accountId: 'account-acme',
          organizationId: 'org-acme',
          original,
          applied,
          ...(pendingTask ? { pendingTask } : {}),
        })
      );
    }

    it.each([
      'active',
      'unbound',
      'unreadable',
      'absent',
      'setup-only',
    ] as const)(
      'refuses recovery and a new run for a persisted %s task',
      async (state) => {
        await crashedRun(
          { 'srv-mail:send_mail': true },
          { 'srv-mail:send_mail': false },
          {
            startedAt: now(),
            ...(state === 'unbound' ? {} : { sessionId: 'cse_trial1' }),
          }
        );
        if (state !== 'absent') {
          const events = promptEvents({ tools: [SEARCH] });
          if (state === 'active' || state === 'setup-only') events.pop();
          if (state === 'setup-only') {
            events.unshift({
              source: 'client',
              created_at: now(),
              payload: {
                type: 'user',
                uuid: 'setup',
                shouldQuery: false,
                message: { role: 'user', content: 'setup' },
              },
            });
            events.push({
              source: 'server',
              created_at: now(),
              payload: {
                type: 'result',
                subtype: 'success',
                is_error: false,
                num_turns: 0,
                result: '',
                user_message_uuids: ['setup'],
              },
            });
          }
          addTrial(events);
        }
        if (state === 'unreadable') account.eventsStatus = 503;
        const expected =
          state === 'unbound'
            ? /unbound/
            : state === 'unreadable'
              ? /cse_trial1 failed \(503\)/
              : state === 'absent'
                ? /cse_trial1 failed \(404\)/
                : /no terminal native result/;
        await expect(drive(restoreClaudeAiConnectors(env))).rejects.toThrow(
          expected
        );
        await expect(
          drive(
            adapter().prepare({
              evalConfig: { name: 'recovery', datasets: [], servers: [SERVER] },
              env,
            })
          )
        ).rejects.toThrow(expected);
        expect(account.patches()).toEqual([]);
        expect(account.permissions['srv-mail:send_mail']).toBe(false);
        await expect(stat(journal())).resolves.toBeDefined();
        expect(
          account.requests.some((request) =>
            request.path.includes('remote_servers')
          )
        ).toBe(false);
        expect(host.commands.some(({ file }) => file === '/usr/bin/open')).toBe(
          false
        );
      }
    );

    it.each(['success', 'cancelled'] as const)(
      'rechecks the persisted exact task and restores only after a native %s result',
      async (terminal) => {
        await crashedRun(
          { 'srv-mail:send_mail': true },
          { 'srv-mail:send_mail': false },
          { startedAt: now(), sessionId: 'cse_trial1' }
        );
        const events = promptEvents({ tools: [SEARCH] });
        if (terminal === 'cancelled')
          events.at(-1)!.payload = {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            terminal_reason: 'cancelled',
          };
        addTrial(events);
        account.listStatus = 500;
        await expect(drive(restoreClaudeAiConnectors(env))).resolves.toBe(true);
        expect(account.permissions).toEqual(account.original);
        expect(
          account.requests.some((request) =>
            request.path.startsWith('/v1/code/sessions/cse_trial1/events')
          )
        ).toBe(true);
        expect(
          account.requests.some((request) => request.path.includes('tags='))
        ).toBe(false);
        expect(host.commands).toEqual([]);
        await expect(stat(journal())).rejects.toMatchObject({ code: 'ENOENT' });
      }
    );

    it('returns false without contacting Chrome when no run left a journal', async () => {
      await expect(
        drive(restoreClaudeAiConnectors({ MST_CLAUDE_AI_DEBUG_PORT: 'none' }))
      ).resolves.toBe(false);
      expect(devtools.sockets).toEqual([]);
      expect(account.requests).toEqual([]);
    });

    it('puts back only the journal values and removes the journal, touching nothing else', async () => {
      await crashedRun(
        {
          'srv-mail:send_mail': true,
          'srv-search:search': false,
          'srv-search:search:always': null,
        },
        {
          'srv-mail:send_mail': false,
          'srv-search:search': true,
          'srv-search:search:always': true,
        }
      );
      vi.stubEnv('MST_CLAUDE_AI_DEBUG_PORT', String(PORT));
      await expect(drive(restoreClaudeAiConnectors())).resolves.toBe(true);
      expect(account.permissions).toEqual(account.original);
      await expect(stat(journal())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(account.patches()).toEqual([
        {
          enabled_mcp_tools: {
            'srv-mail:send_mail': true,
            'srv-search:search': false,
            'srv-search:search:always': null,
          },
        },
      ]);
      // Only the account's permissions: no inventory, no session list, no app.
      expect(
        new Set(account.requests.map((r) => `${r.method} ${r.path}`))
      ).toEqual(new Set(['GET /api/bootstrap', 'PATCH /api/account/settings']));
      expect(host.commands).toEqual([]);
      const requests = account.requests.length;
      await pollMirror();
      expect(account.requests).toHaveLength(requests);
      await expect(stat(sessionsDir())).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('refuses another signed-in account or organization and keeps the journal', async () => {
      await crashedRun(
        { 'srv-mail:send_mail': true },
        { 'srv-mail:send_mail': false }
      );
      account.accountId = 'account-other';
      await expect(drive(restoreClaudeAiConnectors(env))).rejects.toThrow(
        'Claude account or organization changed; refusing a permission write.'
      );
      account.accountId = 'account-acme';
      account.cookie = 'lastActiveOrg=org-other';
      await expect(drive(restoreClaudeAiConnectors(env))).rejects.toThrow(
        'Claude account or organization changed; refusing a permission write.'
      );
      expect(account.patches()).toEqual([]);
      expect(account.permissions['srv-mail:send_mail']).toBe(false);
      await expect(stat(journal())).resolves.toBeDefined();
    });

    it('keeps a value someone changed since the run, restores the rest, and keeps the journal', async () => {
      await crashedRun(
        { 'srv-mail:send_mail': true, 'srv-calendar:list_events': null },
        { 'srv-mail:send_mail': false, 'srv-calendar:list_events': false }
      );
      // Someone enabled the calendar tool by hand after the crash.
      account.permissions['srv-calendar:list_events'] = true;
      await expect(drive(restoreClaudeAiConnectors(env))).rejects.toThrow(
        `Connector restore found 1 concurrent edits. Recovery journal retained at ${journal()}.`
      );
      expect(account.permissions).toEqual({
        ...account.original,
        'srv-calendar:list_events': true,
      });
      await expect(stat(journal())).resolves.toBeDefined();
    });

    it('keeps the journal when claude.ai does not keep the restored values', async () => {
      await crashedRun(
        { 'srv-mail:send_mail': true },
        { 'srv-mail:send_mail': false }
      );
      // claude.ai accepts the write, then the old value comes back.
      account.afterPatch = () => {
        account.permissions['srv-mail:send_mail'] = false;
      };
      const rejected = expect(restoreClaudeAiConnectors(env)).rejects.toThrow(
        'Claude did not persist the requested connector permissions.'
      );
      // Wait for the real journal read before spending the fake-timer budget.
      await vi.waitFor(() => expect(account.patches()).toHaveLength(1));
      await drive(rejected);
      // Two identity reads precede the ten persistence-verification reads.
      expect(
        account.requests.filter((request) => request.path === '/api/bootstrap')
      ).toHaveLength(12);
      expect(account.permissions['srv-mail:send_mail']).toBe(false);
      expect(account.patches()).toHaveLength(1);
      await expect(stat(journal())).resolves.toBeDefined();
    });
  });

  it('runs on macOS only', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    await expect(
      adapter().prepare({
        evalConfig: { name: 'acme-1p', datasets: [], servers: [SERVER] },
        env,
      })
    ).rejects.toThrow('runs on macOS only');
    expect(devtools.sockets).toEqual([]);
  });
});
