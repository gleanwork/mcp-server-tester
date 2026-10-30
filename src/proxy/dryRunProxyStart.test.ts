import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeStartupFailure,
  TokenFileError,
  type DryRunProxy,
} from './dryRunProxy.js';
import { startDryRunProxy } from './dryRunProxyStart.js';

const ARGS = [
  '--upstream-url',
  'https://mcp.example.com/mcp',
  '--name',
  'glean',
];
const proxy = { connect: async () => {}, close: async () => {} } as DryRunProxy;

describe('startDryRunProxy', () => {
  it('tries a failed upstream connection again, and logs why without the message', async () => {
    const lines: string[] = [];
    const waits: number[] = [];
    let tries = 0;
    const started = await startDryRunProxy(ARGS, {
      log: (line) => lines.push(line),
      sleep: async (ms) => waits.push(ms),
      create: async () => {
        tries += 1;
        if (tries === 1)
          throw new TypeError('fetch failed: Bearer secret-token', {
            cause: Object.assign(new Error('getaddrinfo'), {
              code: 'EAI_AGAIN',
            }),
          });
        return proxy;
      },
    });
    expect(started).toEqual({ kind: 'started', proxy });
    expect(waits).toEqual([2000]);
    expect(lines).toEqual([
      'dry-run proxy glean: cannot connect to the upstream MCP server (TypeError EAI_AGAIN); trying again in 2 s',
    ]);
    expect(lines.join('\n')).not.toContain('secret-token');
  });

  it('waits for a token file that is not there yet', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-dry-run-start-'));
    const file = join(dir, 'token.json');
    const lines: string[] = [];
    try {
      const started = await startDryRunProxy([...ARGS, '--token-file', file], {
        log: (line) => lines.push(line),
        sleep: async () =>
          fs.writeFile(file, JSON.stringify({ version: 1, accessToken: 't' })),
        create: async () => proxy,
      });
      expect(started.kind).toBe('started');
      expect(lines).toEqual([
        'dry-run proxy glean: cannot connect to the upstream MCP server (Cannot read the token file.); trying again in 2 s',
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('gives up after the last try, and fails bad arguments at once', async () => {
    const lines: string[] = [];
    const failed = await startDryRunProxy(ARGS, {
      log: (line) => lines.push(line),
      sleep: async () => {},
      create: async () => {
        throw Object.assign(new Error('Unauthorized: body'), { code: 401 });
      },
    });
    expect(failed).toEqual({ kind: 'failed' });
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toBe(
      'dry-run proxy glean: cannot connect to the upstream MCP server (Error HTTP 401)'
    );
    let created = false;
    const usage = await startDryRunProxy(['--name', 'glean'], {
      log: () => {},
      create: async () => ((created = true), proxy),
    });
    expect(usage).toEqual({
      kind: 'usage',
      message: '--upstream-url and --name are required.',
    });
    expect(created).toBe(false);
  });
});

describe('describeStartupFailure', () => {
  it('names MST token-file errors, and never repeats another message', () => {
    expect(
      describeStartupFailure(new TokenFileError('The token file is malformed.'))
    ).toBe('The token file is malformed.');
    expect(describeStartupFailure(new Error('token=abc'))).toBe('Error');
    expect(describeStartupFailure('x')).toBe('string');
  });
});
