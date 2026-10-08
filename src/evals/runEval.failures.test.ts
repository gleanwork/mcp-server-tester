import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { ClientDefinition } from './evalFrameworkTypes.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** A two-variant eval on a batch client; `runBatch` decides each batch. */
async function fixture(runBatch: NonNullable<ClientDefinition['runBatch']>) {
  const plugin: Plugin = {
    meta: { name: 'failures-test-plugin', namespace: 'test' },
    clients: {
      batch: {
        schema: z.object({ type: z.string() }),
        evidence: 'structured',
        runBatch,
      },
    },
    datasetSources: {
      cases: {
        schema: z.object({ type: z.string() }),
        async load() {
          return {
            name: 'cases',
            cases: [
              { id: 'one', input: 'A', assertions: { containsText: 'OK' } },
              { id: 'two', input: 'B', assertions: { containsText: 'OK' } },
            ],
          };
        },
      },
    },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-run-failures-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'failures',
      client: 'test/client/batch',
      datasets: [{ type: 'test/dataset/cases' }],
      servers: {},
      variants: [{ name: 'baseline' }, { name: 'candidate' }],
    })
  );
  const outputDir = path.join(dir, 'out');
  return {
    run: () =>
      runEval({ configPath, rootDir: dir, plugins: [plugin], outputDir }),
    async runDirectory() {
      const runs = path.join(outputDir, 'runs');
      const [id] = await fs.readdir(runs);
      return path.join(runs, id!);
    },
  };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

interface StoredCase {
  id: string;
  variant: string;
  pass: boolean;
  error?: string;
  isInfrastructureError?: boolean;
  trialResults?: Array<{ isInfrastructureError?: boolean; error?: string }>;
}

const ok = () => ({ finalText: 'OK', events: [] });

describe('a run that meets failures', () => {
  it('keeps the variants that ran when a later batch fails before its cases', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let batches = 0;
    const f = await fixture(async (requests) => {
      batches += 1;
      if (batches === 2)
        throw new Error('Cowork desktop is locked by another run');
      return requests.map(ok);
    });
    const result = await f.run();
    const runDirectory = await f.runDirectory();
    const run = await readJson<{ phases: unknown }>(
      path.join(runDirectory, 'run.json')
    );
    expect(run.phases).toEqual({ collect: 'complete', grade: 'complete' });
    const { cases } = await readJson<{ cases: StoredCase[] }>(
      path.join(runDirectory, 'results.json')
    );
    expect(
      cases.filter((c) => c.variant === 'baseline').map((c) => c.pass)
    ).toEqual([true, true]);
    const candidate = cases.filter((c) => c.variant === 'candidate');
    expect(candidate).toHaveLength(2);
    for (const c of candidate) {
      expect(c.pass).toBe(false);
      expect(c.error).toContain(
        'Not run: the test/client/batch batch failed before this case ran: Cowork desktop is locked'
      );
    }
    // Infrastructure failures, not failed grades.
    for (const id of ['one', 'two']) {
      const trial = await readJson<{ infrastructureError: boolean }>(
        path.join(runDirectory, 'traces', 'candidate', id, '0.json')
      );
      expect(trial.infrastructureError).toBe(true);
    }
    const baselineTrial = await readJson<{ infrastructureError: boolean }>(
      path.join(runDirectory, 'traces', 'baseline', 'one', '0.json')
    );
    expect(baselineTrial.infrastructureError).toBe(false);
    expect(result.summary.variants.map((v) => v.name)).toEqual([
      'baseline',
      'candidate',
    ]);
  });

  it('saves the run after each variant, while later variants run', async () => {
    let seen: { phases: unknown; variants: string[] } | undefined;
    let batches = 0;
    const f = await fixture(async (requests) => {
      batches += 1;
      if (batches === 2) {
        const runDirectory = await f.runDirectory();
        const run = await readJson<{ phases: unknown }>(
          path.join(runDirectory, 'run.json')
        );
        const { cases } = await readJson<{ cases: StoredCase[] }>(
          path.join(runDirectory, 'results.json')
        );
        seen = {
          phases: run.phases,
          variants: [...new Set(cases.map((c) => c.variant))],
        };
      }
      return requests.map(ok);
    });
    await f.run();
    expect(seen).toEqual({
      phases: { collect: 'partial', grade: 'partial' },
      variants: ['baseline'],
    });
  });

  it('writes what finished, marked failed, when the run stops on an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let batches = 0;
    const f = await fixture(async (requests) => {
      batches += 1;
      // A client that returns fewer traces than requests breaks the contract.
      return batches === 2 ? [] : requests.map(ok);
    });
    await expect(f.run()).rejects.toThrow('incomplete trace set');
    const runDirectory = await f.runDirectory();
    const run = await readJson<{ phases: unknown }>(
      path.join(runDirectory, 'run.json')
    );
    expect(run.phases).toEqual({ collect: 'failed', grade: 'partial' });
    const { cases } = await readJson<{ cases: StoredCase[] }>(
      path.join(runDirectory, 'results.json')
    );
    expect(cases.map((c) => `${c.variant}/${c.id}`)).toEqual([
      'baseline/one',
      'baseline/two',
    ]);
  });
});
