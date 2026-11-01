/**
 * The `codex` client: OpenAI's Codex agent, run headless through
 * `@openai/codex-sdk` (which runs the Codex CLI's `codex exec`), with the
 * eval's servers as its MCP servers.
 *
 * Each trial gets a fresh, private CODEX_HOME (also its HOME) holding only
 * the `config.toml` MST writes: the model endpoint, the MCP servers and
 * their credentials, and settings that keep the operator's and OpenAI's
 * extras out of the result (no plugins, apps, memories, bundled skills,
 * history or update checks). Nothing secret is passed as an argument. The
 * trial runs in an empty working directory (or `cwd`), both removed after.
 *
 * The trace is Codex's own record (see codexTrace.ts): its streamed events,
 * and the session's rollout file for each model response's usage and the
 * tool searches it ran. Its model endpoint and credential come from
 * `resolveLLMEndpoint('openai')`: OPENAI_API_KEY, or OPENAI_BASE_URL with a
 * gateway token.
 */
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';
import { z } from 'zod';
import {
  isHttpConfig,
  mcpServerLabel,
  usesClientResolvedFields,
  type MCPConfig,
} from '../config/mcpConfig.js';
import { resolveLLMEndpoint } from '../llm/endpoint.js';
import { codexSandboxMode } from '../judge/agentic/codexSandbox.js';
import type { TrialEnding } from '../types/trialEnding.js';
import { contextOverflowEnding, infrastructureEnding } from './trialEnding.js';
import type { ClientDiagnostics } from '../types/index.js';
import { clientSecretValues, redactClientSecrets } from './clientSecrets.js';
import { buildCodexTrace, type TimedCodexEvent } from './codexTrace.js';
import type {
  ClientDefinition,
  ClientRunContext,
  ClientRunInput,
  ClientRunResult,
} from './evalFrameworkTypes.js';
import type { ClientConfig } from './evalConfig.js';
import {
  GenerationOptions,
  SystemPromptOption,
} from './mstClient/clientOptions.js';
import {
  hostTelemetryReceiver,
  type HostTelemetryReceiver,
} from './telemetry/hostReceiver.js';

/** How long a trial may run when the eval sets no `timeout`. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** How long Codex waits for an MCP server to start and list its tools. */
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
/** The environment variable Codex reads the model credential from. */
const API_KEY_ENV = 'MST_CODEX_API_KEY';
/** Variables of MST's environment Codex itself needs (never credentials). */
const PASSTHROUGH_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

export const CodexClientSchema = z
  .object({
    type: z.literal('codex').optional(),
    /** The model Codex runs. Without one, Codex's own default. */
    model: GenerationOptions.model,
    /** The trial's time limit in ms (default 300000). */
    timeout: GenerationOptions.timeout,
    /** Added to Codex's own instructions (`developer_instructions`), which stay. */
    systemPrompt: SystemPromptOption,
    reasoningEffort: z
      .enum(['minimal', 'low', 'medium', 'high', 'xhigh'])
      .optional(),
    /**
     * Codex's sandbox for its shell commands. Default: `read-only`, or
     * `danger-full-access` where MST_JUDGE_SANDBOX=container says the
     * machine is a disposable container (MST's Linux image), in which
     * Codex's own sandbox can't start.
     */
    sandbox: z
      .enum(['read-only', 'workspace-write', 'danger-full-access'])
      .optional(),
    /** Let Codex search the web (default false: answers come from the servers). */
    webSearch: z.boolean().optional(),
    /**
     * The directory Codex runs in, relative to the working directory of the
     * process running the eval. By default an empty temporary directory,
     * removed afterwards.
     */
    cwd: z.string().min(1).optional(),
    /** Read the model credential from this variable instead of OPENAI_API_KEY or a gateway. */
    apiKeyEnvVar: z.string().min(1).optional(),
    /** Extra environment variables for the Codex process (and its shell). */
    env: z.record(z.string(), z.string().optional()).optional(),
  })
  .strict();

type CodexClientOptions = z.infer<typeof CodexClientSchema>;

/** The part of `@openai/codex-sdk` the client uses. */
interface CodexSdk {
  Codex: new (options: {
    codexPathOverride?: string;
    env?: Record<string, string>;
  }) => {
    startThread(options: Record<string, unknown>): {
      runStreamed(
        input: string,
        options: { signal?: AbortSignal }
      ): Promise<{
        events: AsyncGenerator<{ type: string } & Record<string, unknown>>;
      }>;
    };
  };
}

async function loadCodexSdk(): Promise<CodexSdk> {
  try {
    return (await import('@openai/codex-sdk')) as unknown as CodexSdk;
  } catch (cause) {
    throw new Error(
      'The codex client requires the `@openai/codex-sdk` package (which brings the Codex CLI). ' +
        `Install it with: npm install @openai/codex-sdk\nOriginal error: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}

/** A Codex `mcp_servers` key from a server's label: letters, digits, `_` and `-`. */
export function codexServerKey(label: string, taken: ReadonlySet<string>) {
  const base = label.replace(/[^A-Za-z0-9_-]/g, '_') || 'server';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

/**
 * Connection settings Codex can't take for a server. `accessTokenEnv` is
 * resolved just before a client runs, so only then (`resolved`) does an
 * unresolved one fail.
 */
function unsupported(server: MCPConfig, resolved: boolean): string[] {
  if (server.transport === 'stdio')
    return [
      usesClientResolvedFields(server) && 'url/auth/files (desktop clients)',
      server.capabilities && 'capabilities',
    ].filter((value): value is string => Boolean(value));
  return [
    server.auth?.clientCredentials && 'clientCredentials',
    server.auth?.oauth && 'oauth',
    resolved &&
      server.auth?.accessTokenEnv &&
      !server.auth.accessToken &&
      'unresolved accessTokenEnv',
    isHttpConfig(server) && server.tls && 'tls/mTLS',
    isHttpConfig(server) && server.proxy && 'proxy',
    server.retryAttempts !== undefined && 'retryAttempts',
    server.capabilities && 'capabilities',
  ].filter((value): value is string => Boolean(value));
}

/** Fails, naming what to remove, for a server Codex can't connect to as configured. */
export function assertCodexServers(
  servers: readonly MCPConfig[],
  { resolved, context = 'codex' }: { resolved: boolean; context?: string }
): void {
  for (const [index, server] of servers.entries()) {
    const settings = unsupported(server, resolved);
    if (settings.length)
      throw new Error(
        `${context}: codex can't take ${settings.join(', ')} for server ${mcpServerLabel(server, index)}. Remove ${settings.length > 1 ? 'them' : 'it'}, or use the mst client.`
      );
  }
}

/**
 * The servers as Codex's `mcp_servers`, keyed by a name Codex accepts, and
 * the eval's label for each key. Each server is required: Codex fails the
 * trial when one doesn't start, instead of answering without it.
 */
export function codexMcpServers(
  servers: readonly MCPConfig[],
  timeoutMs: number
): {
  config: Record<string, Record<string, unknown>>;
  labels: Map<string, string>;
} {
  assertCodexServers(servers, { resolved: true });
  const config: Record<string, Record<string, unknown>> = {};
  const labels = new Map<string, string>();
  for (const [index, server] of servers.entries()) {
    const label = mcpServerLabel(server, index);
    const key = codexServerKey(label, new Set(labels.keys()));
    labels.set(key, label);
    const toolTimeoutMs = Math.max(
      timeoutMs,
      server.callTimeoutMs ?? 0,
      server.requestTimeoutMs ?? 0
    );
    const common = {
      required: true,
      startup_timeout_sec:
        (server.connectTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS) / 1000,
      tool_timeout_sec: toolTimeoutMs / 1000,
      // An eval approves every call: the servers (or MST's dry-run proxy)
      // decide what a write does.
      default_tools_approval_mode: 'approve',
    };
    if (server.transport === 'stdio') {
      config[key] = {
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        ...(server.env && Object.keys(server.env).length
          ? { env: server.env }
          : {}),
        ...common,
      };
    } else {
      const token = server.auth?.accessToken;
      const headers = {
        ...server.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      config[key] = {
        url: server.serverUrl,
        ...(Object.keys(headers).length ? { http_headers: headers } : {}),
        ...common,
      };
    }
  }
  return { config, labels };
}

/** Codex's `[otel]` settings, exporting to MST's host telemetry receiver. */
function otelConfig(
  receiver: HostTelemetryReceiver | undefined
): Record<string, unknown> {
  const exporter = (signal: string) => ({
    'otlp-http': {
      endpoint: `${receiver!.endpoint}/v1/${signal}`,
      protocol: 'json',
    },
  });
  if (!receiver)
    // Codex's own metrics would otherwise go to OpenAI.
    return {
      exporter: 'none',
      trace_exporter: 'none',
      metrics_exporter: 'none',
    };
  return {
    environment: 'mst',
    log_user_prompt: receiver.content,
    exporter: exporter('logs'),
    metrics_exporter: exporter('metrics'),
    trace_exporter: receiver.traces ? exporter('traces') : 'none',
  };
}

/** The `config.toml` a trial's CODEX_HOME holds. */
export function codexConfigToml(options: {
  baseURL?: string;
  systemPrompt?: string;
  mcpServers: Record<string, Record<string, unknown>>;
  receiver?: HostTelemetryReceiver;
}): string {
  return stringify({
    ...(options.baseURL
      ? {
          model_provider: 'mst',
          model_providers: {
            mst: {
              name: 'MST LLM endpoint',
              base_url: options.baseURL,
              env_key: API_KEY_ENV,
              wire_api: 'responses',
              // Gateways and proxies serve Responses over HTTPS; Codex would
              // otherwise try a WebSocket first on every turn.
              supports_websockets: false,
            },
          },
        }
      : {}),
    ...(options.systemPrompt !== undefined
      ? { developer_instructions: options.systemPrompt }
      : {}),
    check_for_update_on_startup: false,
    history: { persistence: 'none' },
    analytics: { enabled: false },
    feedback: { enabled: false },
    features: { plugins: false, apps: false, memories: false },
    skills: { bundled: { enabled: false } },
    // Codex's shell gets only core variables, never the model credential.
    shell_environment_policy: { inherit: 'core' },
    otel: otelConfig(options.receiver),
    mcp_servers: options.mcpServers,
  });
}

/** The rollout file of `threadId` under a CODEX_HOME, if Codex wrote one. */
async function findRollout(
  home: string,
  threadId: string | undefined
): Promise<string | undefined> {
  if (!threadId) return undefined;
  const suffix = `${threadId}.jsonl`;
  async function walk(dir: string, depth: number): Promise<string | undefined> {
    let entries: fs.Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(suffix)) return file;
      if (entry.isDirectory() && depth < 4) {
        const found = await walk(file, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }
  const file = await walk(path.join(home, 'sessions'), 0);
  return file ? readFile(file, 'utf8').catch(() => undefined) : undefined;
}

function pick(
  env: Record<string, string | undefined>,
  names: readonly string[]
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string') picked[name] = value;
  }
  return picked;
}

function defined(
  env: Record<string, string | undefined> | undefined
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

async function runCodex(
  input: ClientRunInput,
  clientConfig: ClientConfig,
  context: ClientRunContext
): Promise<ClientRunResult> {
  if (!input.prompt) throw new Error('Clients require an input.');
  const options: CodexClientOptions = CodexClientSchema.parse(clientConfig);
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  // As the other built-in clients: the run's environment, then the client's.
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...context.env,
    ...input.env,
    ...options.env,
  };
  const endpoint = await resolveLLMEndpoint('openai', {
    env,
    ...(options.apiKeyEnvVar ? { apiKeyEnvVar: options.apiKeyEnvVar } : {}),
  });
  if (!endpoint.apiKey)
    throw new Error(
      'The codex client requires an API key: set OPENAI_API_KEY, or OPENAI_BASE_URL with MST_LLM_AUTH_COMMAND for a gateway (docs/llm-gateways.md).'
    );
  const secrets = clientSecretValues(env, input.servers, [endpoint.apiKey]);
  const redact = (text: string) => redactClientSecrets(text, secrets);
  const { config: mcpServers, labels } = codexMcpServers(
    input.servers,
    timeoutMs
  );
  const { Codex } = await loadCodexSdk();

  const home = await mkdtemp(path.join(os.tmpdir(), 'mst-codex-'));
  let workDir: string | undefined;
  let receiver: HostTelemetryReceiver | undefined;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('timeout')),
    timeoutMs
  );
  const stream: TimedCodexEvent[] = [];
  const startedAt = new Date().toISOString();
  let failure:
    | { kind: ClientDiagnostics['failureKind']; message: string }
    | undefined;
  try {
    const cwd =
      options.cwd !== undefined
        ? path.resolve(options.cwd)
        : (workDir = await mkdtemp(path.join(os.tmpdir(), 'mst-workdir-')));
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`codex: cwd ${cwd} is not a directory.`);
    const hostConfig = context.evalConfig?.telemetry?.host;
    if (hostConfig) receiver = await hostTelemetryReceiver(hostConfig, { env });
    await writeFile(
      path.join(home, 'config.toml'),
      codexConfigToml({
        ...(endpoint.overridden ? { baseURL: endpoint.baseURL } : {}),
        ...(options.systemPrompt !== undefined
          ? { systemPrompt: options.systemPrompt }
          : {}),
        mcpServers,
        ...(receiver ? { receiver } : {}),
      }),
      { mode: 0o600 }
    );
    const codex = new Codex({
      env: {
        ...pick(env, PASSTHROUGH_ENV),
        ...defined(options.env),
        HOME: home,
        CODEX_HOME: home,
        // The built-in OpenAI provider reads CODEX_API_KEY; MST's, its own.
        [endpoint.overridden ? API_KEY_ENV : 'CODEX_API_KEY']: endpoint.apiKey,
      },
    });
    const thread = codex.startThread({
      ...(options.model !== undefined ? { model: options.model } : {}),
      sandboxMode: options.sandbox ?? codexSandboxMode(env),
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: options.webSearch ? 'live' : 'disabled',
      ...(options.reasoningEffort !== undefined
        ? { modelReasoningEffort: options.reasoningEffort }
        : {}),
    });
    try {
      const { events } = await thread.runStreamed(input.prompt, {
        signal: controller.signal,
      });
      for await (const event of events)
        stream.push({ at: new Date().toISOString(), event });
    } catch (error) {
      failure = controller.signal.aborted
        ? {
            kind: 'timeout',
            message: `codex client timed out after ${timeoutMs} ms.`,
          }
        : {
            kind: stream.some((e) => e.event.type === 'turn.started')
              ? 'process'
              : 'startup',
            message: redact(
              `Codex exited with an error: ${error instanceof Error ? error.message : String(error)}`
            ).slice(0, 4000),
          };
    }
    const endedAt = new Date().toISOString();
    const threadId = stream.find((e) => e.event.type === 'thread.started')
      ?.event.thread_id as string | undefined;
    const trace = buildCodexTrace(stream, await findRollout(home, threadId), {
      servers: labels,
      ...(options.model ? { model: options.model } : {}),
      startedAt,
      endedAt,
    });
    const host =
      receiver && threadId ? await receiver.collect([threadId]) : undefined;
    const error = failure?.message ?? (trace.error && redact(trace.error));
    const ending =
      failure?.kind === 'timeout' || trace.error === undefined
        ? undefined
        : codexTurnEnding(
            redact(trace.error),
            trace.events.length > 0 || trace.finalText.length > 0
          );
    const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
    const toolMs = trace.telemetry.toolWallDurationMs;
    return {
      finalText: trace.finalText,
      events: trace.events,
      ...(trace.modelCalls ? { modelCalls: trace.modelCalls } : {}),
      ...(trace.usage ? { usage: trace.usage } : {}),
      startedAt,
      completedAt: endedAt,
      durationMs,
      ...(typeof toolMs === 'number'
        ? { llmDurationMs: Math.max(0, durationMs - toolMs) }
        : {}),
      telemetry: trace.telemetry,
      ...(host ? { hostTelemetry: host } : {}),
      ...(error ? { error } : {}),
      ...(ending ? { ending } : {}),
      ...(failure ? { diagnostics: { failureKind: failure.kind } } : {}),
    };
  } finally {
    clearTimeout(timer);
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
    if (workDir)
      await rm(workDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * The `codex` client. It connects to the servers it is given, so a variant's
 * tool metadata reaches it through MST's proxy; it needs no desktop.
 */
/**
 * How a Codex turn that failed ended (ADR 0010), from the error Codex
 * reported for it: Codex reports these only as text. Running out of context
 * depends on whether the model had done anything (`acted`); a provider's
 * `429`, server error or dropped stream is the provider; a key it can't use
 * is setup. Anything else is left to the failure kind (`process`: Codex
 * itself failed) or, with none, a trial that failed.
 */
function codexTurnEnding(
  error: string,
  acted: boolean
): TrialEnding | undefined {
  if (CODEX_CONTEXT_OVERFLOW.test(error))
    return contextOverflowEnding(error, acted);
  if (CODEX_PROVIDER_FAILURE.test(error))
    return infrastructureEnding('provider', error);
  if (CODEX_SETUP_FAILURE.test(error))
    return infrastructureEnding('setup', error, false);
  return undefined;
}

const CODEX_CONTEXT_OVERFLOW =
  /context window|context_length_exceeded|maximum context length/i;
/** Codex says `unexpected status 503 ...` or `last status: 429 ...`. */
const CODEX_PROVIDER_FAILURE =
  /status:? (429|5\d\d)\b|too many requests|rate limit|stream disconnected|overloaded/i;
const CODEX_SETUP_FAILURE = /status:? 40[13]\b|unauthorized|invalid api key/i;

export const CODEX_CLIENT: ClientDefinition = {
  schema: CodexClientSchema,
  evidence: 'structured',
  headless: true,
  run: runCodex,
};
