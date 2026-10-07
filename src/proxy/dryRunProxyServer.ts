import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StdioMCPConfig } from '../config/mcpConfig.js';

export { PLANNED_WRITE_KEY } from './dryRunProxy.js';

const PACKAGE_NAME = '@gleanwork/mcp-server-tester';

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
  /** Readiness fails closed below this many tools. */
  minTools?: number;
  /** Node to run the proxy with. Default: the Node running MST. */
  nodePath?: string;
}

function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string;
      };
      if (name === PACKAGE_NAME) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot find the ${PACKAGE_NAME} package.`);
    directory = parent;
  }
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
  const args = [
    dryRunProxyEntry(),
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
  return {
    transport: 'stdio',
    label: options.label,
    command: options.nodePath ?? process.execPath,
    args,
    // The proxy needs no ambient environment; a token never travels in env.
    inheritEnv: false,
    connectTimeoutMs: 120_000,
    requestTimeoutMs: 120_000,
    callTimeoutMs: 120_000,
    ...(options.minTools !== undefined ? { minTools: options.minTools } : {}),
  };
}
