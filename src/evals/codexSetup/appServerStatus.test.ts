import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  AppServerFailureError,
  appServerServerReady,
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
const glean = { name: 'glean', tools: [] };
function status(
  label: string,
  toolCount: number | null,
  authStatus: AppServerAuthStatus = 'bearerToken'
): AppServerServerStatus {
  return { label, initialized: toolCount !== null, toolCount, authStatus };
}

describe('app-server MCP status exchange', () => {
  it('sends only the allowlisted methods and parses configured servers', async () => {
    const channel = new FakeChannel([
      initialized,
      { method: 'notification/progress', params: { private: 'x' } },
      list([
        {
          name: 'glean',
          tools: [{ name: 'search' }, { name: 'read' }],
          authStatus: 'bearerToken',
          private: 'https://private.example/token',
        },
        { name: 'mapped', tools: { a: {} }, authStatus: 'secret-mode' },
        { name: 'other', tools: {}, authStatus: 'oAuth' },
      ]),
    ]);
    const servers = await exchangeAppServerStatus(channel, [
      'glean',
      'mapped',
      'absent',
    ]);
    expect(channel.sent.map((message) => message.method)).toEqual(METHODS);
    expect(servers).toEqual([
      status('glean', 2),
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
    [[initialized, list([], { nextCursor: 'more' })], 'invalid-response'],
    [[initialized, list([], { data: {} })], 'invalid-response'],
    [listed([glean, glean]), 'invalid-response'],
    [listed([{ name: 'glean', tools: [1] }]), 'invalid-response'],
    [listed([{ name: 'glean' }]), 'invalid-response'],
    [
      listed(
        Array.from({ length: 101 }, (_, i) => ({ ...glean, name: `${i}` }))
      ),
      'invalid-response',
    ],
    [[initialized], 'unexpected-eof'],
  ])('fails closed on %j with %s', async (lines, reason) => {
    const channel = new FakeChannel(lines);
    await expect(
      exchangeAppServerStatus(channel, ['glean'])
    ).rejects.toMatchObject({ reason });
    for (const { method } of channel.sent) expect(METHODS).toContain(method);
  });
});

describe('bounded JSONL stream channel', () => {
  function channel(timeoutMs = 1000) {
    const input = new PassThrough();
    const output = new PassThrough();
    const limits = { timeoutMs, lineBytes: 16, totalBytes: 64, rows: 100 };
    const jsonl = new StreamJsonlChannel(input, output, limits);
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

  it('reads split lines and enforces limits, deadline, and EOF', async () => {
    const line = channel();
    line.output.write('{"a"');
    line.output.write(':1}\n');
    expect((await line.jsonl.readLine()).toString()).toBe('{"a":1}');
    line.output.write('x'.repeat(17));
    await line.failure('output-limit');
    const total = channel();
    total.output.write('0123456789012\n'.repeat(6));
    await total.failure('output-limit');
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
  if (m.method === 'mcpServerStatus/list') console.log(JSON.stringify({ id: 1, result: { data: [{ name: 'glean', tools: [{}], authStatus: 'bearerToken' }], nextCursor: null } }));
});
setInterval(() => {}, 1000);
`,
        { mode: 0o700 }
      );
      const result = await probeAppServerStatus(
        codex,
        { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root },
        ['glean']
      );
      expect(result).toEqual({
        status: 'available',
        servers: [status('glean', 1)],
      });
      const missing = await probeAppServerStatus(
        join(root, 'missing'),
        { HOME: root },
        ['glean']
      );
      expect(missing).toEqual({ status: 'unavailable', reason: 'io-error' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
