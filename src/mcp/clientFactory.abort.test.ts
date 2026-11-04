/**
 * `openMCPClient` with an `AbortSignal`, against the real SDK: aborting it
 * closes the transport the open has started, even before connect finishes,
 * and the open rejects. The readiness probe aborts it at its deadline.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeMCPClient, openMCPClient } from './clientFactory.js';
import { readyStdioServer } from '../../tests/mocks/readyServers.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function serverLog(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-open-abort-'));
  dirs.push(dir);
  return path.join(dir, 'server.log');
}

/** Whether `line` shows up in `log` within `ms`. */
async function waitForLine(
  log: string,
  line: string,
  ms: number
): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const text = await fs.readFile(log, 'utf8').catch(() => '');
    if (text.split('\n').includes(line)) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('openMCPClient', () => {
  it('connects as createMCPClientForConfig does when the signal is not aborted', async () => {
    const controller = new AbortController();
    const client = await openMCPClient(
      readyStdioServer(),
      undefined,
      controller.signal
    );
    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: 'tool_1' }],
      });
    } finally {
      await closeMCPClient(client);
    }
  });

  it('closes a stdio server that never answers initialize when aborted, and rejects', async () => {
    const log = await serverLog();
    const controller = new AbortController();
    // No connectTimeoutMs: only the abort ends this connect.
    const opening = openMCPClient(
      readyStdioServer({
        READINESS_LOG: log,
        READINESS_STALL_INITIALIZE: '1',
      }),
      undefined,
      controller.signal
    );
    expect(await waitForLine(log, 'initialize', 5_000)).toBe(true);
    const started = Date.now();
    controller.abort();
    await expect(opening).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    // Its stdin is closed, so the process ends.
    expect(await waitForLine(log, 'closed', 1_000)).toBe(true);
  });

  it('aborts a stalled SSE fallback request before its endpoint event, and rejects', async () => {
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
    const controller = new AbortController();
    const opening = openMCPClient(
      { transport: 'http', serverUrl: 'https://example.test/mcp' },
      undefined,
      controller.signal
    );
    await vi.waitFor(() =>
      expect(requests.map((request) => request.method)).toContain('GET')
    );
    controller.abort();
    await expect(opening).rejects.toThrow();
    const fallback = requests.find((request) => request.method === 'GET');
    expect(fallback?.signal?.aborted).toBe(true);
  });

  it('rejects at once for a signal that is already aborted, launching nothing', async () => {
    const log = await serverLog();
    await expect(
      openMCPClient(
        readyStdioServer({ READINESS_LOG: log }),
        undefined,
        AbortSignal.abort()
      )
    ).rejects.toThrow();
    expect(await waitForLine(log, 'initialize', 300)).toBe(false);
  });
});
