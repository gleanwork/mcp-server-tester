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
  meta: { name: 'env-test-plugin', namespace: 'test' },
  clients: {
    echo: {
      schema: z.object({ type: z.string() }),
      evidence: 'structured',
      async run() {
        return { finalText: 'OK', events: [] };
      },
    },
  },
  environments: {
    vm: {
      schema: z.object({ zone: z.string().optional() }).strict(),
      maxShards: 4,
      async open() {
        throw new Error('MST should not open an environment yet');
      },
    },
  },
};

/** One case on the echo client; `run` runs it with these options. */
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-run-env-'));
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
      name: 'env',
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

describe('runEval environments', () => {
  it('runs in local by default, and run.json says so', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.environment).toEqual({
      name: 'local',
      shards: 1,
      keep: 'never',
      options: {},
    });
    const run = JSON.parse(
      await fs.readFile(path.join(result.outputDir, 'run.json'), 'utf8')
    ) as { environment: Record<string, unknown> };
    expect(run.environment).toMatchObject({
      name: 'local',
      shards: 1,
      platform: process.platform,
    });
    // Defaults aren't recorded.
    expect(run.environment).not.toHaveProperty('keep');
    expect(run.environment).not.toHaveProperty('options');
  });

  it('runs --env local as it runs without --env', async () => {
    const f = await fixture();
    const result = await f.run({ env: 'local', envOptions: { shards: '1' } });
    expect(result.summary.metrics).toMatchObject({ passed: 1, total: 1 });
  });

  it('records the options it was given', async () => {
    const f = await fixture();
    const result = await f.run({ envOptions: { keep: 'failed' } });
    const run = JSON.parse(
      await fs.readFile(path.join(result.outputDir, 'run.json'), 'utf8')
    ) as { environment: Record<string, unknown> };
    expect(run.environment).toMatchObject({ name: 'local', keep: 'failed' });
  });

  it('dry-runs a plugin environment, checking its options', async () => {
    const f = await fixture();
    const result = await f.run({
      dryRun: true,
      env: 'test/env/vm',
      envOptions: { shards: '3', zone: 'eu' },
    });
    expect(result.environment).toEqual({
      name: 'test/env/vm',
      shards: 3,
      keep: 'never',
      options: { zone: 'eu' },
    });
    await expect(
      f.run({ dryRun: true, env: 'test/env/vm', envOptions: { shards: '5' } })
    ).rejects.toThrow('test/env/vm runs at most 4 shards');
  });

  it("doesn't run trials in a plugin environment yet, and writes nothing", async () => {
    const f = await fixture();
    await expect(f.run({ env: 'test/env/vm' })).rejects.toThrow(
      'MST can\'t run trials in "test/env/vm" yet: only the local environment runs them. Use --dry-run to check its options.'
    );
    await expect(fs.stat(f.outputDir)).rejects.toThrow();
  });

  it('checks the environment before a dry run returns', async () => {
    const f = await fixture();
    await expect(
      f.run({ dryRun: true, envOptions: { shards: '2' } })
    ).rejects.toThrow('The local environment runs one shard');
  });
});
