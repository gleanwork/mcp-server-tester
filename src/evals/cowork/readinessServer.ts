import { isHttpConfig, type MCPConfig } from '../../config/mcpConfig.js';
import {
  resolveCoworkMcpHeaders,
  toCoworkServers,
} from '../coworkSetup/config.js';
import {
  clientStdioReadinessConfig,
  clientStdioServers,
  type MarketplacePlugin,
  type ClientStdioPaths,
} from '../clientPlugins.js';

/**
 * A server as Cowork will launch it, for MST's readiness check after the app
 * is prepared: a stdio server's resolved launch, with only its declared env
 * and the prepared data dir, and an HTTP server with Cowork's runtime
 * headers. `server` already has its label. Throws for a server Cowork can't
 * take, which fails that server's check.
 */
export function coworkReadinessServer(
  server: MCPConfig,
  env: Record<string, string | undefined>,
  stdio: { plugins: readonly MarketplacePlugin[]; paths: ClientStdioPaths }
): MCPConfig {
  if (!isHttpConfig(server)) {
    // Readiness fails closed below `minTools`.
    const [parsed] = clientStdioServers([server], stdio.plugins);
    if (!parsed) throw new Error('Invalid Cowork MCP configuration.');
    return clientStdioReadinessConfig(parsed, stdio.paths);
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
