import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { MCPConfig } from '../config/mcpConfig.js';
import { getHost, registerHost } from './frameworkRegistries.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';

export interface BuiltinHostOptions {
  model?: string;
  maxToolCalls?: number;
  timeout?: number;
  provider?: string;
  server?: MCPConfig;
  apiToken?: string;
  pluginDir?: string;
  pluginMcpUrl?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
}

/**
 * Built-in client host configs. Organization-specific plugin wiring stays
 * outside the framework and is provided through generic plugin options.
 */
const BuiltinHostSchema = z.object({}).passthrough();
let builtinsRegistered = false;

export function registerBuiltinHosts(): void {
  if (builtinsRegistered) return;
  for (const [name, factory] of Object.entries(BUILTIN_HOSTS)) {
    registerHost({
      name,
      schema: BuiltinHostSchema,
      createConfig: (options) => factory(options ?? {}),
    });
  }
  builtinsRegistered = true;
}

export function getBuiltinHostConfig(
  name: string,
  options: BuiltinHostOptions = {}
): MCPHostConfig {
  registerBuiltinHosts();
  return getHost(name).createConfig(
    options as unknown as Record<string, unknown>
  );
}

const BUILTIN_HOSTS: Record<
  string,
  (options: BuiltinHostOptions) => MCPHostConfig
> = {
  'claude-cli': claudeCliHost,
  'vercel-sdk': vercelSdkHost,
};

function vercelSdkHost(options: BuiltinHostOptions): MCPHostConfig {
  return {
    hostType: 'sdk',
    provider: (options.provider as MCPHostConfig['provider']) ?? 'anthropic',
    model: options.model ?? 'claude-sonnet-4-20250514',
    maxToolCalls: options.maxToolCalls ?? 5,
  };
}

function claudeCliHost(options: BuiltinHostOptions): MCPHostConfig {
  const provider = options.provider ?? 'anthropic';
  if (provider === 'vertex') {
    // Claude Code prefers ANTHROPIC_API_KEY even when Vertex is selected.
    // Remove the conflicting direct key so the explicit provider wins.
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    if (process.env.GOOGLE_VERTEX_PROJECT) {
      process.env.ANTHROPIC_VERTEX_PROJECT_ID ??=
        process.env.GOOGLE_VERTEX_PROJECT;
    }
  }

  const server = options.server;
  const defaultServerUrl =
    server?.transport === 'http'
      ? server.serverUrl
      : process.env.MCP_SERVER_URL;
  const apiToken =
    options.apiToken ??
    (server?.transport === 'http' ? server.auth?.accessToken : undefined) ??
    process.env.MCP_ACCESS_TOKEN ??
    '';
  const pluginDir = options.pluginDir ?? process.env.MCP_PLUGIN_DIR ?? '';

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
      process.env.MCP_PLUGIN_DATA_DIR ??
      path.join(os.homedir(), '.mcp-server-tester', 'plugins');
    const serverUrl =
      options.pluginMcpUrl ?? process.env.MCP_PLUGIN_SERVER_URL ?? '';
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
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        alwaysLoad: process.env.MCP_PLUGIN_ALWAYS_LOAD !== '0',
      };
    }
  }

  const mcpConfigFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp_config_')),
    'mcp.json'
  );
  fs.writeFileSync(
    mcpConfigFile,
    `${JSON.stringify({ mcpServers }, null, 2)}\n`
  );

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
    },
    maxToolCalls: options.maxToolCalls ?? 5,
  };
}
