/**
 * Dry-run proxy: a stdio MCP server in front of one streamable-HTTP MCP
 * server. The client sees the upstream server's real tools; read-only tool
 * calls go upstream; every other tool call returns a planned-write result and
 * never reaches the upstream server.
 *
 * Fail closed: a tool without annotations, or one the upstream server does
 * not list, is a write. `readOnlyTools` allows reads on servers that annotate
 * nothing; `alwaysWriteTools` intercepts tools that are annotated as reads.
 *
 * The token comes from a file MST rewrites when it renews the token. The
 * proxy re-reads the file when it changes, and after a 401 waits briefly for a
 * new token before it gives up, so a renewal never restarts the MCP session.
 */
import { lstatSync, readFileSync } from 'node:fs';
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { FetchLike, Tool } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import type { Transport } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** The key of a planned-write result: what the client asked to do, not done. */
export const PLANNED_WRITE_KEY = '_mst_planned_write';

/** Seconds a request that got a 401 waits for MST to deliver a new token. */
const AUTH_RETRY_WAIT_MS = 90_000;
const AUTH_RETRY_POLL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_TOKEN_FILE_BYTES = 64 * 1024;
const LooseResult = z.looseObject({});

/** The token file MST writes for a proxy: `{ "version": 1, "accessToken": "..." }`. */
const TokenFileSchema = z.object({
  version: z.literal(1),
  accessToken: z.string().min(1),
});

export interface DryRunProxyOptions {
  /** The upstream streamable-HTTP MCP endpoint. */
  upstreamUrl: string;
  /** The server's label, recorded in planned-write results. */
  name: string;
  /** Where the current access token is. Omit for an upstream without auth. */
  token?: TokenSource;
  /** Extra headers on every upstream request. */
  headers?: Record<string, string>;
  /** Tools to forward even though they are not annotated read-only. */
  readOnlyTools?: readonly string[];
  /** Tools to intercept even though they are annotated read-only. */
  alwaysWriteTools?: readonly string[];
  /** Extra keys for the planned-write result, for graders that read an older name. */
  plannedWriteAliases?: readonly string[];
  /** For tests: how long to wait for a new token after a 401. */
  authRetryWaitMs?: number;
  /** For tests: a fetch to reach the upstream server with. */
  fetch?: FetchLike;
  /** Where diagnostics go. Never receives a token. */
  log?: (line: string) => void;
}

/** The current upstream token. */
export interface TokenSource {
  current(): string;
  /** After `rejected` got a 401: a different token, or undefined if none arrives in time. */
  waitForNew(rejected: string, timeoutMs: number): Promise<string | undefined>;
}

/** A token that never changes (for an upstream whose token does not expire). */
export function staticToken(token: string): TokenSource {
  if (!token.trim()) throw new Error('The token is empty.');
  return {
    current: () => token,
    waitForNew: async () => undefined,
  };
}

/**
 * The token in `path`, re-read whenever the file is replaced. MST replaces it
 * atomically (write, then rename), so a read never sees a partial file.
 */
export function fileToken(
  path: string,
  pollMs: number = AUTH_RETRY_POLL_MS
): TokenSource {
  let stamp: string | undefined;
  let token = '';
  function current(): string {
    let info;
    try {
      info = lstatSync(path, { bigint: true });
    } catch {
      if (token) return token;
      throw new Error('Cannot read the token file.');
    }
    if (!info.isFile() || info.size > MAX_TOKEN_FILE_BYTES)
      throw new Error('The token file is not a regular file.');
    const next = `${info.ino}:${info.mtimeNs}:${info.size}`;
    if (next !== stamp) {
      const parsed = TokenFileSchema.safeParse(
        JSON.parse(readFileSync(path, 'utf8'))
      );
      if (!parsed.success) throw new Error('The token file is malformed.');
      token = parsed.data.accessToken;
      stamp = next;
    }
    return token;
  }
  current();
  return {
    current,
    async waitForNew(rejected, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let latest = '';
        try {
          latest = current();
        } catch {
          // A file mid-replacement: try again.
        }
        if (latest && latest !== rejected) return latest;
        if (Date.now() >= deadline) return undefined;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(pollMs, timeoutMs))
        );
      }
    },
  };
}

/** Read-only means readOnlyHint true and destructiveHint not true. */
export function isReadOnlyTool(tool: Tool | undefined): boolean {
  const annotations = tool?.annotations;
  if (!annotations) return false;
  return (
    annotations.readOnlyHint === true && annotations.destructiveHint !== true
  );
}

/** The result a client gets for a write the proxy did not send. */
function plannedWriteResult(
  server: string,
  toolName: string,
  args: unknown,
  aliases: readonly string[] = []
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const planned = { server, tool_name: toolName, arguments: args ?? {} };
  const envelope: Record<string, unknown> = { [PLANNED_WRITE_KEY]: planned };
  for (const alias of aliases) envelope[alias] = planned;
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

/** A fetch that sends the current token, and retries once with a new one after a 401. */
function authenticatedFetch(options: DryRunProxyOptions): FetchLike {
  const base = options.fetch ?? fetch;
  const token = options.token;
  const log = options.log ?? (() => {});
  const wait = options.authRetryWaitMs ?? AUTH_RETRY_WAIT_MS;
  return async (input, init) => {
    const send = (bearer: string | undefined) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(options.headers ?? {}))
        headers.set(name, value);
      if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
      return base(input, { ...init, headers });
    };
    if (!token) return send(undefined);
    const first = token.current();
    const response = await send(first);
    if (response.status !== 401) return response;
    // A body we can't replay (a stream) can't be retried.
    if (init?.body instanceof ReadableStream) return response;
    const renewed = await token.waitForNew(first, wait);
    if (!renewed) {
      // A stable marker for run audits; never includes token data.
      log(
        `dry-run proxy ${options.name}: CONNECTOR_AUTH_EXPIRED: the server rejected the token and no new token arrived`
      );
      return response;
    }
    log(
      `dry-run proxy ${options.name}: the server rejected the token; retrying once with a new one`
    );
    return send(renewed);
  };
}

export interface DryRunProxy {
  /** Connect the proxy's server side (for example, to stdio). */
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create the proxy. It connects to the upstream server first, so a bad URL or
 * token fails before the client sees a server.
 */
export async function createDryRunProxy(
  options: DryRunProxyOptions
): Promise<DryRunProxy> {
  const readOnly = new Set(options.readOnlyTools ?? []);
  const alwaysWrite = new Set(options.alwaysWriteTools ?? []);
  const aliases = options.plannedWriteAliases ?? [];
  const tools = new Map<string, Tool>();

  const upstream = new Client({ name: 'mst-dry-run-proxy', version: '1.0' });
  await upstream.connect(
    new StreamableHTTPClientTransport(new URL(options.upstreamUrl), {
      fetch: authenticatedFetch(options),
    })
  );
  const upstreamCapabilities = upstream.getServerCapabilities() ?? {};
  const capabilities = Object.fromEntries(
    (['tools', 'resources', 'prompts', 'logging', 'completions'] as const)
      .filter((key) => key in upstreamCapabilities)
      .map((key) => [key, upstreamCapabilities[key]])
  );

  async function listAllTools(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await upstream.listTools(cursor ? { cursor } : undefined, {
        timeout: REQUEST_TIMEOUT_MS,
      });
      for (const tool of page.tools) tools.set(tool.name, tool);
      cursor = page.nextCursor;
    } while (cursor);
  }

  function isWrite(name: string): boolean {
    if (alwaysWrite.has(name)) return true;
    if (readOnly.has(name)) return false;
    return !isReadOnlyTool(tools.get(name));
  }

  const server = new Server(
    { name: options.name, version: '1.0' },
    { capabilities }
  );

  async function forward(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    try {
      return await upstream.request(
        { method, params } as Parameters<typeof upstream.request>[0],
        LooseResult,
        { timeout: REQUEST_TIMEOUT_MS, signal }
      );
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        'Upstream MCP request failed.'
      );
    }
  }

  if ('tools' in capabilities) {
    server.setRequestHandler('tools/list', async (request, context) => {
      const result = await forward(
        'tools/list',
        request.params,
        context.mcpReq.signal
      );
      const listed = z
        .object({ tools: z.array(z.looseObject({ name: z.string() })) })
        .safeParse(result);
      if (listed.success)
        for (const tool of listed.data.tools)
          tools.set(tool.name, tool as unknown as Tool);
      return result as never;
    });
    server.setRequestHandler('tools/call', async (request, context) => {
      const name = request.params.name;
      if (!tools.has(name) && !alwaysWrite.has(name) && !readOnly.has(name))
        await listAllTools().catch(() => {});
      if (isWrite(name))
        return plannedWriteResult(
          options.name,
          name,
          request.params.arguments,
          aliases
        ) as never;
      return (await forward(
        'tools/call',
        request.params,
        context.mcpReq.signal
      )) as never;
    });
    upstream.setNotificationHandler(
      'notifications/tools/list_changed',
      async (notice) => {
        tools.clear();
        await server.notification(notice).catch(() => {});
      }
    );
  }
  server.fallbackRequestHandler = async (request, context) =>
    (await forward(
      request.method,
      request.params,
      context.mcpReq.signal
    )) as never;
  server.fallbackNotificationHandler = async (notice) => {
    await upstream.notification(notice).catch(() => {});
  };
  upstream.fallbackNotificationHandler = async (notice) => {
    await server.notification(notice).catch(() => {});
  };

  return {
    async connect(transport) {
      await server.connect(transport);
    },
    async close() {
      await Promise.allSettled([server.close(), upstream.close()]);
    },
  };
}
