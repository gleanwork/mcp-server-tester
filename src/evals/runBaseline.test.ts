import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEvalSuite } from './runEvalSuite.js';
import { resolveManifestPath } from './evalManifest.js';
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
  it('looks next to the manifest, then in rootDir, and defaults to the manifest', async () => {
    const manifestDir = await tempDir();
    const rootDir = await tempDir();
    await fs.writeFile(path.join(manifestDir, 'here.json'), '{}');
    await fs.writeFile(path.join(rootDir, 'there.json'), '{}');
    const dirsOf = { manifestDir, rootDir };
    expect(resolveManifestPath('here.json', dirsOf)).toBe(
      path.join(manifestDir, 'here.json')
    );
    expect(resolveManifestPath('there.json', dirsOf)).toBe(
      path.join(rootDir, 'there.json')
    );
    expect(resolveManifestPath('store', dirsOf)).toBe(
      path.join(manifestDir, 'store')
    );
    expect(resolveManifestPath('/abs/x', dirsOf)).toBe('/abs/x');
  });
});

/** A host that passes a case when its scenario mentions the current outcome. */
function plugin(pass: () => Set<string>): Plugin {
  return {
    meta: { name: 'baseline-test', namespace: 'base' },
    hosts: {
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

describe('a run is compared with the previous run of the same manifest', () => {
  it('finds it in the result store, ignoring other manifests that share the store', async () => {
    const root = await tempDir();
    const suite = path.join(root, 'suite');
    await fs.mkdir(suite);
    await fs.writeFile(
      path.join(suite, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: ['a', 'b'].map((id) => ({
          id,
          mode: 'host',
          input: id,
          assertions: { containsText: 'yes' },
        })),
      })
    );
    const manifest = (name: string) => ({
      name,
      datasets: ['./cases.json'],
      host: { type: 'base/fixed' },
      // Relative to the manifest, not to rootDir.
      results: { store: { type: 'file', dir: './store' } },
    });
    await fs.writeFile(
      path.join(suite, 'one.json'),
      JSON.stringify(manifest('one'))
    );
    await fs.writeFile(
      path.join(suite, 'two.json'),
      JSON.stringify(manifest('two'))
    );
    let passing = new Set(['a', 'b']);
    const host = plugin(() => passing);
    const run = (file: string) =>
      runEvalSuite({
        manifestPath: path.join(suite, file),
        rootDir: root,
        outputDir: path.join(root, 'out'),
        plugins: [host],
      });

    const first = await run('one.json');
    expect(first.summary.previousRun).toBeUndefined();
    // Another manifest's run, in between, is not a baseline for `one`.
    passing = new Set();
    await run('two.json');
    passing = new Set(['a']);
    const second = await run('one.json');

    expect(second.summary.previousRun).toEqual({
      runId: first.summary.runId,
      timestamp: first.summary.timestamp,
      sameManifest: true,
      passRate: 1,
      passRateDelta: -0.5,
      arms: {
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
    await expect(fs.stat(path.join(suite, 'store'))).resolves.toBeTruthy();
  });

  it('keeps a store next to the manifest even if rootDir has one, and survives a corrupt summary', async () => {
    const root = await tempDir();
    const suite = path.join(root, 'suite');
    await fs.mkdir(suite);
    // A store directory of the same name where the run starts.
    await fs.mkdir(path.join(root, 'store', 'eval-summaries'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(suite, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: [
          {
            id: 'a',
            mode: 'host',
            input: 'a',
            assertions: { containsText: 'yes' },
          },
        ],
      })
    );
    await fs.writeFile(
      path.join(suite, 'm.json'),
      JSON.stringify({
        name: 'm',
        datasets: ['./cases.json'],
        host: { type: 'base/fixed' },
        results: { store: { type: 'file', dir: './store' } },
      })
    );
    const host = plugin(() => new Set(['a']));
    const run = () =>
      runEvalSuite({
        manifestPath: path.join(suite, 'm.json'),
        rootDir: root,
        outputDir: path.join(root, 'out'),
        plugins: [host],
      });
    await run();
    expect(
      await fs.readdir(path.join(root, 'store', 'eval-summaries'))
    ).toEqual([]);
    // A summary that can't be read isn't a baseline, and doesn't fail the run.
    await fs.writeFile(
      path.join(suite, 'store', 'eval-summaries', 'broken.json'),
      '{'
    );
    const second = await run();
    expect(second.summary.metrics.passRate).toBe(1);
  });
});
