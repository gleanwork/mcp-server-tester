import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV3 } from 'ai/test';
import { registerBuiltinHosts } from './builtinHosts.js';
import { getHost } from './frameworkRegistries.js';

// Only the model provider is fake. Hosts create and close real local MCP clients.
const mocks = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.provider }));
const answer = {
  content: [{ type: 'text' as const, text: 'done' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 },
  },
  warnings: [],
};
let model: MockLanguageModelV3;
let server: http.Server;
let serverUrl: string;
let initialize: http.ServerResponse | undefined;
let deletion: http.ServerResponse | undefined;
let initializeId: unknown;
let onInitialize: (() => void) | undefined;
let holdInitialize: boolean;
let holdDelete: boolean;
let deleteAborted: boolean;

function releaseInitialize() {
  if (!initialize || initialize.writableEnded) return;
  initialize
    .writeHead(200, {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': 'local-session',
    })
    .end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: initializeId,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'local', version: '1' },
        },
      })
    );
}
function run(timeout: number) {
  return getHost('vercel-sdk').run!(
    {
      scenario: 'hello',
      servers: [{ transport: 'http', serverUrl, label: 'local' }],
    },
    { type: 'vercel-sdk', provider: 'openai', timeout },
    { manifest: { name: 'offline', datasets: [] } }
  );
}

beforeEach(async () => {
  registerBuiltinHosts();
  vi.stubEnv('HTTP_PROXY', undefined);
  vi.stubEnv('HTTPS_PROXY', undefined);
  holdInitialize = false;
  holdDelete = false;
  deleteAborted = false;
  initialize = undefined;
  onInitialize = undefined;
  deletion = undefined;
  model = new MockLanguageModelV3({ doGenerate: answer });
  mocks.provider.mockReturnValue(() => model);
  server = http.createServer((request, response) => {
    if (request.method === 'DELETE') {
      deletion = response;
      response.on('close', () => {
        deleteAborted = !response.writableEnded;
      });
      if (!holdDelete) response.writeHead(200).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: unknown; method: string };
      if (message.method === 'initialize') {
        initialize = response;
        initializeId = message.id;
        onInitialize?.();
        if (!holdInitialize) releaseInitialize();
      } else if (message.id !== undefined) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [] },
          })
        );
      } else response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No test server address');
  serverUrl = `http://127.0.0.1:${address.port}/mcp`;
});
afterEach(async () => {
  vi.useRealTimers();
  releaseInitialize();
  deletion?.end();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

describe('registered SDK owned lifecycle deadline', () => {
  it('bounds delayed connection setup without starting model execution', async () => {
    holdInitialize = true;
    const pending = run(50);
    await vi.waitFor(() => expect(initialize).toBeDefined());
    const bounded = await Promise.race([pending, delay(150).then(() => null)]);
    releaseInitialize();
    await pending;
    expect(bounded?.error).toContain('timed out');
    expect(model.doGenerateCalls).toHaveLength(0);
    // Allow late connection cleanup to settle before closing the HTTP fixture.
    await delay(50);
  });

  it('uses the remaining lifecycle budget for model execution and aborts it at the deadline', async () => {
    holdInitialize = true;
    const initializeStarted = new Promise<void>((resolve) => {
      onInitialize = resolve;
    });
    const modelStarted = new Promise<void>((resolve) => {
      model = new MockLanguageModelV3({
        doGenerate: async () => {
          resolve();
          return new Promise(() => {});
        },
      });
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const startedAt = Date.now();
    let settled = false;
    const pending = run(200).finally(() => {
      settled = true;
    });

    // Wait for real HTTP/import readiness without advancing the fake clock.
    await initializeStarted;
    expect(model.doGenerateCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(75);
    releaseInitialize();
    await modelStarted;
    expect(Date.now() - startedAt).toBe(75);
    expect(model.doGenerateCalls).toHaveLength(1);
    const signal = model.doGenerateCalls[0]?.abortSignal;

    // Setup consumed 75 ms, leaving only 125 ms for model execution.
    await vi.advanceTimersByTimeAsync(124);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(Date.now() - startedAt).toBe(200);
    expect(result.error).toContain('timed out');
    expect(signal?.aborted).toBe(true);
  });

  it('bounds stalled session teardown and aborts its owned HTTP request', async () => {
    holdDelete = true;
    const pending = run(200);
    await vi.waitFor(() => expect(deletion).toBeDefined());
    const bounded = await Promise.race([pending, delay(350).then(() => null)]);
    // Release on failure too, so this regression never leaves a hung test run.
    if (!bounded) deletion?.end();
    await pending;
    expect(bounded?.error).toContain('timed out');
    await vi.waitFor(() => expect(deleteAborted).toBe(true));
  });

  it('closes a real stdio connection that finishes startup after the deadline', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'builtin-mcp-test-')
    );
    const closed = path.join(directory, 'closed');
    const script = `
      const fs = require('node:fs');
      const readline = require('node:readline');
      const lines = readline.createInterface({ input: process.stdin });
      process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(closed)}, 'closed'); process.exit(0); });
      lines.on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') setTimeout(() => console.log(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local', version: '1' } }
        })), 150);
        else if (message.id !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
      });
      setTimeout(() => process.exit(0), 3000);
    `;
    try {
      const result = await getHost('vercel-sdk').run!(
        {
          scenario: 'hello',
          servers: [
            {
              transport: 'stdio',
              command: process.execPath,
              args: ['-e', script],
            },
          ],
        },
        { type: 'vercel-sdk', provider: 'openai', timeout: 50 },
        { manifest: { name: 'offline', datasets: [] } }
      );
      expect(result.error).toContain('timed out');
      await vi.waitFor(() => expect(fs.existsSync(closed)).toBe(true), {
        timeout: 2000,
      });
      expect(model.doGenerateCalls).toHaveLength(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
