import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeRun, runEval } from './runEval.js';
import { shardOf } from './environments/shardedCollect.js';
import { resetPluginsForTests } from '../plugins/extensions.js';

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

const JUDGES = ['grade-test/judge/where', 'grade-test/judge/flaky'];
const PAIRWISE = [
  'grade-test/pairwise-judge/longer',
  'grade-test/pairwise-judge/flaky',
];

/**
 * Four cases and two variants, collected without grading. Each trial has two
 * judges and each case two pairwise judges; the `flaky` ones time out while
 * `flag` exists. Every judge call is logged to `calls`.
 */
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-grade-resume-'));
  dirs.push(dir);
  const writeCases = (judges: string[]) =>
    fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: CASES.map((id) => ({ id, input: id, judges })),
      })
    );
  await writeCases(JUDGES);
  const configPath = path.join(dir, 'eval.json');
  const writeConfig = (pairwiseJudges: string[]) =>
    fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'grade-resume',
        plugins: [
          mock('forkEnvPlugin.ts'),
          mock('shardTestPlugin.ts'),
          mock('gradeTestPlugin.ts'),
        ],
        client: 'shard-test/client/probe',
        datasets: ['./cases.json'],
        servers: {},
        redactStoredResponses: false,
        pairwiseJudges,
        variants: [{ name: 'baseline' }, { name: 'candidate' }],
      })
    );
  await writeConfig(PAIRWISE);
  const secretsFile = path.join(dir, 'secrets.json');
  await fs.writeFile(secretsFile, JSON.stringify({ GRADE_TEST_KEY: KEY }));
  const calls = path.join(dir, 'calls.log');
  const flag = path.join(dir, 'flaky');
  vi.stubEnv('GRADE_TEST_CALLS', calls);
  vi.stubEnv('GRADE_TEST_FLAKY', flag);
  const base = { configPath, rootDir: dir, outputDir: path.join(dir, 'out') };
  const collected = await runEval({ ...base, grade: false });
  return {
    base,
    secretsFile,
    collectedId: path.basename(collected.outputDir),
    writeCases,
    writeConfig,
    flaky: (on: boolean) =>
      on ? fs.writeFile(flag, '') : fs.rm(flag, { force: true }),
    /** The judge calls since the last time, by judge. */
    async takeCalls(): Promise<Record<string, number>> {
      const lines = (await fs.readFile(calls, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean);
      await fs.rm(calls, { force: true });
      const counts: Record<string, number> = {};
      for (const line of lines) {
        const judge = line.split(' ')[0]!;
        counts[judge] = (counts[judge] ?? 0) + 1;
      }
      return counts;
    },
    readRun: async (outputDir: string) =>
      JSON.parse(
        await fs.readFile(path.join(outputDir, 'run.json'), 'utf8')
      ) as Record<string, unknown>,
  };
}

type Graded = Awaited<ReturnType<typeof gradeRun>>;

/** Each trial's judge verdicts and each case's preferences, without timing. */
function verdicts(result: Graded) {
  return {
    trials: result.summary.results
      .map(
        (r) =>
          `${r.variant}/${r.id}: ${r.pass} ${(
            r.scores?.judge?.judgeResults ?? []
          )
            .map((j) => `${j.judgeName}=${j.error ?? j.score}`)
            .join(',')}`
      )
      .sort(),
    pairwise: result.summary.variants
      .flatMap((v) => v.pairwise?.cases ?? [])
      .map(
        (c) =>
          `${c.id}: ${c.preferences.map((p) => `${p.judge}=${p.preference ?? p.error}`).join()}`
      )
      .sort(),
  };
}

describe('mst grade --resume', () => {
  it('runs only the judges and pairwise judges that failed, and keeps every other verdict', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    vi.stubEnv('GRADE_TEST_KEY', KEY);
    await f.flaky(true);
    const first = await gradeRun({ ...f.base, run: f.collectedId });
    // Pairwise judges compare each case in both orders; one that times out
    // doesn't try the second.
    expect(await f.takeCalls()).toEqual({
      where: 8,
      flaky: 8,
      longer: 8,
      'flaky-pairwise': 4,
    });
    expect((await f.readRun(first.outputDir)).phases).toEqual({
      collect: 'complete',
      grade: 'partial',
    });
    expect(
      first.summary.results.every((r) => r.gradingError?.includes('timed out'))
    ).toBe(true);

    await f.flaky(false);
    const resumed = await gradeRun({
      ...f.base,
      run: path.basename(first.outputDir),
      resume: true,
    });
    // Only the judges that timed out ran again.
    expect(await f.takeCalls()).toEqual({ flaky: 8, 'flaky-pairwise': 8 });
    expect(resumed.summary.results.every((r) => r.pass)).toBe(true);
    expect(
      resumed.summary.results.every((r) => r.gradingError === undefined)
    ).toBe(true);
    // The `where` verdicts are the first grading's, as it gave them.
    const where = (result: Graded) =>
      result.summary.results.map(
        (r) => r.scores?.judge?.judgeResults?.[0]?.reasoning
      );
    expect(where(resumed)).toEqual(where(first));
    const pairwise = resumed.summary.variants.find(
      (v) => v.pairwise
    )!.pairwise!;
    expect(pairwise.summary.map((s) => [s.judge, s.errors])).toEqual([
      ['grade-test/pairwise-judge/longer', 0],
      ['grade-test/pairwise-judge/flaky', 0],
    ]);
    const run = await f.readRun(resumed.outputDir);
    expect(run.phases).toEqual({ collect: 'complete', grade: 'complete' });
    expect(run.gradedFrom).toBe(f.collectedId);
    expect(run.resumedGrading).toEqual({
      from: path.basename(first.outputDir),
      reusedTrials: 0,
      gradedTrials: 8,
      reusedComparisons: 0,
      gradedComparisons: 4,
    });

    // A complete grading resumes to the same verdicts, with no judge run.
    const again = await gradeRun({
      ...f.base,
      run: path.basename(resumed.outputDir),
      resume: true,
    });
    expect(await f.takeCalls()).toEqual({});
    expect(verdicts(again)).toEqual(verdicts(resumed));
    expect((await f.readRun(again.outputDir)).resumedGrading).toMatchObject({
      reusedTrials: 8,
      gradedTrials: 0,
      reusedComparisons: 4,
      gradedComparisons: 0,
    });
  }, 60_000);

  it("grades only a lost grade shard's cases, on shards, as a full regrade would", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    const lost = CASES.filter((id) => shardOf(id, 2) === 0);
    expect(lost.length).toBeGreaterThan(0);
    const sharded = {
      secretsFile: f.secretsFile,
      env: 'fork/env/children',
    } as const;
    const partial = await gradeRun({
      ...f.base,
      ...sharded,
      run: f.collectedId,
      envOptions: { shards: '2', fail: '0' },
    });
    await f.takeCalls();
    expect(
      partial.summary.results.filter((r) => r.gradingError).map((r) => r.id)
    ).toEqual(expect.arrayContaining(lost));

    const resumed = await gradeRun({
      ...f.base,
      ...sharded,
      run: path.basename(partial.outputDir),
      envOptions: { shards: '2' },
      resume: true,
    });
    // Both judges of the lost cases' trials, on both variants, and their
    // comparisons; nothing of the cases that came back.
    const n = lost.length;
    expect(await f.takeCalls()).toEqual({
      where: 2 * n,
      flaky: 2 * n,
      longer: 2 * n,
      'flaky-pairwise': 2 * n,
    });
    const run = await f.readRun(resumed.outputDir);
    expect(run.phases).toEqual({ collect: 'complete', grade: 'complete' });
    // Only the shard that holds the lost cases ran.
    const machines = (
      run.grading as { environment: { machines: Array<{ shard: number }> } }
    ).environment.machines;
    expect(machines.map((m) => m.shard)).toEqual([1]);

    vi.stubEnv('GRADE_TEST_KEY', KEY);
    const full = await gradeRun({ ...f.base, run: f.collectedId });
    expect(verdicts(resumed)).toEqual(verdicts(full));
  }, 90_000);

  it('runs no grade shard when nothing is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    vi.stubEnv('GRADE_TEST_KEY', KEY);
    const graded = await gradeRun({ ...f.base, run: f.collectedId });
    await f.takeCalls();
    const resumed = await gradeRun({
      ...f.base,
      secretsFile: f.secretsFile,
      env: 'fork/env/children',
      envOptions: { shards: '2', fail: '0' },
      run: path.basename(graded.outputDir),
      resume: true,
    });
    expect(await f.takeCalls()).toEqual({});
    expect(verdicts(resumed)).toEqual(verdicts(graded));
    const run = await f.readRun(resumed.outputDir);
    expect(run.phases).toEqual({ collect: 'complete', grade: 'complete' });
    expect(run.grading).toMatchObject({ environment: { shards: 2 } });
  }, 60_000);

  it('refuses when the judges or the cases changed since the grading, and for a run never graded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    vi.stubEnv('GRADE_TEST_KEY', KEY);
    await expect(
      gradeRun({ ...f.base, run: f.collectedId, resume: true })
    ).rejects.toThrow(/was never graded, so there is no grading to resume/);
    const graded = path.basename(
      (await gradeRun({ ...f.base, run: f.collectedId })).outputDir
    );

    await f.writeConfig(PAIRWISE.slice(0, 1));
    await expect(
      gradeRun({ ...f.base, run: graded, resume: true })
    ).rejects.toThrow(
      /judges or their options changed since run .* was graded.*without --resume/
    );
    await f.writeConfig(PAIRWISE);

    await f.writeCases(JUDGES.slice(0, 1));
    await expect(
      gradeRun({ ...f.base, run: graded, resume: true })
    ).rejects.toThrow(/Dataset "cases" changed since run .* was graded/);
  }, 60_000);

  it("resumes a run graded before judges had an identity, and refuses when a judge's identity changed", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    vi.stubEnv('GRADE_TEST_KEY', KEY);
    const graded = (await gradeRun({ ...f.base, run: f.collectedId }))
      .outputDir;
    const runFile = path.join(graded, 'run.json');
    const run = JSON.parse(await fs.readFile(runFile, 'utf8'));
    const judges = run.judges as Array<Record<string, unknown>>;
    expect(judges.length).toBeGreaterThan(0);
    for (const judge of judges)
      expect(judge.identity).toMatch(/^[0-9a-f]{64}$/);

    // A run that an earlier MST graded records no identities.
    const withoutIdentity = judges.map(
      ({ identity: _identity, ...rest }) => rest
    );
    await fs.writeFile(
      runFile,
      JSON.stringify({ ...run, judges: withoutIdentity })
    );
    await gradeRun({ ...f.base, run: path.basename(graded), resume: true });

    // The same judges and options, but a judge that grades differently now.
    const changed = judges.map((judge, index) =>
      index === 0 ? { ...judge, identity: '0'.repeat(64) } : judge
    );
    await fs.writeFile(runFile, JSON.stringify({ ...run, judges: changed }));
    await expect(
      gradeRun({ ...f.base, run: path.basename(graded), resume: true })
    ).rejects.toThrow(
      /A judge changed since run .* was graded \(its version, its plugin's version or its options' defaults\).*without --resume/
    );
  }, 60_000);

  it("grades a case judge's trials again when that judge's identity changed", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    vi.stubEnv('GRADE_TEST_KEY', KEY);
    const first = await gradeRun({ ...f.base, run: f.collectedId });
    await f.takeCalls();
    // Case judges aren't in run.json: each verdict records its judge's identity.
    const identityOf = (result: Graded, judge: string) =>
      result.summary.results.map(
        (r) =>
          r.scores?.judge?.judgeResults?.find((j) =>
            j.judgeName?.endsWith(judge)
          )?.judgeIdentity
      );
    const where = identityOf(first, 'where');
    expect(new Set(where).size).toBe(1);
    expect(where[0]).toMatch(/^[0-9a-f]{64}$/);

    // Every stored `where` verdict now says another judge gave it.
    const stale = '0'.repeat(64);
    const files = (
      await fs.readdir(first.outputDir, {
        recursive: true,
        withFileTypes: true,
      })
    ).filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    for (const entry of files) {
      const file = path.join(entry.parentPath, entry.name);
      const text = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, text.replaceAll(where[0]!, stale));
    }

    const resumed = await gradeRun({
      ...f.base,
      run: path.basename(first.outputDir),
      resume: true,
    });
    // Only `where` ran again, on every trial; `flaky` kept its verdicts.
    expect(await f.takeCalls()).toEqual({ where: 8 });
    expect(identityOf(resumed, 'where')).toEqual(where);
    expect(verdicts(resumed)).toEqual(verdicts(first));
  }, 60_000);
});
