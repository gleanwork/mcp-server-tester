import { isHttpConfig, type MCPConfig } from '../../config/mcpConfig.js';
import {
  checkMcpServers,
  describeMcpReadiness,
  isMcpServerReady,
  McpReadinessError,
  type McpServerReadiness,
} from '../mcpReadiness.js';
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
  stdio: { plugins: readonly MarketplacePlugin[]; paths: ClientStdioPaths }
): MCPConfig {
  if (!isHttpConfig(server)) {
    // The same resolved launch Desktop runs, with only its declared env and
    // the caller's data dir. Readiness fails closed below `minTools`.
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

/**
 * Waits before rechecking servers that weren't ready. A remote server that is
 * briefly slow or unreachable would otherwise end the whole shard: every
 * remaining case in it is lost, not just the one about to start.
 */
export const COWORK_MCP_PREFLIGHT_RETRY_DELAYS_MS: readonly number[] = [
  10_000, 30_000,
];

/**
 * `MST_COWORK_MCP_PREFLIGHT_RETRY_S` overrides the delays: comma-separated
 * seconds ("10,30"); empty means no retries.
 */
export function preflightRetryDelaysMs(
  value = process.env.MST_COWORK_MCP_PREFLIGHT_RETRY_S
): readonly number[] {
  if (value === undefined) return COWORK_MCP_PREFLIGHT_RETRY_DELAYS_MS;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const seconds = Number(part);
      if (!Number.isFinite(seconds) || seconds < 0)
        throw new Error(
          `MST_COWORK_MCP_PREFLIGHT_RETRY_S must be comma-separated seconds, got "${value}"`
        );
      return seconds * 1000;
    });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Verify endpoint authentication and MCP initialization before Cowork submits
 * a prompt. This is shared across platforms; native Desktop status remains a
 * platform-owned diagnostic because MST cannot inspect every Desktop runtime.
 *
 * Servers that aren't ready are checked again after each of `retryDelaysMs`;
 * only those servers are rechecked, and the preflight fails if any is still
 * not ready after the last attempt.
 */
export async function verifyCoworkMcpServers(
  servers: MCPConfig[],
  env: Record<string, string | undefined>,
  stdio: {
    plugins?: readonly MarketplacePlugin[];
    paths?: ClientStdioPaths;
    retryDelaysMs?: readonly number[];
    log?: (message: string) => void;
  } = {}
): Promise<CoworkMcpServerReadiness[]> {
  const context = { plugins: stdio.plugins ?? [], paths: stdio.paths ?? {} };
  // Resolve labels before checking servers individually so private paths and
  // Desktop settings use the same original (HTTP + stdio) server index.
  const labeledServers = servers.map((server, index) => ({
    ...server,
    label: mcpServerLabel(server, index),
  }));
  const check = (subset: MCPConfig[]) =>
    checkMcpServers(subset, (server) => resolveServer(server, env, context));
  const results = await check(labeledServers);
  // The run's setting, like the client's other MST_COWORK_* settings; when
  // it has none, preflightRetryDelaysMs reads MST's own environment.
  const delays =
    stdio.retryDelaysMs ??
    preflightRetryDelaysMs(env.MST_COWORK_MCP_PREFLIGHT_RETRY_S);
  for (const delayMs of delays) {
    const failed = results.flatMap((result, index) =>
      isMcpServerReady(result) ? [] : [index]
    );
    if (failed.length === 0) break;
    stdio.log?.(
      `[mst:cowork] MCP preflight: ${describeMcpReadiness(
        failed.map((index) => results[index]!)
      )}; checking again in ${Math.round(delayMs / 1000)}s`
    );
    await sleep(delayMs);
    const again = await check(failed.map((index) => labeledServers[index]!));
    failed.forEach((index, k) => {
      results[index] = again[k]!;
    });
  }
  // The shared readiness rule (connected, with tools), Cowork's error.
  if (!results.every(isMcpServerReady))
    throw new CoworkMcpReadinessError(results);
  return results;
}
