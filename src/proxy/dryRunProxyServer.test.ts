import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import { PLANNED_WRITE_KEY } from './dryRunProxy.js';
import { dryRunProxyEntry, dryRunProxyServer } from './dryRunProxyServer.js';

function built(): boolean {
  try {
    return existsSync(dryRunProxyEntry());
  } catch {
    return false;
  }
}

describe('dryRunProxyServer', () => {
  it('describes a stdio launch that holds a token path, never a token', () => {
    if (!built()) return;
    const entry = dryRunProxyServer({
      label: 'slack',
      upstreamUrl: 'https://mcp.slack.com/mcp',
      tokenFile: '/private/run/slack.json',
      readOnlyTools: ['b', 'a'],
      alwaysWriteTools: ['c'],
      minTools: 10,
    });
    expect(entry).toMatchObject({
      transport: 'stdio',
      label: 'slack',
      command: process.execPath,
      inheritEnv: false,
      minTools: 10,
    });
    expect(entry.args?.slice(1)).toEqual([
      '--upstream-url',
      'https://mcp.slack.com/mcp',
      '--name',
      'slack',
      '--token-file',
      '/private/run/slack.json',
      '--read-only',
      'a',
      '--read-only',
      'b',
      '--always-write',
      'c',
    ]);
    expect(entry.env).toBeUndefined();
  });
});

// Runs the built proxy as a real child process. CI builds before it tests.
describe.skipIf(!built())('built dry-run proxy (stdio)', () => {
  let http: HttpServer;
  let url: string;
  let dir: string;
  const calls: string[] = [];

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-proxy-e2e-'));
    const sessions = new Map<
      string,
      WebStandardStreamableHTTPServerTransport
    >();
    http = createServer((request, response) => {
      void (async () => {
        if (request.headers.authorization !== 'Bearer file-token') {
          response.writeHead(401).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers))
          if (typeof value === 'string') headers.set(name, value);
        const webRequest = new Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        const id = request.headers['mcp-session-id'];
        let transport = typeof id === 'string' ? sessions.get(id) : undefined;
        if (!transport) {
          const created = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
            onsessioninitialized: (sessionId) => {
              sessions.set(sessionId, created);
            },
          });
          const server = new Server(
            { name: 'vendor', version: '1' },
            { capabilities: { tools: {} } }
          );
          server.setRequestHandler('tools/list', async () => ({
            tools: [
              {
                name: 'search',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true },
              },
              { name: 'post', inputSchema: { type: 'object' } },
            ],
          }));
          server.setRequestHandler('tools/call', async (call) => {
            calls.push(call.params.name);
            return { content: [{ type: 'text', text: 'ok' }] };
          });
          await server.connect(created);
          transport = created;
        }
        const result = await transport.handleRequest(webRequest);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      })().catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('serves the upstream tools on stdio and blocks writes', async () => {
    const tokenFile = join(dir, 'token.json');
    await fs.writeFile(
      tokenFile,
      JSON.stringify({ version: 1, accessToken: 'file-token' }),
      { mode: 0o600 }
    );
    const client = await createMCPClientForConfig({
      ...dryRunProxyServer({ label: 'vendor', upstreamUrl: url, tokenFile }),
      connectTimeoutMs: 10_000,
    });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['search', 'post']);
      await client.callTool({ name: 'search', arguments: {} });
      const write = await client.callTool({
        name: 'post',
        arguments: { text: 'hi' },
      });
      expect(write.structuredContent).toEqual({
        [PLANNED_WRITE_KEY]: {
          server: 'vendor',
          tool_name: 'post',
          arguments: { text: 'hi' },
        },
      });
      expect(calls).toEqual(['search']);
    } finally {
      await closeMCPClient(client);
    }
  }, 20_000);
});
