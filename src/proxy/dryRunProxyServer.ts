import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StdioMCPConfig } from '../config/mcpConfig.js';
import { PACKAGE_NAME, packageRoot } from '../utils/packageRoot.js';

export { PLANNED_WRITE_KEY } from './plannedWrite.js';

/**
 * Where the proxy records writes and how it answers them: what MST gives a
 * connector's `launch` as `context.writes`. Pass it to `dryRunProxyServer`
 * unchanged.
 */
export interface ProxyWrites {
  /** The write record file MST reads after each trial. */
  file: string;
  /** Answer writes with a success reply instead of a planned-write result. */
  simulate: boolean;
  /** The connector's `plannedWriteKey`: used when the proxy forwards writes. */
  plannedWriteKey?: string;
  /** The connector's `dispatchers`. */
  dispatchers?: Readonly<Record<string, string>>;
}

/** Options for {@link dryRunProxyServer}. */
export interface DryRunProxyServerOptions {
  /** The server's label in the eval config. */
  label: string;
  /** The upstream streamable-HTTP MCP endpoint. */
  upstreamUrl: string;
  /** The token file MST keeps current (`{ "version": 1, "accessToken": "..." }`). */
  tokenFile?: string;
  /** Extra headers on every upstream request. Not for credentials. */
  headers?: Record<string, string>;
  /** Tools to forward even though they are not annotated read-only. */
  readOnlyTools?: readonly string[];
  /** Tools to intercept even though they are annotated read-only. */
  alwaysWriteTools?: readonly string[];
  /** Extra keys for the planned-write result, for graders that read an older name. */
  plannedWriteAliases?: readonly string[];
  /**
   * Forward writes too, for a server that stops writes itself: the proxy
   * then carries the token MST renews and records the writes the server
   * marks with the connector's `plannedWriteKey`. Not when MST simulates
   * writes.
   */
  forwardWrites?: boolean;
  /**
   * How long a request may take, through the proxy and upstream. Default: 120
   * seconds. Raise it for tools slower than that, so the client's own limit
   * applies.
   */
  requestTimeoutMs?: number;
  /**
   * The launch context's `writes`: where the proxy records every write, and
   * whether it simulates them. Without it, MST can't see the server's writes
   * and refuses to run it (ADR 0014).
   */
  writes?: ProxyWrites;
  /**
   * Reply templates for simulated writes, by tool name: any JSON, with
   * `{{arguments.<path>}}`, `{{id}}`, `{{now}}` and `{{unixTime}}`
   * placeholders (see simulatedWrites.ts).
   */
  writeReplies?: Readonly<Record<string, unknown>>;
  /** Readiness fails closed below this many tools. */
  minTools?: number;
  /** Node to run the proxy with. Default: the Node running MST. */
  nodePath?: string;
}

/** The dry-run proxy's entry point in the installed package (built). */
export function dryRunProxyEntry(): string {
  const entry = join(packageRoot(), 'dist', 'proxy', 'dryRun.js');
  if (!existsSync(entry))
    throw new Error(
      `The dry-run proxy is not built (${entry}). Run \`npm run build\` in ${PACKAGE_NAME}.`
    );
  return entry;
}

/**
 * A stdio server entry that runs MST's dry-run proxy in front of an HTTP MCP
 * server: the client sees the server's tools, and only read-only tool calls
 * reach it. The entry holds a token file's path, never a token.
 */
export function dryRunProxyServer(
  options: DryRunProxyServerOptions
): StdioMCPConfig {
  return dryRunProxyServerAt([dryRunProxyEntry()], options);
}

/**
 * {@link dryRunProxyServer}, running the proxy from `entry` (the arguments
 * before its own): for tests, which run it from source.
 */
export function dryRunProxyServerAt(
  entry: readonly string[],
  options: DryRunProxyServerOptions
): StdioMCPConfig {
  // Fail here, where the connector is defined, not when the proxy starts.
  if ('simulateWrites' in options)
    throw new Error(
      "dryRunProxyServer: simulateWrites is now writes: pass the launch context's `writes`, and the reply templates as `writeReplies` (ADR 0014)."
    );
  const writes = options.writes;
  if (options.forwardWrites && writes?.simulate)
    throw new Error(
      `dryRunProxyServer: server "${options.label}" stops writes itself (forwardWrites), so MST can't simulate its writes. Run it without simulateWrites.`
    );
  if (writes?.plannedWriteKey !== undefined && !options.forwardWrites)
    throw new Error(
      `dryRunProxyServer: server "${options.label}" has a plannedWriteKey but doesn't forward writes; the key marks writes a server stopped itself.`
    );
  const { requestTimeoutMs } = options;
  if (
    requestTimeoutMs !== undefined &&
    (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
  )
    throw new Error(
      'dryRunProxyServer: requestTimeoutMs takes a positive whole number of milliseconds.'
    );
  const args = [
    ...entry,
    '--upstream-url',
    options.upstreamUrl,
    '--name',
    options.label,
  ];
  if (options.tokenFile) args.push('--token-file', options.tokenFile);
  for (const [name, value] of Object.entries(options.headers ?? {}))
    args.push('--header', `${name}:${value}`);
  for (const tool of [...(options.readOnlyTools ?? [])].sort())
    args.push('--read-only', tool);
  for (const tool of [...(options.alwaysWriteTools ?? [])].sort())
    args.push('--always-write', tool);
  for (const key of options.plannedWriteAliases ?? [])
    args.push('--planned-write-alias', key);
  if (options.forwardWrites) args.push('--forward-writes');
  if (options.requestTimeoutMs !== undefined)
    args.push('--request-timeout-ms', String(options.requestTimeoutMs));
  if (writes) {
    args.push('--write-record', writes.file);
    if (writes.plannedWriteKey !== undefined)
      args.push('--planned-write-key', writes.plannedWriteKey);
    for (const [tool, argument] of Object.entries(writes.dispatchers ?? {}))
      args.push('--dispatcher', `${tool}=${argument}`);
    if (writes.simulate) {
      args.push('--simulate-writes');
      if (options.writeReplies)
        args.push('--write-replies', JSON.stringify(options.writeReplies));
    }
  }
  return {
    transport: 'stdio',
    label: options.label,
    command: options.nodePath ?? process.execPath,
    args,
    // The proxy needs no ambient environment; a token never travels in env.
    inheritEnv: false,
    connectTimeoutMs: 120_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
    callTimeoutMs: options.requestTimeoutMs ?? 120_000,
    ...(options.minTools !== undefined ? { minTools: options.minTools } : {}),
  };
}
