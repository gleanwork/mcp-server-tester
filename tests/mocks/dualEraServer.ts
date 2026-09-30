/**
 * Dual-era mock MCP server: serves the legacy `initialize` handshake and the
 * 2026-07-28 stateless protocol from one entry point, over stdio or HTTP.
 *
 * Usage:
 *   node --import tsx tests/mocks/dualEraServer.ts             # stdio
 *   node --import tsx tests/mocks/dualEraServer.ts --http 3917 # HTTP on :3917/mcp
 *
 * Environment:
 *   MOCK_ERA=dual    (default) serve both eras
 *   MOCK_ERA=modern  reject legacy (initialize) openings
 *   MOCK_ERA=legacy  legacy only (stdio only; answers like a 2025 SDK server)
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { createMockMcpServer } from './mockServerDefinition.js';

type MockEra = 'dual' | 'modern' | 'legacy';

const era = (process.env.MOCK_ERA ?? 'dual') as MockEra;
if (!['dual', 'modern', 'legacy'].includes(era)) {
  throw new Error(`Unknown MOCK_ERA "${era}"`);
}

const httpFlag = process.argv.indexOf('--http');
const httpPort =
  httpFlag >= 0 ? Number(process.argv[httpFlag + 1] ?? '3917') : null;

/** Bridges a Node request to the SDK's web-standard fetch handler. */
async function serveNode(
  handler: McpHttpHandler,
  req: IncomingMessage,
  res: ServerResponse,
  port: number
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const abort = new AbortController();
  res.on('close', () => abort.abort());
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
  Readable.fromWeb(response.body as WebReadableStream<Uint8Array>).pipe(res);
}

if (httpPort !== null) {
  if (era === 'legacy') {
    throw new Error('MOCK_ERA=legacy is only supported over stdio.');
  }
  const handler = createMcpHandler(() => createMockMcpServer(), {
    legacy: era === 'modern' ? 'reject' : 'stateless',
  });
  const server = createServer((req, res) => {
    serveNode(handler, req, res, httpPort).catch((error: unknown) => {
      console.error('dual-era mock request failed', error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(httpPort, '127.0.0.1', () => {
    console.error(
      `Dual-era MCP mock (${era}) on http://127.0.0.1:${httpPort}/mcp`
    );
  });
  const shutdown = () => {
    void handler.close().finally(() => server.close(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (era === 'legacy') {
  await createMockMcpServer().connect(new StdioServerTransport());
  console.error('Dual-era MCP mock (legacy only) on stdio');
} else {
  serveStdio(() => createMockMcpServer(), {
    legacy: era === 'modern' ? 'reject' : 'serve',
  });
  console.error(`Dual-era MCP mock (${era}) on stdio`);
}
