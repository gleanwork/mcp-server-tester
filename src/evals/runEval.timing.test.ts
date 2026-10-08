import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { EvalCase } from './datasetTypes.js';
import type {
  DatasetSource,
  ClientDefinition,
  JudgeDefinition,
} from './evalFrameworkTypes.js';

const dirs: string[] = [];
let sequence = 0;

interface TestPlugin extends Plugin {
  clients: Record<string, ClientDefinition>;
  datasetSources: Record<string, DatasetSource>;
  judges: Record<string, JudgeDefinition>;
}
function newTestPlugin(): TestPlugin {
  return {
    meta: { name: 'timing-test-plugin', namespace: 'test' },
    clients: {},
    datasetSources: {},
    judges: {},
  };
}
/** Extensions defined by the current test; evals load it as the `test` plugin. */
let testPlugin = newTestPlugin();

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
});
afterEach(async () => {
  vi.useRealTimers();
  resetPluginsForTests();
  testPlugin = newTestPlugin();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function fixture(
  clientDefinition: Pick<ClientDefinition, 'run' | 'runBatch'>,
  cases: EvalCase[],
  extra: Record<string, unknown> = {}
) {
  const clientName = `timing-client-${sequence++}`;
  const sourceName = `timing-source-${sequence++}`;
  testPlugin.clients[clientName] = {
    schema: z.object({ type: z.string() }),
    evidence: 'structured',
    ...clientDefinition,
  };
  testPlugin.datasetSources[sourceName] = {
    schema: z.object({ type: z.string() }),
    async load() {
      advance(7);
      return { name: 'timing', cases };
    },
  };
  const type = `test/client/${clientName}`;
  const source = `test/dataset/${sourceName}`;
  const root = path.resolve('.mcp-test-results');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'suite-timing-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'timing',
      client: type,
      datasets: [{ type: source }],
      servers: [],
      ...extra,
    })
  );
  return { configPath, rootDir: dir, source, plugins: [testPlugin] };
}

describe('eval wall-clock timing', () => {
  it('counts batch setup and cleanup once across cases, trials, datasets and variants', async () => {
    const judgeKey = `timing-judge-${sequence++}`;
    testPlugin.judges[judgeKey] = {
      schema: z.object({}).passthrough(),
      async evaluate() {
        advance(2);
        return { score: 1 };
      },
    };
    const judgeName = `test/judge/${judgeKey}`;
    const runBatch = vi.fn<NonNullable<ClientDefinition['runBatch']>>(
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
        { id: 'explicit', input: 'A', trials: 2 },
        { id: 'default', input: 'B' },
      ],
      {
        trials: 3,
        judges: [{ type: judgeName }],
        variants: [{ name: 'baseline' }, { name: 'comparison' }],
      }
    );
    const evalConfig = JSON.parse(
      await fs.readFile(f.configPath, 'utf8')
    ) as Record<string, unknown>;
    evalConfig.datasets = [{ type: f.source }, { type: f.source }];
    await fs.writeFile(f.configPath, JSON.stringify(evalConfig));

    const result = await runEval(f);

    expect(runBatch).toHaveBeenCalledTimes(4);
    for (const dataset of result.datasets) {
      expect(dataset.result?.durationMs).toBe(110); // 100 batch + 10 judging.
      expect(dataset.result?.caseResults.map((c) => c.durationMs)).toEqual([
        34, 76,
      ]);
      expect(
        dataset.result?.caseResults.map((c) =>
          c.trialResults?.map((trial) => trial.durationMs)
        )
      ).toEqual([
        [12, 22],
        [32, 42, 2],
      ]);
    }
    expect(
      result.summary.variants.map((variant) => variant.result?.durationMs)
    ).toEqual([220, 220]);
    expect(result.summary.durationMs).toBe(454); // 14 source preparation + 440 execution.
  });

  it('does not add live client trace timing to time already measured by the runner', async () => {
    const f = await fixture(
      {
        async run() {
          advance(30);
          return { finalText: 'OK', events: [], durationMs: 30 };
        },
      },
      [{ id: 'live', input: 'A', trials: 2 }]
    );

    const result = await runEval(f);

    expect(
      result.summary.results[0]?.trialResults?.map((r) => r.durationMs)
    ).toEqual([30, 30]);
    expect(result.summary.results[0]?.durationMs).toBe(60);
    expect(result.datasets[0]?.result?.durationMs).toBe(60);
    expect(result.summary.variants[0]?.result?.durationMs).toBe(60);
    expect(result.summary.durationMs).toBe(67);
  });
});
