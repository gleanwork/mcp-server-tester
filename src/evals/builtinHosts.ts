import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';

export interface BuiltinHostOptions {
  model?: string;
  maxToolCalls?: number;
  timeout?: number;
  provider?: string;
  mcpUrl?: string;
  apiToken?: string;
  pluginDir?: string;
  pluginMcpUrl?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
}

/**
 * Built-in client host configs matching scio's python/hosts registry.
 * Glean-specific plugin wiring stays env-driven for backward compatibility.
 */
export function getBuiltinHostConfig(
  name: string,
  options: BuiltinHostOptions = {}
): MCPHostConfig {
  const factory = BUILTIN_HOSTS[name];
  if (!factory) {
    const valid = Object.keys(BUILTIN_HOSTS).sort().join(', ');
    throw new Error(`Unknown client host "${name}". Valid hosts: ${valid}`);
  }
  return factory(options);
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
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    process.env.ANTHROPIC_VERTEX_PROJECT_ID ??=
      process.env.GOOGLE_VERTEX_PROJECT ?? 'dev-sandbox-334901';
  }

  const mcpUrl =
    options.mcpUrl ??
    process.env.GLEAN_MCP_URL ??
    'https://scio-prod-be.glean.com/mcp/default';
  const apiToken = options.apiToken ?? process.env.GLEAN_API_TOKEN ?? '';
  const pluginDir = options.pluginDir ?? process.env.PLUGIN_DIR ?? '';

  const mcpServers: Record<string, unknown> = {
    ...(mcpUrl
      ? {
          'glean-mcp': {
            type: 'http',
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${apiToken}`,
            },
          },
        }
      : {}),
    ...(options.mcpServers ?? {}),
  };

  if (pluginDir) {
    const dataDir =
      process.env.PLUGIN_DATA_DIR ??
      path.join(
        os.homedir(),
        '.claude/plugins/data/glean-vnext-glean-plugins-vnext'
      );
    const serverUrl =
      options.pluginMcpUrl ??
      process.env.GLEAN_PLUGIN_MCP_URL ??
      'https://scio-prod-be.glean.com/mcp/gateway/proxy';
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'mcp-server-url.json'),
      `${JSON.stringify({ serverUrl }, null, 2)}\n`
    );
    mcpServers['glean-plugin'] = {
      command: 'bash',
      args: [path.join(pluginDir, 'start.sh')],
      env: {
        GLEAN_MCP_SERVER_URL: serverUrl,
        ENABLE_HITL: 'false',
        CLAUDE_PLUGIN_DATA: dataDir,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      alwaysLoad: process.env.PLUGIN_ALWAYS_LOAD !== '0',
    };
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
    provider: provider as MCPHostConfig['provider'],
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
