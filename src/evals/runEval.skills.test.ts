import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMCPClientForConfig } from '../mcp/clientFactory.js';
import { simulateMstClient } from './mstClient/simulation.js';
import { runEval } from './runEval.js';

vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(),
  closeMCPClient: vi.fn(async () => {}),
}));
vi.mock('./mstClient/simulation.js', () => ({ simulateMstClient: vi.fn() }));

const dirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createMCPClientForConfig).mockResolvedValue({
    listTools: vi.fn(async () => ({ tools: [] })),
  } as unknown as Awaited<ReturnType<typeof createMCPClientForConfig>>);
  vi.mocked(simulateMstClient).mockResolvedValue({
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

async function evalRun(caseOverrides: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-skills-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [{ id: 'weather', input: 'Weather?', ...caseOverrides }],
    })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'skills-help',
      datasets: ['./cases.json'],
      servers: [{ transport: 'http', serverUrl: 'https://example.com/mcp' }],
      client: 'mst',
      clientOptions: { provider: 'anthropic' },
      variants: [
        { name: 'off' },
        { name: 'explicit-off', clientOptions: { skills: 'off' } },
        { name: 'catalog', clientOptions: { skills: 'catalog' } },
        { name: 'preload', clientOptions: { skills: 'preload' } },
      ],
    })
  );
  return runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
  });
}

describe('skills modes as eval variants', () => {
  it("passes each variant's vercel-sdk skills mode to the SDK client", async () => {
    const { summary } = await evalRun();

    expect(summary.variants.map((variant) => variant.name)).toEqual([
      'off',
      'explicit-off',
      'catalog',
      'preload',
    ]);
    expect(
      vi
        .mocked(simulateMstClient)
        .mock.calls.map(([, , config]) => config.skills)
    ).toEqual([undefined, undefined, 'catalog', 'preload']);
  });
});
