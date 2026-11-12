import { existsSync, statSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  CODEX_CLIENT,
  CODEX_ROLLOUT_TRACE_DIR,
  CodexClientSchema,
  codexConfigToml,
  codexMcpServers,
  codexRolloutTrace,
  codexServerKey,
} from './codexClient.js';
import { ARTIFACT_LIMITS } from './allArtifacts.js';
import { assertClientSupports, getClient } from './builtinClients.js';
import type { ClientRunContext } from './evalFrameworkTypes.js';
import type { EvalConfig } from './evalConfig.js';
import { endingOf } from './trialEnding.js';
import { hostTelemetryReceiver } from './telemetry/hostReceiver.js';

/** What the fake SDK saw, and how it behaves. */
const sdk = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  thread: undefined as Record<string, unknown> | undefined,
  input: undefined as string | undefined,
  config: undefined as string | undefined,
  homeMode: undefined as number | undefined,
  authCacheName: undefined as string | undefined,
  authCachePath: undefined as string | undefined,
  authCacheBefore: undefined as string | undefined,
  homeEntries: undefined as string[] | undefined,
  hang: false,
  /** Hang before the first turn starts, as a Codex stuck starting does. */
  hangBeforeTurn: undefined as boolean | undefined,
  fail: undefined as string | undefined,
  /** Fail before the first turn starts, as a Codex that can't start does. */
  failBeforeTurn: undefined as string | undefined,
  /** Fail the turn with this error, as Codex reports one, then exit 1. */
  turnFailed: undefined as string | undefined,
  /** Answer once before the turn fails. */
  actedFirst: undefined as boolean | undefined,
  /**
   * Export these events to the receiver the trial's config.toml names, as
   * Codex's `[otel]` exporter does, each with the thread's conversation ID.
   */
  hostEvents: undefined as
    | Array<{ name: string; attributes: Record<string, string> }>
    | undefined,
  /** Write no rollout trace, as a Codex older than 0.124 doesn't. */
  noTrace: undefined as boolean | undefined,
  /** Have the trace quote the model key, as a payload echoing it would. */
  traceQuotesKey: undefined as boolean | undefined,
  /** Hard-link the trial's config.toml into the trace, as a shell could. */
  traceLinksConfig: undefined as boolean | undefined,
}));

/** A rollout trace bundle as Codex writes one for a thread. */
async function writeTraceBundle(root: string, threadId: string) {
  const bundle = join(root, `trace-t1-${threadId}`);
  await mkdir(join(bundle, 'payloads'), { recursive: true });
  await writeFile(
    join(bundle, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      trace_id: 't1',
      rollout_id: threadId,
      root_thread_id: threadId,
      raw_event_log: 'trace.jsonl',
      payloads_dir: 'payloads',
    })
  );
  await writeFile(
    join(bundle, 'trace.jsonl'),
    `${JSON.stringify({
      seq: 1,
      payload: {
        type: 'inference_started',
        request_payload: {
          kind: { type: 'inference_request' },
          path: 'payloads/1.json',
        },
      },
    })}\n`
  );
  await writeFile(
    join(bundle, 'payloads', '1.json'),
    JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }],
    })
  );
  return bundle;
}

/**
 * The trace directories trials left. A trial's trace is temporary: MST removes
 * it after copying, so a test that runs the client alone removes it here.
 */
const clientTraceDirs: string[] = [];

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: Record<string, unknown>) {
      sdk.options = options;
    }
    startThread(thread: Record<string, unknown>) {
      sdk.thread = thread;
      return {
        async runStreamed(input: string, turn: { signal?: AbortSignal }) {
          sdk.input = input;
          const env = sdk.options!.env as Record<string, string>;
          sdk.config = await readFile(
            join(env.CODEX_HOME!, 'config.toml'),
            'utf8'
          );
          sdk.homeMode = statSync(join(env.CODEX_HOME!, 'config.toml')).mode;
          if (env.CODEX_ROLLOUT_TRACE_ROOT && !sdk.noTrace) {
            clientTraceDirs.push(join(env.CODEX_ROLLOUT_TRACE_ROOT, '..'));
            const bundle = await writeTraceBundle(
              env.CODEX_ROLLOUT_TRACE_ROOT,
              'thread-9'
            );
            if (sdk.traceQuotesKey)
              await writeFile(
                join(bundle, 'payloads', '2.json'),
                JSON.stringify({ echoed: `Bearer ${env.MST_CODEX_API_KEY}` })
              );
            if (sdk.traceLinksConfig)
              await link(
                join(env.CODEX_HOME!, 'config.toml'),
                join(bundle, 'payloads', 'config.toml')
              );
          }
          if (sdk.authCacheName) {
            // Simulate a managed helper with a fake credential, never a real
            // sign-in or model call. It discovers its cache through HOME.
            sdk.homeEntries = await readdir(env.HOME!);
            sdk.authCachePath = await realpath(
              join(env.HOME!, sdk.authCacheName)
            );
            const cacheFile = join(sdk.authCachePath, 'credentials.json');
            sdk.authCacheBefore = await readFile(cacheFile, 'utf8').catch(
              () => undefined
            );
            await writeFile(cacheFile, 'test-only-auth-fixture', {
              mode: 0o600,
            });
          }
          const sessions = join(
            env.CODEX_HOME!,
            'sessions',
            '2026',
            '10',
            '29'
          );
          await mkdir(sessions, { recursive: true });
          await writeFile(
            join(sessions, 'rollout-2026-10-29T10-00-00-thread-9.jsonl'),
            [
              { type: 'turn_context', payload: { model: 'gpt-5.5' } },
              {
                type: 'response_item',
                payload: {
                  type: 'function_call',
                  namespace: 'mcp__notes',
                  name: 'search',
                  call_id: 'call_1',
                },
              },
              {
                type: 'token_usage_record',
                payload: {
                  response_id: 'resp_1',
                  usage: { input_tokens: 10, output_tokens: 2 },
                },
              },
            ]
              .map((record) =>
                JSON.stringify({
                  timestamp: new Date().toISOString(),
                  ...record,
                })
              )
              .join('\n')
          );
          async function* events() {
            yield { type: 'thread.started', thread_id: 'thread-9' };
            if (sdk.failBeforeTurn) throw new Error(sdk.failBeforeTurn);
            if (sdk.hangBeforeTurn)
              await new Promise((_, reject) =>
                turn.signal?.addEventListener('abort', () =>
                  reject(new Error('aborted'))
                )
              );
            yield { type: 'turn.started' };
            if (sdk.hostEvents) {
              const otel = parse(sdk.config!).otel as {
                exporter: { 'otlp-http': { endpoint: string } };
              };
              const str = (v: string) => ({ stringValue: v });
              const response = await fetch(
                otel.exporter['otlp-http'].endpoint,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    resourceLogs: [
                      {
                        resource: {
                          attributes: [
                            { key: 'service.name', value: str('codex') },
                          ],
                        },
                        scopeLogs: [
                          {
                            logRecords: sdk.hostEvents.map((event) => ({
                              timeUnixNano: `${Date.now()}000000`,
                              body: str('codex_otel::otel_event_manager'),
                              attributes: [
                                { key: 'event.name', value: str(event.name) },
                                {
                                  key: 'conversation.id',
                                  value: str('thread-9'),
                                },
                                ...Object.entries(event.attributes).map(
                                  ([key, v]) => ({ key, value: str(v) })
                                ),
                              ],
                            })),
                          },
                        ],
                      },
                    ],
                  }),
                }
              );
              if (!response.ok)
                throw new Error(`receiver answered ${response.status}`);
            }
            if (sdk.fail) throw new Error(sdk.fail);
            if (sdk.turnFailed !== undefined) {
              if (sdk.actedFirst)
                yield {
                  type: 'item.completed',
                  item: { id: 'item_0', type: 'agent_message', text: 'Hm.' },
                };
              yield { type: 'turn.failed', error: { message: sdk.turnFailed } };
              throw new Error('Codex Exec exited with code 1');
            }
            if (sdk.hang)
              await new Promise((_, reject) =>
                turn.signal?.addEventListener('abort', () =>
                  reject(new Error('aborted'))
                )
              );
            yield {
              type: 'item.completed',
              item: {
                id: 'item_1',
                type: 'mcp_tool_call',
                server: 'notes',
                tool: 'search',
                arguments: { q: 'x' },
                result: { content: [{ type: 'text', text: 'hit' }] },
                status: 'completed',
              },
            };
            yield {
              type: 'item.completed',
              item: { id: 'item_2', type: 'agent_message', text: 'Done.' },
            };
            yield {
              type: 'turn.completed',
              usage: {
                input_tokens: 10,
                cached_input_tokens: 4,
                output_tokens: 2,
              },
            };
          }
          return { events: events() };
        },
      };
    }
  },
}));

const servers: MCPConfig[] = [
  {
    transport: 'stdio',
    label: 'notes',
    command: 'node',
    args: ['server.js'],
    env: { NOTES_TOKEN: 'stdio-secret' },
  },
  {
    transport: 'http',
    label: 'glean.eval',
    serverUrl: 'http://127.0.0.1:9/mcp',
    headers: { 'X-Tenant': 't1' },
    auth: { accessToken: 'http-secret' },
    connectTimeoutMs: 5000,
    callTimeoutMs: 600_000,
  },
];

const evalConfig = { name: 'e', datasets: [] } as unknown as EvalConfig;

function context(env: Record<string, string> = {}): ClientRunContext {
  return { evalConfig, env };
}

const GATEWAY = {
  OPENAI_BASE_URL: 'https://gateway.example/v1',
  OPENAI_API_KEY: 'sk-gateway',
};

beforeEach(() => {
  for (const key of Object.keys(sdk) as Array<keyof typeof sdk>)
    (sdk as Record<string, unknown>)[key] = key === 'hang' ? false : undefined;
});

afterEach(async () => {
  for (const dir of clientTraceDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe('codex-cli client options', () => {
  it('is a built-in, headless client with a structured transcript', () => {
    expect(getClient('codex-cli')).toBe(CODEX_CLIENT);
    expect(CODEX_CLIENT).toMatchObject({
      evidence: 'structured',
      headless: true,
    });
    // It connects to its servers, so variants reach it through MST's proxy.
    expect(CODEX_CLIENT.toolMetadata).toBeUndefined();
    expect(CODEX_CLIENT.toolSurfaceProxy).toBeUndefined();
  });

  it('takes its options and refuses others', () => {
    expect(
      CodexClientSchema.parse({
        type: 'codex-cli',
        model: 'gpt-5.5',
        timeout: 1000,
        reasoningEffort: 'high',
        sandbox: 'read-only',
        webSearch: false,
        systemPrompt: 'Be brief.',
        authCacheDirectories: { '.example-gateway': join(tmpdir(), 'cache') },
      })
    ).toMatchObject({ model: 'gpt-5.5', reasoningEffort: 'high' });
    expect(() =>
      CodexClientSchema.parse({ type: 'codex-cli', bogus: 1 })
    ).toThrow(/bogus/);
    expect(() =>
      CodexClientSchema.parse({ type: 'codex-cli', sandbox: 'none' })
    ).toThrow();
    expect(
      CodexClientSchema.parse({ type: 'codex-cli', rolloutTrace: false })
    ).toMatchObject({ rolloutTrace: false });
    expect(() =>
      CodexClientSchema.parse({ type: 'codex-cli', rolloutTrace: 'yes' })
    ).toThrow();
  });

  it("refuses connection settings it can't forward, before anything runs", () => {
    const oauth: MCPConfig = {
      transport: 'http',
      label: 'x',
      serverUrl: 'https://x.example/mcp',
      auth: { oauth: { serverUrl: 'https://x.example', scopes: ['a'] } },
    };
    expect(() =>
      assertClientSupports(
        { type: 'codex-cli' },
        { servers: [oauth], context: 'eval "e"' }
      )
    ).toThrow(`eval "e": codex-cli can't take oauth for server x.`);
    // An access token from the environment is resolved just before the run.
    const fromEnv: MCPConfig = {
      transport: 'http',
      serverUrl: 'https://x.example/mcp',
      auth: { accessTokenEnv: 'X_TOKEN' },
    };
    expect(() =>
      assertClientSupports(
        { type: 'codex-cli' },
        { servers: [fromEnv], context: 'eval "e"' }
      )
    ).not.toThrow();
    expect(() => codexMcpServers([fromEnv], 1000)).toThrow(
      /unresolved accessTokenEnv/
    );
  });
});

describe('codex config', () => {
  it('keys servers as Codex accepts and maps them back to labels', () => {
    expect(codexServerKey('glean.eval', new Set())).toBe('glean_eval');
    expect(codexServerKey('a b', new Set(['a_b']))).toBe('a_b_2');
    const { config, labels } = codexMcpServers(servers, 300_000);
    expect([...labels]).toEqual([
      ['notes', 'notes'],
      ['glean_eval', 'glean.eval'],
    ]);
    expect(config).toEqual({
      notes: {
        command: 'node',
        args: ['server.js'],
        env: { NOTES_TOKEN: 'stdio-secret' },
        required: true,
        startup_timeout_sec: 60,
        tool_timeout_sec: 300,
        default_tools_approval_mode: 'approve',
      },
      glean_eval: {
        url: 'http://127.0.0.1:9/mcp',
        http_headers: {
          'X-Tenant': 't1',
          Authorization: 'Bearer http-secret',
        },
        required: true,
        startup_timeout_sec: 5,
        tool_timeout_sec: 600,
        default_tools_approval_mode: 'approve',
      },
    });
  });

  it('points Codex at a gateway over HTTPS and turns off what would leak into results', () => {
    const toml = parse(
      codexConfigToml({
        baseURL: 'https://gateway.example/v1',
        systemPrompt: 'Be brief.',
        mcpServers: {},
      })
    );
    expect(toml).toMatchObject({
      model_provider: 'mst',
      model_providers: {
        mst: {
          base_url: 'https://gateway.example/v1',
          env_key: 'MST_CODEX_API_KEY',
          wire_api: 'responses',
          supports_websockets: false,
        },
      },
      developer_instructions: 'Be brief.',
      check_for_update_on_startup: false,
      history: { persistence: 'none' },
      features: { plugins: false, apps: false, memories: false },
      skills: { bundled: { enabled: false } },
      shell_environment_policy: { inherit: 'core' },
      otel: { exporter: 'none', metrics_exporter: 'none' },
    });
    // OpenAI's own API: Codex's built-in provider.
    expect(
      parse(codexConfigToml({ mcpServers: {} })).model_provider
    ).toBeUndefined();
  });

  it("exports Codex's telemetry to MST's receiver for telemetry.host", () => {
    const toml = parse(
      codexConfigToml({
        mcpServers: {},
        receiver: {
          endpoint: 'http://127.0.0.1:4318/secret',
          port: 4318,
          content: false,
          traces: true,
          collect: async () => undefined,
          close: async () => {},
        },
      })
    );
    expect(toml.otel).toEqual({
      environment: 'mst',
      log_user_prompt: false,
      exporter: {
        'otlp-http': {
          endpoint: 'http://127.0.0.1:4318/secret/v1/logs',
          protocol: 'json',
        },
      },
      metrics_exporter: {
        'otlp-http': {
          endpoint: 'http://127.0.0.1:4318/secret/v1/metrics',
          protocol: 'json',
        },
      },
      trace_exporter: {
        'otlp-http': {
          endpoint: 'http://127.0.0.1:4318/secret/v1/traces',
          protocol: 'json',
        },
      },
    });
  });
});

describe('codex-cli client run', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'mst-codex-test-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('runs one turn in a private CODEX_HOME and returns its transcript', async () => {
    const result = await CODEX_CLIENT.run!(
      { prompt: 'Find x', servers: [servers[0]!], env: { EXTRA: '1' } },
      {
        type: 'codex-cli',
        model: 'gpt-5.5',
        reasoningEffort: 'low',
        env: { MY_FLAG: 'on' },
      },
      context(GATEWAY)
    );
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('Done.');
    expect(result.events).toMatchObject([
      {
        kind: 'tool_call',
        source: 'mcp',
        server: 'notes',
        name: 'search',
        id: 'call_1',
        output: 'hit',
      },
    ]);
    expect(result.modelCalls).toMatchObject([
      { id: 'resp_1', model: 'gpt-5.5', toolCallIds: ['call_1'] },
    ]);
    expect(result.usage).toMatchObject({
      inputTokens: 6,
      cacheReadInputTokens: 4,
      outputTokens: 2,
    });
    expect(sdk.input).toBe('Find x');
    expect(sdk.thread).toMatchObject({
      model: 'gpt-5.5',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      webSearchMode: 'disabled',
      networkAccessEnabled: false,
      modelReasoningEffort: 'low',
    });
    // The credential is in the environment Codex reads, never in its arguments.
    const env = sdk.options!.env as Record<string, string>;
    expect(env.MST_CODEX_API_KEY).toBe('sk-gateway');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.EXTRA).toBeUndefined();
    expect(env.MY_FLAG).toBe('on');
    expect(env.HOME).toBe(env.CODEX_HOME);
    expect(sdk.options).not.toHaveProperty('config');
    expect(sdk.config).toContain('base_url = "https://gateway.example/v1"');
    expect(sdk.homeMode! & 0o077).toBe(0);
    // The trial's home and working directory are gone.
    expect(existsSync(env.CODEX_HOME!)).toBe(false);
    expect(existsSync(String(sdk.thread!.workingDirectory))).toBe(false);
    // The rollout trace is kept by default, as a copy: Codex's is gone.
    expect(existsSync(env.CODEX_ROLLOUT_TRACE_ROOT!)).toBe(false);
    expect(result.artifacts?.include).toEqual([CODEX_ROLLOUT_TRACE_DIR]);
    expect(result.telemetry!.rolloutTrace).toMatchObject({ bundles: 1 });
    await rm(result.artifacts!.dir, { recursive: true, force: true });
  });

  it('keeps no rollout trace with rolloutTrace false', async () => {
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli', rolloutTrace: false },
      context(GATEWAY)
    );
    const env = sdk.options!.env as Record<string, string>;
    expect(env).not.toHaveProperty('CODEX_ROLLOUT_TRACE_ROOT');
    expect(result).not.toHaveProperty('artifacts');
    expect(result.telemetry).not.toHaveProperty('rolloutTrace');
  });

  it('reuses opted-in auth state without reusing trial configuration or HOME', async () => {
    const cache = join(cwd, 'persistent-auth');
    const options = {
      type: 'codex-cli',
      authCacheDirectories: { '.example-gateway': cache },
    };
    sdk.authCacheName = '.example-gateway';
    await CODEX_CLIENT.run!(
      { prompt: 'Find x', servers: [servers[0]!] },
      options,
      context(GATEWAY)
    );
    const firstHome = (sdk.options!.env as Record<string, string>).HOME!;
    expect(sdk.authCacheBefore).toBeUndefined();
    expect(existsSync(firstHome)).toBe(false);
    expect(await readFile(join(cache, 'credentials.json'), 'utf8')).toBe(
      'test-only-auth-fixture'
    );
    await CODEX_CLIENT.run!(
      { prompt: 'Find y', servers: [servers[0]!] },
      options,
      context(GATEWAY)
    );
    const env = sdk.options!.env as Record<string, string>;
    expect(env.HOME).not.toBe(firstHome);
    expect(env.HOME).toBe(env.CODEX_HOME);
    expect(sdk.authCacheBefore).toBe('test-only-auth-fixture');
    expect(sdk.authCachePath).toBe(await realpath(cache));
    expect(sdk.homeEntries?.sort()).toEqual([
      '.example-gateway',
      'config.toml',
    ]);
    expect(parse(sdk.config!)).toMatchObject({
      features: { plugins: false, apps: false, memories: false },
      skills: { bundled: { enabled: false } },
      history: { persistence: 'none' },
    });
    expect(existsSync(env.HOME!)).toBe(false);
    expect(existsSync(join(cache, 'credentials.json'))).toBe(true);
  });

  it('keeps the opted-in auth cache when the Codex process fails', async () => {
    const cache = join(cwd, 'persistent-auth');
    sdk.authCacheName = '.example-gateway';
    sdk.fail = 'offline test failure';
    const result = await CODEX_CLIENT.run!(
      { prompt: 'Find x', servers: [servers[0]!] },
      {
        type: 'codex-cli',
        authCacheDirectories: { '.example-gateway': cache },
      },
      context(GATEWAY)
    );
    expect(result.error).toContain('offline test failure');
    const env = sdk.options!.env as Record<string, string>;
    expect(existsSync(env.HOME!)).toBe(false);
    expect(await readFile(join(cache, 'credentials.json'), 'utf8')).toBe(
      'test-only-auth-fixture'
    );
  });

  it('keeps the opted-in auth cache when the trial times out', async () => {
    const cache = join(cwd, 'persistent-auth');
    sdk.authCacheName = '.example-gateway';
    sdk.hang = true;
    const result = await CODEX_CLIENT.run!(
      { prompt: 'Find x', servers: [servers[0]!] },
      {
        type: 'codex-cli',
        timeout: 200,
        authCacheDirectories: { '.example-gateway': cache },
      },
      context(GATEWAY)
    );
    expect(result.error).toContain('timed out');
    const env = sdk.options!.env as Record<string, string>;
    expect(existsSync(env.HOME!)).toBe(false);
    expect(await readFile(join(cache, 'credentials.json'), 'utf8')).toBe(
      'test-only-auth-fixture'
    );
  });

  it("gives its model calls the request IDs the host's events name them by, as Cowork and Claude Code do", async () => {
    // Codex 0.160's own `codex.api_request` carries no request or response
    // ID; these are the attributes an event would need for the join.
    sdk.hostEvents = [
      {
        name: 'codex.api_request',
        attributes: { request_id: 'req_9', response_id: 'resp_1' },
      },
      { name: 'codex.api_request', attributes: { request_id: 'req_other' } },
    ];
    try {
      const result = await CODEX_CLIENT.run!(
        { prompt: 'Find x', servers: [servers[0]!] },
        { type: 'codex-cli', model: 'gpt-5.5' },
        {
          evalConfig: { ...evalConfig, telemetry: { host: {} } },
          env: GATEWAY,
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.hostTelemetry?.events.map((event) => event.name)).toEqual([
        'codex.api_request',
        'codex.api_request',
      ]);
      expect(result.modelCalls).toMatchObject([
        { id: 'resp_1', requestId: 'req_9' },
      ]);
    } finally {
      // The process-wide receiver the trial started.
      await (await hostTelemetryReceiver({}, { env: GATEWAY })).close();
    }
  });

  it.each([
    [undefined, 300],
    [1_234, 1.234],
  ])(
    'uses timeout %s for the trial and its default tool deadline',
    async (timeout, seconds) => {
      await CODEX_CLIENT.run!(
        { prompt: 'x', servers: [servers[0]!] },
        { type: 'codex-cli', ...(timeout === undefined ? {} : { timeout }) },
        context(GATEWAY)
      );
      expect(parse(sdk.config!)).toMatchObject({
        mcp_servers: { notes: { tool_timeout_sec: seconds } },
      });
    }
  );

  it('gives Codex the reasoningEffort set, and rejects one it lacks before Codex starts', async () => {
    await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli', reasoningEffort: 'minimal' },
      context(GATEWAY)
    );
    expect(sdk.thread).toMatchObject({ modelReasoningEffort: 'minimal' });
    sdk.thread = undefined;
    await expect(
      CODEX_CLIENT.run!(
        { prompt: 'x', servers: [] },
        { type: 'codex-cli', reasoningEffort: 'max' },
        context(GATEWAY)
      )
    ).rejects.toThrow(
      "codex-cli doesn't support reasoningEffort `max`: it accepts minimal, low, medium, high, xhigh."
    );
    expect(sdk.thread).toBeUndefined();
  });

  it('runs in a given cwd, and keeps it', async () => {
    await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli', cwd },
      context(GATEWAY)
    );
    expect(sdk.thread!.workingDirectory).toBe(cwd);
    expect(existsSync(cwd)).toBe(true);
  });

  it('reports the rollout trace Codex wrote as the trial artifacts', async () => {
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      {
        type: 'codex-cli',
        // MST's trace root wins over one the client's env sets.
        env: { CODEX_ROLLOUT_TRACE_ROOT: join(cwd, 'elsewhere') },
      },
      context(GATEWAY)
    );
    try {
      const env = sdk.options!.env as Record<string, string>;
      expect(result.artifacts).toEqual({
        dir: expect.any(String),
        include: [CODEX_ROLLOUT_TRACE_DIR],
        temporary: true,
      });
      const dir = result.artifacts!.dir;
      expect(env.CODEX_ROLLOUT_TRACE_ROOT).not.toBe(join(cwd, 'elsewhere'));
      expect(existsSync(join(cwd, 'elsewhere'))).toBe(false);
      // The copy outlives the trial's home and Codex's trace directory: MST
      // copies it for the judges, then removes it.
      expect(existsSync(env.CODEX_HOME!)).toBe(false);
      expect(existsSync(env.CODEX_ROLLOUT_TRACE_ROOT!)).toBe(false);
      expect(
        JSON.parse(
          await readFile(
            join(
              dir,
              CODEX_ROLLOUT_TRACE_DIR,
              'trace-t1-thread-9',
              'payloads',
              '1.json'
            ),
            'utf8'
          )
        )
      ).toMatchObject({ model: 'gpt-5.5' });
      expect(result.telemetry!.rolloutTrace).toEqual({
        bundles: 1,
        files: 3,
        bytes: expect.any(Number),
      });
    } finally {
      if (result.artifacts)
        await rm(result.artifacts.dir, { recursive: true, force: true });
    }
  });

  it('replaces the credentials MST knows in the trace it keeps', async () => {
    sdk.traceQuotesKey = true;
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli' },
      context(GATEWAY)
    );
    try {
      const payload = await readFile(
        join(
          result.artifacts!.dir,
          CODEX_ROLLOUT_TRACE_DIR,
          'trace-t1-thread-9',
          'payloads',
          '2.json'
        ),
        'utf8'
      );
      expect(payload).not.toContain('sk-gateway');
      expect(JSON.parse(payload)).toEqual({ echoed: 'Bearer [REDACTED]' });
    } finally {
      if (result.artifacts)
        await rm(result.artifacts.dir, { recursive: true, force: true });
    }
  });

  it("keeps no trace with a hard link to the trial's config.toml", async () => {
    sdk.traceLinksConfig = true;
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli' },
      context(GATEWAY)
    );
    const env = sdk.options!.env as Record<string, string>;
    expect(result.error).toBeUndefined();
    expect(result).not.toHaveProperty('artifacts');
    expect(result.telemetry!.rolloutTrace).toEqual({
      bundles: 1,
      notKept:
        "The rollout trace holds an entry MST doesn't copy: trace-t1-thread-9/payloads/config.toml is a hard link.",
    });
    expect(existsSync(env.CODEX_HOME!)).toBe(false);
    expect(existsSync(join(env.CODEX_ROLLOUT_TRACE_ROOT!, '..'))).toBe(false);
  });

  it('says why there is no trace when Codex wrote none, and removes its directory', async () => {
    sdk.noTrace = true;
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli' },
      context(GATEWAY)
    );
    const env = sdk.options!.env as Record<string, string>;
    expect(result.error).toBeUndefined();
    expect(result).not.toHaveProperty('artifacts');
    expect(result.telemetry!.rolloutTrace).toEqual({
      bundles: 0,
      notKept: expect.stringMatching(/no rollout trace.*0\.124/),
    });
    expect(existsSync(join(env.CODEX_ROLLOUT_TRACE_ROOT!, '..'))).toBe(false);
  });

  it('keeps the trace of a trial that timed out', async () => {
    sdk.hang = true;
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli', timeout: 50 },
      context(GATEWAY)
    );
    try {
      expect(result.error).toMatch(/timed out/);
      expect(result.artifacts?.include).toEqual([CODEX_ROLLOUT_TRACE_DIR]);
      expect(result.telemetry!.rolloutTrace).toMatchObject({ bundles: 1 });
    } finally {
      if (result.artifacts)
        await rm(result.artifacts.dir, { recursive: true, force: true });
    }
  });

  it('uses the built-in OpenAI provider without a base URL', async () => {
    await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli' },
      context({ OPENAI_API_KEY: 'sk-openai', OPENAI_BASE_URL: '' })
    );
    const env = sdk.options!.env as Record<string, string>;
    expect(env.CODEX_API_KEY).toBe('sk-openai');
    expect(sdk.config).not.toContain('model_provider');
    expect(sdk.thread).not.toHaveProperty('model');
  });

  it('needs a model credential', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        CODEX_CLIENT.run!(
          { prompt: 'x', servers: [] },
          { type: 'codex-cli' },
          context({})
        )
      ).rejects.toThrow(/requires an API key/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it('times out, keeping what Codex reported', async () => {
    sdk.hang = true;
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli', timeout: 50 },
      context(GATEWAY)
    );
    expect(result.error).toBe('codex-cli client timed out after 50 ms.');
    expect(result.diagnostics).toEqual({ failureKind: 'timeout' });
    // The case's own time ran out: a trial that failed (ADR 0010).
    expect(result.ending).toEqual({ kind: 'trial' });
  });

  it('is not a trial when the deadline comes before the turn started', async () => {
    sdk.hangBeforeTurn = true;
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli', timeout: 50 },
      context(GATEWAY)
    );
    expect(result.error).toBe('codex-cli client timed out after 50 ms.');
    expect(result.ending).toBeUndefined();
    expect(result.diagnostics).toEqual({ failureKind: 'timeout' });
  });

  it('reports a failed Codex process without its secrets', async () => {
    sdk.fail = 'boom: Bearer sk-gateway rejected';
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli' },
      context(GATEWAY)
    );
    expect(result.error).toContain('Codex exited with an error: boom');
    expect(result.error).not.toContain('sk-gateway');
    expect(result.diagnostics).toEqual({ failureKind: 'process' });
    // Codex itself failed: the failure kind says so (ADR 0010).
    expect(result.ending).toBeUndefined();
  });

  // How a failed turn ended (ADR 0010), from the error Codex reported.
  it.each([
    [
      'a context overflow before the model acted',
      'Your input exceeds the context window of this model.',
      false,
      { kind: 'infrastructure', broke: 'setup', retryable: false },
    ],
    [
      'a context overflow after it acted',
      'Your input exceeds the context window of this model.',
      true,
      { kind: 'trial' },
    ],
    [
      'a rate limit',
      'exceeded retry limit, last status: 429 Too Many Requests',
      true,
      { kind: 'infrastructure', broke: 'provider', retryable: true },
    ],
    [
      'a server error',
      'unexpected status 503 Service Unavailable: upstream',
      false,
      { kind: 'infrastructure', broke: 'provider', retryable: true },
    ],
    [
      'a key the provider rejects',
      'unexpected status 401 Unauthorized: invalid key',
      false,
      { kind: 'infrastructure', broke: 'setup', retryable: false },
    ],
  ])('types %s', async (_, message, acted, expected) => {
    sdk.turnFailed = message;
    sdk.actedFirst = acted;
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli' },
      context(GATEWAY)
    );
    expect(result.error).toContain('Codex exited with an error');
    expect(result.ending).toMatchObject(expected);
  });

  it('is a startup failure when Codex fails before its turn starts', async () => {
    sdk.failBeforeTurn = 'spawn codex ENOENT';
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli' },
      context(GATEWAY)
    );
    expect(result.diagnostics).toEqual({ failureKind: 'startup' });
    expect(result.ending).toBeUndefined();
    expect(endingOf(result)).toMatchObject({
      kind: 'infrastructure',
      broke: 'client-app',
      retryable: true,
    });
  });

  it('leaves a failed turn it cannot name to the failure kind', async () => {
    sdk.turnFailed = 'The model refused: line 500 of the plan.';
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex-cli' },
      context(GATEWAY)
    );
    expect(result.ending).toBeUndefined();
    expect(result.diagnostics).toEqual({ failureKind: 'process' });
  });
});

describe('codex-cli rollout trace', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mst-codex-trace-test-'));
    await writeTraceBundle(join(dir, CODEX_ROLLOUT_TRACE_DIR), 'thread-9');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const bundle = () => join(dir, CODEX_ROLLOUT_TRACE_DIR, 'trace-t1-thread-9');
  const copied = async (
    trace: Awaited<ReturnType<typeof codexRolloutTrace>>,
    file: string
  ) =>
    readFile(
      join(
        trace.artifacts!.dir,
        CODEX_ROLLOUT_TRACE_DIR,
        'trace-t1-thread-9',
        file
      ),
      'utf8'
    );

  it('keeps a copy of a trace that fits what the copy of a trial artifacts may hold', async () => {
    const trace = await codexRolloutTrace(dir);
    try {
      expect(trace).toEqual({
        artifacts: {
          dir: expect.any(String),
          include: [CODEX_ROLLOUT_TRACE_DIR],
          temporary: true,
        },
        telemetry: { bundles: 1, files: 3, bytes: expect.any(Number) },
      });
      expect(trace.artifacts!.dir).not.toBe(dir);
      expect(JSON.parse(await copied(trace, 'payloads/1.json'))).toMatchObject({
        model: 'gpt-5.5',
      });
      expect(
        statSync(
          join(
            trace.artifacts!.dir,
            CODEX_ROLLOUT_TRACE_DIR,
            'trace-t1-thread-9',
            'trace.jsonl'
          )
        ).mode & 0o077
      ).toBe(0);
    } finally {
      await rm(trace.artifacts!.dir, { recursive: true, force: true });
    }
  });

  it('replaces secrets as written and as JSON escapes them, and counts the bytes it wrote', async () => {
    const quoted = 'pa"ss\\word-1234';
    await writeFile(
      join(bundle(), 'payloads', '2.json'),
      JSON.stringify({ header: 'Bearer sk-secret-123456', quoted })
    );
    const trace = await codexRolloutTrace(dir, {
      secrets: ['sk-secret-123456', quoted],
    });
    try {
      expect(JSON.parse(await copied(trace, 'payloads/2.json'))).toEqual({
        header: 'Bearer [REDACTED]',
        quoted: '[REDACTED]',
      });
      // Codex's files are the caller's, as they were.
      expect(
        await readFile(join(bundle(), 'payloads', '2.json'), 'utf8')
      ).toContain('sk-secret-123456');
      let written = 0;
      for (const file of [
        'manifest.json',
        'trace.jsonl',
        'payloads/1.json',
        'payloads/2.json',
      ])
        written += Buffer.byteLength(await copied(trace, file));
      expect(trace.telemetry).toEqual({ bundles: 1, files: 4, bytes: written });
    } finally {
      await rm(trace.artifacts!.dir, { recursive: true, force: true });
    }
  });

  it('keeps no trace with a hard link, which would copy what it links to', async () => {
    await writeFile(join(dir, 'config.toml'), 'api_key = "sk-secret"');
    await link(
      join(dir, 'config.toml'),
      join(bundle(), 'payloads', 'config.toml')
    );
    expect(await codexRolloutTrace(dir)).toEqual({
      telemetry: {
        bundles: 1,
        notKept:
          "The rollout trace holds an entry MST doesn't copy: trace-t1-thread-9/payloads/config.toml is a hard link.",
      },
    });
  });

  it('keeps no trace whose root is a symbolic link, which could lead anywhere', async () => {
    const root = join(dir, CODEX_ROLLOUT_TRACE_DIR);
    await rename(root, join(dir, 'elsewhere'));
    await symlink(join(dir, 'elsewhere'), root);
    expect(await codexRolloutTrace(dir)).toEqual({
      telemetry: {
        bundles: 1,
        notKept:
          "The rollout trace holds an entry MST doesn't copy: the trace root is a symbolic link.",
      },
    });
  });

  it('says Codex wrote no trace only when the trace root is missing', async () => {
    await rm(join(dir, CODEX_ROLLOUT_TRACE_DIR), { recursive: true });
    expect(await codexRolloutTrace(dir)).toEqual({
      telemetry: {
        bundles: 0,
        notKept: expect.stringMatching(/no rollout trace.*0\.124/),
      },
    });
  });

  it("says MST couldn't read a trace root that isn't a directory", async () => {
    const root = join(dir, CODEX_ROLLOUT_TRACE_DIR);
    await rm(root, { recursive: true });
    await writeFile(root, '');
    expect(await codexRolloutTrace(dir)).toEqual({
      telemetry: {
        notKept: expect.stringMatching(
          /^MST couldn't read the rollout trace: ENOTDIR/
        ),
      },
    });
  });

  it('leaves out a symbolic link, as the artifact copy does', async () => {
    await writeFile(join(dir, 'config.toml'), 'api_key = "sk-secret"');
    await symlink(
      join(dir, 'config.toml'),
      join(bundle(), 'payloads', 'config.toml')
    );
    const trace = await codexRolloutTrace(dir);
    try {
      expect(trace.telemetry).toMatchObject({ bundles: 1, files: 3 });
      expect(
        existsSync(
          join(
            trace.artifacts!.dir,
            CODEX_ROLLOUT_TRACE_DIR,
            'trace-t1-thread-9',
            'payloads',
            'config.toml'
          )
        )
      ).toBe(false);
    } finally {
      await rm(trace.artifacts!.dir, { recursive: true, force: true });
    }
  });

  // Root reads any file, whatever its mode.
  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    "says MST couldn't read a trace it couldn't read, not that it was too large",
    async () => {
      await chmod(join(bundle(), 'payloads', '1.json'), 0o000);
      const { artifacts, telemetry } = await codexRolloutTrace(dir);
      expect(artifacts).toBeUndefined();
      expect(telemetry).toEqual({
        bundles: 1,
        notKept: expect.stringMatching(
          /^MST couldn't read the rollout trace: EACCES/
        ),
      });
      expect(telemetry.notKept).not.toMatch(/larger/);
    }
  );

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    "says MST couldn't read a trace root it couldn't list, not that Codex wrote none",
    async () => {
      const root = join(dir, CODEX_ROLLOUT_TRACE_DIR);
      await chmod(root, 0o000);
      try {
        const { artifacts, telemetry } = await codexRolloutTrace(dir);
        expect(artifacts).toBeUndefined();
        expect(telemetry).toEqual({
          notKept: expect.stringMatching(
            /^MST couldn't read the rollout trace: EACCES/
          ),
        });
      } finally {
        await chmod(root, 0o700);
      }
    }
  );

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    "says MST couldn't read a bundle whose manifest it couldn't look for",
    async () => {
      await chmod(bundle(), 0o000);
      try {
        const { artifacts, telemetry } = await codexRolloutTrace(dir);
        expect(artifacts).toBeUndefined();
        expect(telemetry).toEqual({
          notKept: expect.stringMatching(
            /^MST couldn't read the rollout trace: EACCES/
          ),
        });
      } finally {
        await chmod(bundle(), 0o700);
      }
    }
  );

  it.each([
    [{ fileBytes: 5 }, /is larger than 5 bytes/],
    [{ totalBytes: 100 }, /holds more than 100 bytes/],
    [{ entries: 3 }, /more than 3 entries/],
    [{ depth: 2 }, /more than 2 directories deep/],
  ])(
    'does not keep a trace over a limit (%o), and says which',
    async (limit, reason) => {
      const { artifacts, telemetry } = await codexRolloutTrace(dir, {
        limits: { ...ARTIFACT_LIMITS, ...limit },
      });
      expect(artifacts).toBeUndefined();
      expect(telemetry).toEqual({
        bundles: 1,
        notKept: expect.stringMatching(
          new RegExp(
            `^The rollout trace is larger than a trial's artifacts may be: .*${reason.source}`
          )
        ),
      });
    }
  );
});
