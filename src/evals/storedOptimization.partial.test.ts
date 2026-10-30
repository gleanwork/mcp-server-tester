/**
 * An optimization never starts from a baseline missing trials. The use-case
 * fixture's local client always collects every trial, so the stored baseline
 * is read back as partial, as a run whose shards ended early is stored.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { runsDirectory } from './runFormat.js';
import type * as RunFormat from './runFormat.js';
import { startToolOptimization } from './storedOptimization.js';

vi.mock('./runFormat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RunFormat>();
  return {
    ...actual,
    async readRunDirectory(
      ...args: Parameters<typeof actual.readRunDirectory>
    ) {
      const stored = await actual.readRunDirectory(...args);
      if (stored.run.optimization?.role === 'baseline')
        stored.run.phases = { ...stored.run.phases, collect: 'partial' };
      return stored;
    },
  };
});

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/usecases/fixtures'
);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

it('refuses to start from a baseline missing trials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stored-opt-partial-'));
  dirs.push(dir);
  const catalog = path.join(dir, 'docs.json');
  await fs.copyFile(path.join(FIXTURES, 'catalogs', 'docs.json'), catalog);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'triggering',
      cases: [
        {
          id: 'case-0',
          input: 'Find what we know about outage 0',
          assertions: {
            toolsTriggered: { calls: [{ name: 'search', required: true }] },
          },
        },
      ],
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'stored-optimization',
      datasets: ['./cases.json'],
      plugins: [path.join(FIXTURES, 'plugin.mjs')],
      servers: {
        docs: {
          transport: 'stdio',
          command: process.execPath,
          args: [path.join(FIXTURES, 'catalogServer.mjs'), catalog],
        },
      },
      client: 'usecase/client/model',
      clientOptions: { policy: [] },
    })
  );
  await expect(
    startToolOptimization({ evalConfig: { configPath, rootDir: dir } })
  ).rejects.toThrow(
    /baseline run \S+ is missing trials[\s\S]*mst optimize start again/
  );
  // The run is kept, and no optimization was stored.
  const evalDirectory = path.join(
    dir,
    '.mcp-test-results',
    'stored-optimization'
  );
  expect(await fs.readdir(runsDirectory(evalDirectory))).toHaveLength(1);
  await expect(
    fs.readdir(path.join(evalDirectory, 'optimizations'))
  ).rejects.toThrow();
});
