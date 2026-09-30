/**
 * The connection record against a real server: the dual-era mock over stdio
 * and HTTP, with raw probes built from the recorded target.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { closeMCPClient, createMCPClientForConfig } from './clientFactory.js';
import { connectionOf } from './connection.js';
import { probeHttp, probeStdio } from '../spec/probe.js';

const mock = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/mocks/dualEraServer.ts'
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('connection record over stdio', () => {
  it('records the target and wire, and probes start the same server', async () => {
    const client = await createMCPClientForConfig({
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', mock],
      env: { MOCK_ERA: 'dual' },
      quiet: true,
      protocol: 'legacy',
    });
    try {
      await client.listTools();
      const connection = connectionOf(client);
      expect(connection?.requestedProtocol).toBe('legacy');
      expect(
        connection?.wire?.exchanges().map((exchange) => exchange.method)
      ).toContain('tools/list');
      const target = connection?.target;
      expect(target?.transport).toBe('stdio');
      if (target?.transport !== 'stdio') return;
      // The environment the SDK spawned with: its defaults plus the config.
      expect(target.env).toMatchObject({
        ...getDefaultEnvironment(),
        MOCK_ERA: 'dual',
      });
      const reply = await probeStdio(target, {
        jsonrpc: '2.0',
        id: 'probe-1',
        method: 'ping',
      });
      expect(reply.message).toMatchObject({ jsonrpc: '2.0', id: 'probe-1' });
    } finally {
      await closeMCPClient(client);
    }
  });
});

describe('connection record over HTTP', () => {
  async function freePort(): Promise<number> {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it('records the target, and probes reach the same endpoint', async () => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', mock, '--http', String(port)],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('dual-era HTTP server did not start')),
          15_000
        );
        child.stderr.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes(`127.0.0.1:${port}/mcp`)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const serverUrl = `http://127.0.0.1:${port}/mcp`;
      const client = await createMCPClientForConfig({
        transport: 'http',
        serverUrl,
        protocol: 'legacy',
        headers: { 'X-Probe-Test': 'yes' },
      });
      try {
        const target = connectionOf(client)?.target;
        expect(target).toMatchObject({
          transport: 'http',
          url: serverUrl,
          headers: { 'X-Probe-Test': 'yes' },
        });
        if (target?.transport !== 'http') return;
        const reply = await probeHttp(target, {
          body: { jsonrpc: '2.0', id: 'probe-2', method: 'ping' },
        });
        expect(reply.status).toBeGreaterThanOrEqual(200);
        expect(reply.status).toBeLessThan(500);
      } finally {
        await closeMCPClient(client);
      }
    } finally {
      child.kill();
    }
  }, 30_000);
});

describe('probes present what the SDK transport does', () => {
  it('spawn a stdio server with the SDK defaults, not the whole parent environment', async () => {
    vi.stubEnv('MST_PROBE_PARENT_SECRET', 'leaked');
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const { id } = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {
          secret: process.env.MST_PROBE_PARENT_SECRET ?? null,
          hasPath: Boolean(process.env.PATH),
        } }) + '\\n');
      });`;
    const reply = await probeStdio(
      { transport: 'stdio', command: process.execPath, args: ['-e', script] },
      { jsonrpc: '2.0', id: 'env', method: 'ping' }
    );
    expect(reply.message?.result).toEqual({ secret: null, hasPath: true });
  });

  it('send the auth provider token over a configured Authorization header', async () => {
    let seen: string | undefined;
    const server = http.createServer((request, response) => {
      seen = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"jsonrpc":"2.0","id":"auth","result":{}}');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await probeHttp(
        {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: 'Bearer configured' },
          authProvider: {
            tokens: async () => ({
              access_token: 'from-provider',
              token_type: 'Bearer',
            }),
          } as unknown as NonNullable<
            Parameters<typeof probeHttp>[0]['authProvider']
          >,
        },
        { body: { jsonrpc: '2.0', id: 'auth', method: 'ping' } }
      );
      expect(seen).toBe('Bearer from-provider');
    } finally {
      server.close();
    }
  });
});
