import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { formatMCPConnectionFailure } from '../mcp/connectionDiagnostics.js';
import { mcpServerLabel } from '../config/mcpConfig.js';

/** Sanitized direct-connection readiness. Never raw errors, bodies, or headers. */
export interface McpServerReadiness {
  label: string;
  status: 'connected' | 'failed';
  toolCount?: number;
  /** The server's declared `minTools`, when it listed fewer. */
  minTools?: number;
  elapsedMs: number;
  error?: string;
}

/**
 * How long one probe may take: connect, list tools and close. A server whose
 * `connectTimeoutMs` is longer gets that to connect, plus this to list and
 * close (`probeLimitMs`).
 */
export const MCP_READINESS_TIMEOUT_MS = 30_000;

/** One server's whole probe limit, and how long its connect may take. */
function probeLimitMs(
  server: MCPConfig,
  timeoutMs: number
): { connect: number; whole: number } {
  const connect = server.connectTimeoutMs ?? timeoutMs;
  return connect > timeoutMs
    ? { connect, whole: connect + timeoutMs }
    : { connect, whole: timeoutMs };
}

/** The probe's own work: connect, list tools, close. Never throws. */
async function probe(
  server: MCPConfig,
  label: string,
  started: number,
  resolve: (server: MCPConfig) => MCPConfig,
  timeoutMs: number
): Promise<McpServerReadiness> {
  let client: Awaited<ReturnType<typeof createMCPClientForConfig>> | undefined;
  try {
    const resolved = resolve(server);
    // A connect that outlives the probe gives up, and stops its server.
    client = await createMCPClientForConfig({
      ...resolved,
      connectTimeoutMs: probeLimitMs(resolved, timeoutMs).connect,
    });
    const tools = await client.listTools();
    // A degraded server (e.g. static tools only, after an auth failure)
    // can still list tools. Fail closed below the declared minimum.
    const minTools =
      resolved.transport === 'stdio' ? resolved.minTools : undefined;
    if (minTools !== undefined && tools.tools.length < minTools)
      return {
        label,
        status: 'failed',
        toolCount: tools.tools.length,
        minTools,
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
}

/**
 * Connect to every server, list its tools and close, before any client
 * prompt. `timeoutMs` bounds each server's whole probe. Never throws for a
 * server failure and never retries: `readinessCheck.ts` decides that.
 */
export async function checkMcpServers(
  servers: MCPConfig[],
  resolve: (server: MCPConfig) => MCPConfig = (server) => server,
  timeoutMs = MCP_READINESS_TIMEOUT_MS
): Promise<McpServerReadiness[]> {
  return Promise.all(
    servers.map(async (server, index): Promise<McpServerReadiness> => {
      const label = mcpServerLabel(server, index);
      const started = Date.now();
      const limitMs = probeLimitMs(server, timeoutMs).whole;
      let timer: NodeJS.Timeout | undefined;
      try {
        // A probe that outlives its time still closes its connection.
        return await Promise.race([
          probe(server, label, started, resolve, timeoutMs),
          new Promise<McpServerReadiness>((settle) => {
            timer = setTimeout(
              () =>
                settle({
                  label,
                  status: 'failed',
                  elapsedMs: Date.now() - started,
                  error: `timed out after ${limitMs / 1000}s`,
                }),
              limitMs
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })
  );
}

/**
 * The one readiness rule for every client: the server connects and lists at
 * least one tool (and at least its declared `minTools`, which
 * `checkMcpServers` already enforces). A server with no tools can't be
 * evaluated, so it fails before any prompt is sent.
 */
export function isMcpServerReady(server: McpServerReadiness): boolean {
  return server.status === 'connected' && (server.toolCount ?? 0) > 0;
}

/**
 * What is wrong with a server that isn't ready, in words a person reads:
 * `search did not connect (network_error)`, `search listed no tools`, or
 * `search listed 2 tools, fewer than its minTools (4)`.
 */
export function describeNotReady(server: McpServerReadiness): string {
  if (server.status === 'connected') return `${server.label} listed no tools`;
  if (server.minTools !== undefined)
    return `${server.label} listed ${server.toolCount ?? 0} tool${server.toolCount === 1 ? '' : 's'}, fewer than its minTools (${server.minTools})`;
  return `${server.label} did not connect${server.error ? ` (${server.error})` : ''}`;
}
