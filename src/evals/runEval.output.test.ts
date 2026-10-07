/**
 * What an eval prints. Its own file: the runner's warnings are once per
 * process, and vitest isolates files.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMCPClientForConfig } from '../mcp/clientFactory.js';
import { simulateMstClient } from './mstClient/simulation.js';
import { runEval } from './runEval.js';

vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(),
  closeMCPClient: vi.fn(async () => {}),
}));
vi.mock('./mstClient/simulation.js', () => ({ simulateMstClient: vi.fn() }));

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('eval output', () => {
  it('prints no reporter hint, and the trials warning once across variants', async () => {
    vi.mocked(createMCPClientForConfig).mockResolvedValue({
      listTools: vi.fn(async () => ({ tools: [] })),
    } as unknown as Awaited<ReturnType<typeof createMCPClientForConfig>>);
    vi.mocked(simulateMstClient).mockResolvedValue({
      success: true,
      response: 'OK',
      toolCalls: [],
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
        servers: [{ transport: 'http', serverUrl: 'https://example.com/mcp' }],
        client: 'mst',
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
