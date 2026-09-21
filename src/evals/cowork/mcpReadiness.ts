import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../mcp/clientFactory.js';
import { isHttpConfig, type MCPConfig } from '../../config/mcpConfig.js';

export interface CoworkMcpServerReadiness {
  label: string;
  status: 'connected' | 'failed';
  toolCount?: number;
  elapsedMs: number;
  error?: string;
}

const PREFLIGHT_TIMEOUT_MS = 30_000;

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

function label(server: MCPConfig, index: number): string {
  return server.label ?? `server-${index + 1}`;
}

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

function resolveServer(
  server: MCPConfig,
  env: Record<string, string | undefined>
): MCPConfig {
  if (!isHttpConfig(server)) return server;
  const tokenEnv = server.auth?.accessTokenEnv;
  if (!tokenEnv) return server;
  const token = env[tokenEnv];
  if (!token)
    throw new Error(`MCP token environment variable ${tokenEnv} is not set.`);
  return {
    ...server,
    // Match Claude Desktop's headers-helper contract exactly. Some eval MCP
    // endpoints reject the SDK auth option even though it produces the same
    // nominal Authorization value.
    auth: undefined,
    headers: {
      ...server.headers,
      Authorization: `Bearer ${token}`,
    },
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'connection_failed';
  return message
    .replace(/https?:\/\/[^\s)]+/g, '[REDACTED_URL]')
    .replace(
      /(token|key|secret|password|authorization)[^\s=]*[=:\s]+[^\s]+/gi,
      '$1=[REDACTED]'
    );
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
  const results = await Promise.all(
    servers.map(async (server, index): Promise<CoworkMcpServerReadiness> => {
      const started = Date.now();
      let client:
        | Awaited<ReturnType<typeof createMCPClientForConfig>>
        | undefined;
      try {
        client = await createMCPClientForConfig(resolveServer(server, env));
        const tools = await withTimeout(
          client.listTools(),
          PREFLIGHT_TIMEOUT_MS
        );
        return {
          label: label(server, index),
          status: 'connected',
          toolCount: tools.tools.length,
          elapsedMs: Date.now() - started,
        };
      } catch (error) {
        return {
          label: label(server, index),
          status: 'failed',
          elapsedMs: Date.now() - started,
          error: safeError(error),
        };
      } finally {
        if (client) await closeMCPClient(client).catch(() => undefined);
      }
    })
  );
  if (results.some((result) => result.status !== 'connected'))
    throw new CoworkMcpReadinessError(results);
  return results;
}
