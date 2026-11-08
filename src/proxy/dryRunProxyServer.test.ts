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
import { PLANNED_WRITE_KEY } from './plannedWrite.js';
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

  it('passes forwarded writes, and its request timeout to the client too', () => {
    if (!built()) return;
    const entry = dryRunProxyServer({
      label: 'glean',
      upstreamUrl: 'https://glean.example/mcp',
      tokenFile: '/private/run/glean.json',
      forwardWrites: true,
      requestTimeoutMs: 300_000,
    });
    expect(entry.args?.slice(-3)).toEqual([
      '--forward-writes',
      '--request-timeout-ms',
      '300000',
    ]);
    expect(entry).toMatchObject({
      requestTimeoutMs: 300_000,
      callTimeoutMs: 300_000,
    });
    expect(
      dryRunProxyServer({ label: 'x', upstreamUrl: 'https://x.example' })
    ).toMatchObject({ requestTimeoutMs: 120_000, callTimeoutMs: 120_000 });
  });

  it('rejects forwarded writes with simulated writes, and a bad timeout, when defined', () => {
    const base = { label: 'x', upstreamUrl: 'https://x.example' };
    expect(() =>
      dryRunProxyServer({
        ...base,
        forwardWrites: true,
        writes: { file: '/tmp/w.jsonl', simulate: true },
      })
    ).toThrow("stops writes itself (forwardWrites), so MST can't simulate");
    expect(() =>
      dryRunProxyServer({
        ...base,
        writes: { file: '/tmp/w.jsonl', simulate: false, plannedWriteKey: 'k' },
      })
    ).toThrow("has a plannedWriteKey but doesn't forward writes");
    for (const requestTimeoutMs of [0, -1, 1.5, Number.NaN])
      expect(() => dryRunProxyServer({ ...base, requestTimeoutMs })).toThrow(
        'positive whole number'
      );
  });

  it('names its replacement when given the old simulateWrites option', () => {
    expect(() =>
      dryRunProxyServer({
        label: 'x',
        upstreamUrl: 'https://x.example',
        simulateWrites: { file: '/tmp/w.jsonl' },
      } as never)
    ).toThrow(
      "simulateWrites is now writes: pass the launch context's `writes`"
    );
  });

  it('passes the write record, simulated writes and their reply templates', () => {
    if (!built()) return;
    const entry = dryRunProxyServer({
      label: 'slack',
      upstreamUrl: 'https://mcp.slack.com/mcp',
      writes: { file: '/private/run/slack.jsonl', simulate: true },
      writeReplies: { send: { ok: true } },
    });
    expect(entry.args?.slice(-5)).toEqual([
      '--write-record',
      '/private/run/slack.jsonl',
      '--simulate-writes',
      '--write-replies',
      '{"send":{"ok":true}}',
    ]);
    // Reply templates only matter when MST simulates writes.
    const planned = dryRunProxyServer({
      label: 'slack',
      upstreamUrl: 'https://mcp.slack.com/mcp',
      writes: { file: '/private/run/slack.jsonl', simulate: false },
      writeReplies: { send: { ok: true } },
    });
    expect(planned.args?.slice(-2)).toEqual([
      '--write-record',
      '/private/run/slack.jsonl',
    ]);
  });

  it('passes a server-stopped write key and dispatchers', () => {
    if (!built()) return;
    const entry = dryRunProxyServer({
      label: 'glean',
      upstreamUrl: 'https://glean.example/mcp',
      forwardWrites: true,
      writes: {
        file: '/private/run/glean.jsonl',
        simulate: false,
        plannedWriteKey: '_eval_planned',
        dispatchers: { run_tool: 'tool_name' },
      },
    });
    expect(entry.args?.slice(-6)).toEqual([
      '--write-record',
      '/private/run/glean.jsonl',
      '--planned-write-key',
      '_eval_planned',
      '--dispatcher',
      'run_tool=tool_name',
    ]);
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
            {
              capabilities: { tools: {} },
              instructions: 'Use vendor for posts.',
            }
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

  it('forwards writes on stdio with forwardWrites', async () => {
    const tokenFile = join(dir, 'token.json');
    await fs.writeFile(
      tokenFile,
      JSON.stringify({ version: 1, accessToken: 'file-token' }),
      { mode: 0o600 }
    );
    calls.length = 0;
    const client = await createMCPClientForConfig({
      ...dryRunProxyServer({
        label: 'vendor',
        upstreamUrl: url,
        tokenFile,
        forwardWrites: true,
      }),
      connectTimeoutMs: 10_000,
    });
    try {
      expect(client.getInstructions()).toBe('Use vendor for posts.');
      const write = await client.callTool({ name: 'post', arguments: {} });
      expect(write.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(calls).toEqual(['post']);
    } finally {
      await closeMCPClient(client);
    }
  }, 20_000);

  it('simulates writes on stdio and records them', async () => {
    const tokenFile = join(dir, 'token.json');
    await fs.writeFile(
      tokenFile,
      JSON.stringify({ version: 1, accessToken: 'file-token' }),
      { mode: 0o600 }
    );
    const file = join(dir, 'vendor.jsonl');
    calls.length = 0;
    const client = await createMCPClientForConfig({
      ...dryRunProxyServer({
        label: 'vendor',
        upstreamUrl: url,
        tokenFile,
        writes: { file, simulate: true },
        writeReplies: { post: { ok: true, text: '{{arguments.text}}' } },
      }),
      connectTimeoutMs: 10_000,
    });
    try {
      const write = await client.callTool({
        name: 'post',
        arguments: { text: 'hi' },
      });
      expect(write.content).toEqual([
        { type: 'text', text: '{"ok":true,"text":"hi"}' },
      ]);
      expect(calls).toEqual([]);
      // The proxy listed the tools to classify the call: a `tools` line first.
      const record = (await fs.readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.kind === 'write');
      expect(record).toMatchObject({
        format: 'mst.write-record/v1',
        kind: 'write',
        server: 'vendor',
        tool: 'post',
        arguments: { text: 'hi' },
        mode: 'simulated',
      });
    } finally {
      await closeMCPClient(client);
    }
  }, 20_000);
});
