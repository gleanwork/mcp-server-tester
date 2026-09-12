import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { MCPConfigSchema, type MCPConfig } from '../config/mcpConfig.js';
import {
  GenerationOptions,
  ProviderSchema,
  hostEnvironment,
  overrideHostTools,
  type HostEnvironment,
} from './mcpHost/hostOptions.js';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import type {
  HostRunInput,
  HostRunContext,
  HostRunResult,
} from './evalFrameworkTypes.js';
import type { HostConfig } from './evalManifest.js';
import { simulationToHostTrace } from './hostTrace.js';
import { getHost, registerHost } from './frameworkRegistries.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import { ANTHROPIC_API_HOST } from './anthropicApiHost.js';

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
        { client: (typeof clients)[number]; name: string }
      >();
      const overrides =
        options.arm?.toolOverrides ?? options.manifest.toolOverrides;
      const mcp: MCPFixtureApi = {
        get client() {
          if (!clients[0]) throw new Error('No MCP client for this host.');
          return clients[0];
        },
        authType: 'none',
        getServerInfo: () => null,
        async listTools() {
          const tools = [];
          for (const [index, client] of clients.entries()) {
            const result = await client.listTools();
            for (const tool of result.tools) {
              const name =
                clients.length > 1
                  ? `${options.servers[index]!.label}.${tool.name}`
                  : tool.name;
              routes.set(name, { client, name: tool.name });
              tools.push({ ...tool, server: options.servers[index]!.label });
            }
          }
          return overrideHostTools(tools, overrides).map(
            ({ server, ...tool }) => ({
              ...tool,
              name: clients.length > 1 ? `${server}.${tool.name}` : tool.name,
            })
          );
        },
        async callTool(name, args) {
          if (!routes.size) await this.listTools();
          const route = routes.get(name);
          if (!route) throw new Error(`Unknown MCP tool: ${name}`);
          return route.client.callTool({
            name: route.name,
            arguments: args,
          }) as ReturnType<MCPFixtureApi['callTool']>;
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
      }
      if (overrides && config.hostType === 'cli')
        throw new Error(
          'CLI description overrides require a host plugin that exposes overridden tools.'
        );
      checkDeadline();
      const response = await simulateMCPHost(
        mcp,
        case_.scenario,
        config,
        timeout === undefined ? undefined : controller.signal
      );
      return simulationToHostTrace(response, input.servers);
    } finally {
      await Promise.allSettled(clients.map(closeOwnedClient));
    }
  }

  try {
    const result = await Promise.race([execute(), expired]);
    checkDeadline();
    return result;
  } catch (error) {
    if (error === timeoutError)
      return { finalText: '', events: [], error: timeoutError.message };
    throw error;
  } finally {
    clearTimeout(timer);
    if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  }
}

export interface BuiltinHostOptions {
  env?: HostEnvironment;
  temperature?: number;
  maxTokens?: number;
  apiKeyEnvVar?: string;
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
    provider: z.enum(['anthropic', 'vertex', 'vertex-anthropic']).optional(),
    apiToken: z.string().optional(),
    pluginDir: z.string().optional(),
    pluginMcpUrl: z.string().optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    server: MCPConfigSchema.optional(),
    servers: z.array(MCPConfigSchema).optional(),
  })
  .strict();
let builtinsRegistered = false;

export function registerBuiltinHosts(): void {
  if (builtinsRegistered) return;
  for (const [name, factory] of Object.entries(BUILTIN_HOSTS)) {
    registerHost({
      name,
      schema: name === 'vercel-sdk' ? SdkHostSchema : CliHostSchema,
      createConfig: (options) => factory(options ?? {}),
      evidence: 'structured',
      run: (input, config, context) =>
        runBuiltinHost(input, config, context, factory),
    });
  }
  registerHost(ANTHROPIC_API_HOST);
  builtinsRegistered = true;
}

export function getBuiltinHostConfig(
  name: string,
  options: BuiltinHostOptions = {}
): MCPHostConfig {
  registerBuiltinHosts();
  const definition = getHost(name);
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
  };
}

function claudeCliHost(options: BuiltinHostOptions): MCPHostConfig {
  CliHostSchema.parse(options);
  const env = { ...process.env, ...options.env };
  for (const server of [
    ...(options.servers ?? []),
    ...(options.server ? [options.server] : []),
  ]) {
    if (server.transport !== 'http') continue;
    const unsupported = [
      server.auth?.clientCredentials && 'clientCredentials',
      server.auth?.oauth && 'oauth',
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
        `claude-cli cannot forward connection policy for ${server.label ?? server.serverUrl}: ${unsupported.join(', ')}. Use an SDK host or explicit proxy.`
      );
  }
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
  ];

  return {
    hostType: 'cli',
    timeout: options.timeout,
    provider: (provider === 'vertex'
      ? 'vertex-anthropic'
      : provider) as MCPHostConfig['provider'],
    mcpServers: mcpServers as Record<string, Record<string, unknown>>,
    model,
    cli: {
      command: 'claude',
      args: baseArgs,
      outputFormat: 'stream-json',
      timeout: options.timeout ?? 180_000,
      env: {
        ...env,
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
