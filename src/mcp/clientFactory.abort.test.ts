/**
 * `openMCPClient` with an `AbortSignal`, against the real SDK: aborting it
 * closes the transport the open has started, even before connect finishes,
 * and the open rejects. The readiness probe aborts it at its deadline.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { closeMCPClient, openMCPClient } from './clientFactory.js';
import {
  readyStdioServer,
  startReadinessHttpServer,
} from '../../tests/mocks/readyServers.js';

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

/**
 * Stubs `fetch` with a server that never answers: every request stalls until
 * its signal aborts. Returns the requests it saw.
 */
function stallEveryRequest(): Array<{
  method: string;
  signal: AbortSignal | null;
}> {
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
  return requests;
}

/**
 * An OAuth provider whose stored token the server refuses, so the transport
 * refreshes it. The refresh is held until `releaseRefresh` runs.
 */
function refreshingProvider(): OAuthClientProvider {
  let tokens = {
    access_token: 'old',
    token_type: 'Bearer',
    refresh_token: 'refresh',
    issuer: 'https://auth.test',
  };
  const provider = {
    redirectUrl: 'https://client.test/callback',
    clientMetadata: {
      redirect_uris: ['https://client.test/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    },
    async tokens() {
      return tokens;
    },
    async clientInformation() {
      return { client_id: 'test-client', issuer: 'https://auth.test' };
    },
    async saveTokens(next: typeof tokens) {
      tokens = next;
    },
    async discoveryState() {
      return {
        authorizationServerUrl: 'https://auth.test',
        resourceMetadata: {
          resource: 'https://example.test/mcp',
          authorization_servers: ['https://auth.test'],
        },
        authorizationServerMetadata: {
          issuer: 'https://auth.test',
          authorization_endpoint: 'https://auth.test/authorize',
          token_endpoint: 'https://auth.test/token',
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        },
      };
    },
    async redirectToAuthorization() {
      throw new Error('unexpected redirect');
    },
    async saveCodeVerifier() {},
    async codeVerifier() {
      return 'test-verifier';
    },
  };
  return provider as unknown as OAuthClientProvider;
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

  it('leaves an HTTP client it opened working after the signal aborts', async () => {
    const server = await startReadinessHttpServer();
    const controller = new AbortController();
    try {
      const client = await openMCPClient(
        { transport: 'http', serverUrl: server.url },
        undefined,
        controller.signal
      );
      try {
        // The open is over, so its signal no longer reaches the requests.
        controller.abort();
        await expect(client.listTools()).resolves.toMatchObject({
          tools: [{ name: 'tool_1' }],
        });
      } finally {
        await closeMCPClient(client);
      }
    } finally {
      await server.close();
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

  it('starts no SSE fallback after an abort during a stalled Streamable HTTP initialize', async () => {
    const requests = stallEveryRequest();
    const controller = new AbortController();
    const opening = openMCPClient(
      { transport: 'http', serverUrl: 'https://example.test/mcp' },
      undefined,
      controller.signal
    );
    await vi.waitFor(() =>
      expect(requests.map((request) => request.method)).toEqual(['POST'])
    );
    controller.abort(new Error('stop opening'));
    await expect(opening).rejects.toThrow('stop opening');
    // Time for a fallback to start, if one were going to.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requests.map((request) => request.method)).toEqual(['POST']);
    expect(requests[0]!.signal?.aborted).toBe(true);
  });

  it('leaves no request open when an SSE OAuth refresh finishes after the abort', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let releaseRefresh!: () => void;
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshStarted!: () => void;
    const refreshing = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    // Each request to the MCP server, and the signal it was sent with.
    const requests: Array<{ method: string; signal: AbortSignal | null }> = [];
    let gets = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = String(input);
        if (url === 'https://auth.test/token') {
          refreshStarted();
          await refreshHeld;
          return Response.json({
            access_token: 'new',
            token_type: 'Bearer',
            refresh_token: 'refresh',
          });
        }
        const method = init.method ?? 'GET';
        const signal = init.signal ?? null;
        requests.push({ method, signal });
        // No Streamable HTTP, so the open falls back to SSE.
        if (method === 'POST') return new Response('', { status: 405 });
        // The first SSE GET is refused, which starts the refresh.
        if (++gets === 1) return new Response('', { status: 401 });
        // Any later GET stalls until its signal aborts.
        return new Promise<Response>((_, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      })
    );
    try {
      const controller = new AbortController();
      const opening = openMCPClient(
        { transport: 'http', serverUrl: 'https://example.test/mcp' },
        { authProvider: refreshingProvider() },
        controller.signal
      );
      await refreshing;
      controller.abort(new Error('stop opening'));
      await expect(opening).rejects.toThrow('stop opening');
      // The refresh finishes after the abort, so the SDK restarts the SSE
      // stream itself, past the transport's start().
      releaseRefresh();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const open = requests.filter(
        (request) =>
          request.method === 'GET' && request.signal?.aborted !== true
      );
      expect(open.map((request) => request.method)).toEqual([]);
      expect(requests.map((request) => request.method)).toEqual([
        'POST',
        'GET',
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stops waiting to retry when aborted, and retries no more', async () => {
    // Every request fails on the network, which a retry could help.
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit = {}) => {
        methods.push(init.method ?? 'GET');
        throw new TypeError('fetch failed');
      })
    );
    const controller = new AbortController();
    const opening = openMCPClient(
      {
        transport: 'http',
        serverUrl: 'https://example.test/mcp',
        retryAttempts: 3,
      },
      undefined,
      controller.signal
    );
    // The first attempt tried both transports; the retry waits 1 s.
    await vi.waitFor(() => expect(methods).toEqual(['POST', 'GET']));
    const started = Date.now();
    controller.abort(new Error('stop opening'));
    await expect(opening).rejects.toThrow('stop opening');
    expect(Date.now() - started).toBeLessThan(500);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(methods).toEqual(['POST', 'GET']);
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
