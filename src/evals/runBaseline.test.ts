import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resolveConfigPath } from './evalConfig.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';

const dirs: string[] = [];
afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-baseline-'));
  dirs.push(dir);
  return dir;
}

describe('resolveManifestPath', () => {
  it('looks next to the eval config, then in rootDir, and defaults to the eval config', async () => {
    const configDir = await tempDir();
    const rootDir = await tempDir();
    await fs.writeFile(path.join(configDir, 'here.json'), '{}');
    await fs.writeFile(path.join(rootDir, 'there.json'), '{}');
    const dirsOf = { configDir, rootDir };
    expect(resolveConfigPath('here.json', dirsOf)).toBe(
      path.join(configDir, 'here.json')
    );
    expect(resolveConfigPath('there.json', dirsOf)).toBe(
      path.join(rootDir, 'there.json')
    );
    expect(resolveConfigPath('store', dirsOf)).toBe(
      path.join(configDir, 'store')
    );
    expect(resolveConfigPath('/abs/x', dirsOf)).toBe('/abs/x');
  });
});

/** A client that passes a case when its scenario mentions the current outcome. */
function plugin(pass: () => Set<string>): Plugin {
  return {
    meta: { name: 'baseline-test', namespace: 'base' },
    clients: {
      fixed: {
        schema: z.object({ type: z.string() }).passthrough(),
        evidence: 'structured',
        run: async (input) => ({
          finalText: pass().has(input.prompt) ? 'yes' : 'no',
          events: [],
        }),
      },
    },
  };
}

describe('a run is compared with the previous run of the same eval config', () => {
  it('finds it in the result store, ignoring other eval configs that share the store', async () => {
    const root = await tempDir();
    const evalRun = path.join(root, 'suite');
    await fs.mkdir(evalRun);
    await fs.writeFile(
      path.join(evalRun, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: ['a', 'b'].map((id) => ({
          id,
          input: id,
          assertions: { containsText: 'yes' },
        })),
      })
    );
    const evalConfig = (name: string) => ({
      name,
      datasets: ['./cases.json'],
      client: 'base/client/fixed',
      // Relative to the eval config, not to rootDir.
      results: { store: { type: 'file', dir: './store' } },
    });
    await fs.writeFile(
      path.join(evalRun, 'one.json'),
      JSON.stringify(evalConfig('one'))
    );
    await fs.writeFile(
      path.join(evalRun, 'two.json'),
      JSON.stringify(evalConfig('two'))
    );
    let passing = new Set(['a', 'b']);
    const clientPlugin = plugin(() => passing);
    const run = (file: string) =>
      runEval({
        configPath: path.join(evalRun, file),
        rootDir: root,
        outputDir: path.join(root, 'out'),
        plugins: [clientPlugin],
      });

    const first = await run('one.json');
    expect(first.summary.previousRun).toBeUndefined();
    // Another eval config's run, in between, is not a baseline for `one`.
    passing = new Set();
    await run('two.json');
    passing = new Set(['a']);
    const second = await run('one.json');

    expect(second.summary.previousRun).toEqual({
      runId: first.summary.runId,
      timestamp: first.summary.timestamp,
      sameConfig: true,
      passRate: 1,
      passRateDelta: -0.5,
      variants: {
        default: {
          passRateDelta: -0.5,
          trialPassRateDelta: -0.5,
          regressed: ['b'],
          improved: [],
          added: [],
          removed: [],
        },
      },
    });
    await expect(fs.stat(path.join(evalRun, 'store'))).resolves.toBeTruthy();
  });

  it('keeps a store next to the eval config even if rootDir has one, and survives a corrupt summary', async () => {
    const root = await tempDir();
    const evalRun = path.join(root, 'suite');
    await fs.mkdir(evalRun);
    // A store directory of the same name where the run starts.
    await fs.mkdir(path.join(root, 'store', 'eval-summaries'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(evalRun, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: [
          {
            id: 'a',
            input: 'a',
            assertions: { containsText: 'yes' },
          },
        ],
      })
    );
    await fs.writeFile(
      path.join(evalRun, 'm.json'),
      JSON.stringify({
        name: 'm',
        datasets: ['./cases.json'],
        client: 'base/client/fixed',
        results: { store: { type: 'file', dir: './store' } },
      })
    );
    const clientPlugin = plugin(() => new Set(['a']));
    const run = () =>
      runEval({
        configPath: path.join(evalRun, 'm.json'),
        rootDir: root,
        outputDir: path.join(root, 'out'),
        plugins: [clientPlugin],
      });
    await run();
    expect(
      await fs.readdir(path.join(root, 'store', 'eval-summaries'))
    ).toEqual([]);
    // A summary that can't be read isn't a baseline, and doesn't fail the run.
    await fs.writeFile(
      path.join(evalRun, 'store', 'eval-summaries', 'broken.json'),
      '{'
    );
    const second = await run();
    expect(second.summary.metrics.passRate).toBe(1);
  });
});

describe('findPreviousRun', () => {
  it('skips a run in an older result format', async () => {
    const { findPreviousRun } = await import('./runBaseline.js');
    const outputRoot = await tempDir();
    const summary = (schemaVersion: number, timestamp: string) => ({
      schemaVersion,
      configId: 'cfg',
      timestamp,
      variants: [{ name: 'a' }],
    });
    await fs.mkdir(path.join(outputRoot, 'older'));
    await fs.writeFile(
      path.join(outputRoot, 'older', 'results.json'),
      JSON.stringify(summary(1, '2026-10-02T00:00:00.000Z'))
    );
    const lookup = {
      configId: 'cfg',
      runId: 'now',
      variants: ['a'],
      outputRoot,
    };
    await expect(findPreviousRun(lookup)).resolves.toBeUndefined();
    await fs.mkdir(path.join(outputRoot, 'current'));
    await fs.writeFile(
      path.join(outputRoot, 'current', 'results.json'),
      JSON.stringify(summary(2, '2026-10-01T00:00:00.000Z'))
    );
    await expect(findPreviousRun(lookup)).resolves.toMatchObject({
      runId: 'current',
    });
  });
});
