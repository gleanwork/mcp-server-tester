import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { ConnectionTarget } from '../mcp/connectionTarget.js';

/**
 * Raw request channel for conformance checks.
 *
 * Some spec rules are about how a server rejects malformed or mismatched
 * requests (`-32022`, `-32602`, `-32020`, HTTP 404/405). The SDK client always
 * sends well-formed requests, so these checks talk to the server directly.
 */

/** The response to a raw probe. */
export interface ProbeResponse {
  /** HTTP status (HTTP probes only). */
  status?: number;
  /** Response headers, lower-cased (HTTP probes only). */
  headers?: Record<string, string>;
  /** The first JSON-RPC message in the response, if any. */
  message: Record<string, unknown> | null;
}

const PROBE_TIMEOUT_MS = 10_000;

/** Builds the per-request `_meta` envelope for a modern request. */
export function modernMeta(protocolVersion: string): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': {
      name: '@gleanwork/mcp-server-tester/conformance-probe',
      version: '1',
    },
  };
}

/** Extracts the first JSON-RPC message from a JSON or SSE response body. */
function parseBody(
  contentType: string,
  body: string
): Record<string, unknown> | null {
  const text = body.trim();
  if (!text) return null;
  try {
    if (contentType.includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        }
      }
      return null;
    }
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Options for an HTTP probe. */
export interface HttpProbeOptions {
  method?: 'POST' | 'GET' | 'DELETE';
  body?: unknown;
  /** Extra headers; these override MST's defaults. */
  headers?: Record<string, string>;
}

/**
 * Sends one raw HTTP request to the target's MCP endpoint.
 */
export async function probeHttp(
  target: Extract<ConnectionTarget, { transport: 'http' }>,
  options: HttpProbeOptions
): Promise<ProbeResponse> {
  // Headers merge case-insensitively, so a configured `authorization` or
  // `Accept` is replaced rather than sent twice.
  const headers = new Headers(target.headers);
  headers.set('accept', 'application/json, text/event-stream');
  if (options.body !== undefined)
    headers.set('content-type', 'application/json');
  if (target.authProvider && !headers.has('authorization')) {
    const tokens = await target.authProvider.tokens();
    if (tokens?.access_token) {
      headers.set('authorization', `Bearer ${tokens.access_token}`);
    }
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(target.url, {
      method: options.method ?? 'POST',
      headers,
      signal: controller.signal,
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      ...(target.dispatcher ? { dispatcher: target.dispatcher } : {}),
    } as RequestInit);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value;
    });
    const body = await response.text();
    return {
      status: response.status,
      headers: responseHeaders,
      message: parseBody(responseHeaders['content-type'] ?? '', body),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts a fresh copy of the target's stdio server, writes one message, and
 * returns the JSON-RPC response with the same id (or `null` on timeout/exit).
 *
 * Uses a separate process so the connection under test is never affected.
 */
export async function probeStdio(
  target: Extract<ConnectionTarget, { transport: 'stdio' }>,
  message: unknown,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<ProbeResponse> {
  const child = spawn(target.command, target.args, {
    cwd: target.cwd,
    env: target.env ?? process.env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  try {
    const reply = await new Promise<Record<string, unknown> | null>(
      (resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.once('error', () => {
          clearTimeout(timer);
          resolve(null);
        });
        lines.on('line', (line) => {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            // Match the response by id; servers may print notifications first.
            if (
              parsed.jsonrpc === '2.0' &&
              parsed.id === (message as { id?: unknown }).id
            ) {
              clearTimeout(timer);
              resolve(parsed);
            }
          } catch {
            // Ignore non-JSON output; stdio servers should not emit it, but
            // that is not what this probe checks.
          }
        });
        // A server that exits early would otherwise raise EPIPE unhandled.
        child.stdin.on('error', () => undefined);
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    );
    return { message: reply };
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

/** Reads `error.code` from a JSON-RPC message, if it is an error. */
export function errorCodeOf(
  message: Record<string, unknown> | null
): number | null {
  const error = message?.error as { code?: unknown } | undefined;
  return typeof error?.code === 'number' ? error.code : null;
}
