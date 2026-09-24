import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { formatMCPConnectionFailure } from '../mcp/connectionDiagnostics.js';

/** Sanitized direct-connection readiness. Never raw errors, bodies, or headers. */
export interface McpServerReadiness {
  label: string;
  status: 'connected' | 'failed';
  toolCount?: number;
  elapsedMs: number;
  error?: string;
}

export const MCP_PREFLIGHT_TIMEOUT_MS = 30_000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('MCP preflight timed out')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Connect to every configured server and list tools before any host prompt.
 * Shared by desktop hosts. Callers decide how to fail; this never throws for a
 * server failure and never retries.
 */
export async function checkMcpServers(
  servers: MCPConfig[],
  resolve: (server: MCPConfig) => MCPConfig = (server) => server
): Promise<McpServerReadiness[]> {
  return Promise.all(
    servers.map(async (server, index): Promise<McpServerReadiness> => {
      const label = server.label ?? `server-${index + 1}`;
      const started = Date.now();
      let client:
        | Awaited<ReturnType<typeof createMCPClientForConfig>>
        | undefined;
      try {
        const resolved = resolve(server);
        client = await createMCPClientForConfig(resolved);
        const tools = await withTimeout(
          client.listTools(),
          MCP_PREFLIGHT_TIMEOUT_MS
        );
        // A degraded server (e.g. static tools only, after an auth failure)
        // can still list tools. Fail closed below the declared minimum.
        const minTools =
          resolved.transport === 'stdio' ? resolved.minTools : undefined;
        if (minTools !== undefined && tools.tools.length < minTools)
          return {
            label,
            status: 'failed',
            toolCount: tools.tools.length,
            elapsedMs: Date.now() - started,
            error: `too few tools (${tools.tools.length} < ${minTools})`,
          };
        return {
          label,
          status: 'connected',
          toolCount: tools.tools.length,
          elapsedMs: Date.now() - started,
        };
      } catch (error) {
        return {
          label,
          status: 'failed',
          elapsedMs: Date.now() - started,
          error: formatMCPConnectionFailure(error),
        };
      } finally {
        if (client) await closeMCPClient(client).catch(() => undefined);
      }
    })
  );
}
