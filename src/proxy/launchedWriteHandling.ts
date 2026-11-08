/**
 * How a launched server entry handles writes, read back from the arguments
 * `dryRunProxyServer` gives the dry-run proxy (ADR 0014). Its own module, with
 * no file system access, so MST's root bundle can read an entry without
 * carrying the code that finds the built proxy.
 */
import type { MCPConfig } from '../config/mcpConfig.js';

/** How a launched server entry handles writes, read from its arguments. */
export interface LaunchedWriteHandling {
  /** Whether the entry runs MST's dry-run proxy. */
  proxy: boolean;
  /** The write record file it was given, if any. */
  writeRecord?: string;
  forwardWrites: boolean;
  plannedWriteKey?: string;
  simulate: boolean;
}

/**
 * How `entry` handles writes, from the arguments `dryRunProxyServer` gives
 * it. An entry that doesn't run the dry-run proxy handles none.
 */
export function launchedWriteHandling(entry: MCPConfig): LaunchedWriteHandling {
  const args = entry.transport === 'stdio' ? (entry.args ?? []) : [];
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  // The built proxy, or (in tests) a source entry of the same name.
  const proxy =
    args.includes('--upstream-url') &&
    args.some((arg) => /[\\/]proxy[\\/]dryRun\.[jt]s$/.test(arg));
  const writeRecord = proxy ? value('--write-record') : undefined;
  const plannedWriteKey = proxy ? value('--planned-write-key') : undefined;
  return {
    proxy,
    ...(writeRecord !== undefined ? { writeRecord } : {}),
    forwardWrites: proxy && args.includes('--forward-writes'),
    ...(plannedWriteKey !== undefined ? { plannedWriteKey } : {}),
    simulate: proxy && args.includes('--simulate-writes'),
  };
}
