import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  APP_SERVER_LIMITS,
  AppServerFailureError,
  appServerServerReady,
  appServerTimeoutMs,
  exchangeAppServerStatus,
  probeAppServerStatus,
  StreamJsonlChannel,
  type AppServerAuthStatus,
  type AppServerServerStatus,
  type JsonlChannel,
} from './appServerStatus.js';

class FakeChannel implements JsonlChannel {
  sent: Array<Record<string, unknown>> = [];
  constructor(private readonly lines: unknown[]) {}
  async send(message: Record<string, unknown>) {
    this.sent.push(message);
  }
  async readLine() {
    if (!this.lines.length) throw new AppServerFailureError('unexpected-eof');
    const line = this.lines.shift();
    return Buffer.from(typeof line === 'string' ? line : JSON.stringify(line));
  }
}

const METHODS = ['initialize', 'initialized', 'mcpServerStatus/list'];
const initialized = { id: 0, result: {} };
function list(data: unknown[], extra: Record<string, unknown> = {}) {
  return { id: 1, result: { data, nextCursor: null, ...extra } };
}
function rpcError(message: string, code = 1) {
  return [{ id: 0, error: { code, message } }];
}
function listed(data: unknown[]) {
  return [initialized, list(data)];
}
const acme = { name: 'acme', tools: [] };
function status(
  label: string,
  toolCount: number | null,
  authStatus: AppServerAuthStatus = 'bearerToken'
): AppServerServerStatus {
  return { label, initialized: toolCount !== null, toolCount, authStatus };
}

describe('app-server MCP status exchange', () => {
  it('follows every status page, so the server count is never capped', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      name: `s${i}`,
      tools: [{ name: 'search' }],
      authStatus: 'bearerToken',
    }));
    const channel = new FakeChannel([
      initialized,
      list(rows.slice(0, 100), { nextCursor: 'page-2' }),
      { id: 2, result: { data: rows.slice(100), nextCursor: null } },
    ]);
    const servers = await exchangeAppServerStatus(channel, ['s0', 's149']);
    expect(servers).toEqual([status('s0', 1), status('s149', 1)]);
    const lists = channel.sent.filter(
      (message) => message.method === 'mcpServerStatus/list'
    );
    expect(
      lists.map((message) => (message.params as { cursor: unknown }).cursor)
    ).toEqual([null, 'page-2']);
  });

  it('sends only the allowlisted methods and parses configured servers', async () => {
    const channel = new FakeChannel([
      initialized,
      { method: 'notification/progress', params: { private: 'x' } },
      list([
        {
          name: 'acme',
          tools: [{ name: 'search' }, { name: 'read' }],
          authStatus: 'bearerToken',
          private: 'https://private.example/token',
        },
        { name: 'mapped', tools: { a: {} }, authStatus: 'secret-mode' },
        { name: 'other', tools: {}, authStatus: 'oAuth' },
      ]),
    ]);
    const servers = await exchangeAppServerStatus(channel, [
      'acme',
      'mapped',
      'absent',
    ]);
    expect(channel.sent.map((message) => message.method)).toEqual(METHODS);
    expect(servers).toEqual([
      status('acme', 2),
      // Unknown auth strings and object tool maps map safely.
      status('mapped', 1, 'unknown'),
      status('absent', null, 'unknown'),
    ]);
    expect(JSON.stringify(servers)).not.toContain('private');
    expect(appServerServerReady(servers[0]!, 'bearerToken')).toBe(true);
    expect(appServerServerReady(servers[0]!, 'unsupported')).toBe(false);
    for (const server of servers.slice(1))
      expect(appServerServerReady(server, 'bearerToken')).toBe(false);
  });

  it.each([
    [[{ id: 7, method: 'account/login' }], 'server-request-unsupported'],
    [rpcError('no', -32601), 'unsupported-method-or-params'],
    [rpcError('HTTP status 401 private'), 'http-auth-error'],
    [rpcError('HTTP 404'), 'http-client-error'],
    [rpcError('HTTP 503'), 'http-server-error'],
    [rpcError('private detail'), 'rpc-error'],
    [['not json'], 'invalid-response'],
    [[{ id: '0', result: {} }], 'invalid-response'],
    [[initialized, list([], { nextCursor: 'more' })], 'unexpected-eof'],
    [[initialized, list([], { nextCursor: 7 })], 'invalid-response'],
    [
      [
        initialized,
        list([], { nextCursor: 'a' }),
        { id: 2, result: { data: [], nextCursor: 'a' } },
      ],
      'invalid-response',
    ],
    [[initialized, list([], { data: {} })], 'invalid-response'],
    [listed([acme, acme]), 'invalid-response'],
    [listed([{ name: 'acme', tools: [1] }]), 'invalid-response'],
    [listed([{ name: 'acme' }]), 'invalid-response'],
    [[initialized], 'unexpected-eof'],
  ])('fails closed on %j with %s', async (lines, reason) => {
    const channel = new FakeChannel(lines);
    await expect(
      exchangeAppServerStatus(channel, ['acme'])
    ).rejects.toMatchObject({ reason });
    for (const { method } of channel.sent) expect(METHODS).toContain(method);
  });
});

describe('bounded JSONL stream channel', () => {
  function channel(timeoutMs = 1000) {
    const input = new PassThrough();
    const output = new PassThrough();
    const jsonl = new StreamJsonlChannel(input, output, timeoutMs);
    const failure = (reason: string) =>
      expect(jsonl.readLine()).rejects.toMatchObject({ reason });
    return { input, output, jsonl, failure };
  }

  it('rejects methods outside the allowlist before writing', async () => {
    const { input, jsonl } = channel();
    await expect(jsonl.send({ method: 'thread/start' })).rejects.toMatchObject({
      reason: 'unsupported-method',
    });
    expect(input.read()).toBeNull();
  });

  it('reads one status line as large as many connectors report', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const jsonl = new StreamJsonlChannel(input, output);
    // Seven real connectors list ~600 KB of tool schemas in one line.
    const row = `{"data":"${'x'.repeat(1024 * 1024)}"}`;
    output.write(`${row}\n`);
    expect((await jsonl.readLine()).length).toBe(row.length);
  });

  it('reads large output past any fixed byte budget', async () => {
    const { output, jsonl } = channel();
    const line = 'y'.repeat(64 * 1024);
    for (let i = 0; i < 128; i++) output.write(`${line}\n`); // 8 MB total
    for (let i = 0; i < 128; i++)
      expect((await jsonl.readLine()).length).toBe(line.length);
  });

  it('scales the deadline with the configured servers', () => {
    expect(appServerTimeoutMs(8)).toBeGreaterThan(appServerTimeoutMs(1));
    expect(appServerTimeoutMs(8) - appServerTimeoutMs(1)).toBe(
      7 * APP_SERVER_LIMITS.perServerTimeoutMs
    );
  });

  it('reads split lines and enforces the deadline and EOF', async () => {
    const line = channel();
    line.output.write('{"a"');
    line.output.write(':1}\n');
    expect((await line.jsonl.readLine()).toString()).toBe('{"a":1}');
    await channel(50).failure('timeout');
    const closed = channel();
    closed.output.end();
    await closed.failure('unexpected-eof');
  });
});

describe('app-server process probe', () => {
  it('runs the native binary, returns sanitized status, and stops its group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mst-app-server-'));
    try {
      const codex = join(root, 'codex.cjs');
      await writeFile(
        codex,
        `#!/usr/bin/env node
if (process.argv[2] !== 'app-server') process.exit(2);
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') console.log(JSON.stringify({ id: 0, result: { userAgent: 'private' } }));
  if (m.method === 'mcpServerStatus/list') console.log(JSON.stringify({ id: 1, result: { data: [{ name: 'acme', tools: [{}], authStatus: 'bearerToken' }], nextCursor: null } }));
});
setInterval(() => {}, 1000);
`,
        { mode: 0o700 }
      );
      const result = await probeAppServerStatus(
        codex,
        { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root },
        ['acme']
      );
      expect(result).toEqual({
        status: 'available',
        servers: [status('acme', 1)],
      });
      const missing = await probeAppServerStatus(
        join(root, 'missing'),
        { HOME: root },
        ['acme']
      );
      expect(missing).toEqual({ status: 'unavailable', reason: 'io-error' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
