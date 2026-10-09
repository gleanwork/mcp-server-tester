import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resumeRun, runEval } from './runEval.js';
import { shardOf } from './environments/shardedCollect.js';
import { resetPluginsForTests } from '../plugins/extensions.js';

const mock = (name: string) =>
  fileURLToPath(new URL(`../../tests/mocks/${name}`, import.meta.url));
const CASES = ['alpha', 'bravo', 'charlie', 'delta'];
const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** Four cases, two variants, on the shard-test client, in fork/env/children. */
async function fixture({
  redact = true,
  extra = {},
}: { redact?: boolean; extra?: Record<string, unknown> } = {}) {
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
      ...(redact ? {} : { redactStoredResponses: false }),
      ...extra,
    })
  );
  const outputDir = path.join(dir, 'out');
  const readJson = async <T>(file: string) =>
    JSON.parse(await fs.readFile(file, 'utf8')) as T;
  return {
    outputDir,
    readJson,
    resume: (run: string, envOptions?: Record<string, string>) =>
      resumeRun({
        configPath,
        rootDir: dir,
        outputDir,
        run,
        ...(envOptions ? { envOptions } : {}),
      }),
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

  it('--resume collects only the missing trials and completes the run', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture({ redact: false });
    const lost = CASES.filter((id) => shardOf(id, 2) === 1);
    const partial = await f.run({ shards: '2', fail: '1' });
    const runId = path.basename(partial.outputDir);
    log.mockClear();

    // The run's own environment and options, without the failure.
    const resumed = await f.resume(runId, { shards: '2' });

    expect(resumed.outputDir).toBe(partial.outputDir);
    expect(resumed.summary.metrics).toMatchObject({
      total: 8,
      passed: 8,
      failed: 0,
    });
    expect(resumed.summary.metrics).not.toHaveProperty('incomplete');
    // Only the lost shard's trials ran again.
    const collected = log.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => / collected$/.test(line));
    expect(collected).toHaveLength(lost.length * 2);
    for (const line of collected)
      expect(lost.some((id) => line.includes(` ${id} `))).toBe(true);
    const run = await f.readJson<{ phases: unknown; gradedFrom?: string }>(
      path.join(resumed.outputDir, 'run.json')
    );
    expect(run.phases).toEqual({ collect: 'complete', grade: 'complete' });
    expect(run.gradedFrom).toBeUndefined();
    // Complete now, so it is the eval's latest.
    const latest = await f.readJson<{ runId: string }>(
      path.join(f.outputDir, 'latest.json')
    );
    expect(latest.runId).toBe(runId);

    await expect(f.resume(runId)).rejects.toThrow(
      `Run ${runId} has no missing trials: there is nothing to resume.`
    );
  }, 90_000);

  it('keeps run-wide limits across shards', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture({
      extra: {
        model: 'claude-test',
        clientOptions: { delayMs: 300 },
        // One trial at a time on this provider, whatever the shard count.
        limits: { providers: { anthropic: 1 } },
      },
    });
    const log = path.join(path.dirname(f.outputDir), 'trials.log');
    vi.stubEnv('SHARD_TEST_LOG', log);

    const result = await f.run({ shards: '2' });

    expect(result.summary.metrics).toMatchObject({ passed: 8, total: 8 });
    const marks = (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const [event, prompt, at] = line.split(' ');
        return { event, prompt: prompt!, at: Number(at) };
      })
      .sort((a, b) => a.at - b.at || (a.event === 'end' ? -1 : 1));
    let running = 0;
    let most = 0;
    for (const { event } of marks) {
      running += event === 'start' ? 1 : -1;
      most = Math.max(most, running);
    }
    expect(most).toBe(1);
    // Both shards ran trials; the limit only took turns between them.
    const shards = new Set(marks.map(({ prompt }) => shardOf(prompt, 2)));
    expect(shards).toEqual(new Set([0, 1]));
  }, 90_000);

  it("can't resume a run stored redacted, which can't be graded again", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    const partial = await f.run({ shards: '2', fail: '1' });
    await expect(
      f.resume(path.basename(partial.outputDir), { shards: '2' })
    ).rejects.toThrow('stored redacted traces');
  }, 60_000);
});
