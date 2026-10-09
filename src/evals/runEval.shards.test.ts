import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from './runEval.js';
import { shardOf } from './environments/shardedCollect.js';
import { resetPluginsForTests } from '../plugins/extensions.js';

const mock = (name: string) =>
  fileURLToPath(new URL(`../../tests/mocks/${name}`, import.meta.url));
const CASES = ['alpha', 'bravo', 'charlie', 'delta'];
const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** Four cases, two variants, on the shard-test client, in fork/env/children. */
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-run-shards-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: CASES.map((id) => ({
        id,
        input: id,
        assertions: { containsText: 'then' },
      })),
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'shards',
      plugins: [mock('forkEnvPlugin.ts'), mock('shardTestPlugin.ts')],
      client: 'shard-test/client/probe',
      datasets: ['./cases.json'],
      servers: {},
      variants: [{ name: 'baseline' }, { name: 'candidate' }],
    })
  );
  const outputDir = path.join(dir, 'out');
  const readJson = async <T>(file: string) =>
    JSON.parse(await fs.readFile(file, 'utf8')) as T;
  return {
    outputDir,
    readJson,
    run: (envOptions: Record<string, string>) =>
      runEval({
        configPath,
        rootDir: dir,
        outputDir,
        env: 'fork/env/children',
        envOptions,
      }),
  };
}

interface StoredCase {
  id: string;
  variant: string;
  pass: boolean;
  error?: string;
}

describe('a run in an environment with shards', () => {
  it('collects every variant on shards and gathers one run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    const result = await f.run({ shards: '2' });

    expect(result.summary.metrics).toMatchObject({ passed: 8, total: 8 });
    const run = await f.readJson<{
      environment: Record<string, unknown>;
      phases: unknown;
    }>(path.join(result.outputDir, 'run.json'));
    expect(run.environment).toMatchObject({
      name: 'fork/env/children',
      shards: 2,
    });
    expect(run.phases).toEqual({ collect: 'complete', grade: 'complete' });
    // A complete run becomes the eval's latest.
    await expect(
      fs.stat(path.join(f.outputDir, 'latest.json'))
    ).resolves.toBeDefined();
    const traces = (
      await fs.readdir(path.join(result.outputDir, 'traces'), {
        recursive: true,
      })
    ).filter((name) => name.endsWith('.json'));
    expect(traces).toHaveLength(8);
  }, 60_000);

  it("marks a lost shard's trials missing, not failed, and leaves the run partial", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    const lost = CASES.filter((id) => shardOf(id, 2) === 1);
    expect(lost.length).toBeGreaterThan(0);

    const result = await f.run({ shards: '2', fail: '1' });

    const { cases } = await f.readJson<{ cases: StoredCase[] }>(
      path.join(result.outputDir, 'results.json')
    );
    for (const stored of cases) {
      if (lost.includes(stored.id))
        expect(stored.error).toMatch(
          /^Missing: shard 2 ended before this trial came back \(Couldn't create a machine for shard 2: machine 1 never came up\)\.$/
        );
      else expect(stored).toMatchObject({ pass: true });
    }
    // Missing trials aren't failures: their cases are incomplete, and left
    // out of the counts and the pass rate.
    expect(result.summary.metrics).toMatchObject({
      total: (CASES.length - lost.length) * 2,
      passed: (CASES.length - lost.length) * 2,
      failed: 0,
      passRate: 1,
      incomplete: lost.length * 2,
    });
    const run = await f.readJson<{ phases: unknown }>(
      path.join(result.outputDir, 'run.json')
    );
    expect(run.phases).toEqual({ collect: 'partial', grade: 'complete' });
    await expect(
      fs.stat(path.join(f.outputDir, 'latest.json'))
    ).rejects.toThrow();
  }, 60_000);
});
