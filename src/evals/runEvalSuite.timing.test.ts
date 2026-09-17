import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runEvalSuite } from './runEvalSuite.js';
import {
  registerDatasetSource,
  registerHost,
  registerJudge,
} from './frameworkRegistries.js';
import type { EvalCase } from './datasetTypes.js';
import type { HostDefinition } from './evalFrameworkTypes.js';

const dirs: string[] = [];
let sequence = 0;

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function fixture(
  host: Pick<HostDefinition, 'run' | 'runBatch'>,
  cases: EvalCase[],
  extra: Record<string, unknown> = {}
) {
  const type = `timing-host-${sequence++}`;
  const source = `timing-source-${sequence++}`;
  registerHost({
    name: type,
    schema: z.object({ type: z.string() }),
    evidence: 'structured',
    ...host,
  });
  registerDatasetSource({
    name: source,
    schema: z.object({ type: z.string() }),
    async load() {
      advance(7);
      return { name: 'timing', cases };
    },
  });
  const root = path.resolve('.mcp-test-results');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'suite-timing-'));
  dirs.push(dir);
  const manifestPath = path.join(dir, 'manifest.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      name: 'timing',
      host: { type },
      datasets: [{ type: source }],
      servers: [],
      ...extra,
    })
  );
  return { manifestPath, rootDir: dir, source };
}

describe('suite wall-clock timing', () => {
  it('counts batch setup and cleanup once across cases, iterations, datasets and arms', async () => {
    const judgeName = `timing-judge-${sequence++}`;
    registerJudge({
      name: judgeName,
      schema: z.object({}).passthrough(),
      async evaluate() {
        advance(2);
        return { score: 1 };
      },
    });
    const runBatch = vi.fn<NonNullable<HostDefinition['runBatch']>>(
      async (requests) => {
        advance(20); // Shared setup.
        advance(50); // Concurrent requests: elapsed time is not their sum.
        const traces = requests.map((_, index) => ({
          finalText: 'OK',
          events: [],
          // Missing request timing must not inherit or divide the batch total.
          ...(index < 4 ? { durationMs: (index + 1) * 10 } : {}),
        }));
        advance(30); // Shared cleanup completes before runBatch returns.
        return traces;
      }
    );
    const f = await fixture(
      { runBatch },
      [
        { id: 'explicit', mode: 'host', scenario: 'A', iterations: 2 },
        { id: 'default', mode: 'host', scenario: 'B' },
      ],
      {
        iterations: 3,
        judges: [{ type: judgeName }],
        arms: [{ name: 'baseline' }, { name: 'comparison' }],
      }
    );
    const manifest = JSON.parse(
      await fs.readFile(f.manifestPath, 'utf8')
    ) as Record<string, unknown>;
    manifest.datasets = [{ type: f.source }, { type: f.source }];
    await fs.writeFile(f.manifestPath, JSON.stringify(manifest));

    const result = await runEvalSuite(f);

    expect(runBatch).toHaveBeenCalledTimes(4);
    for (const dataset of result.datasets) {
      expect(dataset.result?.durationMs).toBe(110); // 100 batch + 10 judging.
      expect(dataset.result?.caseResults.map((c) => c.durationMs)).toEqual([
        34, 76,
      ]);
      expect(
        dataset.result?.caseResults.map((c) =>
          c.iterationResults?.map((iteration) => iteration.durationMs)
        )
      ).toEqual([
        [12, 22],
        [32, 42, 2],
      ]);
    }
    expect(result.summary.arms.map((arm) => arm.result?.durationMs)).toEqual([
      220, 220,
    ]);
    expect(result.summary.durationMs).toBe(454); // 14 source preparation + 440 execution.
  });

  it('does not add live host trace timing to time already measured by the runner', async () => {
    const f = await fixture(
      {
        async run() {
          advance(30);
          return { finalText: 'OK', events: [], durationMs: 30 };
        },
      },
      [{ id: 'live', mode: 'host', scenario: 'A', iterations: 2 }]
    );

    const result = await runEvalSuite(f);

    expect(
      result.summary.results[0]?.iterationResults?.map((r) => r.durationMs)
    ).toEqual([30, 30]);
    expect(result.summary.results[0]?.durationMs).toBe(60);
    expect(result.datasets[0]?.result?.durationMs).toBe(60);
    expect(result.summary.arms[0]?.result?.durationMs).toBe(60);
    expect(result.summary.durationMs).toBe(67);
  });
});
