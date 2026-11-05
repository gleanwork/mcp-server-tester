/**
 * What an eval prints. Its own file: the runner's warnings are once per
 * process, and vitest isolates files.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openMCPClient } from '../mcp/clientFactory.js';
import { runApiClient } from './mstClient/run.js';
import { runEval } from './runEval.js';

vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(),
  // What MST's readiness check opens each server with.
  openMCPClient: vi.fn(),
  closeMCPClient: vi.fn(async () => {}),
}));
vi.mock('./mstClient/run.js', () => ({ runApiClient: vi.fn() }));

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('eval output', () => {
  it('prints no reporter hint, and the trials warning once across variants', async () => {
    // One tool, so MST's readiness check passes.
    vi.mocked(openMCPClient).mockResolvedValue({
      listTools: vi.fn(async () => ({ tools: [{ name: 'weather' }] })),
    } as unknown as Awaited<ReturnType<typeof openMCPClient>>);
    vi.mocked(runApiClient).mockResolvedValue({
      finalText: 'OK',
      events: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-output-'));
    dirs.push(dir);
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: [{ id: 'weather', input: 'Weather?', trials: 2 }],
      })
    );
    await fs.writeFile(
      path.join(dir, 'eval.json'),
      JSON.stringify({
        name: 'output',
        datasets: ['./cases.json'],
        servers: {
          'server-1': {
            transport: 'http',
            serverUrl: 'https://example.com/mcp',
          },
        },
        client: 'api',
        clientOptions: { provider: 'anthropic' },
        variants: [{ name: 'a' }, { name: 'b' }],
      })
    );

    await runEval({
      configPath: path.join(dir, 'eval.json'),
      rootDir: dir,
    });

    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.filter((m) => m.includes('testInfo not provided'))).toEqual(
      []
    );
    expect(
      messages.filter((m) => m.includes('may not be statistically reliable'))
    ).toHaveLength(1);
  });
});
