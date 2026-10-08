import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { ClientUnavailableError } from './clientUnavailable.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { ClientDefinition } from './evalFrameworkTypes.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/**
 * A two-variant eval on a batch client; `runBatch` decides each batch. With
 * `datasets: 2`, each variant runs two datasets (one batch each).
 */
async function fixture(
  runBatch: NonNullable<ClientDefinition['runBatch']>,
  { datasets = 1, judgeError }: { datasets?: number; judgeError?: string } = {}
) {
  const plugin: Plugin = {
    meta: { name: 'failures-test-plugin', namespace: 'test' },
    judges: {
      flaky: {
        schema: z.object({}).passthrough(),
        async evaluate() {
          if (judgeError) throw new Error(judgeError);
          return { score: 1 };
        },
      },
    },
    clients: {
      batch: {
        schema: z.object({ type: z.string() }),
        evidence: 'structured',
        runBatch,
      },
    },
    datasetSources: {
      cases: {
        schema: z.object({ type: z.string(), suffix: z.string() }),
        async load(config) {
          const { suffix } = config as unknown as { suffix: string };
          return {
            name: `cases${suffix}`,
            cases: ['one', 'two'].map((id) => ({
              id: `${id}${suffix}`,
              input: id,
              assertions: { containsText: 'OK' },
            })),
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
      datasets: Array.from({ length: datasets }, (_, index) => ({
        type: 'test/dataset/cases',
        suffix: index ? `-${index + 1}` : '',
      })),
      servers: {},
      variants: [{ name: 'baseline' }, { name: 'candidate' }],
      ...(judgeError ? { judges: [{ type: 'test/judge/flaky' }] } : {}),
    })
  );
  const outputDir = path.join(dir, 'out');
  const runsDir = path.join(outputDir, 'runs');
  return {
    run: () =>
      runEval({ configPath, rootDir: dir, plugins: [plugin], outputDir }),
    async runDirectory() {
      const [id] = await fs.readdir(runsDir);
      return path.join(runsDir, id!);
    },
    async runCount() {
      return (await fs.readdir(runsDir).catch(() => [])).length;
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
}

async function storedRun(runDirectory: string) {
  const run = await readJson<{
    phases: unknown;
    variants: Array<{ name: string }>;
  }>(path.join(runDirectory, 'run.json'));
  const { cases } = await readJson<{ cases: StoredCase[] }>(
    path.join(runDirectory, 'results.json')
  );
  return { run, cases };
}

const ok = () => ({ finalText: 'OK', events: [] });

describe('a run that meets failures', () => {
  it('records an unavailable client as infrastructure failures and goes on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let batches = 0;
    const f = await fixture(async (requests) => {
      batches += 1;
      if (batches === 2)
        throw new ClientUnavailableError(
          'Cowork desktop is locked by another run'
        );
      return requests.map(ok);
    });
    const result = await f.run();
    const runDirectory = await f.runDirectory();
    const { run, cases } = await storedRun(runDirectory);
    expect(run.phases).toEqual({ collect: 'complete', grade: 'complete' });
    expect(
      cases.filter((c) => c.variant === 'baseline').map((c) => c.pass)
    ).toEqual([true, true]);
    const candidate = cases.filter((c) => c.variant === 'candidate');
    expect(candidate).toHaveLength(2);
    for (const c of candidate) {
      expect(c.pass).toBe(false);
      expect(c.error).toBe(
        'Not run: the test/client/batch client was unavailable: Cowork desktop is locked by another run'
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

  it('never stores a credential from an unavailable client', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MST_TEST_TOKEN', 'sk-SECRET123');
    const f = await fixture(async () => {
      throw new ClientUnavailableError('no desktop for token=sk-SECRET123');
    });
    await f.run();
    const { cases } = await storedRun(await f.runDirectory());
    expect(cases[0]?.error).toBe(
      'Not run: the test/client/batch client was unavailable: no desktop for token=[REDACTED]'
    );
    expect(JSON.stringify(cases)).not.toContain('sk-SECRET123');
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('sk-SECRET123')
    );
  });

  it('stops on any other client error, keeping the variants that finished', async () => {
    let batches = 0;
    const f = await fixture(async (requests) => {
      batches += 1;
      if (batches === 2) throw new Error('invalid client option: model');
      return requests.map(ok);
    });
    await expect(f.run()).rejects.toThrow('invalid client option: model');
    const { run, cases } = await storedRun(await f.runDirectory());
    expect(run.phases).toEqual({ collect: 'failed', grade: 'partial' });
    expect(run.variants.map((v) => v.name)).toEqual(['baseline']);
    expect(cases.map((c) => `${c.variant}/${c.id}`)).toEqual([
      'baseline/one',
      'baseline/two',
    ]);
  });

  it('leaves out the cases of a variant that failed partway', async () => {
    let batches = 0;
    const f = await fixture(
      async (requests) => {
        batches += 1;
        // The candidate's second dataset breaks the contract: fewer traces.
        return batches === 4 ? [] : requests.map(ok);
      },
      { datasets: 2 }
    );
    await expect(f.run()).rejects.toThrow('incomplete trace set');
    const { run, cases } = await storedRun(await f.runDirectory());
    expect(run.phases).toEqual({ collect: 'failed', grade: 'partial' });
    expect(run.variants.map((v) => v.name)).toEqual(['baseline']);
    expect(new Set(cases.map((c) => c.variant))).toEqual(new Set(['baseline']));
    expect(cases).toHaveLength(4);
  });

  it('writes no run when nothing finished', async () => {
    const f = await fixture(async () => {
      throw new Error('invalid client option: model');
    });
    await expect(f.run()).rejects.toThrow('invalid client option: model');
    expect(await f.runCount()).toBe(0);
  });

  it('leaves a trial a judge failed on ungraded, not failed', async () => {
    const f = await fixture(async (requests) => requests.map(ok), {
      judgeError: 'Cannot find package @anthropic-ai/sdk',
    });
    const result = await f.run();
    const runDirectory = await f.runDirectory();
    const { run, cases } = await storedRun(runDirectory);
    // A regrade would finish these.
    expect(run.phases).toEqual({ collect: 'complete', grade: 'partial' });
    expect(cases[0]?.error).toBe(
      'Not graded: judge: Judge "test/judge/flaky" error: Cannot find package @anthropic-ai/sdk'
    );
    const trial = await readJson<{ infrastructureError: boolean }>(
      path.join(runDirectory, 'traces', 'baseline', 'one', '0.json')
    );
    expect(trial.infrastructureError).toBe(true);
    // The other graders' scores, and the judge's error, are kept.
    const graders = await fs.readdir(path.join(runDirectory, 'scores'));
    expect(graders.sort()).toEqual(
      ['textContains', 'judge.test/judge/flaky'].map(encodeURIComponent).sort()
    );
    // Out of the pass rate: no trial was graded.
    const baseline = result.summary.variants[0]!;
    expect(baseline.result?.caseResults.every((c) => !c.pass)).toBe(true);
    expect(baseline.metrics).toEqual({});
  });

  it('saves the run after each variant, while later variants run', async () => {
    let seen: { phases: unknown; variants: string[] } | undefined;
    let batches = 0;
    const f = await fixture(async (requests) => {
      batches += 1;
      if (batches === 2) {
        const { run, cases } = await storedRun(await f.runDirectory());
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
});
