import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  batchNotReady,
  checkServersReady,
  checksServersAfterPrepare,
  READINESS_RETRY_DELAYS_MS,
  readinessRetryDelaysMs,
  readyBatch,
} from './readinessCheck.js';
import {
  ProxyUpstreamError,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';
import { startToolSurfaceProxy } from './toolSurfaceProxyServer.js';
import { getClient } from './builtinClients.js';
import { checkMcpServers } from './mcpReadiness.js';
import { createEvalCaseExecutor, executionEnding } from './caseExecution.js';
import { prepareClientBatch } from './prepareClientBatch.js';
import type {
  ClientDefinition,
  ClientRunResult,
} from './evalFrameworkTypes.js';
import type { EvalCase } from './datasetTypes.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import {
  readyStdioServer,
  startReadinessHttpServer,
} from '../../tests/mocks/readyServers.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-readiness-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** How many times a server's log says it was asked for `method`. */
async function count(log: string, method = 'initialize'): Promise<number> {
  const text = await fs.readFile(log, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line === method).length;
}

/** Whether `line` shows up in `log` within `ms`. */
async function waitForLine(
  log: string,
  line: string,
  ms: number
): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if ((await count(log, line)) > 0) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A sleep that records each delay and returns at once. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe('checkServersReady', () => {
  it('passes a server that connects and lists a tool', async () => {
    const readiness = await checkServersReady([
      { ...readyStdioServer(), label: 'docs' },
    ]);
    expect(readiness).toMatchObject({
      ready: true,
      servers: [{ label: 'docs', status: 'connected', toolCount: 1 }],
    });
  });

  it('fails a server that lists no tools', async () => {
    const { sleep } = fakeSleep();
    const readiness = await checkServersReady(
      [{ ...readyStdioServer({ READINESS_TOOLS: '0' }), label: 'docs' }],
      { sleep, log: () => {} }
    );
    expect(readiness).toMatchObject({
      ready: false,
      reason:
        'MCP server not ready, so no trial was sent: docs listed no tools. Checked 3 times.',
    });
  });

  it('fails a stdio server that lists fewer tools than its minTools', async () => {
    const { sleep } = fakeSleep();
    const readiness = await checkServersReady(
      [
        {
          ...readyStdioServer({ READINESS_TOOLS: '2' }),
          label: 'docs',
          minTools: 3,
        },
      ],
      { sleep, log: () => {} }
    );
    expect(readiness).toMatchObject({
      ready: false,
      servers: [{ label: 'docs', status: 'failed', toolCount: 2, minTools: 3 }],
    });
    expect(readiness.ready || readiness.reason).toContain(
      'docs listed 2 tools, fewer than its minTools (3)'
    );
  });

  it("fails a server that doesn't connect, naming it", async () => {
    const readiness = await checkServersReady(
      [
        { ...readyStdioServer(), label: 'docs' },
        {
          transport: 'stdio',
          label: 'search',
          command: path.join(os.tmpdir(), 'no-such-mcp-server'),
        },
      ],
      { env: { MST_MCP_READINESS_RETRY_S: '' } }
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.ready || readiness.reason).toMatch(
      /^MCP server not ready, so no trial was sent: search did not connect \(.+\)\. Checked 1 time\.$/
    );
  });

  it('checks a failed server again after 10 s, and only that one, until it recovers', async () => {
    const dir = await tempDir();
    const steady = path.join(dir, 'steady.log');
    const launches = path.join(dir, 'launches');
    const { delays, sleep } = fakeSleep();
    const log = vi.fn();
    const readiness = await checkServersReady(
      [
        { ...readyStdioServer({ READINESS_LOG: steady }), label: 'docs' },
        {
          ...readyStdioServer({
            READINESS_FAIL_FILE: launches,
            READINESS_FAIL_TIMES: '1',
          }),
          label: 'search',
        },
      ],
      { sleep, log }
    );
    expect(readiness).toMatchObject({
      ready: true,
      servers: [
        { label: 'docs', status: 'connected' },
        { label: 'search', status: 'connected' },
      ],
    });
    expect(delays).toEqual([10_000]);
    // The ready server isn't checked again.
    expect(await count(steady)).toBe(1);
    expect((await fs.readFile(launches, 'utf8')).trim().split('\n')).toEqual([
      'launch',
      'launch',
    ]);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(
      /^\[mst\] MCP servers not ready: search did not connect \(.+\)\. Checking again in 10s\.$/
    );
  });

  it('gives up after the 10 s and 30 s retries', async () => {
    const dir = await tempDir();
    const { delays, sleep } = fakeSleep();
    const readiness = await checkServersReady(
      [
        {
          ...readyStdioServer({
            READINESS_FAIL_FILE: path.join(dir, 'launches'),
            READINESS_FAIL_TIMES: '9',
          }),
          label: 'search',
        },
      ],
      { sleep, log: () => {} }
    );
    expect(delays).toEqual([10_000, 30_000]);
    expect(readiness.ready).toBe(false);
    expect(readiness.ready || readiness.reason).toMatch(/Checked 3 times\.$/);
  });

  it('bounds the whole probe, connecting included', async () => {
    const started = Date.now();
    const readiness = await checkServersReady(
      [
        {
          transport: 'stdio',
          label: 'stuck',
          command: process.execPath,
          // Never answers `initialize`; exits when the probe closes it.
          args: [
            '-e',
            "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
          ],
        },
      ],
      { env: { MST_MCP_READINESS_RETRY_S: '' }, timeoutMs: 300 }
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(readiness).toMatchObject({
      ready: false,
      servers: [
        { label: 'stuck', status: 'failed', error: 'timed out after 0.3s' },
      ],
    });
  });

  it('closes a stdio server that never answers tools/list at the deadline', async () => {
    const log = path.join(await tempDir(), 'server.log');
    const readiness = await checkServersReady(
      [
        {
          ...readyStdioServer({
            READINESS_LOG: log,
            READINESS_STALL_LIST: '1',
          }),
          label: 'stalled',
        },
      ],
      { env: { MST_MCP_READINESS_RETRY_S: '' }, timeoutMs: 300 }
    );
    expect(readiness).toMatchObject({
      ready: false,
      servers: [
        { label: 'stalled', status: 'failed', error: 'timed out after 0.3s' },
      ],
    });
    expect(await count(log, 'tools/list')).toBe(1);
    // Its stdin is closed at once, not when the SDK's request times out.
    expect(await waitForLine(log, 'closed', 1_000)).toBe(true);
  });

  it('says a server that connected did not list its tools when listing fails', async () => {
    const readiness = await checkServersReady(
      [
        {
          ...readyStdioServer({ READINESS_LIST_ERROR: '1' }),
          label: 'broken',
        },
      ],
      { env: { MST_MCP_READINESS_RETRY_S: '' }, timeoutMs: 3_000 }
    );
    expect(readiness).toMatchObject({
      ready: false,
      servers: [{ label: 'broken', status: 'connected' }],
    });
    expect(readiness.ready || readiness.reason).toMatch(
      /broken did not list its tools \(/
    );
  });

  it('drops a stalled HTTP tools/list at the deadline, without waiting on a session DELETE', async () => {
    const log = path.join(await tempDir(), 'server.log');
    const server = await startReadinessHttpServer({ log, stallList: true });
    try {
      const started = Date.now();
      const readiness = await checkServersReady(
        [{ transport: 'http', serverUrl: server.url, label: 'stalled' }],
        { env: { MST_MCP_READINESS_RETRY_S: '' }, timeoutMs: 300 }
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(readiness).toMatchObject({
        ready: false,
        servers: [{ label: 'stalled', error: 'timed out after 0.3s' }],
      });
      expect(await waitForLine(log, 'closed', 1_000)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('aborts a connect still opening at the deadline: the stalled SSE fallback request is cancelled', async () => {
    // Rejects Streamable HTTP, then never sends the SSE endpoint event.
    const requests: Array<{ method: string; signal: AbortSignal | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        requests.push({ method, signal: init.signal ?? null });
        if (method === 'POST') return new Response('', { status: 405 });
        return new Promise<Response>(() => {});
      })
    );
    const readiness = await checkServersReady(
      [
        {
          transport: 'http',
          serverUrl: 'https://example.test/mcp',
          label: 'stalled',
        },
      ],
      { env: { MST_MCP_READINESS_RETRY_S: '' }, timeoutMs: 300 }
    );
    expect(readiness).toMatchObject({
      ready: false,
      servers: [{ label: 'stalled', error: 'timed out after 0.3s' }],
    });
    const fallback = requests.filter((request) => request.method === 'GET');
    expect(fallback).toHaveLength(1);
    // Cancelled at the deadline, not left open while a retry opens another.
    expect(fallback[0]!.signal?.aborted).toBe(true);
  });

  it('starts no SSE fallback after the deadline aborts a stalled Streamable HTTP initialize', async () => {
    // Stalls every request until it is aborted.
    const requests: Array<{ method: string; signal: AbortSignal | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit = {}) => {
        const signal = init.signal ?? null;
        requests.push({ method: init.method ?? 'GET', signal });
        return new Promise<Response>((_, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      })
    );
    const readiness = await checkMcpServers(
      [{ transport: 'http', serverUrl: 'https://example.test/mcp' }],
      undefined,
      100
    );
    expect(readiness).toMatchObject([
      { status: 'failed', error: 'timed out after 0.1s' },
    ]);
    // Time for a fallback to start, if one were going to.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requests.map((request) => request.method)).toEqual(['POST']);
    expect(requests[0]!.signal?.aborted).toBe(true);
  });

  it("gives a server its longer connectTimeoutMs, plus the probe's time to list", async () => {
    const readiness = await checkServersReady(
      [
        {
          transport: 'stdio',
          label: 'slow',
          connectTimeoutMs: 400,
          command: process.execPath,
          args: [
            '-e',
            "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
          ],
        },
      ],
      { env: { MST_MCP_READINESS_RETRY_S: '' }, timeoutMs: 300 }
    );
    expect(readiness).toMatchObject({
      ready: false,
      servers: [{ label: 'slow', status: 'failed' }],
    });
    // Its connect gave up at 0.4s, inside the 0.7s whole-probe limit.
    expect(
      readiness.ready ? undefined : readiness.servers[0]?.error
    ).not.toMatch(/^timed out after 0\.3s$/);
  });
});

describe('readinessRetryDelaysMs', () => {
  it('waits 10 s and then 30 s by default', () => {
    expect(readinessRetryDelaysMs({})).toEqual([10_000, 30_000]);
    expect(READINESS_RETRY_DELAYS_MS).toEqual([10_000, 30_000]);
  });

  it('reads MST_MCP_READINESS_RETRY_S', () => {
    expect(
      readinessRetryDelaysMs({ MST_MCP_READINESS_RETRY_S: '5, 20' })
    ).toEqual([5000, 20000]);
    expect(readinessRetryDelaysMs({ MST_MCP_READINESS_RETRY_S: '' })).toEqual(
      []
    );
    expect(() =>
      readinessRetryDelaysMs({ MST_MCP_READINESS_RETRY_S: 'soon' })
    ).toThrow('MST_MCP_READINESS_RETRY_S must be comma-separated seconds');
  });

  it('fails for the retired MST_COWORK_MCP_PREFLIGHT_RETRY_S, naming the new setting', () => {
    for (const env of [
      { MST_COWORK_MCP_PREFLIGHT_RETRY_S: '' },
      { MST_COWORK_MCP_PREFLIGHT_RETRY_S: '5' },
    ])
      expect(() => readinessRetryDelaysMs(env)).toThrow(
        "MST_COWORK_MCP_PREFLIGHT_RETRY_S was renamed: MST now checks every client's MCP servers before the first trial. Set MST_MCP_READINESS_RETRY_S instead."
      );
    vi.stubEnv('MST_COWORK_MCP_PREFLIGHT_RETRY_S', '10,30');
    expect(() => readinessRetryDelaysMs({})).toThrow(
      'Set MST_MCP_READINESS_RETRY_S instead.'
    );
  });
});

describe('batchNotReady', () => {
  const plain: ClientDefinition = { schema: z.object({}) };

  it('checks nothing for a batch without servers', async () => {
    await expect(batchNotReady(plain, [])).resolves.toBeUndefined();
  });

  it('leaves a stdio server with client-resolved fields to the client that resolves it', async () => {
    const resolvedByClient: MCPConfig = {
      transport: 'stdio',
      command: process.execPath,
      args: ['${pluginRoot:fake}/mcp/start.mjs'],
    };
    await expect(
      batchNotReady(plain, [resolvedByClient])
    ).resolves.toBeUndefined();
    // The others are still checked, under the names their places give them.
    const notReady = await batchNotReady(
      plain,
      [resolvedByClient, readyStdioServer({ READINESS_TOOLS: '0' })],
      { env: { MST_MCP_READINESS_RETRY_S: '' } }
    );
    expect(notReady?.().error).toBe(
      'MCP server not ready, so no trial was sent: server-2 listed no tools. Checked 1 time.'
    );
  });

  it('leaves a client that checks after it prepares its app to its batch', async () => {
    const dir = await tempDir();
    const log = path.join(dir, 'probes.log');
    const servers = [
      readyStdioServer({ READINESS_LOG: log, READINESS_TOOLS: '0' }),
    ];
    const desktop = checksServersAfterPrepare({ schema: z.object({}) });
    await expect(batchNotReady(desktop, servers)).resolves.toBeUndefined();
    expect(await count(log)).toBe(0);
    const notReady = await batchNotReady(plain, servers, {
      env: { MST_MCP_READINESS_RETRY_S: '' },
    });
    expect(notReady?.()).toMatchObject({
      ending: { kind: 'infrastructure', broke: 'setup', retryable: true },
    });
    expect(await count(log)).toBe(1);
  });
});

describe('readyBatch', () => {
  const plain: ClientDefinition = { schema: z.object({}) };
  const env = { MST_MCP_READINESS_RETRY_S: '' };

  it('checks the declared servers, minTools included, before it starts the proxy', async () => {
    const log = path.join(await tempDir(), 'probes.log');
    const docs: MCPConfig = {
      ...readyStdioServer({ READINESS_LOG: log }),
      label: 'docs',
    };
    const order: string[] = [];
    const startProxy = vi.fn(async () => {
      order.push(`proxy after ${await count(log)} checks`);
      return 'proxy';
    });
    await expect(
      readyBatch(plain, [docs], startProxy, { env })
    ).resolves.toEqual({ proxy: 'proxy' });
    expect(order).toEqual(['proxy after 1 checks']);

    startProxy.mockClear();
    const degraded = await readyBatch(
      plain,
      [{ ...docs, minTools: 2 }],
      startProxy,
      { env }
    );
    expect(degraded.notReady?.()).toMatchObject({
      error:
        'MCP server not ready, so no trial was sent: docs listed 1 tool, fewer than its minTools (2). Checked 1 time.',
      ending: { kind: 'infrastructure', broke: 'setup', retryable: true },
    });
    expect(startProxy).not.toHaveBeenCalled();
  });

  it('checks a proxied batch even for a client that checks after it prepares its app', async () => {
    const log = path.join(await tempDir(), 'probes.log');
    const servers = [
      readyStdioServer({ READINESS_LOG: log, READINESS_TOOLS: '0' }),
    ];
    const desktop = checksServersAfterPrepare({ schema: z.object({}) });
    const startProxy = vi.fn(async () => 'proxy');
    const ready = await readyBatch(desktop, servers, startProxy, { env });
    expect(ready.notReady?.()).toMatchObject({
      ending: { kind: 'infrastructure', broke: 'setup', retryable: true },
    });
    expect(startProxy).not.toHaveBeenCalled();
    expect(await count(log)).toBe(1);
    // Unproxied, it is still left to the client.
    await expect(
      readyBatch(desktop, servers, undefined, { env })
    ).resolves.toEqual({ proxy: undefined });
    expect(await count(log)).toBe(1);
  });

  it('ends the batch when the proxy still cannot reach a server, and throws any other proxy error', async () => {
    const servers = [{ ...readyStdioServer(), label: 'docs' }];
    const unreachable = await readyBatch(
      plain,
      servers,
      async () => {
        throw new ProxyUpstreamError(
          'docs',
          'connect',
          new Error('connect ECONNREFUSED')
        );
      },
      { env, log: () => {} }
    );
    const result = unreachable.notReady?.();
    expect(result?.error).toMatch(
      /^MCP server not ready, so no trial was sent: docs did not connect \(.+\) when the tool-variant proxy started\.$/
    );
    expect(result).toMatchObject({
      ending: { kind: 'infrastructure', broke: 'setup', retryable: true },
      telemetry: { mcpReadiness: [{ label: 'docs', status: 'failed' }] },
    });
    await expect(
      readyBatch(
        plain,
        servers,
        async () => {
          throw new Error('Tool variant "v2" names a tool no server has.');
        },
        { env }
      )
    ).rejects.toThrow('names a tool no server has');
  });

  it('says a server connected but did not list its tools when the proxy could not list them', async () => {
    // The check's own probe lists the tools; the proxy's connection then
    // connects, and its tools/list stalls past the request timeout.
    const servers = [{ ...readyStdioServer(), label: 'docs' }];
    const listStalls = {
      ...readyStdioServer({ READINESS_STALL_LIST: '1' }),
      label: 'docs',
      requestTimeoutMs: 500,
    };
    const lines: string[] = [];
    const ready = await readyBatch(
      plain,
      servers,
      () => startToolSurfaceProxy([listStalls], { id: 'v2', tools: {} }),
      { env, log: (line) => lines.push(line) }
    );
    const result = ready.notReady?.();
    const reason =
      /^MCP server not ready, so no trial was sent: docs did not list its tools \(.+\) when the tool-variant proxy started\.$/;
    expect(result?.error).toMatch(reason);
    expect(result).toMatchObject({
      ending: { kind: 'infrastructure', broke: 'setup', retryable: true },
      telemetry: {
        mcpReadiness: [
          { label: 'docs', status: 'connected', error: expect.any(String) },
        ],
      },
    });
    expect(lines).toEqual([
      expect.stringMatching(/did not list its tools \(.+\) when the tool/),
    ]);
    expect(lines.join('\n')).not.toContain('did not connect');
  });
});

/**
 * Every built-in client and a plugin client gets MST's check before the
 * first trial of a batch, once per batch. A server with no tools isn't
 * ready: no trial is sent, and each ends as a retryable setup failure.
 */
describe('the readiness check before a batch', () => {
  const cases: EvalCase[] = ['one', 'two', 'three'].map((id) => ({
    id,
    input: `query ${id}`,
  }));
  const evalConfig = { name: 'readiness', datasets: [] };
  // One attempt: the counts below are per check.
  const env = { MST_MCP_READINESS_RETRY_S: '' };
  const reason =
    'MCP server not ready, so no trial was sent: docs listed no tools. Checked 1 time.';
  const setupEnding = {
    kind: 'infrastructure',
    broke: 'setup',
    retryable: true,
    reason,
  };

  async function emptyServer(): Promise<{ server: MCPConfig; log: string }> {
    const log = path.join(await tempDir(), 'probes.log');
    return {
      server: {
        ...readyStdioServer({ READINESS_LOG: log, READINESS_TOOLS: '0' }),
        label: 'docs',
      },
      log,
    };
  }

  function installTestClient(name: string, client: ClientDefinition): string {
    installPlugins([
      {
        meta: { name: 'readiness-test', namespace: 'readiness-test' },
        clients: { [name]: client },
      },
    ]);
    return `readiness-test/client/${name}`;
  }

  it.each(['api', 'claude-code', 'codex-cli'])(
    'checks the %s client once, and sends no trial to an empty server',
    async (type) => {
      const definition = getClient(type);
      expect(getClient(type)).toBe(definition);
      // Never the real client: the check must stop the batch first.
      const run = vi
        .spyOn(definition, 'run')
        .mockResolvedValue({ finalText: 'ran', events: [] });
      const { server, log } = await emptyServer();
      const execute = createEvalCaseExecutor({
        servers: [server],
        client: { type },
        evalConfig,
        env,
      });
      for (const evalCase of cases) {
        const execution = await execute(evalCase);
        expect(execution.error).toBe(reason);
        expect(executionEnding(execution)).toEqual(setupEnding);
      }
      expect(run).not.toHaveBeenCalled();
      expect(await count(log)).toBe(1);
    }
  );

  it.each(['chatgpt', 'codex-app'])(
    'checks the %s client once, before its batch touches the desktop',
    async (type) => {
      const definition = getClient(type);
      const open = vi.spyOn(definition, 'open');
      const { server, log } = await emptyServer();
      const queues = await prepareClientBatch(
        definition,
        cases,
        { type },
        [server],
        { evalConfig, env }
      );
      expect(open).not.toHaveBeenCalled();
      for (const evalCase of cases)
        expect(queues?.get(evalCase.id)).toMatchObject([
          { error: reason, ending: setupEnding },
        ]);
      expect(await count(log)).toBe(1);
    }
  );

  it('checks a plugin client with run() once per batch, before its first trial', async () => {
    const dir = await tempDir();
    const log = path.join(dir, 'probes.log');
    const order: string[] = [];
    const run = vi.fn(async (): Promise<ClientRunResult> => {
      order.push(`run after ${await count(log)} checks`);
      return { finalText: 'ok', events: [] };
    });
    const type = installTestClient('per-case', {
      schema: z.object({ type: z.string() }),
      run,
    });
    const execute = createEvalCaseExecutor({
      servers: [{ ...readyStdioServer({ READINESS_LOG: log }), label: 'docs' }],
      client: { type },
      evalConfig,
      env,
    });
    for (const evalCase of cases)
      await expect(execute(evalCase)).resolves.toMatchObject({
        kind: 'completed',
      });
    expect(order).toEqual([
      'run after 1 checks',
      'run after 1 checks',
      'run after 1 checks',
    ]);

    // Not ready: no trial is sent.
    run.mockClear();
    const empty = await emptyServer();
    const notReady = createEvalCaseExecutor({
      servers: [empty.server],
      client: { type },
      evalConfig,
      env,
    });
    for (const evalCase of cases)
      expect(executionEnding(await notReady(evalCase))).toEqual(setupEnding);
    expect(run).not.toHaveBeenCalled();
    expect(await count(empty.log)).toBe(1);
  });

  it('checks a plugin client with open() once, before opening its session', async () => {
    const dir = await tempDir();
    const log = path.join(dir, 'probes.log');
    const checksSeen: number[] = [];
    const open = vi.fn(async () => {
      checksSeen.push(await count(log));
      return {
        async run() {
          return {
            result: { finalText: 'ok', events: [] },
            continuation: 'continue' as const,
          };
        },
        async reset() {},
        async close() {},
      };
    });
    const definition: ClientDefinition = {
      schema: z.object({ type: z.string() }),
      open,
    };
    const ready = await prepareClientBatch(
      definition,
      cases,
      { type: 'readiness-test/client/batch' },
      [{ ...readyStdioServer({ READINESS_LOG: log }), label: 'docs' }],
      { evalConfig, env }
    );
    expect(checksSeen).toEqual([1]);
    expect(ready?.get('one')).toMatchObject([{ finalText: 'ok' }]);

    open.mockClear();
    const empty = await emptyServer();
    const queues = await prepareClientBatch(
      definition,
      cases,
      { type: 'readiness-test/client/batch' },
      [empty.server],
      { evalConfig, env }
    );
    expect(open).not.toHaveBeenCalled();
    expect(queues?.get('two')).toMatchObject([{ ending: setupEnding }]);
    expect(await count(empty.log)).toBe(1);
  });
});

/**
 * A case can name its own client (runEval resolves it in full). The check
 * and the proxy follow the client the case runs on, not the variant's, and
 * each distinct setup (through the proxy or not) is checked once per batch.
 */
describe('a case on its own client', () => {
  const evalConfig = { name: 'readiness', datasets: [] };
  const env = { MST_MCP_READINESS_RETRY_S: '' };
  const ran: ClientRunResult = { finalText: 'ran', events: [] };
  const setupEnding = {
    kind: 'infrastructure',
    broke: 'setup',
    retryable: true,
  };

  async function docs(tools = 1): Promise<{ server: MCPConfig; log: string }> {
    const log = path.join(await tempDir(), 'probes.log');
    return {
      server: {
        ...readyStdioServer({
          READINESS_LOG: log,
          READINESS_TOOLS: String(tools),
        }),
        label: 'docs',
      },
      log,
    };
  }

  /** A proxy whose upstream can't be reached once the check passed. */
  function unreachableProxy() {
    return vi.fn(async (): Promise<ToolSurfaceProxy> => {
      throw new ProxyUpstreamError(
        'docs',
        'connect',
        new Error('connect ECONNREFUSED')
      );
    });
  }

  it("ends a claude-code case in an api variant as setup when its proxy can't reach a server", async () => {
    const run = vi
      .spyOn(getClient('claude-code'), 'run')
      .mockResolvedValue(ran);
    const { server } = await docs();
    const proxy = unreachableProxy();
    const execute = createEvalCaseExecutor({
      servers: [server],
      client: { type: 'api' },
      evalConfig,
      env,
      toolVariant: { id: 'v2', proxy },
    });
    for (const id of ['one', 'two']) {
      const execution = await execute({ id, input: id, client: 'claude-code' });
      expect(execution.error).toMatch(
        /^MCP server not ready, so no trial was sent: docs did not connect \(.+\) when the tool-variant proxy started\.$/
      );
      expect(executionEnding(execution)).toMatchObject(setupEnding);
    }
    expect(run).not.toHaveBeenCalled();
    // Started once for the batch's proxied setup.
    expect(proxy).toHaveBeenCalledTimes(1);
  });

  it('runs an api case in a claude-code variant without the proxy it never uses', async () => {
    const run = vi.spyOn(getClient('api'), 'run').mockResolvedValue(ran);
    const { server, log } = await docs();
    const proxy = unreachableProxy();
    const execute = createEvalCaseExecutor({
      servers: [server],
      client: { type: 'claude-code' },
      evalConfig,
      env,
      toolVariant: { id: 'v2', proxy },
    });
    await expect(
      execute({ id: 'one', input: 'one', client: 'api' })
    ).resolves.toMatchObject({ kind: 'completed' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(proxy).not.toHaveBeenCalled();
    expect(await count(log)).toBe(1);
  });

  it('checks each setup of a batch once', async () => {
    const apiRun = vi.spyOn(getClient('api'), 'run').mockResolvedValue(ran);
    const claudeRun = vi
      .spyOn(getClient('claude-code'), 'run')
      .mockResolvedValue(ran);
    const mixed: EvalCase[] = [
      { id: 'a', input: 'a', client: 'api' },
      { id: 'b', input: 'b' },
      { id: 'c', input: 'c', client: 'api' },
      { id: 'd', input: 'd' },
    ];
    // Proxied: the claude-code cases go through the proxy and the api cases
    // don't, so the server is checked once for each setup.
    const proxiedServer = await docs(0);
    const proxy = unreachableProxy();
    const proxied = createEvalCaseExecutor({
      servers: [proxiedServer.server],
      client: { type: 'claude-code' },
      evalConfig,
      env,
      toolVariant: { id: 'v2', proxy },
    });
    for (const evalCase of mixed)
      expect(executionEnding(await proxied(evalCase))).toMatchObject({
        ...setupEnding,
        reason:
          'MCP server not ready, so no trial was sent: docs listed no tools. Checked 1 time.',
      });
    expect(await count(proxiedServer.log)).toBe(2);
    expect(proxy).not.toHaveBeenCalled();

    // Without a proxy, both clients reach the server the same way: once.
    const directServer = await docs(0);
    const direct = createEvalCaseExecutor({
      servers: [directServer.server],
      client: { type: 'claude-code' },
      evalConfig,
      env,
    });
    for (const evalCase of mixed)
      expect(executionEnding(await direct(evalCase))).toMatchObject(
        setupEnding
      );
    expect(await count(directServer.log)).toBe(1);
    expect(apiRun).not.toHaveBeenCalled();
    expect(claudeRun).not.toHaveBeenCalled();
  });

  it('leaves a cowork case in an api variant to the check Cowork runs after prepare', async () => {
    const coworkRun = vi.spyOn(getClient('cowork'), 'open').mockResolvedValue({
      async run() {
        return { result: ran, continuation: 'continue' };
      },
      async reset() {},
      async close() {},
    });
    const apiRun = vi.spyOn(getClient('api'), 'run').mockResolvedValue(ran);
    const { server, log } = await docs(0);
    const execute = createEvalCaseExecutor({
      servers: [server],
      client: { type: 'api' },
      evalConfig,
      env,
    });
    await expect(
      execute({ id: 'one', input: 'one', client: 'cowork' })
    ).resolves.toMatchObject({ kind: 'completed' });
    expect(coworkRun).toHaveBeenCalledTimes(1);
    expect(await count(log)).toBe(0);
    // The variant's own client is still checked before its first trial.
    expect(
      executionEnding(await execute({ id: 'two', input: 'two' }))
    ).toMatchObject(setupEnding);
    expect(apiRun).not.toHaveBeenCalled();
    expect(await count(log)).toBe(1);

    // Through the proxy, MST checks it before the proxy starts.
    const proxiedServer = await docs(0);
    const proxy = unreachableProxy();
    const proxied = createEvalCaseExecutor({
      servers: [proxiedServer.server],
      client: { type: 'api' },
      evalConfig,
      env,
      toolVariant: { id: 'v2', proxy },
    });
    expect(
      executionEnding(
        await proxied({ id: 'one', input: 'one', client: 'cowork' })
      )
    ).toMatchObject(setupEnding);
    expect(coworkRun).toHaveBeenCalledTimes(1);
    expect(proxy).not.toHaveBeenCalled();
    expect(await count(proxiedServer.log)).toBe(1);
  });
});
