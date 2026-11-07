/**
 * Dry-run proxy: a stdio MCP server in front of one streamable-HTTP MCP
 * server. The client sees the upstream server's real tools; read-only tool
 * calls go upstream; every other tool call returns a planned-write result and
 * never reaches the upstream server. With `simulateWrites`, a write instead
 * gets a success reply (see simulatedWrites.ts).
 *
 * Fail closed: a tool without annotations, or one the upstream server does
 * not list, is a write. `readOnlyTools` allows reads on servers that annotate
 * nothing; `alwaysWriteTools` intercepts tools that are annotated as reads.
 * With `forwardWrites`, every call goes upstream: for a server that stops
 * writes itself, which needs the proxy only for its renewed token. Such a
 * server marks each write it stopped with `plannedWriteKey`.
 *
 * With `writeRecord`, the proxy records every write it stops, every write
 * the server marks, and every forwarded call it can't classify (a
 * dispatcher's, say) in that file, for MST to keep with the trial (ADR 0014;
 * writeRecordLines.ts).
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
import { simulatedReply, simulatedWriteId } from './simulatedWrites.js';
import { isReadOnlyTool, plannedWriteResult } from './plannedWrite.js';
import { appendWriteRecordLine } from './writeRecordWriter.js';
import type { WriteRecordLine } from './writeRecordLines.js';

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
  /**
   * Forward every tool call, writes too: the upstream server stops writes
   * itself (an eval endpoint, say). Not with `simulateWrites`.
   */
  forwardWrites?: boolean;
  /**
   * With `forwardWrites`: the key the server puts in a write's result when it
   * stopped the write. Each marked result is a `server-planned` write.
   */
  plannedWriteKey?: string;
  /**
   * Tools that run another tool, by the argument that names it
   * (`{ run_tool: 'tool_name' }`). Their calls are recorded with their
   * target.
   */
  dispatchers?: Readonly<Record<string, string>>;
  /** How long an upstream request may take. Default: 120 seconds. */
  requestTimeoutMs?: number;
  /** The write record file (JSONL) MST reads after each trial. */
  writeRecord?: string;
  /**
   * Answer writes with a success reply instead of a planned-write result.
   * The write still never reaches the server.
   */
  simulateWrites?: boolean;
  /** Reply templates for simulated writes, by tool name (see simulatedWrites.ts). */
  writeReplies?: Readonly<Record<string, unknown>>;
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

/** The token file is missing, not a file, or malformed. Its message names no token. */
export class TokenFileError extends Error {
  override name = 'TokenFileError';
}

/**
 * Why the proxy couldn't start, safe to log: MST's own token-file error, or an
 * error's class with a network error's code and an HTTP status. Never an
 * upstream error's message, which can carry a token or a response body.
 */
export function describeStartupFailure(error: unknown): string {
  if (error instanceof TokenFileError) return error.message;
  if (!(error instanceof Error)) return typeof error;
  const parts = [error.name];
  const status =
    (error as { code?: unknown; status?: unknown }).status ??
    (error as { code?: unknown }).code;
  if (typeof status === 'number') parts.push(`HTTP ${status}`);
  else if (typeof status === 'string' && /^[A-Z_]+$/.test(status))
    parts.push(status);
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = (cause as { code?: unknown } | undefined)?.code;
  if (typeof causeCode === 'string' && /^[A-Z_]+$/.test(causeCode))
    parts.push(causeCode);
  return parts.join(' ');
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
      throw new TokenFileError('Cannot read the token file.');
    }
    if (!info.isFile() || info.size > MAX_TOKEN_FILE_BYTES)
      throw new TokenFileError('The token file is not a regular file.');
    const next = `${info.ino}:${info.mtimeNs}:${info.size}`;
    if (next !== stamp) {
      const parsed = TokenFileSchema.safeParse(
        JSON.parse(readFileSync(path, 'utf8'))
      );
      if (!parsed.success)
        throw new TokenFileError('The token file is malformed.');
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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function firstText(result: Record<string, unknown>): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const text = (content as Array<{ type?: unknown; text?: unknown }>).find(
    (item) => item.type === 'text' && typeof item.text === 'string'
  );
  return text?.text as string | undefined;
}

/**
 * Whether a tool result carries a server's planned-write mark: `key` in its
 * structured content, or in a text item that is a JSON object.
 */
function hasPlannedWriteMark(
  result: Record<string, unknown>,
  key: string
): boolean {
  const structured = result.structuredContent;
  if (
    typeof structured === 'object' &&
    structured !== null &&
    Object.hasOwn(structured, key)
  )
    return true;
  const content = Array.isArray(result.content) ? result.content : [];
  return (content as Array<{ type?: unknown; text?: unknown }>).some((item) => {
    if (item.type !== 'text' || typeof item.text !== 'string') return false;
    try {
      const parsed: unknown = JSON.parse(item.text);
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        Object.hasOwn(parsed, key)
      );
    } catch {
      return false;
    }
  });
}

export { isReadOnlyTool };

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
  const dispatchers = new Map(Object.entries(options.dispatchers ?? {}));
  if (options.forwardWrites && options.simulateWrites)
    throw new Error('forwardWrites and simulateWrites exclude each other.');
  if (options.plannedWriteKey !== undefined && !options.forwardWrites)
    throw new Error(
      'plannedWriteKey needs forwardWrites: only a server that stops writes itself marks them.'
    );
  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
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
        timeout: requestTimeout,
      });
      for (const tool of page.tools) tools.set(tool.name, tool);
      cursor = page.nextCursor;
    } while (cursor);
    await recordWriteTools();
  }

  /** Whether the proxy's rule makes `name` a write, forwarded or not. */
  function isWriteTool(name: string): boolean {
    if (alwaysWrite.has(name)) return true;
    if (readOnly.has(name)) return false;
    return !isReadOnlyTool(tools.get(name));
  }

  /** Whether the proxy stops a call to `name`. */
  function isWrite(name: string): boolean {
    return !options.forwardWrites && isWriteTool(name);
  }

  async function record(
    line: DistributiveOmit<WriteRecordLine, 'format' | 'time' | 'server'>
  ): Promise<boolean> {
    if (!options.writeRecord) return false;
    try {
      await appendWriteRecordLine(options.writeRecord, {
        ...line,
        time: new Date().toISOString(),
        server: options.name,
      } as DistributiveOmit<WriteRecordLine, 'format'>);
      return true;
    } catch {
      options.log?.(
        `dry-run proxy ${options.name}: couldn't record a ${line.kind} line in the write record`
      );
      return false;
    }
  }

  // The write tools last recorded, so a listing that changes nothing adds no line.
  let recordedWriteTools: string | undefined;
  async function recordWriteTools(): Promise<void> {
    if (!options.writeRecord) return;
    const writeTools = [...new Set([...tools.keys(), ...alwaysWrite])]
      .filter((name) => isWriteTool(name) || dispatchers.has(name))
      .sort();
    const key = JSON.stringify(writeTools);
    if (key === recordedWriteTools) return;
    if (await record({ kind: 'tools', writeTools })) recordedWriteTools = key;
  }

  /** A dispatcher call's target, from the argument the connector names. */
  function targetOf(name: string, args: unknown): string | undefined {
    const key = dispatchers.get(name);
    if (key === undefined || typeof args !== 'object' || args === null)
      return undefined;
    const target = (args as Record<string, unknown>)[key];
    return typeof target === 'string' ? target : undefined;
  }

  // The upstream's instructions tell the client what the server is for (a
  // search server's connected sources, say). Without them, a client uses the
  // server less than it would without the proxy.
  const instructions = upstream.getInstructions();
  const server = new Server(
    { name: options.name, version: '1.0' },
    { capabilities, ...(instructions ? { instructions } : {}) }
  );

  /**
   * The reply to a write the proxy stops, once it is recorded. A simulated
   * write that can't be recorded gets the planned-write result instead, so
   * the client is never told a write MST can't see succeeded.
   */
  async function stopWrite(name: string, args: unknown): Promise<unknown> {
    const target = targetOf(name, args);
    const planned = () => {
      const reply = plannedWriteResult(options.name, name, args, aliases);
      return { reply, value: reply.structuredContent };
    };
    if (options.simulateWrites) {
      const reply = simulatedReply(
        tools.get(name),
        name,
        args,
        options.writeReplies,
        { id: simulatedWriteId(), now: new Date() }
      );
      if (
        await record({
          kind: 'write',
          tool: name,
          arguments: args ?? {},
          reply: reply.structuredContent ?? reply.content[0]?.text,
          mode: 'simulated',
          ...(target !== undefined ? { target } : {}),
        })
      )
        return reply;
      options.log?.(
        `Couldn't record a simulated write of ${name}; answered as planned.`
      );
      return planned().reply;
    }
    const { reply, value } = planned();
    await record({
      kind: 'write',
      tool: name,
      arguments: args ?? {},
      reply: value,
      mode: 'planned',
      ...(target !== undefined ? { target } : {}),
    });
    return reply;
  }

  /**
   * Records a forwarded call the proxy can't classify itself: a dispatcher's,
   * or a write tool's when the server stops writes. A result the server
   * marked with `plannedWriteKey` is a write it stopped.
   */
  async function recordForwarded(
    name: string,
    args: unknown,
    result: Record<string, unknown>
  ): Promise<void> {
    const dispatcher = dispatchers.has(name);
    if (!dispatcher && !(options.forwardWrites && isWriteTool(name))) return;
    const target = targetOf(name, args);
    const key = options.plannedWriteKey;
    if (key !== undefined && hasPlannedWriteMark(result, key)) {
      await record({
        kind: 'write',
        tool: name,
        arguments: args ?? {},
        reply: result.structuredContent ?? firstText(result),
        mode: 'server-planned',
        ...(target !== undefined ? { target } : {}),
      });
      return;
    }
    await record({
      kind: 'unclassified',
      tool: name,
      arguments: args ?? {},
      reason: dispatcher ? 'dispatch' : 'unmarked',
      ...(target !== undefined ? { target } : {}),
    });
  }

  async function forward(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    try {
      return await upstream.request(
        { method, params } as Parameters<typeof upstream.request>[0],
        LooseResult,
        { timeout: requestTimeout, signal }
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
      if (listed.success) {
        for (const tool of listed.data.tools)
          tools.set(tool.name, tool as unknown as Tool);
        await recordWriteTools();
      }
      return result as never;
    });
    server.setRequestHandler('tools/call', async (request, context) => {
      const name = request.params.name;
      // A server that stops writes itself still needs its tools listed, so
      // the record tells its write tools from its reads.
      const classifies = !options.forwardWrites || options.writeRecord;
      if (
        classifies &&
        !tools.has(name) &&
        !alwaysWrite.has(name) &&
        !readOnly.has(name)
      )
        await listAllTools().catch(() => {});
      if (isWrite(name))
        return (await stopWrite(name, request.params.arguments)) as never;
      const result = await forward(
        'tools/call',
        request.params,
        context.mcpReq.signal
      );
      await recordForwarded(name, request.params.arguments, result);
      return result as never;
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
