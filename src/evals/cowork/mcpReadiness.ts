import { isHttpConfig, type MCPConfig } from '../../config/mcpConfig.js';
import { checkMcpServers, type McpServerReadiness } from '../mcpReadiness.js';
import {
  resolveCoworkMcpHeaders,
  toCoworkServers,
} from '../coworkSetup/config.js';

export type CoworkMcpServerReadiness = McpServerReadiness;

export class CoworkMcpReadinessError extends Error {
  readonly servers: CoworkMcpServerReadiness[];

  constructor(servers: CoworkMcpServerReadiness[]) {
    super(
      `Cowork MCP preflight failed; no task was submitted. ${servers
        .map(
          (server) =>
            `${server.label}=${server.status}${server.error ? `(${server.error})` : ''}(${server.elapsedMs}ms)`
        )
        .join(', ')}`
    );
    this.name = 'CoworkMcpReadinessError';
    this.servers = servers;
  }
}

function resolveServer(
  server: MCPConfig,
  env: Record<string, string | undefined>
): MCPConfig {
  if (!isHttpConfig(server)) return server;
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
  env: Record<string, string | undefined>
): Promise<CoworkMcpServerReadiness[]> {
  const results = await checkMcpServers(servers, (server) =>
    resolveServer(server, env)
  );
  if (results.some((result) => result.status !== 'connected'))
    throw new CoworkMcpReadinessError(results);
  return results;
}
