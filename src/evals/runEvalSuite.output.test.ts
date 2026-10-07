/**
 * What a suite prints. Its own file: the runner's warnings are once per
 * process, and vitest isolates files.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMCPClientForConfig } from '../mcp/clientFactory.js';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import { runEvalSuite } from './runEvalSuite.js';

vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(),
  closeMCPClient: vi.fn(async () => {}),
}));
vi.mock('./mcpHost/mcpHostSimulation.js', () => ({ simulateMCPHost: vi.fn() }));

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('suite output', () => {
  it('prints no reporter hint, and the iterations warning once across arms', async () => {
    vi.mocked(createMCPClientForConfig).mockResolvedValue({
      listTools: vi.fn(async () => ({ tools: [] })),
    } as unknown as Awaited<ReturnType<typeof createMCPClientForConfig>>);
    vi.mocked(simulateMCPHost).mockResolvedValue({
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
        cases: [{ id: 'weather', mode: 'host', input: 'Weather?', trials: 2 }],
      })
    );
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'output',
        datasets: ['./cases.json'],
        servers: [{ transport: 'http', serverUrl: 'https://example.com/mcp' }],
        client: 'mst',
        clientOptions: { provider: 'anthropic' },
        arms: [{ name: 'a' }, { name: 'b' }],
      })
    );

    await runEvalSuite({
      manifestPath: path.join(dir, 'manifest.json'),
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
