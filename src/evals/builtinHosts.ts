import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { MCPConfigSchema, type MCPConfig } from '../config/mcpConfig.js';
import { usesToolSurfaceProxy } from './toolSurfaceProxy.js';
import {
  buildToolSurface,
  registerPresentedTools,
  withOriginalToolNames,
  type ListedServerTools,
} from './toolSurface.js';
import {
  GenerationOptions,
  ProviderSchema,
  SystemPromptOption,
  hostEnvironment,
  type HostEnvironment,
} from './mcpHost/hostOptions.js';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { callToolNormalized } from '../mcp/callTool.js';
import { DEFAULT_PROTOCOL_SETTING, getProtocolInfo } from '../mcp/protocol.js';
import { createFixtureExtensions } from '../mcp/fixtures/fixtureExtensions.js';
import type { Client } from '@modelcontextprotocol/client';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import type {
  HostRunInput,
  HostRunContext,
  HostRunResult,
} from './evalFrameworkTypes.js';
import type { HostConfig } from './evalManifest.js';
import type { HostDefinition } from './evalFrameworkTypes.js';
import { extensionLookup } from '../plugins/extensions.js';
import { simulationToHostRun } from './hostTrace.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import { ANTHROPIC_API_HOST } from './anthropicApiHost.js';
import { COWORK_HOST } from './coworkHost.js';
import { CHATGPT_HOST, CHATGPT_LINUX_HOST } from './chatgptHost.js';

/** A stand-in client for hosts that manage their own connections. */
function missingClient(): Client {
  return new Proxy({} as Client, {
    get() {
      throw new Error('No MCP client for this host.');
    },
  });
}

async function runBuiltinHost(
  input: HostRunInput,
  host: HostConfig,
  context: HostRunContext,
  factory: (options: BuiltinHostOptions) => MCPHostConfig
): Promise<HostRunResult> {
  const startedAt = Date.now();
  // Runtime values are fallbacks; explicit host and legacy case values win.
  const env: HostEnvironment = {
    ...hostEnvironment(input, context),
    ...(host.env as HostEnvironment | undefined),
    ...context.mcpHostConfig?.env,
  };
  const options = { ...input, host, ...context };
  const case_ = {
    scenario: input.scenario,
    mcpHostConfig: context.mcpHostConfig,
  };
  if (!input.scenario) throw new Error('Hosts require a scenario.');
  // Legacy execution details (especially caller-authored CLI args) remain
  // intact, but accepted generation settings must reach the factory first.
  const legacyOptions = { ...case_.mcpHostConfig };
  delete legacyOptions.hostType;
  delete legacyOptions.cli;
  delete legacyOptions.browser;
  delete legacyOptions.mcpServers;
  const config = {
    ...factory({
      ...options.host,
      ...legacyOptions,
      servers: options.servers,
      env,
    }),
    ...case_.mcpHostConfig,
    env,
  };
  const clients: Array<Awaited<ReturnType<typeof createMCPClientForConfig>>> =
    [];
  let configDir: string | undefined;
  let claudeConfigDir: string | undefined;
  const controller = new AbortController();
  const timeout =
    config.timeout ??
    (config.hostType === 'cli' ? config.cli?.timeout : undefined);
  const timeoutError = new Error(
    `${config.hostType === 'cli' ? 'CLI' : 'SDK'} host timed out after ${timeout} ms.`
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = new Map<(typeof clients)[number], Promise<void>>();

  function closeOwnedClient(client: (typeof clients)[number]): Promise<void> {
    let pending = closing.get(client);
    if (!pending) {
      pending = closeMCPClient(client);
      closing.set(client, pending);
      // Cleanup can finish after the deadline, but must not reject unobserved.
      void pending.catch(() => {});
    }
    if (controller.signal.aborted) {
      // Bypass a stalled session DELETE. Only this host's clients are closed;
      // the shared graceful-close policy and caller-owned fixtures are unchanged.
      void client.close().catch(() => {});
    }
    return pending;
  }

  const expired = new Promise<never>((_, reject) => {
    if (timeout === undefined) return;
    function expire() {
      controller.abort(timeoutError);
      for (const client of clients) void closeOwnedClient(client);
      reject(timeoutError);
    }
    const remaining = timeout - (Date.now() - startedAt);
    if (remaining <= 0) expire();
    else timer = setTimeout(expire, remaining);
  });

  function checkDeadline() {
    if (timeout !== undefined && Date.now() - startedAt >= timeout) {
      controller.abort(timeoutError);
    }
    controller.signal.throwIfAborted();
  }

  async function execute(): Promise<HostRunResult> {
    try {
      checkDeadline();
      // CLI hosts manage their own server connections.
      if (config.hostType !== 'cli') {
        for (const server of options.servers) {
          const client = await createMCPClientForConfig(server);
          clients.push(client);
          // A connection that settles late is still owned and closed in finally.
          checkDeadline();
        }
      }
      const routes = new Map<
        string,
        { client: (typeof clients)[number]; name: string; original: string }
      >();
      const overrides =
        options.arm?.toolOverrides ?? options.manifest.toolOverrides;
      const mcp: MCPFixtureApi = {
        get client() {
          if (!clients[0]) throw new Error('No MCP client for this host.');
          return clients[0];
        },
        authType: 'none',
        get protocol() {
          return clients[0]
            ? getProtocolInfo(clients[0])
            : {
                requested: DEFAULT_PROTOCOL_SETTING,
                negotiated: null,
                era: null,
              };
        },
        // Resource and skills helpers address the first server.
        ...createFixtureExtensions(clients[0] ?? missingClient()),
        getServerInfo: () => null,
        async listTools() {
          const listed: ListedServerTools[] = [];
          for (const [index, client] of clients.entries()) {
            const result = await client.listTools();
            listed.push({
              server: options.servers[index]!.label,
              tools: result.tools,
            });
          }
          const surface = buildToolSurface(listed, overrides);
          routes.clear();
          return surface.tools.map(({ server, originalName, tool }) => {
            const qualify = (toolName: string) =>
              clients.length > 1 ? `${server}.${toolName}` : toolName;
            const index = listed.findIndex((item) => item.server === server);
            routes.set(qualify(tool.name), {
              client: clients[index]!,
              name: originalName,
              original: qualify(originalName),
            });
            return { ...tool, name: qualify(tool.name) };
          });
        },
        async callTool(name, args) {
          if (!routes.size) await this.listTools();
          const route = routes.get(name);
          if (!route) throw new Error(`Unknown MCP tool: ${name}`);
          return callToolNormalized(route.client, {
            name: route.name,
            arguments: args,
          });
        },
      };
      if (config.cli) {
        const position = config.cli.args.indexOf('--mcp-config');
        if (position >= 0 && config.cli.args[position + 1]?.startsWith('{')) {
          configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp_config_'));
          const file = path.join(configDir, 'mcp.json');
          fs.writeFileSync(file, config.cli.args[position + 1]!, {
            mode: 0o600,
          });
          config.cli = { ...config.cli, args: [...config.cli.args] };
          config.cli.args[position + 1] = file;
        }
        // Claude Code loads the operator's skills, plugins and settings from
        // its config directory. An empty one per run keeps them out of the
        // results. Only an explicit CLAUDE_CONFIG_DIR (host or case env)
        // opts out; one inherited from the shell doesn't.
        const explicitConfigDir =
          (host.env as HostEnvironment | undefined)?.CLAUDE_CONFIG_DIR ??
          context.mcpHostConfig?.env?.CLAUDE_CONFIG_DIR ??
          context.mcpHostConfig?.cli?.env?.CLAUDE_CONFIG_DIR;
        if (
          host.type === 'claude-cli' &&
          (host as { isolate?: boolean }).isolate !== false &&
          explicitConfigDir === undefined
        ) {
          claudeConfigDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'mst-claude-')
          );
          config.cli = {
            ...config.cli,
            env: { ...config.cli.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
          };
        }
      }
      if (overrides && config.hostType === 'cli')
        throw new Error(
          'CLI description overrides require a host plugin that exposes overridden tools.'
        );
      checkDeadline();
      registerPresentedTools(mcp, (name) => routes.get(name)?.original);
      const response = withOriginalToolNames(
        await simulateMCPHost(
          mcp,
          case_.scenario,
          config,
          timeout === undefined ? undefined : controller.signal
        ),
        mcp
      );
      return simulationToHostRun(response, input.servers);
    } finally {
      await Promise.allSettled(clients.map(closeOwnedClient));
    }
  }

  try {
    if (
      config.hostType === 'cli' &&
      config.cli?.claudeMcpServers !== undefined
    ) {
      // The Claude process runner settles on this controller's abort. Do not
      // race away its partial trace/diagnostics at the same deadline.
      void expired.catch(() => {});
      return await execute();
    }
    const result = await Promise.race([execute(), expired]);
    checkDeadline();
    return result;
  } catch (error) {
    if (error === timeoutError)
      return { finalText: '', events: [], error: timeoutError.message };
    throw error;
  } finally {
    clearTimeout(timer);
    // A killed CLI can still be exiting; retry rather than fail the result.
    if (configDir)
      fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 3 });
    if (claudeConfigDir)
      fs.rmSync(claudeConfigDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
  }
}

export interface BuiltinHostOptions {
  env?: HostEnvironment;
  temperature?: number;
  maxTokens?: number;
  apiKeyEnvVar?: string;
  systemPrompt?: string;
  /** The vercel-sdk host's Agent Skills mode. */
  skills?: 'off' | 'catalog' | 'preload';
  model?: string;
  maxToolCalls?: number;
  timeout?: number;
  provider?: string;
  server?: MCPConfig;
  servers?: MCPConfig[];
  apiToken?: string;
  pluginDir?: string;
  pluginMcpUrl?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
}

/**
 * Built-in client host configs. Organization-specific plugin wiring stays
 * outside the framework and is provided through generic plugin options.
 */
const SdkHostSchema = z
  .object({
    type: z.literal('vercel-sdk').optional(),
    ...GenerationOptions,
    provider: ProviderSchema.optional(),
    apiKeyEnvVar: z.string().min(1).optional(),
    systemPrompt: SystemPromptOption,
    /** Offer the server's Agent Skills: as a catalog the model loads from, or preloaded. */
    skills: z.enum(['off', 'catalog', 'preload']).optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    server: MCPConfigSchema.optional(),
    servers: z.array(MCPConfigSchema).optional(),
  })
  .strict();
const CliHostSchema = z
  .object({
    type: z.literal('claude-cli').optional(),
    model: GenerationOptions.model,
    timeout: GenerationOptions.timeout,
    systemPrompt: SystemPromptOption,
    provider: z.enum(['anthropic', 'vertex', 'vertex-anthropic']).optional(),
    apiToken: z.string().optional(),
    pluginDir: z.string().optional(),
    pluginMcpUrl: z.string().optional(),
    /**
     * Run Claude Code with an empty config directory (the default), so the
     * operator's skills, plugins and settings don't affect results. Set false
     * to use your own, for example to sign in with a claude.ai account.
     */
    isolate: z.boolean().optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    server: MCPConfigSchema.optional(),
    servers: z.array(MCPConfigSchema).optional(),
  })
  .strict();
let builtinHosts: Record<string, HostDefinition> | undefined;

/** Built-in hosts by name, including aliases. */
function builtinHostDefinitions(): Readonly<Record<string, HostDefinition>> {
  if (builtinHosts) return builtinHosts;
  const hosts: Record<string, HostDefinition> = {};
  for (const [name, factory] of Object.entries(BUILTIN_HOSTS)) {
    hosts[name] = {
      schema: name === 'vercel-sdk' ? SdkHostSchema : CliHostSchema,
      createConfig: (options) => factory(options ?? {}),
      evidence: 'structured',
      // The SDK host presents tool variants; the CLI only sees its servers.
      ...(name === 'vercel-sdk' ? { toolOverrides: true } : {}),
      run: (input, config, context) =>
        runBuiltinHost(input, config, context, factory),
    };
  }
  return (builtinHosts = {
    ...hosts,
    'anthropic-api': ANTHROPIC_API_HOST,
    'chatgpt-mac': CHATGPT_HOST,
    'chatgpt-linux': CHATGPT_LINUX_HOST,
    cowork: COWORK_HOST,
  });
}

/**
 * Earlier names for built-in hosts, still accepted with a warning. `chatgpt`
 * meant the ChatGPT host for the machine it ran on.
 */
const DEPRECATED_HOST_NAMES: Readonly<Record<string, () => string>> = {
  cowork_cu: () => 'cowork',
  'anthropic.claude.cowork.desktop-app.macos': () => 'cowork',
  'openai.chatgpt.agent.desktop-app.macos': () => 'chatgpt-mac',
  'openai.chatgpt.agent.desktop-app.linux': () => 'chatgpt-linux',
  chatgpt: () =>
    process.platform === 'linux' ? 'chatgpt-linux' : 'chatgpt-mac',
};
const warnedHostNames = new Set<string>();

const hosts = extensionLookup('hosts', builtinHostDefinitions);

/**
 * A host reference's current name: a deprecated built-in name becomes its
 * replacement, with a warning once per process; anything else is unchanged.
 */
export function resolveHostName(reference: string): string {
  if (!Object.hasOwn(DEPRECATED_HOST_NAMES, reference)) return reference;
  const current = DEPRECATED_HOST_NAMES[reference]!();
  if (!warnedHostNames.has(reference)) {
    warnedHostNames.add(reference);
    process.emitWarning(
      `Host "${reference}" is deprecated; use "${current}".`,
      {
        type: 'DeprecationWarning',
        code: 'MST_DEPRECATED_HOST',
      }
    );
  }
  return current;
}

/** The host `reference` names: a built-in, or `namespace/name` from a plugin. */
export function getHost(reference: string): HostDefinition {
  return hosts.get(resolveHostName(reference));
}

export function getBuiltinHostConfig(
  name: string,
  options: BuiltinHostOptions = {}
): MCPHostConfig {
  const definition = builtinHostDefinitions()[name];
  if (!definition) {
    const available = Object.keys(builtinHostDefinitions()).sort().join(', ');
    throw new Error(
      `Host "${name}" is not available. Available: ${available}.`
    );
  }
  const createConfig = definition.createConfig?.bind(definition);
  if (!createConfig)
    throw new Error(`Host ${name} does not expose a legacy config factory.`);
  return createConfig(options as unknown as Record<string, unknown>);
}

const BUILTIN_HOSTS: Record<
  string,
  (options: BuiltinHostOptions) => MCPHostConfig
> = {
  'claude-cli': claudeCliHost,
  'vercel-sdk': vercelSdkHost,
};

function vercelSdkHost(options: BuiltinHostOptions): MCPHostConfig {
  SdkHostSchema.parse(options);
  return {
    timeout: options.timeout,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    apiKeyEnvVar: options.apiKeyEnvVar,
    env: options.env,
    hostType: 'sdk',
    provider: (options.provider as MCPHostConfig['provider']) ?? 'anthropic',
    model: options.model ?? 'claude-sonnet-4-20250514',
    maxToolCalls: options.maxToolCalls ?? 5,
    ...(options.systemPrompt !== undefined
      ? { systemPrompt: options.systemPrompt }
      : {}),
    ...(options.skills !== undefined && options.skills !== 'off'
      ? { skills: options.skills }
      : {}),
  };
}

/**
 * Settings a host can't honour, checked before anything runs (dry runs
 * included), so a run never reports results for a configuration the host
 * ignored. Throws with the first problem; `context` names the manifest, arm
 * or case.
 */
export function assertHostSupports(
  host: { type: string },
  options: {
    servers: MCPConfig[];
    toolOverrides?: unknown;
    concurrency?: number;
    context: string;
  }
): void {
  const definition = getHost(host.type);
  const appliesOverrides =
    definition.toolOverrides === true ||
    usesToolSurfaceProxy(definition) ||
    (definition.createConfig !== undefined &&
      !definition.run &&
      !definition.runBatch);
  if (options.toolOverrides !== undefined && !appliesOverrides) {
    throw new Error(
      `${options.context}: host "${host.type}" can't apply toolOverrides; it would run with the original tools. ` +
        'Use a host that shows tool variants to the model (vercel-sdk, anthropic-api), or one that connects to the servers it is given.'
    );
  }
  if (
    definition.maxConcurrency !== undefined &&
    (options.concurrency ?? 1) > definition.maxConcurrency
  ) {
    throw new Error(
      `${options.context}: host "${host.type}" runs at most ${definition.maxConcurrency} case at a time; set concurrency to ${definition.maxConcurrency}.`
    );
  }
  if (host.type === 'claude-cli')
    assertClaudeCliServers(options.servers, false, options.context);
}

/**
 * Connection policy claude-cli can't forward to its MCP servers. Unresolved
 * `accessTokenEnv` is only known once secrets resolve, at run time.
 */
function assertClaudeCliServers(
  servers: MCPConfig[],
  resolved: boolean,
  context = 'claude-cli'
): void {
  for (const server of servers) {
    if (server.transport !== 'http') continue;
    const unsupported = [
      server.auth?.clientCredentials && 'clientCredentials',
      server.auth?.oauth && 'oauth',
      resolved &&
        server.auth?.accessTokenEnv &&
        !server.auth.accessToken &&
        'unresolved accessTokenEnv',
      server.tls && 'tls/mTLS',
      server.proxy && 'proxy',
      server.retryAttempts !== undefined && 'retryAttempts',
      server.connectTimeoutMs !== undefined && 'connectTimeoutMs',
      server.requestTimeoutMs !== undefined && 'requestTimeoutMs',
      server.callTimeoutMs !== undefined && 'callTimeoutMs',
      server.capabilities && 'capabilities',
    ].filter(Boolean);
    if (unsupported.length)
      throw new Error(
        `${context}: claude-cli can't forward ${unsupported.join(', ')} for ${server.label ?? server.serverUrl}. Remove ${unsupported.length > 1 ? 'them' : 'it'}, or use vercel-sdk or anthropic-api.`
      );
  }
}

function claudeCliHost(options: BuiltinHostOptions): MCPHostConfig {
  CliHostSchema.parse(options);
  const env = { ...process.env, ...options.env };
  assertClaudeCliServers(
    [...(options.servers ?? []), ...(options.server ? [options.server] : [])],
    true
  );
  const provider =
    options.provider === 'vertex-anthropic'
      ? 'vertex'
      : (options.provider ?? 'anthropic');

  const server = options.server;
  const defaultServerUrl =
    server?.transport === 'http' ? server.serverUrl : env.MCP_SERVER_URL;
  const apiToken =
    options.apiToken ??
    (server?.transport === 'http' ? server.auth?.accessToken : undefined) ??
    env.MCP_ACCESS_TOKEN ??
    '';
  const pluginDir = options.pluginDir ?? env.MCP_PLUGIN_DIR ?? '';

  const mcpServers: Record<string, unknown> = server
    ? server.transport === 'http'
      ? {
          [server.label ?? 'mcp-server']: {
            type: 'http',
            url: server.serverUrl,
            headers: {
              ...server.headers,
              ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
            },
          },
        }
      : {
          [server.label ?? 'mcp-server']: {
            command: server.command,
            args: server.args,
            cwd: server.cwd,
            env: server.env,
          },
        }
    : defaultServerUrl
      ? {
          'mcp-server': {
            type: 'http',
            url: defaultServerUrl,
            headers: apiToken
              ? { Authorization: `Bearer ${apiToken}` }
              : undefined,
          },
        }
      : {};

  if (pluginDir) {
    const dataDir =
      env.MCP_PLUGIN_DATA_DIR ??
      path.join(os.homedir(), '.mcp-server-tester', 'plugins');
    const serverUrl = options.pluginMcpUrl ?? env.MCP_PLUGIN_SERVER_URL ?? '';
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'mcp-server-url.json'),
      `${JSON.stringify({ serverUrl }, null, 2)}\n`
    );
    if (serverUrl) {
      mcpServers['plugin'] = {
        command: 'bash',
        args: [path.join(pluginDir, 'start.sh')],
        env: {
          MCP_PLUGIN_SERVER_URL: serverUrl,
          ENABLE_HITL: 'false',
          CLAUDE_PLUGIN_DATA: dataDir,
        },
        alwaysLoad: env.MCP_PLUGIN_ALWAYS_LOAD !== '0',
      };
    }
  }

  if (options.servers) {
    for (const key of Object.keys(mcpServers)) delete mcpServers[key];
    for (const entry of options.servers) {
      const label = entry.label ?? 'mcp-server';
      mcpServers[label] =
        entry.transport === 'http'
          ? {
              type: 'http',
              url: entry.serverUrl,
              headers: {
                ...entry.headers,
                ...(entry.auth?.accessToken
                  ? { Authorization: `Bearer ${entry.auth.accessToken}` }
                  : {}),
              },
            }
          : {
              command: entry.command,
              args: entry.args,
              cwd: entry.cwd,
              env: entry.env,
            };
    }
  }
  const mcpConfigFile = JSON.stringify({ mcpServers });

  const model = options.model ?? 'claude-sonnet-4-20250514';
  const baseArgs = [
    '-p',
    '{{scenario}}',
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    mcpConfigFile,
    '--strict-mcp-config',
    '--permission-mode',
    'bypassPermissions',
    // Added to Claude Code's own system prompt, which stays.
    ...(options.systemPrompt !== undefined
      ? ['--append-system-prompt', '{{systemPrompt}}']
      : []),
  ];

  return {
    hostType: 'cli',
    timeout: options.timeout,
    provider: (provider === 'vertex'
      ? 'vertex-anthropic'
      : provider) as MCPHostConfig['provider'],
    mcpServers: mcpServers as Record<string, Record<string, unknown>>,
    model,
    ...(options.systemPrompt !== undefined
      ? { systemPrompt: options.systemPrompt }
      : {}),
    cli: {
      command: 'claude',
      claudeMcpServers: Object.keys(mcpServers),
      args: baseArgs,
      outputFormat: 'stream-json',
      timeout: options.timeout ?? 180_000,
      env: {
        ...env,
        MCP_CONNECTION_NONBLOCKING: 'false',
        MCP_CONNECT_TIMEOUT_MS: env.MCP_CONNECT_TIMEOUT_MS ?? '30000',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        ...(provider === 'vertex'
          ? {
              ANTHROPIC_API_KEY: undefined,
              CLAUDE_CODE_USE_VERTEX: '1',
              ANTHROPIC_VERTEX_PROJECT_ID:
                env.ANTHROPIC_VERTEX_PROJECT_ID ?? env.GOOGLE_VERTEX_PROJECT,
            }
          : { CLAUDE_CODE_USE_VERTEX: undefined }),
      },
    },
  };
}
