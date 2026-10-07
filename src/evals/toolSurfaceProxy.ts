import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from '@modelcontextprotocol/server';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import type {
  ClientDefinition,
  ClientRunContext,
  ClientRunResult,
} from './evalFrameworkTypes.js';
import type { ToolOverrideVariant } from './evalRunner.js';
import { buildToolSurface, type ToolSurface } from './toolSurface.js';

/** A tool call the proxy forwarded, under the tool's original name. */
interface ProxiedToolCall {
  server?: string;
  /** The tool's name on its server. */
  name: string;
  /** The name the host called, when the variant renamed the tool. */
  rawName?: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  startedAt: string;
  durationMs: number;
}

/** What one scope's (one host request's) traffic did through the proxy. */
interface ToolSurfaceProxyActivity {
  /**
   * The host listed tools from a proxied server (always true when no server
   * has tools, since there is nothing to list).
   */
  listedTools: boolean;
  calls: ProxiedToolCall[];
}

/**
 * Serves a variant's servers with its tool variant applied, for hosts that
 * connect to servers themselves (plugin hosts, the Claude CLI). Each upstream
 * server gets a loopback Streamable HTTP endpoint with the same label; each
 * host request gets its own scope, so the suite can tell whether the host saw
 * the variant. The proxy holds one connection to each server for the variant.
 */
export interface ToolSurfaceProxy {
  /** Server configs for one host request, pointing at the proxy. */
  serversFor(scope: string): MCPConfig[];
  /** The scope's traffic so far. */
  activity(scope: string): ToolSurfaceProxyActivity;
  /** The scope's traffic, after which the proxy forgets the scope. */
  endScope(scope: string): ToolSurfaceProxyActivity;
  /** The original name behind a presented tool name on a server. */
  originalName(name: string, server?: string): string | undefined;
  close(): Promise<void>;
}

// Capabilities the proxy serves by forwarding requests. Change notifications
// and subscriptions are not forwarded, so they are not advertised.
const FORWARDED_CAPABILITIES = [
  'tools',
  'resources',
  'prompts',
  'logging',
  'completions',
  'extensions',
  'experimental',
] as const;
const AnyResult = z.looseObject({});

interface Upstream {
  config: MCPConfig;
  client: Client;
  capabilities: Record<string, unknown>;
  /** Per-request timeout, as the host would have used against the server. */
  timeout?: number;
}

/**
 * Connects to the variant's servers, applies the variant, and listens on
 * 127.0.0.1. Throws, after closing what it opened, if a server can't be
 * reached or the variant doesn't fit the servers' tools.
 */
export async function startToolSurfaceProxy(
  servers: readonly MCPConfig[],
  variant: ToolOverrideVariant
): Promise<ToolSurfaceProxy> {
  const upstreams: Upstream[] = [];
  let http: HttpServer | undefined;
  try {
    for (const config of servers) {
      const client = await createMCPClientForConfig(config);
      upstreams.push({
        config,
        client,
        capabilities: (client.getServerCapabilities() ?? {}) as Record<
          string,
          unknown
        >,
        timeout: config.callTimeoutMs ?? config.requestTimeoutMs,
      });
    }
    const listed = [];
    for (const upstream of upstreams) {
      listed.push({
        server: upstream.config.label,
        tools:
          'tools' in upstream.capabilities
            ? (
                await upstream.client.listTools(undefined, {
                  timeout: upstream.timeout,
                })
              ).tools
            : [],
      });
    }
    const surface = buildToolSurface(listed, variant);
    const anyTools = upstreams.some(
      (upstream) => 'tools' in upstream.capabilities
    );
    const scopes = new Map<string, ToolSurfaceProxyActivity>();
    const activityOf = (scope: string) => {
      let activity = scopes.get(scope);
      if (!activity) {
        activity = { listedTools: !anyTools, calls: [] };
        scopes.set(scope, activity);
      }
      return activity;
    };
    const token = randomUUID();
    const handler = createMcpHandler(
      (context) => {
        const route = parseRoute(
          new URL(context.requestInfo!.url).pathname,
          token,
          upstreams.length
        )!;
        return proxyServer(
          upstreams[route.index]!,
          surface,
          activityOf(route.scope)
        );
      },
      { legacy: 'stateless' }
    );
    http = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      // Refuse anything off the proxy's endpoints before reading the body.
      if (!parseRoute(path, token, upstreams.length)) {
        res.writeHead(404).end();
        return;
      }
      serveNode(handler, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      http!.once('error', reject);
      http!.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = http.address() as AddressInfo;
    const server = http;
    let closing: Promise<void> | undefined;
    return {
      serversFor(scope) {
        return upstreams.map(({ config }, index) => ({
          transport: 'http',
          serverUrl: `http://127.0.0.1:${port}/${token}/${encodeURIComponent(scope)}/${index}/mcp`,
          ...(config.label !== undefined ? { label: config.label } : {}),
          // The client keeps the server's timeouts, as without tool metadata.
          ...(config.requestTimeoutMs !== undefined
            ? { requestTimeoutMs: config.requestTimeoutMs }
            : {}),
          ...(config.callTimeoutMs !== undefined
            ? { callTimeoutMs: config.callTimeoutMs }
            : {}),
        }));
      },
      activity: activityOf,
      endScope(scope) {
        const activity = activityOf(scope);
        scopes.delete(scope);
        return activity;
      },
      originalName(name, label) {
        return surface.resolve(name, label)?.originalName;
      },
      close() {
        // Don't wait for in-flight calls: closing the upstream clients ends
        // them, and dropping the sockets ends the hosts' requests.
        closing ??= Promise.allSettled([
          handler.close(),
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
          ...upstreams.map(({ client }) => closeMCPClient(client)),
        ]).then(() => undefined);
        return closing;
      },
    };
  } catch (error) {
    if (http) {
      const opened = http;
      await new Promise<void>((resolve) => {
        opened.close(() => resolve());
        opened.closeAllConnections();
      });
    }
    await Promise.allSettled(
      upstreams.map(({ client }) => closeMCPClient(client))
    );
    throw error;
  }
}

function parseRoute(
  pathname: string,
  token: string,
  servers: number
): { scope: string; index: number } | undefined {
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\/(\d+)\/mcp$/);
  if (!match || match[1] !== token) return undefined;
  const index = Number(match[3]);
  if (index >= servers) return undefined;
  return { scope: decodeURIComponent(match[2]!), index };
}

/** One request's MCP server: the surface for tools, upstream for the rest. */
function proxyServer(
  upstream: Upstream,
  surface: ToolSurface,
  activity: ToolSurfaceProxyActivity
): Server {
  const label = upstream.config.label;
  const capabilities: Record<string, unknown> = {};
  for (const key of FORWARDED_CAPABILITIES) {
    const value = upstream.capabilities[key];
    if (value === undefined) continue;
    if (key === 'tools' || key === 'resources' || key === 'prompts') {
      const {
        listChanged: _listChanged,
        subscribe: _subscribe,
        ...rest
      } = value as Record<string, unknown>;
      capabilities[key] = rest;
    } else {
      capabilities[key] = value;
    }
  }
  const server = new Server(
    { name: 'mst-tool-surface', version: '1.0.0' },
    { capabilities }
  );
  const options = (signal: AbortSignal) => ({
    signal,
    ...(upstream.timeout !== undefined
      ? { timeout: upstream.timeout, resetTimeoutOnProgress: true }
      : {}),
  });
  if ('tools' in upstream.capabilities) {
    server.setRequestHandler('tools/list', async () => {
      activity.listedTools = true;
      return {
        tools: surface.tools
          .filter((entry) => entry.server === label)
          .map((entry) => entry.tool),
      };
    });
    server.setRequestHandler('tools/call', async (request, context) => {
      const entry = surface.resolve(request.params.name, label);
      if (!entry) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown tool: ${request.params.name}`
        );
      }
      const args = request.params.arguments ?? {};
      const startedAt = new Date();
      const record = (isError: boolean) =>
        activity.calls.push({
          ...(label !== undefined ? { server: label } : {}),
          name: entry.originalName,
          ...(entry.tool.name !== entry.originalName
            ? { rawName: entry.tool.name }
            : {}),
          arguments: args,
          isError,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
        });
      try {
        const result = await upstream.client.callTool(
          { name: entry.originalName, arguments: args },
          options(context.mcpReq.signal)
        );
        record(result.isError === true);
        return result;
      } catch (error) {
        record(true);
        throw error;
      }
    });
  }
  // Requests (resources, prompts, skills, completions) are forwarded as-is.
  // Notifications are not.
  server.fallbackRequestHandler = async (request, context) =>
    upstream.client.request(
      { method: request.method, params: request.params },
      AnyResult,
      options(context.mcpReq.signal)
    );
  return server;
}

/** Bridges a Node request to the SDK's web-standard fetch handler. */
async function serveNode(
  handler: ReturnType<typeof createMcpHandler>,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value))
      value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(url, {
    method: req.method,
    headers,
    signal: abort.signal,
    ...(hasBody
      ? {
          body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
          duplex: 'half',
        }
      : {}),
  } as RequestInit);
  const response = await handler.fetch(request);
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    outHeaders[name] = value;
  });
  res.writeHead(response.status, outHeaders);
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    res
  );
}

/**
 * Whether the suite gives a client a variant's tool metadata through the proxy:
 * hosts that run cases themselves and don't apply variants, unless they opt
 * out with `toolSurfaceProxy: false`.
 */
export function usesToolSurfaceProxy(definition: ClientDefinition): boolean {
  return (
    definition.toolMetadata !== true &&
    definition.toolSurfaceProxy !== false &&
    (typeof definition.run === 'function' ||
      typeof definition.runBatch === 'function')
  );
}

/** A proxied host's context: the proxy applies the variant, not the host. */
export function withoutToolVariant(
  context: ClientRunContext
): ClientRunContext {
  const { tools: _configTools, ...evalConfig } = context.evalConfig;
  if (!context.variant) return { ...context, evalConfig };
  const { tools: _variantTools, ...variant } = context.variant;
  return { ...context, evalConfig, variant };
}

/**
 * Settles one proxied host request. A host that never listed the proxied
 * tools never showed the model the variant, so its trace becomes an error
 * rather than a result for a variant it ignored. Tool calls the host reports
 * are recorded under the tools' original names, with the host's in `rawName`.
 */
export function settleProxiedTrace(
  trace: ClientRunResult,
  proxy: ToolSurfaceProxy,
  listedTools: boolean,
  servers: readonly MCPConfig[],
  variantId: string
): ClientRunResult {
  if (!trace.error && !listedTools) {
    return {
      ...trace,
      error: `The host never listed tools from the servers it was given, so the model didn't see tool variant "${variantId}". Variants reach hosts that connect to input.servers.`,
    };
  }
  return {
    ...trace,
    events: trace.events.map((event) => {
      if (event.kind === 'tool_search' && event.results) {
        // A search shows the variant's names; record the tools it found.
        return {
          ...event,
          results: event.results.map((tool) => {
            const original =
              proxy.originalName(tool.name, tool.server) ??
              (servers.length === 1
                ? proxy.originalName(tool.name, servers[0]!.label)
                : undefined);
            return original === undefined ? tool : { ...tool, name: original };
          }),
        };
      }
      if (event.kind !== 'tool_call' || event.source !== 'mcp') return event;
      // Hosts name a call's server in `server`, as a `label.` prefix, or
      // (with one server) not at all.
      let server = event.server;
      let name = event.name;
      let prefix = '';
      if (server === undefined) {
        const qualified = servers.find(
          ({ label }) => label !== undefined && name.startsWith(`${label}.`)
        )?.label;
        if (qualified !== undefined && servers.length > 1) {
          server = qualified;
          prefix = `${qualified}.`;
          name = name.slice(prefix.length);
        }
      }
      const original =
        proxy.originalName(name, server) ??
        (servers.length === 1
          ? proxy.originalName(name, servers[0]!.label)
          : undefined);
      return original === undefined || original === name
        ? event
        : {
            ...event,
            name: `${prefix}${original}`,
            rawName: event.rawName ?? event.name,
          };
    }),
  };
}
