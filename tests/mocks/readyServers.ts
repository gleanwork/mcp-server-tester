/**
 * Servers MST's readiness check can reach, for tests that run trials: a
 * stdio server (`node tests/mocks/readinessServer.mjs`) and an HTTP one.
 * A test that runs a client against a server that doesn't exist sends no
 * trial: the readiness check stops it first.
 */
import { fileURLToPath } from 'node:url';
import type { StdioMCPConfig } from '../../src/config/mcpConfig.js';
import { startReadinessHttpServer as startHttp } from './readinessServer.mjs';

/** The stdio server's script. */
export const READINESS_SERVER = fileURLToPath(
  new URL('./readinessServer.mjs', import.meta.url)
);

/** A stdio server that lists `READINESS_TOOLS` tools (default 1). */
export function readyStdioServer(
  env: Record<string, string> = {}
): StdioMCPConfig {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [READINESS_SERVER],
    ...(Object.keys(env).length ? { env } : {}),
  };
}

export interface ReadinessHttpServer {
  /** Its MCP endpoint; it answers on any path. */
  url: string;
  close(): Promise<void>;
}

/** The HTTP server, on a free local port. */
export function startReadinessHttpServer(
  options: {
    tools?: number;
    failTimes?: number;
    log?: string;
    stallList?: boolean;
  } = {}
): Promise<ReadinessHttpServer> {
  return startHttp(options) as Promise<ReadinessHttpServer>;
}
