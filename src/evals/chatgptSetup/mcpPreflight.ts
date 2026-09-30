import type { MCPConfig } from '../../config/mcpConfig.js';
import type { CodexMcpServerConfig } from '../codexSetup/config.js';
import {
  checkMcpServers,
  isMcpServerReady,
  type McpServerReadiness,
} from '../mcpReadiness.js';

/** Sanitized direct-preflight outcome. `tokens` must never reach telemetry. */
export interface ChatgptMcpPreflight {
  servers: McpServerReadiness[];
  /** Resolved bearer tokens by env var name, for native status probes. */
  tokens: Record<string, string>;
  passed: boolean;
}

/**
 * Connect to each configured server the way the ChatGPT app will (same URL and
 * resolved bearer token, or the same stdio launch) before any prompt. Fails
 * closed: every server must connect and list at least one tool. A missing
 * bearer token fails without connecting to anything.
 */
export async function preflightChatgptMcpServers(
  servers: readonly CodexMcpServerConfig[],
  launch: Record<string, string | undefined>
): Promise<ChatgptMcpPreflight> {
  const tokens: Record<string, string> = {};
  const missing: McpServerReadiness[] = [];
  const targets = servers.map((server): MCPConfig => {
    if (server.transport === 'stdio') return server;
    const token = server.bearerTokenEnvVar
      ? launch[server.bearerTokenEnvVar]
      : undefined;
    if (server.bearerTokenEnvVar) {
      if (token) tokens[server.bearerTokenEnvVar] = token;
      else
        missing.push({
          label: server.label,
          status: 'failed',
          elapsedMs: 0,
          error: 'missing bearer token',
        });
    }
    return {
      transport: 'http',
      label: server.label,
      serverUrl: server.url,
      ...(token ? { auth: { accessToken: token } } : {}),
    };
  });
  if (missing.length) return { servers: missing, tokens: {}, passed: false };
  const results = await checkMcpServers(targets);
  return {
    servers: results,
    tokens,
    passed: results.every(isMcpServerReady),
  };
}
