import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV3 } from 'ai/test';
import { registerBuiltinHosts } from './builtinHosts.js';
import { getHost } from './frameworkRegistries.js';

// The model provider is fake; the AI SDK and host cancellation path are real.
// A barrier before simulation models setup time without HTTP under fake timers.
const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  beforeSimulation: vi.fn<() => Promise<void>>(),
}));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.provider }));
vi.mock(import('./mcpHost/mcpHostSimulation.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    async simulateMCPHost(...args: Parameters<typeof actual.simulateMCPHost>) {
      await mocks.beforeSimulation();
      return actual.simulateMCPHost(...args);
    },
  };
});
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
let server: http.Server | undefined;
let serverUrl: string;
let initialize: http.ServerResponse | undefined;
let deletion: http.ServerResponse | undefined;
let initializeId: unknown;
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

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function startServer() {
  const localServer = http.createServer((request, response) => {
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
  server = localServer;
  await new Promise<void>((resolve) =>
    localServer.listen(0, '127.0.0.1', resolve)
  );
  const address = localServer.address();
  if (!address || typeof address === 'string')
    throw new Error('No test server address');
  serverUrl = `http://127.0.0.1:${address.port}/mcp`;
}

beforeEach(() => {
  registerBuiltinHosts();
  vi.stubEnv('HTTP_PROXY', undefined);
  vi.stubEnv('HTTPS_PROXY', undefined);
  holdInitialize = false;
  holdDelete = false;
  deleteAborted = false;
  initialize = undefined;
  deletion = undefined;
  server = undefined;
  model = new MockLanguageModelV3({ doGenerate: answer });
  mocks.provider.mockReturnValue(() => model);
  mocks.beforeSimulation.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.useRealTimers();
  releaseInitialize();
  deletion?.end();
  const localServer = server;
  if (localServer) {
    localServer.closeAllConnections();
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});

describe('registered SDK owned lifecycle deadline', () => {
  it('bounds delayed connection setup without starting model execution', async () => {
    await startServer();
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
    const setupStarted = barrier();
    const setupReleased = barrier();
    const modelStarted = barrier();
    const modelReleased = barrier();
    let modelAborted = false;
    mocks.beforeSimulation.mockImplementationOnce(async () => {
      setupStarted.release();
      await setupReleased.promise;
    });
    model = new MockLanguageModelV3({
      doGenerate: async ({ abortSignal }) => {
        function onAbort() {
          modelAborted = true;
          modelReleased.release();
        }
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        modelStarted.release();
        try {
          await modelReleased.promise;
          abortSignal?.throwIfAborted();
          return answer;
        } finally {
          abortSignal?.removeEventListener('abort', onAbort);
        }
      },
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const startedAt = Date.now();
    let settled = false;
    // No HTTP fixture or MCP clients: only promises, imports and the real AI SDK.
    const pending = getHost('vercel-sdk').run!(
      { scenario: 'hello', servers: [] },
      { type: 'vercel-sdk', provider: 'openai', timeout: 200 },
      { manifest: { name: 'offline', datasets: [] } }
    ).finally(() => {
      settled = true;
    });

    try {
      await setupStarted.promise;
      expect(model.doGenerateCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(75);
      setupReleased.release();
      await modelStarted.promise;
      expect(Date.now() - startedAt).toBe(75);
      expect(model.doGenerateCalls).toHaveLength(1);
      const signal = model.doGenerateCalls[0]?.abortSignal;

      // The adapter starts at t=75. Its own fresh timeout would expire at t=275,
      // so only the propagated host signal can stop the model at t=200.
      await vi.advanceTimersByTimeAsync(124);
      expect(settled).toBe(false);
      expect(signal?.aborted).toBe(false);
      expect(modelAborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(Date.now() - startedAt).toBe(200);
      expect(result.error).toContain('timed out');
      expect(signal?.aborted).toBe(true);
      expect(modelAborted).toBe(true);
      expect(model.doGenerateCalls).toHaveLength(1);
    } finally {
      setupReleased.release();
      modelReleased.release();
    }
  });

  it('bounds stalled session teardown and aborts its owned HTTP request', async () => {
    await startServer();
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
