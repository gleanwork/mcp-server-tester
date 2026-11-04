/**
 * The readiness check MST runs for every client before the first trial of a
 * batch (ADR 0011): each server connects and lists at least one tool, and at
 * least its `minTools` (`isMcpServerReady`). A batch is a variant's requests
 * for one client and dataset, as a local run and a shard's worker group
 * them. A server that isn't ready is checked again after each retry delay;
 * when one still isn't, no trial of the batch is sent, and each ends as a
 * retryable `setup` infrastructure failure that names the server (ADR 0010).
 *
 * The local dispatch and the worker call {@link batchNotReady} before a
 * batch starts. A desktop client whose servers resolve only once its app is
 * prepared (Cowork's stdio paths) is marked with
 * {@link checksServersAfterPrepare}: `desktopBatch` checks its servers after
 * `prepare` instead, so each server is checked once per batch.
 */
import {
  mcpServerLabel,
  usesClientResolvedFields,
  type MCPConfig,
} from '../config/mcpConfig.js';
import type {
  ClientDefinition,
  ClientRunResult,
} from './evalFrameworkTypes.js';
import {
  checkMcpServers,
  describeNotReady,
  isMcpServerReady,
  type McpServerReadiness,
} from './mcpReadiness.js';
import { infrastructureEnding } from './trialEnding.js';

/**
 * How long to wait before each recheck of servers that weren't ready. A
 * remote server that is briefly slow or unreachable would otherwise cost the
 * whole batch.
 */
export const READINESS_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000];

const RETRY_VARIABLE = 'MST_MCP_READINESS_RETRY_S';
/** The name `MST_MCP_READINESS_RETRY_S` had when only Cowork retried. */
const RETIRED_RETRY_VARIABLE = 'MST_COWORK_MCP_PREFLIGHT_RETRY_S';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The retry delays: `MST_MCP_READINESS_RETRY_S` (comma-separated seconds,
 * "10,30"; empty means no retries) from `env`, else MST's own environment,
 * else {@link READINESS_RETRY_DELAYS_MS}. Throws for a malformed value, and
 * when the retired `MST_COWORK_MCP_PREFLIGHT_RETRY_S` is set, so a run that
 * sets it fails when it starts.
 */
export function readinessRetryDelaysMs(env: Env = {}): readonly number[] {
  const merged = { ...process.env, ...env };
  if (merged[RETIRED_RETRY_VARIABLE] !== undefined)
    throw new Error(
      `${RETIRED_RETRY_VARIABLE} was renamed: MST now checks every client's MCP servers before the first trial. Set ${RETRY_VARIABLE} instead.`
    );
  const value = merged[RETRY_VARIABLE];
  if (value === undefined) return READINESS_RETRY_DELAYS_MS;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const seconds = Number(part);
      if (!Number.isFinite(seconds) || seconds < 0)
        throw new Error(
          `${RETRY_VARIABLE} must be comma-separated seconds, got "${value}"`
        );
      return seconds * 1000;
    });
}

export interface ReadinessCheckOptions {
  /** Where `MST_MCP_READINESS_RETRY_S` is read first: the run's environment. */
  env?: Env;
  /**
   * The server as the client will launch it (Cowork's resolved stdio
   * launch). A resolve that throws fails that server.
   */
  resolve?: (server: MCPConfig) => MCPConfig;
  /**
   * Receives a line before each recheck, and when a batch doesn't run.
   * `console.warn` by default.
   */
  log?: (line: string) => void;
  /** The batch in messages, e.g. `The api batch for variant "baseline"`. */
  batch?: string;
  /** Waits out a retry delay. Tests pass one that doesn't. */
  sleep?: (ms: number) => Promise<void>;
  /** Bounds each probe. */
  timeoutMs?: number;
}

/** Whether a batch's servers are ready, and why not. */
export type ServersReadiness =
  | { ready: true; servers: McpServerReadiness[] }
  | { ready: false; servers: McpServerReadiness[]; reason: string };

function logLine(options: ReadinessCheckOptions): (line: string) => void {
  return options.log ?? ((line) => console.warn(line));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks `servers`, rechecking only the ones that weren't ready after each
 * retry delay. Never throws for a server; throws only for a malformed retry
 * setting.
 */
export async function checkServersReady(
  servers: readonly MCPConfig[],
  options: ReadinessCheckOptions = {}
): Promise<ServersReadiness> {
  const delays = readinessRetryDelaysMs(options.env);
  // Labels by each server's place in the whole set, so a recheck of a
  // subset names (and resolves) each server as the first check did.
  const labeled = servers.map((server, index) => ({
    ...server,
    label: mcpServerLabel(server, index),
  }));
  const check = (subset: MCPConfig[]) =>
    checkMcpServers(subset, options.resolve, options.timeoutMs);
  const results = await check(labeled);
  let attempts = 1;
  for (const delayMs of delays) {
    const failed = results.flatMap((result, index) =>
      isMcpServerReady(result) ? [] : [index]
    );
    if (failed.length === 0) break;
    logLine(options)(
      `[mst] MCP servers not ready: ${failed
        .map((index) => describeNotReady(results[index]!))
        .join('; ')}. Checking again in ${Math.round(delayMs / 1000)}s.`
    );
    await (options.sleep ?? sleep)(delayMs);
    attempts++;
    const again = await check(failed.map((index) => labeled[index]!));
    failed.forEach((index, k) => {
      results[index] = again[k]!;
    });
  }
  const notReady = results.filter((result) => !isMcpServerReady(result));
  if (notReady.length === 0) return { ready: true, servers: results };
  return {
    ready: false,
    servers: results,
    reason: `MCP server${notReady.length === 1 ? '' : 's'} not ready, so no trial was sent: ${notReady
      .map(describeNotReady)
      .join('; ')}. Checked ${attempts} time${attempts === 1 ? '' : 's'}.`,
  };
}

/**
 * The result each trial of a batch gets when its servers weren't ready: a
 * retryable setup failure (ADR 0010), so `mst run --resume` collects it
 * again. Nothing was sent to the client.
 */
export function notReadyResult(
  readiness: Extract<ServersReadiness, { ready: false }>
): ClientRunResult {
  return {
    finalText: '',
    events: [],
    error: readiness.reason,
    ending: infrastructureEnding('setup', readiness.reason, true),
    telemetry: {
      caseExecution: { status: 'not-submitted', continuation: 'blocked' },
      mcpReadiness: readiness.servers,
    },
  };
}

const CHECKS_AFTER_PREPARE = Symbol('mst.checksServersAfterPrepare');

/**
 * Marks a desktop client whose batch checks its servers after it prepares
 * the app (`DesktopClientAdapter.readiness`), so the dispatch doesn't check
 * them a second time before the batch.
 */
export function checksServersAfterPrepare<T extends ClientDefinition>(
  definition: T
): T {
  return Object.assign(definition, { [CHECKS_AFTER_PREPARE]: true });
}

/**
 * Checks a batch's servers before its first trial. Returns the result for
 * each of its trials when they aren't ready, or `undefined` when the batch
 * can run: its servers are ready, it has none, or its client checks them
 * itself after it prepares its app.
 *
 * A stdio server with client-resolved fields (`${dataDir}`, `files`,
 * `auth`) has no launch until its client resolves it, so it isn't checked
 * here. Only a client that resolves them can run it (Cowork, which checks
 * it after `prepare`).
 */
export async function batchNotReady(
  definition: ClientDefinition,
  servers: readonly MCPConfig[],
  options: ReadinessCheckOptions = {}
): Promise<(() => ClientRunResult) | undefined> {
  if ((definition as { [CHECKS_AFTER_PREPARE]?: true })[CHECKS_AFTER_PREPARE])
    return undefined;
  // Labeled first, so each keeps the name its place in the set gives it.
  const checkable = servers
    .map((server, index) => ({
      ...server,
      label: mcpServerLabel(server, index),
    }))
    .filter((server) => !usesClientResolvedFields(server));
  if (!checkable.length) return undefined;
  const readiness = await checkServersReady(checkable, options);
  if (readiness.ready) return undefined;
  logLine(options)(
    `[mst] ${options.batch ?? 'The batch'} didn't run: ${readiness.reason}`
  );
  return () => notReadyResult(readiness);
}
