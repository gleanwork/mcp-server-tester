import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import type { NativeMcpServerConfig, EvalConfig } from './evalConfigSchema.js';

/** Names or endpoint overrides for native MCP servers. */
export type NativeMcpSelection = string[] | Record<string, string>;

/** Public native-server definition; runtime safety is implemented later. */
export type NativeMcpServerDefinition = NativeMcpServerConfig;

/**
 * Resolve native MCP server definitions for a host.
 *
 * The framework contract is established here; endpoint preflight, credential
 * resolution, and write protection are implemented by the host-integration
 * branch.
 */
export async function buildNativeMcpServers(
  _definitions: NativeMcpServerDefinition[],
  _selection?: NativeMcpSelection,
  _options?: { preflight?: boolean }
): Promise<Record<string, Record<string, unknown>>> {
  throw new Error(
    'Native MCP server resolution is not implemented in the scaffolding branch.'
  );
}

/** Attach resolved server entries to a host configuration. */
export function withNativeMcpServers(
  hostConfig: MCPHostConfig,
  servers: Record<string, Record<string, unknown>>
): MCPHostConfig {
  return { ...hostConfig, mcpServers: servers };
}

/** Keep the config contract import visible to generated API documentation. */
export type NativeMcpConfig = Pick<
  EvalConfig,
  'nativeServers' | 'nativeConnectors'
>;
