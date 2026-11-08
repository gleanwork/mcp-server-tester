/**
 * The readiness check MST runs for every client before the first trial of a
 * batch (ADR 0011): each server connects and lists at least one tool, and at
 * least its `minTools` (`isMcpServerReady`). A batch is a variant's requests
 * for one client and dataset, as a local run and a shard's worker group
 * them. A server that isn't ready is checked again after each retry delay;
 * when one still isn't, no trial of the batch is sent, and each ends as a
 * retryable `setup` infrastructure failure that names the server (ADR 0010).
 *
 * The local dispatch and the worker call {@link readyBatch} before a batch
 * starts. A desktop client whose servers resolve only once its app is
 * prepared (Cowork's stdio paths) is marked with
 * {@link checksServersAfterPrepare}: `desktopBatch` checks its servers after
 * `prepare` instead, so each server is checked once per batch. A proxied
 * batch (a variant's tool metadata, through MST's tool-variant proxy) is
 * checked before the proxy starts, at its declared servers, whatever its
 * client. The check follows the client each trial runs on, which a case can
 * name itself: cases of one batch on clients with different setups
 * ({@link readinessSetup}) get one check per setup.
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
import { eventServer } from './clientTranscript.js';
import { ProxyUpstreamError } from './toolSurfaceProxy.js';
import { formatMCPConnectionFailure } from '../mcp/connectionDiagnostics.js';

/**
 * How long to wait before each recheck of servers that weren't ready. A
 * remote server that is briefly slow or unreachable would otherwise cost the
 * whole batch.
 */
export const READINESS_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000];

const RETRY_VARIABLE = 'MST_MCP_READINESS_RETRY_S';
/**
 * The retired name, from when only Cowork retried. A run that sets it fails
 * and is told to set `MST_MCP_READINESS_RETRY_S` instead.
 */
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
  /**
   * The labels of servers with no write mode (ADR 0014,
   * `readOnlyServerLabels`). A batch doesn't run when one of them lists a
   * tool that isn't read-only: MST couldn't see its writes. The load check
   * stops the run for this when it can list the server first.
   */
  readOnly?: ReadonlySet<string>;
}

/**
 * The tools each `read-only` server listed when it was checked, by label
 * (ADR 0014). A trial that calls another tool on one of them reached a tool
 * MST never saw as read-only (`checkReadOnlyCalls`).
 */
export type ReadOnlyTools = ReadonlyMap<string, ReadonlySet<string>>;

/** Whether a batch's servers are ready, and why not. */
export type ServersReadiness =
  | {
      ready: true;
      servers: McpServerReadiness[];
      readOnlyTools: ReadOnlyTools;
    }
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
  const readOnlyTools: ReadOnlyTools = new Map(
    results.flatMap((result) =>
      result.tools && options.readOnly?.has(result.label) === true
        ? [[result.label, new Set(result.tools)] as const]
        : []
    )
  );
  // The tool names are for the check after each trial, not for results.
  for (const result of results) delete result.tools;
  const notReady = results.filter((result) => !isMcpServerReady(result));
  const unguarded = results.filter(
    (result) =>
      isMcpServerReady(result) &&
      options.readOnly?.has(result.label) === true &&
      (result.writeTools?.length ?? 0) > 0
  );
  if (notReady.length === 0 && unguarded.length > 0)
    return {
      ready: false,
      servers: results,
      reason: `MST can't see these servers' writes, so no trial was sent: ${unguarded
        .map(
          (result) =>
            `"${result.label}" lists tools that aren't read-only (${result.writeTools!.join(', ')})`
        )
        .join(
          '; '
        )}. Put each behind a connector's dry-run proxy, or accept its writes in the eval config with \`"writes": { "<label>": "unguarded" }\` (ADR 0014).`,
    };
  if (notReady.length === 0)
    return { ready: true, servers: results, readOnlyTools };
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
 * How a client reaches a batch's servers, which decides the check it gets
 * before its first trial: through the tool-variant proxy (`proxied`),
 * directly (`direct`), or directly by a client that checks them itself after
 * it prepares its app (`after-prepare`, no check here). Clients with the
 * same setup share one check, so a batch whose cases name different clients
 * checks each server once per setup.
 */
export function readinessSetup(
  definition: ClientDefinition,
  proxied: boolean
): 'proxied' | 'direct' | 'after-prepare' {
  if (proxied) return 'proxied';
  return (definition as { [CHECKS_AFTER_PREPARE]?: true })[CHECKS_AFTER_PREPARE]
    ? 'after-prepare'
    : 'direct';
}

/**
 * `result`, failed when its transcript calls a tool on a `read-only` server
 * that the server didn't list when MST checked it (ADR 0014). MST doesn't
 * sit between a direct server and its client, so a server that lists more
 * tools to the client than to MST's check (one whose tools depend on who
 * signs in, say) could take a write MST never saw. The trial can't count:
 * it ends as a `setup` failure that a retry can't fix. `servers` are the
 * trial's, so a call with no server on a one-server run is that server's,
 * as its transcript will say.
 */
export function checkReadOnlyCalls(
  result: ClientRunResult,
  readOnlyTools: ReadOnlyTools | undefined,
  servers: readonly MCPConfig[]
): ClientRunResult {
  if (!readOnlyTools?.size) return result;
  const unlisted = new Set<string>();
  for (const event of result.events) {
    if (event.kind !== 'tool_call' || event.source !== 'mcp') continue;
    const server = eventServer(event, servers);
    const listed = server === undefined ? undefined : readOnlyTools.get(server);
    if (!server || !listed) continue;
    if (!listed.has(event.name)) unlisted.add(`${server}.${event.name}`);
  }
  if (unlisted.size === 0) return result;
  const reason = `The client called ${[...unlisted].join(', ')}, which ${unlisted.size === 1 ? 'its server' : 'their servers'} didn't list when MST checked ${unlisted.size === 1 ? 'it' : 'them'}: MST can't tell whether ${unlisted.size === 1 ? 'that call' : 'those calls'} wrote. Put the server behind a connector's dry-run proxy, or declare its write mode in the eval config's \`writes\` (ADR 0014).`;
  return {
    ...result,
    error: reason,
    ending: infrastructureEnding('setup', reason, false),
  };
}

/** How a batch's servers stand before its first trial: see {@link batchNotReady}. */
interface BatchServers {
  notReady?: () => ClientRunResult;
  /** The `read-only` servers' tools, when the batch was checked here. */
  readOnlyTools?: ReadOnlyTools;
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
  options: ReadinessCheckOptions & {
    /**
     * The batch reaches its servers through the tool-variant proxy, which
     * MST launches: they are checked here even for a client that checks
     * after it prepares its app.
     */
    proxied?: boolean;
  } = {}
): Promise<(() => ClientRunResult) | undefined> {
  return (await batchServers(definition, servers, options)).notReady;
}

async function batchServers(
  definition: ClientDefinition,
  servers: readonly MCPConfig[],
  options: ReadinessCheckOptions & { proxied?: boolean }
): Promise<BatchServers> {
  if (readinessSetup(definition, options.proxied === true) === 'after-prepare')
    return {};
  // Labeled first, so each keeps the name its place in the set gives it.
  const checkable = servers
    .map((server, index) => ({
      ...server,
      label: mcpServerLabel(server, index),
    }))
    .filter((server) => !usesClientResolvedFields(server));
  if (!checkable.length) return {};
  const readiness = await checkServersReady(checkable, options);
  if (readiness.ready)
    return readiness.readOnlyTools.size > 0
      ? { readOnlyTools: readiness.readOnlyTools }
      : {};
  logLine(options)(
    `[mst] ${options.batch ?? 'The batch'} didn't run: ${readiness.reason}`
  );
  return { notReady: () => notReadyResult(readiness) };
}

/**
 * A batch that can't run, or the proxy it runs through (when it has one)
 * and the tools its `read-only` servers listed, for `checkReadOnlyCalls`.
 */
export type BatchReadiness<P> =
  | {
      notReady: () => ClientRunResult;
      proxy?: undefined;
      readOnlyTools?: undefined;
    }
  | {
      notReady?: undefined;
      proxy: P | undefined;
      readOnlyTools?: ReadOnlyTools;
    };

/**
 * Readies a batch before its first trial: checks its declared servers
 * ({@link batchNotReady}), then, for a proxied batch, starts the proxy
 * (`startProxy`). The check runs against the declarations, never through
 * the proxy, so each server's own `minTools` applies and no probe is taken
 * for the client's traffic. A proxy that can't reach a server once the
 * check passed ends the batch the same way, as a retryable setup failure
 * naming the server; any other error starting the proxy is thrown.
 */
export async function readyBatch<P>(
  definition: ClientDefinition,
  servers: readonly MCPConfig[],
  startProxy: (() => Promise<P>) | undefined,
  options: ReadinessCheckOptions = {}
): Promise<BatchReadiness<P>> {
  const { notReady, readOnlyTools } = await batchServers(definition, servers, {
    ...options,
    proxied: startProxy !== undefined,
  });
  if (notReady) return { notReady };
  const checked = readOnlyTools ? { readOnlyTools } : {};
  if (!startProxy) return { proxy: undefined, ...checked };
  try {
    return { proxy: await startProxy(), ...checked };
  } catch (error) {
    if (!(error instanceof ProxyUpstreamError)) throw error;
    // Recorded as the check records its own failures: one that connected
    // and then failed to list its tools says so.
    const server: McpServerReadiness = {
      label: error.server,
      status: error.phase === 'list' ? 'connected' : 'failed',
      elapsedMs: 0,
      error: formatMCPConnectionFailure(error.cause),
    };
    const reason = `MCP server not ready, so no trial was sent: ${describeNotReady(server)} when the tool-variant proxy started.`;
    logLine(options)(
      `[mst] ${options.batch ?? 'The batch'} didn't run: ${reason}`
    );
    const readiness: Extract<ServersReadiness, { ready: false }> = {
      ready: false,
      servers: [server],
      reason,
    };
    return { notReady: () => notReadyResult(readiness) };
  }
}
