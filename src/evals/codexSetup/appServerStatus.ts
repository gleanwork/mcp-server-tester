import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { signalGroup, stopGroup } from './native.js';

/**
 * Status responses grow with the configured servers: one `mcpServerStatus/list`
 * line carries every server's tool schemas (seven real connectors are ~600 KB),
 * and app-server initializes each server before answering. So the output is
 * never capped by size or row count, and the deadline scales with the servers.
 * The probe stays read-only and its process group is always stopped.
 */
export const APP_SERVER_LIMITS = {
  baseTimeoutMs: 30_000,
  perServerTimeoutMs: 15_000,
  pageRows: 100,
};

export function appServerTimeoutMs(serverCount: number): number {
  return (
    APP_SERVER_LIMITS.baseTimeoutMs +
    Math.max(0, serverCount) * APP_SERVER_LIMITS.perServerTimeoutMs
  );
}

/** The only outgoing methods. The probe never answers server requests. */
const METHODS = new Set(['initialize', 'initialized', 'mcpServerStatus/list']);
const AUTH_STATUSES = new Set([
  'unsupported',
  'notLoggedIn',
  'bearerToken',
  'oAuth',
]);

export type AppServerFailure =
  | 'timeout'
  | 'unexpected-eof'
  | 'io-error'
  | 'invalid-response'
  | 'server-request-unsupported'
  | 'unsupported-method'
  | 'unsupported-method-or-params'
  | 'http-auth-error'
  | 'http-client-error'
  | 'http-server-error'
  | 'rpc-error';

export type AppServerAuthStatus =
  | 'unsupported'
  | 'notLoggedIn'
  | 'bearerToken'
  | 'oAuth'
  | 'unknown';

export interface AppServerServerStatus {
  label: string;
  initialized: boolean;
  toolCount: number | null;
  authStatus: AppServerAuthStatus;
}

/** Sanitized receipt: labels come from MST config, never from native output. */
export type AppServerStatus =
  | { status: 'available'; servers: AppServerServerStatus[] }
  | { status: 'unavailable'; reason: AppServerFailure };

export class AppServerFailureError extends Error {
  constructor(readonly reason: AppServerFailure) {
    super(`app-server status ${reason}`);
  }
}

export interface JsonlChannel {
  send(message: Record<string, unknown>): Promise<void>;
  readLine(): Promise<Buffer>;
}

/** Memory-only JSONL over process pipes with one deadline. */
export class StreamJsonlChannel implements JsonlChannel {
  #pending = Buffer.alloc(0);
  #closed = false;
  #failure?: AppServerFailure;
  #wake?: () => void;
  readonly #deadline: number;

  constructor(
    private readonly input: Writable,
    output: Readable,
    timeoutMs = appServerTimeoutMs(1)
  ) {
    this.#deadline = Date.now() + timeoutMs;
    output.on('data', (chunk: Buffer) => {
      this.#pending = Buffer.concat([this.#pending, chunk]);
      this.#wake?.();
    });
    const close = () => {
      this.#closed = true;
      this.#wake?.();
    };
    output.on('end', close);
    output.on('close', close);
    output.on('error', () => {
      this.#failure ??= 'io-error';
      close();
    });
    input.on('error', () => {
      this.#failure ??= 'io-error';
      this.#wake?.();
    });
  }

  async send(message: Record<string, unknown>): Promise<void> {
    if (!METHODS.has(String(message.method)))
      throw new AppServerFailureError('unsupported-method');
    const data = `${JSON.stringify(message)}\n`;
    await this.#until((done) =>
      this.input.write(data, (error) => {
        if (error) this.#failure ??= 'io-error';
        done();
      })
    );
    if (this.#failure) throw new AppServerFailureError(this.#failure);
  }

  async readLine(): Promise<Buffer> {
    for (;;) {
      if (this.#failure) throw new AppServerFailureError(this.#failure);
      const newline = this.#pending.indexOf(0x0a);
      if (newline >= 0) {
        const line = Buffer.from(this.#pending.subarray(0, newline));
        this.#pending = this.#pending.subarray(newline + 1);
        return line;
      }
      if (this.#closed) throw new AppServerFailureError('unexpected-eof');
      await this.#until((done) => {
        this.#wake = () => {
          this.#wake = undefined;
          done();
        };
      });
    }
  }

  #until(register: (done: () => void) => void): Promise<void> {
    const remaining = this.#deadline - Date.now();
    if (remaining <= 0)
      return Promise.reject(new AppServerFailureError('timeout'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AppServerFailureError('timeout')),
        remaining
      );
      register(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function response(
  channel: JsonlChannel,
  id: number
): Promise<Record<string, unknown>> {
  for (;;) {
    let message: unknown;
    try {
      message = JSON.parse((await channel.readLine()).toString('utf8'));
    } catch (error) {
      if (error instanceof AppServerFailureError) throw error;
      throw new AppServerFailureError('invalid-response');
    }
    if (!isObject(message)) throw new AppServerFailureError('invalid-response');
    if ('method' in message) {
      // Never service auth, approval, or credential requests. Abort instead.
      if ('id' in message)
        throw new AppServerFailureError('server-request-unsupported');
      if (typeof message.method !== 'string')
        throw new AppServerFailureError('invalid-response');
      continue;
    }
    if (message.id !== id) throw new AppServerFailureError('invalid-response');
    if ('error' in message) {
      const error = message.error;
      if (!isObject(error) || 'result' in message)
        throw new AppServerFailureError('invalid-response');
      if (error.code === -32601 || error.code === -32602)
        throw new AppServerFailureError('unsupported-method-or-params');
      // Classify only explicit HTTP status text; never keep the message.
      const match =
        typeof error.message === 'string'
          ? /\bHTTP(?: status(?: code)?)?[: ]+([45][0-9]{2})\b/i.exec(
              error.message
            )
          : null;
      if (match) {
        const code = Number(match[1]);
        throw new AppServerFailureError(
          code === 401 || code === 403
            ? 'http-auth-error'
            : code < 500
              ? 'http-client-error'
              : 'http-server-error'
        );
      }
      throw new AppServerFailureError('rpc-error');
    }
    if (!isObject(message.result))
      throw new AppServerFailureError('invalid-response');
    return message.result;
  }
}

/** initialize, initialized, then every mcpServerStatus/list page. Nothing else. */
export async function exchangeAppServerStatus(
  channel: JsonlChannel,
  labels: readonly string[]
): Promise<AppServerServerStatus[]> {
  await channel.send({
    id: 0,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'mst_mcp_readiness',
        title: 'MST MCP readiness',
        version: '1',
      },
    },
  });
  await response(channel, 0);
  await channel.send({ method: 'initialized' });
  // Follow every page, so the number of configured servers is never capped.
  // Never read an unknown shape, a repeated cursor, or a missing field as zero.
  const rows: Array<Record<string, unknown>> = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let id = 1; ; id++) {
    await channel.send({
      id,
      method: 'mcpServerStatus/list',
      params: {
        detail: 'toolsAndAuthOnly',
        cursor,
        limit: APP_SERVER_LIMITS.pageRows,
      },
    });
    const result = await response(channel, id);
    const page = result.data;
    const next = result.nextCursor;
    if (
      !Array.isArray(page) ||
      page.some((row) => !isObject(row) || typeof row.name !== 'string') ||
      (next !== null && (typeof next !== 'string' || cursors.has(next)))
    )
      throw new AppServerFailureError('invalid-response');
    rows.push(...(page as Array<Record<string, unknown>>));
    if (next === null) break;
    cursors.add(next);
    cursor = next;
  }
  return labels.map((label) => {
    const matches = rows.filter((row) => row.name === label);
    if (matches.length > 1) throw new AppServerFailureError('invalid-response');
    const row = matches[0];
    if (!row)
      return {
        label,
        initialized: false,
        toolCount: null,
        authStatus: 'unknown',
      };
    const tools = row.tools;
    const values = Array.isArray(tools)
      ? tools
      : isObject(tools)
        ? Object.values(tools)
        : undefined;
    if (!values || !values.every(isObject))
      throw new AppServerFailureError('invalid-response');
    const auth = row.authStatus;
    return {
      label,
      initialized: true,
      toolCount: values.length,
      authStatus:
        typeof auth === 'string' && AUTH_STATUSES.has(auth)
          ? (auth as AppServerAuthStatus)
          : 'unknown',
    };
  });
}

/**
 * A separate read-only config client, not the GUI backend. No inference, tool
 * calls, or server-request handling. The process group is always stopped.
 */
export async function probeAppServerStatus(
  codexPath: string,
  env: Record<string, string>,
  labels: readonly string[]
): Promise<AppServerStatus> {
  const cwd = env.HOME;
  if (!cwd) return { status: 'unavailable', reason: 'io-error' };
  const child = spawn(codexPath, ['app-server'], {
    cwd,
    env,
    detached: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const spawned = new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  try {
    if (!(await spawned) || !child.stdin || !child.stdout)
      return { status: 'unavailable', reason: 'io-error' };
    const servers = await exchangeAppServerStatus(
      new StreamJsonlChannel(
        child.stdin,
        child.stdout,
        appServerTimeoutMs(labels.length)
      ),
      labels
    );
    return { status: 'available', servers };
  } catch (error) {
    return {
      status: 'unavailable',
      reason:
        error instanceof AppServerFailureError ? error.reason : 'io-error',
    };
  } finally {
    child.stdin?.destroy();
    child.stdout?.destroy();
    if (child.pid !== undefined) {
      try {
        if (!(await stopGroup(child.pid, 2000)))
          signalGroup(child.pid, 'SIGKILL');
      } catch {
        // Nothing else is ours to signal.
      }
    }
  }
}

/** Ready means initialized with at least one tool and the expected auth mode. */
export function appServerServerReady(
  server: AppServerServerStatus,
  expectedAuth: 'bearerToken' | 'unsupported'
): boolean {
  return (
    server.initialized &&
    server.toolCount !== null &&
    server.toolCount >= 1 &&
    server.authStatus === expectedAuth
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
