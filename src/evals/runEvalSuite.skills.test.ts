import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMCPClientForConfig } from '../mcp/clientFactory.js';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import { runEvalSuite } from './runEvalSuite.js';

vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(),
  closeMCPClient: vi.fn(async () => {}),
}));
vi.mock('./mcpHost/mcpHostSimulation.js', () => ({ simulateMCPHost: vi.fn() }));

const dirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createMCPClientForConfig).mockResolvedValue({
    listTools: vi.fn(async () => ({ tools: [] })),
  } as unknown as Awaited<ReturnType<typeof createMCPClientForConfig>>);
  vi.mocked(simulateMCPHost).mockResolvedValue({
    success: true,
    response: 'OK',
    toolCalls: [],
  });
});

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function suite(caseOverrides: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-skills-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [
        { id: 'weather', mode: 'host', input: 'Weather?', ...caseOverrides },
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'skills-help',
      datasets: ['./cases.json'],
      servers: [{ transport: 'http', serverUrl: 'https://example.com/mcp' }],
      host: { type: 'mst', provider: 'anthropic' },
      arms: [
        { name: 'off' },
        { name: 'explicit-off', host: { skills: 'off' } },
        { name: 'catalog', host: { skills: 'catalog' } },
        { name: 'preload', host: { skills: 'preload' } },
      ],
    })
  );
  return runEvalSuite({
    manifestPath: path.join(dir, 'manifest.json'),
    rootDir: dir,
  });
}

describe('skills modes as suite arms', () => {
  it("passes each arm's vercel-sdk skills mode to the SDK host", async () => {
    const { summary } = await suite();

    expect(summary.arms.map((arm) => arm.name)).toEqual([
      'off',
      'explicit-off',
      'catalog',
      'preload',
    ]);
    expect(
      vi.mocked(simulateMCPHost).mock.calls.map(([, , config]) => config.skills)
    ).toEqual([undefined, undefined, 'catalog', 'preload']);
  });

  it('rejects a case that sets its own skills mode under an arm that sets one', async () => {
    await expect(
      suite({ mcpHostConfig: { skills: 'catalog' } })
    ).rejects.toThrow(
      /Case "weather" in arm "explicit-off" sets mcpHostConfig\.skills.*set skills on the host or the case, not both/
    );
    expect(simulateMCPHost).not.toHaveBeenCalled();
  });
});
