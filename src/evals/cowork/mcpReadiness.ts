import { isHttpConfig, type MCPConfig } from '../../config/mcpConfig.js';
import {
  checkMcpServers,
  isMcpServerReady,
  McpReadinessError,
  type McpServerReadiness,
} from '../mcpReadiness.js';
import {
  resolveCoworkMcpHeaders,
  toCoworkServers,
} from '../coworkSetup/config.js';
import {
  hostStdioReadinessConfig,
  hostStdioServers,
  type HostPlugin,
  type HostStdioPaths,
} from '../hostPlugins.js';
import { mcpServerLabel } from '../../config/mcpConfig.js';

export type CoworkMcpServerReadiness = McpServerReadiness;

export class CoworkMcpReadinessError extends McpReadinessError {
  constructor(servers: CoworkMcpServerReadiness[]) {
    super('Cowork', servers, 'task');
    this.name = 'CoworkMcpReadinessError';
  }
}

function resolveServer(
  server: MCPConfig,
  env: Record<string, string | undefined>,
  stdio: { plugins: readonly HostPlugin[]; paths: HostStdioPaths }
): MCPConfig {
  if (!isHttpConfig(server)) {
    // The same resolved launch Desktop runs, with only its declared env and
    // the caller's data dir. Readiness fails closed below `minTools`.
    const [parsed] = hostStdioServers([server], stdio.plugins);
    if (!parsed) throw new Error('Invalid Cowork MCP configuration.');
    return hostStdioReadinessConfig(parsed, stdio.paths);
  }
  const [coworkServer] = toCoworkServers([server]);
  if (!coworkServer) throw new Error('Invalid Cowork MCP configuration.');
  const headers = resolveCoworkMcpHeaders([coworkServer], env);
  return {
    ...server,
    // Use the same validated runtime headers as Cowork setup.
    auth: undefined,
    headers: headers[coworkServer.label],
  };
}

/**
 * Verify endpoint authentication and MCP initialization before Cowork submits
 * a prompt. This is shared across platforms; native Desktop status remains a
 * platform-owned diagnostic because MST cannot inspect every Desktop runtime.
 */
export async function verifyCoworkMcpServers(
  servers: MCPConfig[],
  env: Record<string, string | undefined>,
  stdio: { plugins?: readonly HostPlugin[]; paths?: HostStdioPaths } = {}
): Promise<CoworkMcpServerReadiness[]> {
  const context = { plugins: stdio.plugins ?? [], paths: stdio.paths ?? {} };
  // Resolve labels before checking servers individually so private paths and
  // Desktop settings use the same original (HTTP + stdio) server index.
  const labeledServers = servers.map((server, index) => ({
    ...server,
    label: mcpServerLabel(server, index),
  }));
  const results = await checkMcpServers(labeledServers, (server) =>
    resolveServer(server, env, context)
  );
  // The shared readiness rule (connected, with tools), Cowork's error.
  if (!results.every(isMcpServerReady))
    throw new CoworkMcpReadinessError(results);
  return results;
}
