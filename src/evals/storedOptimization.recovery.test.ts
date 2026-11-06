/**
 * When a step's runEval throws after it stored its run (a result store
 * that couldn't take it, say), the optimization keeps that run rather than
 * collecting the round again. It keeps a run whose every trial was
 * collected, as the step's own result would be, whether or not every judge
 * gave a verdict: a judge without one leaves `phases.grade: partial`, and
 * the step that succeeds keeps such a run too.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type * as RunEvalModule from './runEval.js';
import type * as RunFormat from './runFormat.js';
import { startToolOptimization } from './storedOptimization.js';

vi.mock('./runEval.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RunEvalModule>();
  return {
    ...actual,
    // The run is written, then the step fails.
    async runEval(...args: Parameters<typeof actual.runEval>) {
      await actual.runEval(...args);
      throw new Error('result store: upload failed');
    },
  };
});

vi.mock('./runFormat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RunFormat>();
  return {
    ...actual,
    // As a run whose judge gave no verdict on a settled case is stored.
    async readRunDirectory(
      ...args: Parameters<typeof actual.readRunDirectory>
    ) {
      const stored = await actual.readRunDirectory(...args);
      if (stored.run.optimization?.role === 'baseline')
        stored.run.phases = { ...stored.run.phases, grade: 'partial' };
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
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

it('keeps a stored baseline whose grading is partial when the step then fails', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stored-opt-recover-'));
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
  const started = await startToolOptimization({
    evalConfig: { configPath, rootDir: dir },
  });
  expect(started.record.baseline.runId).toBeDefined();
  expect(warn).toHaveBeenCalledWith(
    expect.stringMatching(
      /keeps run \S+, which is complete, though the step then failed: result store: upload failed/
    )
  );
});
