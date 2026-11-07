import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval, type RunEvalOptions } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

const plugin: Plugin = {
  meta: { name: 'runner-test-plugin', namespace: 'test' },
  clients: {
    echo: {
      schema: z.object({ type: z.string() }),
      evidence: 'structured',
      async run() {
        return { finalText: 'OK', events: [] };
      },
    },
  },
  runners: {
    vm: {
      schema: z.object({ zone: z.string().optional() }).strict(),
      maxShards: 4,
      async open() {
        throw new Error('MST should not open a runner yet');
      },
    },
  },
};

/** One case on the echo client; `run` runs it with these options. */
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-run-runner-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [{ id: 'one', input: 'one', assertions: { containsText: 'OK' } }],
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'runner',
      client: 'test/client/echo',
      datasets: ['./cases.json'],
      servers: {},
    })
  );
  const outputDir = path.join(dir, 'out');
  return {
    outputDir,
    run: (options: Partial<RunEvalOptions> = {}) =>
      runEval({
        configPath,
        rootDir: dir,
        plugins: [plugin],
        outputDir,
        ...options,
      }),
  };
}

describe('runEval runners', () => {
  it('runs in local by default, and run.json says so', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.runner).toEqual({
      name: 'local',
      shards: 1,
      keep: 'never',
      options: {},
    });
    const run = JSON.parse(
      await fs.readFile(path.join(result.outputDir, 'run.json'), 'utf8')
    ) as Record<string, Record<string, unknown>>;
    expect(run.runner).toMatchObject({
      name: 'local',
      shards: 1,
      platform: process.platform,
    });
    expect(run).not.toHaveProperty('environment');
    // Defaults aren't recorded.
    expect(run.runner).not.toHaveProperty('keep');
    expect(run.runner).not.toHaveProperty('options');
  });

  it('runs --runner local as it runs without --runner', async () => {
    const f = await fixture();
    const result = await f.run({
      runner: 'local',
      runnerOptions: { shards: '1' },
    });
    expect(result.summary.metrics).toMatchObject({ passed: 1, total: 1 });
  });

  it('records the options it was given', async () => {
    const f = await fixture();
    const result = await f.run({ runnerOptions: { keep: 'failed' } });
    const run = JSON.parse(
      await fs.readFile(path.join(result.outputDir, 'run.json'), 'utf8')
    ) as { runner: Record<string, unknown> };
    expect(run.runner).toMatchObject({ name: 'local', keep: 'failed' });
  });

  it('dry-runs a plugin runner, checking its options', async () => {
    const f = await fixture();
    const result = await f.run({
      dryRun: true,
      runner: 'test/runner/vm',
      runnerOptions: { shards: '3', zone: 'eu' },
    });
    expect(result.runner).toEqual({
      name: 'test/runner/vm',
      shards: 3,
      keep: 'never',
      options: { zone: 'eu' },
    });
    await expect(
      f.run({
        dryRun: true,
        runner: 'test/runner/vm',
        runnerOptions: { shards: '5' },
      })
    ).rejects.toThrow('test/runner/vm runs at most 4 shards');
  });

  it("stops before writing anything when the runner can't open", async () => {
    const f = await fixture();
    await expect(f.run({ runner: 'test/runner/vm' })).rejects.toThrow(
      'MST should not open a runner yet'
    );
    await expect(fs.stat(f.outputDir)).rejects.toThrow();
  });

  it('checks the runner before a dry run returns', async () => {
    const f = await fixture();
    await expect(
      f.run({ dryRun: true, runnerOptions: { shards: '2' } })
    ).rejects.toThrow('The local runner runs one shard');
  });
});
