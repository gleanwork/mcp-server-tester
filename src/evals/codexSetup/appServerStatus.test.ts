import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  AppServerFailureError,
  appServerHostToolDisabled,
  appServerServerReady,
  exchangeAppServerStatus,
  probeAppServerStatus,
  StreamJsonlChannel,
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

const initialized = { id: 0, result: {} };
function list(data: unknown[], extra: Record<string, unknown> = {}) {
  return { id: 1, result: { data, nextCursor: null, ...extra } };
}

describe('app-server MCP status exchange', () => {
  it('sends only the allowlisted methods and parses the configured server', async () => {
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
        { name: 'other', tools: {}, authStatus: 'oAuth' },
      ]),
    ]);
    const { servers, hostTools } = await exchangeAppServerStatus(
      channel,
      ['glean', 'absent'],
      ['cua_repl']
    );
    expect(channel.sent.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'mcpServerStatus/list',
    ]);
    expect(servers).toEqual([
      {
        label: 'glean',
        initialized: true,
        toolCount: 2,
        authStatus: 'bearerToken',
      },
      {
        label: 'absent',
        initialized: false,
        toolCount: null,
        authStatus: 'unknown',
      },
    ]);
    expect(hostTools).toEqual({
      unconfiguredServerWithTools: false,
      disabled: [{ label: 'cua_repl', present: false, toolCount: null }],
    });
    expect(appServerHostToolDisabled(hostTools.disabled[0]!)).toBe(true);
    expect(JSON.stringify({ servers, hostTools })).not.toContain('private');
    expect(JSON.stringify(hostTools)).not.toContain('other');
    expect(appServerServerReady(servers[0]!, 'bearerToken')).toBe(true);
    expect(appServerServerReady(servers[0]!, 'unsupported')).toBe(false);
    expect(appServerServerReady(servers[1]!, 'bearerToken')).toBe(false);
  });

  it('maps unknown auth strings and object tool maps safely', async () => {
    const { servers } = await exchangeAppServerStatus(
      new FakeChannel([
        initialized,
        list([{ name: 'glean', tools: { a: {} }, authStatus: 'secret-mode' }]),
      ]),
      ['glean']
    );
    expect(servers[0]).toMatchObject({ toolCount: 1, authStatus: 'unknown' });
    expect(appServerServerReady(servers[0]!, 'bearerToken')).toBe(false);
  });

  it('flags a disabled host server that still lists tools, without tool names', async () => {
    const { hostTools } = await exchangeAppServerStatus(
      new FakeChannel([
        initialized,
        list([
          { name: 'glean', tools: [{}], authStatus: 'bearerToken' },
          {
            name: 'cua_repl',
            tools: [{ name: 'js', description: 'private-desc' }],
          },
          { name: 'idle', tools: [] },
        ]),
      ]),
      ['glean'],
      ['cua_repl']
    );
    expect(hostTools).toEqual({
      unconfiguredServerWithTools: true,
      disabled: [{ label: 'cua_repl', present: true, toolCount: 1 }],
    });
    expect(appServerHostToolDisabled(hostTools.disabled[0]!)).toBe(false);
    expect(JSON.stringify(hostTools)).not.toMatch(/js|private-desc|idle/);
    expect(
      appServerHostToolDisabled({
        label: 'cua_repl',
        present: true,
        toolCount: 0,
      })
    ).toBe(true);
  });

  it.each([
    [
      [{ id: 7, method: 'account/login', params: {} }],
      'server-request-unsupported',
    ],
    [
      [{ id: 0, error: { code: -32601, message: 'no' } }],
      'unsupported-method-or-params',
    ],
    [
      [{ id: 0, error: { code: 1, message: 'HTTP status 401 private' } }],
      'http-auth-error',
    ],
    [[{ id: 0, error: { code: 1, message: 'HTTP 404' } }], 'http-client-error'],
    [[{ id: 0, error: { code: 1, message: 'HTTP 503' } }], 'http-server-error'],
    [[{ id: 0, error: { code: 1, message: 'private detail' } }], 'rpc-error'],
    [['not json'], 'invalid-response'],
    [[{ id: '0', result: {} }], 'invalid-response'],
    [[initialized, list([], { nextCursor: 'more' })], 'invalid-response'],
    [
      [initialized, { id: 1, result: { data: {}, nextCursor: null } }],
      'invalid-response',
    ],
    [
      [
        initialized,
        list([
          { name: 'glean', tools: [] },
          { name: 'glean', tools: [] },
        ]),
      ],
      'invalid-response',
    ],
    [[initialized, list([{ name: 'glean', tools: [1] }])], 'invalid-response'],
    [[initialized, list([{ name: 'glean' }])], 'invalid-response'],
    [
      [initialized, list([{ name: 'cua_repl', tools: 'unknown' }])],
      'invalid-response',
    ],
    [
      [
        initialized,
        list(
          Array.from({ length: 101 }, (_, i) => ({ name: `s${i}`, tools: [] }))
        ),
      ],
      'invalid-response',
    ],
    [[initialized], 'unexpected-eof'],
  ])('fails closed on %j with %s', async (lines, reason) => {
    const channel = new FakeChannel(lines);
    await expect(
      exchangeAppServerStatus(channel, ['glean'], ['cua_repl'])
    ).rejects.toMatchObject({ reason });
    expect(
      channel.sent.every((message) =>
        ['initialize', 'initialized', 'mcpServerStatus/list'].includes(
          String(message.method)
        )
      )
    ).toBe(true);
  });
});

describe('bounded JSONL stream channel', () => {
  function channel(
    limits = { timeoutMs: 1000, lineBytes: 16, totalBytes: 64, rows: 100 }
  ) {
    const input = new PassThrough();
    const output = new PassThrough();
    return {
      input,
      output,
      channel: new StreamJsonlChannel(input, output, limits),
    };
  }

  it('rejects methods outside the allowlist before writing', async () => {
    const { input, channel: jsonl } = channel();
    await expect(jsonl.send({ method: 'thread/start' })).rejects.toMatchObject({
      reason: 'unsupported-method',
    });
    expect(input.read()).toBeNull();
  });

  it('reads split lines and enforces per-line and total limits', async () => {
    const first = channel();
    first.output.write('{"a"');
    first.output.write(':1}\n');
    expect((await first.channel.readLine()).toString()).toBe('{"a":1}');
    first.output.write('x'.repeat(17));
    await expect(first.channel.readLine()).rejects.toMatchObject({
      reason: 'output-limit',
    });
    const total = channel();
    for (let i = 0; i < 6; i++) total.output.write('0123456789012\n');
    await expect(
      (async () => {
        for (;;) await total.channel.readLine();
      })()
    ).rejects.toMatchObject({ reason: 'output-limit' });
  });

  it('times out and reports EOF', async () => {
    const slow = channel({
      timeoutMs: 50,
      lineBytes: 16,
      totalBytes: 64,
      rows: 100,
    });
    await expect(slow.channel.readLine()).rejects.toMatchObject({
      reason: 'timeout',
    });
    const closed = channel();
    closed.output.end();
    await expect(closed.channel.readLine()).rejects.toMatchObject({
      reason: 'unexpected-eof',
    });
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
      const status = await probeAppServerStatus(
        codex,
        { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root },
        ['glean'],
        ['cua_repl']
      );
      expect(status).toEqual({
        status: 'available',
        servers: [
          {
            label: 'glean',
            initialized: true,
            toolCount: 1,
            authStatus: 'bearerToken',
          },
        ],
        hostTools: {
          unconfiguredServerWithTools: false,
          disabled: [{ label: 'cua_repl', present: false, toolCount: null }],
        },
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
