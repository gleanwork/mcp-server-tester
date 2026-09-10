import type { EvalExecutionResult } from './hostTrace.js';
import { simulationToHostTrace } from './hostTrace.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEvalSuite } from './runEvalSuite.js';
import {
  registerHost,
  registerDatasetSource,
  registerJudge,
} from './frameworkRegistries.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type { HostRunOptions } from './evalFrameworkTypes.js';

const dirs: string[] = [];
let sequence = 0;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});
async function fixture(
  cases: EvalCase[],
  extra: Record<string, unknown> = {},
  run = vi.fn<(options: HostRunOptions) => Promise<EvalExecutionResult>>(
    async () => ({
      response: { success: true, response: 'WRONG', toolCalls: [] },
    })
  )
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-review-'));
  dirs.push(dir);
  const type = `review-host-${sequence++}`;
  const source = `review-source-${sequence++}`;
  registerHost({
    name: type,
    schema: z
      .object({ type: z.string(), model: z.string().default('default-model') })
      .passthrough(),
    evidence: 'structured',
    async run(input, config, context) {
      const result = await run({
        dataset: { name: 'canonical', cases },
        cases,
        servers: input.servers,
        host: config,
        manifest: context.manifest,
        arm: context.arm,
      });
      return simulationToHostTrace(
        result.response as MCPHostSimulationResult,
        input.servers
      );
    },
  });
  registerDatasetSource({
    name: source,
    schema: z.object({ type: z.string() }),
    async load(): Promise<EvalDataset> {
      return { name: 'canonical', cases };
    },
  });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = {
    name: 'review',
    datasets: [{ type: source }],
    host: { type },
    servers: [],
    ...extra,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { dir, manifestPath, manifest, run, type };
}
const scenario: EvalCase = {
  id: 'same',
  mode: 'mcp_host',
  scenario: 'Find documents',
  mcpHostConfig: { provider: 'anthropic' },
};

describe('suite review regressions', () => {
  it('does not mutate TLS or per-suite environment settings, including dry runs', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '1');
    vi.stubEnv('EVAL_ITERATIONS', 'untouched');
    const f = await fixture([scenario], { iterations: 9, model: 'chosen' });
    await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
      dryRun: true,
    });
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');
    expect(process.env.EVAL_ITERATIONS).toBe('untouched');
    expect(f.run).not.toHaveBeenCalled();
  });
  it('runs text, call-count and registered judge assertions for every custom-host iteration', async () => {
    const judge = vi.fn(async () => ({ score: 0 }));
    const judgeName = `review-judge-${sequence++}`;
    registerJudge({
      name: judgeName,
      schema: z.object({}).passthrough(),
      evaluate: judge,
    });
    const f = await fixture([
      {
        ...scenario,
        iterations: 3,
        expect: {
          containsText: 'EXPECTED',
          toolCallCount: { min: 1 },
          passesJudge: { judge: judgeName },
        },
      },
    ]);
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(judge).toHaveBeenCalledTimes(3);
    expect(result.summary.results[0]?.pass).toBe(false);
    expect(result.summary.results[0]?.iterationResults).toHaveLength(3);
  });
  it('preserves per-case host overrides and iterations for canonical host mode', async () => {
    const alternate = await fixture([scenario]);
    const f = await fixture(
      [
        {
          ...scenario,
          mode: 'host',
          host: { type: alternate.type, model: 'case-model' },
        },
      ],
      { iterations: 2 }
    );
    await runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir });
    expect(f.run).not.toHaveBeenCalled();
    expect(alternate.run).toHaveBeenCalledTimes(2);
    expect(alternate.run.mock.calls[0]?.[0].host.model).toBe('case-model');
  });
  it('applies manifest judges to canonical cases and respects arm judge overrides', async () => {
    const name = `manifest-judge-${sequence++}`;
    const evaluate = vi.fn(async () => ({ score: 0 }));
    registerJudge({ name, schema: z.object({}).passthrough(), evaluate });
    const f = await fixture([scenario], {
      judges: [{ type: name, reference: 'expected' }],
      arms: [{ name: 'judged' }, { name: 'unjudged', judges: [] }],
    });
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.summary.arms.map((arm) => arm.result?.passed)).toEqual([
      0, 1,
    ]);
  });
  it('merges host patches, forwards parsed defaults and computes each arm independently', async () => {
    const f = await fixture([
      { ...scenario, expect: { containsText: 'EXPECTED' } },
    ]);
    f.manifest.host = {
      type: f.type,
      model: 'base',
      retained: 'yes',
    } as typeof f.manifest.host;
    await fs.writeFile(
      f.manifestPath,
      JSON.stringify({
        ...f.manifest,
        metrics: ['passed'],
        arms: [
          { name: 'a' },
          { name: 'b', host: { type: f.type, model: 'variant' } },
        ],
      })
    );
    f.run.mockImplementation(async (options) => ({
      response: {
        success: true,
        response: options.host.model === 'base' ? 'EXPECTED' : 'WRONG',
        toolCalls: [],
      },
    }));
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(f.run.mock.calls.map(([options]) => options.host.model)).toEqual([
      'base',
      'variant',
    ]);
    expect(f.run.mock.calls[1]?.[0].host.retained).toBe('yes');
    expect(result.summary.arms.map((arm) => arm.result?.passed)).toEqual([
      1, 0,
    ]);
    expect(result.summary.arms.map((arm) => arm.metrics?.passed_rate)).toEqual([
      1, 0,
    ]);
  });
  it('maps multiple native tools to a canonical expectation without dropping argument checks', async () => {
    const f = await fixture(
      [
        {
          ...scenario,
          expect: {
            toolsTriggered: {
              calls: [
                {
                  name: 'search',
                  required: true,
                  arguments: { query: 'wanted' },
                },
              ],
            },
          },
        },
      ],
      { toolMap: { search: ['github.search', 'chat.search'] } }
    );
    f.run.mockResolvedValue({
      response: {
        success: true,
        response: 'OK',
        toolCalls: [{ name: 'chat.search', arguments: { query: 'wrong' } }],
      },
    });
    expect(
      (await runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir }))
        .summary.results[0]?.pass
    ).toBe(false);
    f.run.mockResolvedValue({
      response: {
        success: true,
        response: 'OK',
        toolCalls: [{ name: 'github.search', arguments: { query: 'wanted' } }],
      },
    });
    expect(
      (await runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir }))
        .summary.results[0]?.pass
    ).toBe(true);
  });
  it('passes complete labeled server sets but only persists allowlisted unresolved descriptions', async () => {
    vi.stubEnv('REVIEW_TOKEN', 'dummy-secret-do-not-save');
    const f = await fixture([scenario], {
      servers: [
        {
          transport: 'http',
          label: 'one',
          serverUrl: 'https://example.com/eval',
          headers: { 'X-Secret': 'header-secret' },
          auth: { accessTokenEnv: 'REVIEW_TOKEN' },
        },
        {
          transport: 'stdio',
          label: 'two',
          command: 'test',
          args: ['arg-secret'],
          env: { KEY: 'env-secret' },
        },
      ],
    });
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(f.run.mock.calls[0]?.[0].servers).toHaveLength(2);
    const json = await fs.readFile(
      path.join(result.outputDir, 'results.json'),
      'utf8'
    );
    for (const secret of [
      'dummy-secret-do-not-save',
      'header-secret',
      'arg-secret',
      'env-secret',
    ])
      expect(json).not.toContain(secret);
    expect(json).toContain('REVIEW_TOKEN');
  });
});
