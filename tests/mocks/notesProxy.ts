/**
 * `notesProxyServer()`: a connector launch entry that runs MST's dry-run
 * proxy from source (tests/mocks/proxy/dryRun.ts) in front of an in-process
 * notes server, with the arguments `dryRunProxyServer()` gives the built one.
 */
import { fileURLToPath } from 'node:url';
import type { StdioMCPConfig } from '../../src/config/mcpConfig.js';
import {
  dryRunProxyServerAt,
  type DryRunProxyServerOptions,
} from '../../src/proxy/dryRunProxyServer.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY = fileURLToPath(new URL('./proxy/dryRun.ts', import.meta.url));

export function notesProxyServer(
  options: Omit<DryRunProxyServerOptions, 'upstreamUrl'> & {
    /** The server stops writes itself and marks them with this key. */
    marks?: string;
  }
): StdioMCPConfig {
  const { marks, ...rest } = options;
  const entry = dryRunProxyServerAt(['--import', 'tsx', ENTRY], {
    ...rest,
    upstreamUrl: `https://notes.example/mcp${marks ? `?marks=${marks}` : ''}`,
  });
  // tsx resolves from the repo; the proxy needs no other environment.
  return { ...entry, cwd: ROOT, connectTimeoutMs: 30_000 };
}
