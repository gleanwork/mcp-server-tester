import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import {
  preflightMcpServer,
  type DryRunProxyOptions,
} from '../mcp/dryRunProxy.js';

export interface NativeMcpServerDefinition {
  /** Stable name used in the host's mcpServers map. */
  name: string;
  /** Upstream streamable HTTP MCP endpoint. */
  url: string;
  /** Environment variable containing the bearer token. */
  tokenEnv?: string;
  /** Direct token override for programmatic use; never serialized into host config. */
  token?: string;
  headers?: Record<string, string>;
  /** Explicitly force these tools to be treated as writes. */
  alwaysWriteTools?: string[];
  /** Allow these tools through when their server omits readOnlyHint. */
  readOnlyTools?: string[];
  expectedMinTools?: number;
  /** The result envelope key used by downstream judges. */
  plannedWriteKey?: string;
}

export type NativeMcpSelection = string[] | Record<string, string>;

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  );
}

function resolveEndpoint(
  definition: NativeMcpServerDefinition,
  override: string
): string {
  const url = override || definition.url;
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))
  ) {
    throw new Error(
      `Native MCP server "${definition.name}" endpoint must use https, or http on loopback: ${url}`
    );
  }
  return url;
}

function selectionMap(
  selection: NativeMcpSelection | undefined
): Map<string, string> {
  if (!selection) return new Map();
  if (Array.isArray(selection))
    return new Map(selection.map((name) => [name, '']));
  return new Map(
    Object.entries(selection).map(([name, url]) => [name, url ?? ''])
  );
}

function proxyOptions(
  definition: NativeMcpServerDefinition,
  endpoint: string
): DryRunProxyOptions {
  const token =
    definition.token ??
    (definition.tokenEnv ? process.env[definition.tokenEnv] : undefined) ??
    '';
  if (!token.trim()) {
    throw new Error(
      `Native MCP server "${definition.name}" requires tokenEnv "${definition.tokenEnv ?? '(unset)'}"`
    );
  }
  return {
    name: definition.name,
    upstreamUrl: endpoint,
    token,
    headers: definition.headers,
    alwaysWriteTools: definition.alwaysWriteTools,
    readOnlyTools: definition.readOnlyTools,
    plannedWriteKey: definition.plannedWriteKey,
  };
}

/**
 * Resolve selected connector definitions into Claude-compatible MCP server entries.
 * Every entry points at the tester's dry-run proxy, never directly at the vendor.
 */
export async function buildNativeMcpServers(
  definitions: NativeMcpServerDefinition[],
  selection: NativeMcpSelection | undefined,
  options: { preflight?: boolean; proxyCommand?: string } = {}
): Promise<Record<string, Record<string, unknown>>> {
  const selected = selectionMap(selection);
  if (selected.size === 0) return {};
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition])
  );
  const entries: Record<string, Record<string, unknown>> = {};
  const proxyCommand =
    options.proxyCommand ??
    process.env.MCP_SERVER_TESTER_BIN ??
    'mcp-server-tester';

  for (const [name, override] of selected) {
    const definition = byName.get(name);
    if (!definition) {
      throw new Error(
        `Unknown native MCP server "${name}". Available: ${definitions
          .map((item) => item.name)
          .sort()
          .join(', ')}`
      );
    }
    const endpoint = resolveEndpoint(definition, override);
    const proxy = proxyOptions(definition, endpoint);
    if (options.preflight !== false) {
      await preflightMcpServer(proxy, definition.expectedMinTools ?? 1);
    }
    const args = [
      'proxy',
      '--upstream-url',
      endpoint,
      '--name',
      definition.name,
      ...(definition.tokenEnv ? ['--token-env', definition.tokenEnv] : []),
    ];
    for (const [header, value] of Object.entries(definition.headers ?? {})) {
      args.push('--header', `${header}:${value}`);
    }
    for (const tool of definition.alwaysWriteTools ?? [])
      args.push('--always-write', tool);
    for (const tool of definition.readOnlyTools ?? [])
      args.push('--read-only', tool);
    if (definition.plannedWriteKey)
      args.push('--planned-write-key', definition.plannedWriteKey);

    entries[name] = {
      command: proxyCommand,
      args,
      env: definition.tokenEnv ? {} : { MCP_PROXY_TOKEN: proxy.token },
    };
  }
  return entries;
}

/** Apply native server entries to a CLI host config without exposing credentials. */
export function withNativeMcpServers(
  hostConfig: MCPHostConfig,
  servers: Record<string, Record<string, unknown>>
): MCPHostConfig {
  return {
    ...hostConfig,
    mcpServers: {
      ...(hostConfig.mcpServers ?? {}),
      ...servers,
    },
  };
}
