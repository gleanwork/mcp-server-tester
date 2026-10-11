/**
 * The tool-surface proxy: a loopback Streamable HTTP server per upstream
 * server, serving a variant's tool metadata. Its interface is in
 * toolSurfaceProxy.ts.
 */
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
import type { ToolOverrideVariant } from './evalRunner.js';
import { buildToolSurface, type ToolSurface } from './toolSurface.js';
import type {
  ToolSurfaceProxy,
  ToolSurfaceProxyActivity,
} from './toolSurfaceProxy.js';

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
  /** Per-request timeout, as the client would have used against the server. */
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
        // them, and dropping the sockets ends the clients' requests.
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
