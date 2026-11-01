import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  CODEX_CLIENT,
  CodexClientSchema,
  codexConfigToml,
  codexMcpServers,
  codexServerKey,
} from './codexClient.js';
import { assertClientSupports, getClient } from './builtinClients.js';
import type { ClientRunContext } from './evalFrameworkTypes.js';
import type { EvalConfig } from './evalConfig.js';
import { endingOf } from './trialEnding.js';

/** What the fake SDK saw, and how it behaves. */
const sdk = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  thread: undefined as Record<string, unknown> | undefined,
  input: undefined as string | undefined,
  config: undefined as string | undefined,
  homeMode: undefined as number | undefined,
  hang: false,
  fail: undefined as string | undefined,
  /** Fail before the first turn starts, as a Codex that can't start does. */
  failBeforeTurn: undefined as string | undefined,
  /** Fail the turn with this error, as Codex reports one, then exit 1. */
  turnFailed: undefined as string | undefined,
  /** Answer once before the turn fails. */
  actedFirst: undefined as boolean | undefined,
}));

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
            yield { type: 'turn.started' };
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

describe('codex client options', () => {
  it('is a built-in, headless client with a structured trace', () => {
    expect(getClient('codex')).toBe(CODEX_CLIENT);
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
        type: 'codex',
        model: 'gpt-5.5',
        timeout: 1000,
        reasoningEffort: 'high',
        sandbox: 'read-only',
        webSearch: false,
        systemPrompt: 'Be brief.',
      })
    ).toMatchObject({ model: 'gpt-5.5', reasoningEffort: 'high' });
    expect(() => CodexClientSchema.parse({ type: 'codex', bogus: 1 })).toThrow(
      /bogus/
    );
    expect(() =>
      CodexClientSchema.parse({ type: 'codex', sandbox: 'none' })
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
        { type: 'codex' },
        { servers: [oauth], context: 'eval "e"' }
      )
    ).toThrow(`eval "e": codex can't take oauth for server x.`);
    // An access token from the environment is resolved just before the run.
    const fromEnv: MCPConfig = {
      transport: 'http',
      serverUrl: 'https://x.example/mcp',
      auth: { accessTokenEnv: 'X_TOKEN' },
    };
    expect(() =>
      assertClientSupports(
        { type: 'codex' },
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

describe('codex client run', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'mst-codex-test-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('runs one turn in a private CODEX_HOME and returns its trace', async () => {
    const result = await CODEX_CLIENT.run!(
      { prompt: 'Find x', servers: [servers[0]!], env: { EXTRA: '1' } },
      {
        type: 'codex',
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
  });

  it('runs in a given cwd, and keeps it', async () => {
    await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex', cwd },
      context(GATEWAY)
    );
    expect(sdk.thread!.workingDirectory).toBe(cwd);
    expect(existsSync(cwd)).toBe(true);
  });

  it('uses the built-in OpenAI provider without a base URL', async () => {
    await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex' },
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
          { type: 'codex' },
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
      { type: 'codex', timeout: 50 },
      context(GATEWAY)
    );
    expect(result.error).toBe('codex client timed out after 50 ms.');
    expect(result.diagnostics).toEqual({ failureKind: 'timeout' });
  });

  it('reports a failed Codex process without its secrets', async () => {
    sdk.fail = 'boom: Bearer sk-gateway rejected';
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex' },
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
      { type: 'codex' },
      context(GATEWAY)
    );
    expect(result.error).toContain('Codex exited with an error');
    expect(result.ending).toMatchObject(expected);
  });

  it('is a startup failure when Codex fails before its turn starts', async () => {
    sdk.failBeforeTurn = 'spawn codex ENOENT';
    const result = await CODEX_CLIENT.run!(
      { prompt: 'x', servers: [] },
      { type: 'codex' },
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
      { type: 'codex' },
      context(GATEWAY)
    );
    expect(result.ending).toBeUndefined();
    expect(result.diagnostics).toEqual({ failureKind: 'process' });
  });
});
