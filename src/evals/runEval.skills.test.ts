import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  vi.clearAllMocks();
  // One tool, so MST's readiness check passes.
  vi.mocked(openMCPClient).mockResolvedValue({
    listTools: vi.fn(async () => ({ tools: [{ name: 'weather' }] })),
  } as unknown as Awaited<ReturnType<typeof openMCPClient>>);
  vi.mocked(runApiClient).mockResolvedValue({
    finalText: 'OK',
    events: [],
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
      servers: {
        'server-1': { transport: 'http', serverUrl: 'https://example.com/mcp' },
      },
      client: 'api',
      clientOptions: { provider: 'anthropic' },
      metrics: [
        'skill_loaded',
        'skill_before_tool',
        'skill_verification_failed',
      ],
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
  it('keeps skill metrics through the common result on mst run', async () => {
    vi.mocked(runApiClient).mockImplementation(
      async (_mcp, _input, config) => ({
        finalText: 'OK',
        events: [],
        ...(config.skills
          ? {
              telemetry: {
                skillLoads: [
                  {
                    name: 'weather',
                    uri: 'skill://weather/SKILL.md',
                    server: 'mcp',
                    kind: 'skill',
                    via: config.skills === 'preload' ? 'preload' : 'read_skill',
                    verified: true,
                    afterToolCalls: 0,
                  },
                ],
              },
            }
          : {}),
      })
    );
    const { summary } = await evalRun({ trials: 2 });
    expect(
      summary.variants.map(({ metrics }) => [
        metrics?.skill_loaded_rate,
        metrics?.skill_before_tool_rate,
        metrics?.skill_verification_failed_rate,
      ])
    ).toEqual([
      // An aggregate with no applicable measurement is omitted.
      [undefined, undefined, undefined],
      [undefined, undefined, undefined],
      [1, 1, 0],
      [undefined, undefined, 0],
    ]);
  });

  it("passes each variant's vercel-sdk skills mode to the SDK client", async () => {
    const { summary } = await evalRun();

    expect(summary.variants.map((variant) => variant.name)).toEqual([
      'off',
      'explicit-off',
      'catalog',
      'preload',
    ]);
    expect(
      vi.mocked(runApiClient).mock.calls.map(([, , config]) => config.skills)
    ).toEqual([undefined, undefined, 'catalog', 'preload']);
  });
});
