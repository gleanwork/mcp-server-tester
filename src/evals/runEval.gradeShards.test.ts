import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeRun, runEval } from './runEval.js';
import { shardOf } from './environments/shardedCollect.js';
import { readRunDirectory } from './runFormat.js';
import { buildRunReport } from './runReport.js';
import packageJson from '../../package.json' with { type: 'json' };
import { resetPluginsForTests } from '../plugins/extensions.js';
import { readJsonFile } from '../utils/jsonFile.js';
import type * as JsonFile from '../utils/jsonFile.js';

// Passes through, so a test can count this process's reads of results.json.
vi.mock('../utils/jsonFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof JsonFile>();
  return { ...actual, readJsonFile: vi.fn(actual.readJsonFile) };
});
const resultsReads = (runId: string) =>
  vi
    .mocked(readJsonFile)
    .mock.calls.filter(([file]) =>
      String(file).endsWith(path.join(runId, 'results.json'))
    ).length;

const mock = (name: string) =>
  fileURLToPath(new URL(`../../tests/mocks/${name}`, import.meta.url));
const CASES = ['alpha', 'bravo', 'charlie', 'delta'];
const KEY = 'grade-key-0123456789';
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
 * Four cases and two variants, collected locally on the shard-test client,
 * then graded by grade-test's judges: in this process, or in
 * fork/env/children, whose machines run `mst grade-shard` in child processes.
 */
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-grade-shards-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: CASES.map((id) => ({
        id,
        input: id,
        judges: ['grade-test/judge/where'],
      })),
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'grade-shards',
      plugins: [
        mock('forkEnvPlugin.ts'),
        mock('shardTestPlugin.ts'),
        mock('gradeTestPlugin.ts'),
      ],
      client: 'shard-test/client/probe',
      datasets: ['./cases.json'],
      servers: {},
      redactStoredResponses: false,
      pairwiseJudges: ['grade-test/pairwise-judge/longer'],
      variants: [{ name: 'baseline' }, { name: 'candidate' }],
    })
  );
  const secretsFile = path.join(dir, 'secrets.json');
  await fs.writeFile(secretsFile, JSON.stringify({ GRADE_TEST_KEY: KEY }));
  const outputDir = path.join(dir, 'out');
  const base = { configPath, rootDir: dir, outputDir };
  const collected = await runEval({ ...base, grade: false });
  const runId = path.basename(collected.outputDir);
  const readJson = async <T>(file: string) =>
    JSON.parse(await fs.readFile(file, 'utf8')) as T;
  return { dir, base, runId, secretsFile, readJson };
}

/** Each trial's verdict, and each case's preference: what grading decided. */
function decisions(result: Awaited<ReturnType<typeof gradeRun>>) {
  return {
    trials: result.summary.results
      .map((r) => `${r.variant}/${r.id}: ${r.pass} ${r.gradingError ?? ''}`)
      .sort(),
    pairwise: result.summary.variants
      .flatMap((v) => v.pairwise?.cases ?? [])
      .map(
        (c) =>
          `${c.id}: ${c.preferences.map((p) => p.preference ?? p.error).join()}`
      )
      .sort(),
  };
}

/** The pids judges reported, from their reasoning. */
function judgePids(result: Awaited<ReturnType<typeof gradeRun>>): Set<string> {
  const reasons = [
    ...result.summary.results.flatMap((r) =>
      Object.values(r.scores ?? {}).map((s) => s?.reasoning ?? '')
    ),
    ...result.summary.variants.flatMap((v) =>
      (v.pairwise?.cases ?? []).flatMap((c) =>
        c.preferences.map((p) => p.reasoning ?? '')
      )
    ),
  ];
  return new Set(reasons.flatMap((r) => r.match(/pid (\d+)/)?.[1] ?? []));
}

describe('mst grade --env (ADR 0005)', () => {
  it("parses the run's results.json once for every shard's bundle, not once per shard", async () => {
    // It can be hundreds of MB: 20 shards parsing it at once ran a
    // coordinator out of memory.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    const reads = async (shards: string) => {
      const before = resultsReads(f.runId);
      await gradeRun({
        ...f.base,
        run: f.runId,
        secretsFile: f.secretsFile,
        env: 'fork/env/children',
        envOptions: { shards },
      });
      return resultsReads(f.runId) - before;
    };
    // The collected run's, for grading and then for the shards' bundles.
    expect(await reads('2')).toBe(2);
    expect(await reads('8')).toBe(2);
  }, 90_000);

  it('grades in shards as a local regrade does, with judges and their keys only on the workers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    vi.stubEnv('GRADE_TEST_KEY', KEY);
    const local = await gradeRun({ ...f.base, run: f.runId });
    vi.unstubAllEnvs();
    // Not in this process's environment: only in the secrets file.
    expect(process.env.GRADE_TEST_KEY).toBeUndefined();

    const sharded = await gradeRun({
      ...f.base,
      run: f.runId,
      secretsFile: f.secretsFile,
      env: 'fork/env/children',
      envOptions: { shards: '2' },
    });
    expect(decisions(sharded)).toEqual(decisions(local));
    expect(decisions(sharded).trials.every((t) => t.includes('true'))).toBe(
      true
    );
    // Every judge ran in a worker, none here.
    const pids = judgePids(sharded);
    expect(pids.size).toBeGreaterThanOrEqual(1);
    expect(pids.has(String(process.pid))).toBe(false);
    // The worker read its key from the secrets file, and sent it back redacted.
    const reasoning = JSON.stringify(sharded.summary.results);
    expect(reasoning).not.toContain(KEY);
    expect(reasoning).toContain('key [REDACTED]');
    const run = await f.readJson<Record<string, unknown>>(
      path.join(sharded.outputDir, 'run.json')
    );
    expect(run.phases).toEqual({ collect: 'complete', grade: 'complete' });
    expect(run.gradedFrom).toBe(f.runId);
    expect(run.grading).toMatchObject({
      environment: { name: 'fork/env/children', shards: 2 },
    });
    const machines = (
      run.grading as {
        environment: { machines: Array<Record<string, unknown>> };
      }
    ).environment.machines;
    // Two shards had cases; every trial and comparison came back.
    expect(machines.map((m) => m.ok)).toEqual([true, true]);
    expect(machines.reduce((n, m) => n + Number(m.graded), 0)).toBe(8 + 4);
    // The report says where the trials were graded; a local regrade's doesn't.
    const report = buildRunReport(await readRunDirectory(sharded.outputDir));
    expect(report.run.gradingEnvironment).toEqual({
      name: 'fork/env/children',
      shards: 2,
      machines: [1, 2].map((shard) => ({ shard, mst: packageJson.version })),
    });
    expect(
      buildRunReport(await readRunDirectory(local.outputDir)).run
        .gradingEnvironment
    ).toBeUndefined();
  }, 60_000);

  it("a shard that never ran leaves its cases' grading missing, and the regrade partial", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    const lost = new Set(CASES.filter((id) => shardOf(id, 2) === 0));
    expect(lost.size).toBeGreaterThan(0);
    const sharded = await gradeRun({
      ...f.base,
      run: f.runId,
      secretsFile: f.secretsFile,
      env: 'fork/env/children',
      envOptions: { shards: '2', fail: '0' },
    });
    for (const result of sharded.summary.results)
      if (lost.has(result.id))
        expect(result.gradingError).toMatch(
          /^error: Missing: grade shard 1 ended before this trial's grading came back \(Couldn't create a machine for shard 1/
        );
      else expect(result.gradingError).toBeUndefined();
    const run = await f.readJson<Record<string, unknown>>(
      path.join(sharded.outputDir, 'run.json')
    );
    expect(run.phases).toEqual({ collect: 'complete', grade: 'partial' });
    const pairwise = sharded.summary.variants.find((v) => v.pairwise)?.pairwise;
    expect(pairwise?.summary[0]).toMatchObject({ errors: lost.size });
  }, 60_000);

  it("a judge key that isn't in the secrets file stops the shard at the judge's preflight", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    // No secrets file: the workers get no key. (Not set here either: a fork
    // machine, unlike a real one, inherits this process's environment. The
    // first test shows the key comes from the secrets file.)
    const sharded = await gradeRun({
      ...f.base,
      run: f.runId,
      env: 'fork/env/children',
      envOptions: { shards: '1' },
    });
    expect(sharded.summary.results.every((r) => r.gradingError)).toBe(true);
    const run = await f.readJson<{
      grading: { environment: { machines: Array<{ reason?: string }> } };
    }>(path.join(sharded.outputDir, 'run.json'));
    expect(run.grading.environment.machines[0]?.reason).toContain(
      "GRADE_TEST_KEY isn't set"
    );
  }, 60_000);

  it("refuses an environment that can't run grade shards, before any shard runs", async () => {
    const f = await fixture();
    await expect(
      gradeRun({
        ...f.base,
        run: f.runId,
        secretsFile: f.secretsFile,
        env: 'grade-test/env/collect-only',
      })
    ).rejects.toThrow(
      "The environment grade-test/env/collect-only can't run grade shards: it runs collect."
    );
  }, 60_000);
});
