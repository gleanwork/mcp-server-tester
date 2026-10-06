import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEvalSuite } from './runEvalSuite.js';
import { manifestIdentity } from './manifestIdentity.js';
import { resolveManifestExtends } from './manifestExtends.js';
import { loadEvalManifest } from './evalManifest.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import { assertPlugin, type Plugin } from '../plugins/plugin.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** A suite directory with one file dataset and the given manifest. */
async function suiteDir(manifest: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-configs-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [{ id: 'one', mode: 'mcp_host', input: 'Say hello' }],
    })
  );
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('manifest identity', () => {
  it('is unchanged for a manifest without extends', async () => {
    const dir = await suiteDir({
      name: 'identity',
      datasets: ['./cases.json'],
      judges: [{ type: 'rubric', rubric: 'correctness' }],
      trials: 2,
    });
    const { summary } = await runEvalSuite({
      manifestPath: path.join(dir, 'manifest.json'),
      rootDir: dir,
      dryRun: true,
    });
    expect({
      manifestId: summary.manifestId,
      contentHash: summary.contentHash,
    }).toEqual({
      manifestId: 'identity',
      contentHash:
        'ffb64e7252b1d335266b8f5d27a02801c62ffea003a6e1e6e724419fa6c231d4',
    });
  });
});

/** A plugin with an echo host, a fixed-score judge and the given configs. */
function acme(configs: Plugin['configs'], namespace = 'acme'): Plugin {
  return {
    meta: { name: `${namespace}-plugin`, namespace },
    clients: {
      echo: {
        schema: z.object({ type: z.string() }).passthrough(),
        evidence: 'structured',
        run: async () => ({ finalText: 'hello', events: [] }),
      },
    },
    judges: {
      fixed: {
        schema: z.object({ score: z.number().default(1) }).strict(),
        evaluate: async (_input, options) => ({
          score: (options as { score: number }).score,
        }),
      },
    },
    configs,
  };
}

async function dryRun(
  manifest: Record<string, unknown>,
  plugins: Plugin[]
): Promise<Awaited<ReturnType<typeof runEvalSuite>>> {
  const dir = await suiteDir(manifest);
  return runEvalSuite({
    manifestPath: path.join(dir, 'manifest.json'),
    rootDir: dir,
    plugins,
    dryRun: true,
  });
}

describe('shared configs', () => {
  it('applies a config under the manifest, which wins per key', async () => {
    const { manifest } = await dryRun(
      {
        name: 'extends',
        extends: ['acme/recommended'],
        datasets: ['./cases.json'],
        trials: 3,
      },
      [
        acme({
          recommended: {
            host: { type: 'acme/echo' },
            judges: ['acme/fixed'],
            trials: 2,
            maxToolCalls: 4,
          },
        }),
      ]
    );
    expect(manifest).toMatchObject({
      host: { type: 'acme/echo' },
      judges: [{ type: 'acme/fixed', score: 1 }],
      trials: 3,
      maxToolCalls: 4,
      extends: ['acme/recommended'],
    });
  });

  it('applies configs in order and replaces lists rather than merging them', async () => {
    const plugin = acme({
      base: { judges: [{ type: 'acme/fixed', score: 0.2 }], timeout: 10 },
      strict: { judges: [{ type: 'acme/fixed', score: 0.9 }] },
    });
    const later = await dryRun(
      {
        name: 'order',
        extends: ['acme/base', 'acme/strict'],
        datasets: ['./cases.json'],
      },
      [plugin]
    );
    expect(later.manifest.judges).toEqual([{ type: 'acme/fixed', score: 0.9 }]);
    expect(later.manifest.timeout).toBe(10);

    const own = await dryRun(
      {
        name: 'own',
        extends: ['acme/base'],
        datasets: ['./cases.json'],
        judges: [{ type: 'rubric', rubric: 'correctness' }],
      },
      [plugin]
    );
    expect(own.manifest.judges).toEqual([
      expect.objectContaining({ type: 'rubric', rubric: 'correctness' }),
    ]);
  });

  it("identifies a suite by its resolved settings, so a changed config isn't a saved run", async () => {
    const manifest = {
      name: 'identity',
      extends: ['acme/recommended'],
      datasets: ['./cases.json'],
    };
    const first = await dryRun(manifest, [
      acme({ recommended: { trials: 2 } }),
    ]);
    resetPluginsForTests();
    const second = await dryRun(manifest, [
      acme({ recommended: { trials: 5 } }),
    ]);
    expect(first.summary.contentHash).not.toBe(second.summary.contentHash);

    // The hash is the resolved manifest's, the one a batch resume compares.
    const dir = await suiteDir(manifest);
    const resolved = resolveManifestExtends(
      loadEvalManifest(path.join(dir, 'manifest.json'), { rootDir: dir }),
      ['acme']
    );
    expect(manifestIdentity(resolved).contentHash).toBe(
      second.summary.contentHash
    );
  });

  it('runs a suite whose host and judge come from a config', async () => {
    const dir = await suiteDir({
      name: 'run',
      extends: ['acme/recommended'],
      datasets: ['./cases.json'],
    });
    const result = await runEvalSuite({
      manifestPath: path.join(dir, 'manifest.json'),
      rootDir: dir,
      plugins: [
        acme({
          recommended: {
            host: { type: 'acme/echo' },
            judges: [{ type: 'acme/fixed', score: 0.9 }],
          },
        }),
      ],
    });
    expect(
      result.summary.results.map((entry) => ({
        pass: entry.pass,
        judge: entry.expectations.judge?.pass,
      }))
    ).toEqual([{ pass: true, judge: true }]);
  });

  it.each([
    [
      'a bare config name',
      { extends: ['recommended'] },
      [acme({ recommended: {} })],
      'MST has no built-in configs. Name a plugin\'s config: "namespace/recommended"',
    ],
    [
      'a plugin the manifest does not load',
      { extends: ['other/recommended'] },
      [acme({ recommended: {} })],
      `references "other/recommended", but doesn't load the "other" plugin`,
    ],
    [
      'a config the plugin does not have',
      { extends: ['acme/strict'] },
      [acme({ recommended: {}, base: {} })],
      'Plugin "acme-plugin" has no config "strict". Available: base, recommended.',
    ],
    [
      "a key that is the manifest's own",
      { extends: ['acme/recommended'] },
      [acme({ recommended: { datasets: ['x.json'] } as never })],
      `Shared config "acme/recommended" can't set "datasets"`,
    ],
    [
      'an unknown key',
      { extends: ['acme/recommended'] },
      [acme({ recommended: { iteration: 2 } as never })],
      'Invalid Shared config "acme/recommended"',
    ],
    [
      'the same config twice',
      { extends: ['acme/recommended', 'acme/recommended'] },
      [acme({ recommended: {} })],
      'The manifest extends "acme/recommended" more than once.',
    ],
    [
      "another plugin's metric",
      { extends: ['acme/recommended'] },
      [
        acme({
          recommended: { metrics: [{ type: 'pass_rate', metric: 'beta/y' }] },
        }),
        acme({}, 'beta'),
      ],
      `Shared config "acme/recommended" references "beta/y"`,
    ],
    [
      "another plugin's extension",
      { extends: ['acme/recommended'] },
      [acme({ recommended: { judges: ['beta/fixed'] } }), acme({}, 'beta')],
      `Shared config "acme/recommended" references "beta/fixed". A shared config may use only its own plugin's extensions ("acme/...") and built-ins.`,
    ],
  ])('rejects %s', async (_, extra, plugins, message) => {
    await expect(
      dryRun({ name: 'bad', datasets: ['./cases.json'], ...extra }, plugins)
    ).rejects.toThrow(message);
  });

  it("lets the manifest's run controls win over a config's", async () => {
    const { manifest } = await dryRun(
      {
        name: 'run-controls',
        extends: ['acme/recommended'],
        datasets: ['./cases.json'],
        run: { trials: 5 },
      },
      [acme({ recommended: { trials: 3, concurrency: 2 } })]
    );
    expect(manifest).toMatchObject({ trials: 5, concurrency: 2 });
  });

  it('lets a config use built-ins', async () => {
    const { manifest } = await dryRun(
      {
        name: 'builtins',
        extends: ['acme/recommended'],
        datasets: ['./cases.json'],
      },
      [
        acme({
          recommended: {
            judges: [{ type: 'rubric', rubric: 'correctness' }],
            metrics: ['passed'],
          },
        }),
      ]
    );
    expect(manifest.metrics).toEqual([
      expect.objectContaining({ type: 'passed' }),
    ]);
  });
});

describe('plugin configs', () => {
  it.each([
    [{ recommended: 'x' }, 'configs.recommended must be an object'],
    [{ '-bad': {} }, 'config name "-bad" must start with a letter or digit'],
    [[], 'configs must be an object'],
  ])('rejects %j', (configs, message) => {
    expect(() =>
      assertPlugin({ meta: { name: 'p', namespace: 'p' }, configs }, 'inline')
    ).toThrow(message);
  });

  it('treats a rebuilt plugin with different configs as a different plugin', () => {
    const plugin = acme({ recommended: { trials: 1 } });
    installPlugins([plugin]);
    // A rebuilt object around the same definitions and equal configs is the same plugin.
    expect(() =>
      installPlugins([{ ...plugin, configs: { recommended: { trials: 1 } } }])
    ).not.toThrow();
    expect(() =>
      installPlugins([{ ...plugin, configs: { recommended: { trials: 2 } } }])
    ).toThrow('uses namespace "acme", which "acme-plugin" already uses');
  });

  it('normalizes shorthand judges, metrics and result store in a config', () => {
    installPlugins([
      acme({
        recommended: {
          judges: ['acme/fixed'],
          metrics: ['passed'],
          results: { store: 'file' },
        },
      }),
    ]);
    const resolved = resolveManifestExtends(
      { name: 'm', datasets: [], extends: ['acme/recommended'] },
      ['acme']
    );
    expect(resolved).toMatchObject({
      judges: [{ type: 'acme/fixed' }],
      metrics: [{ type: 'passed' }],
      results: { store: { type: 'file' } },
    });
  });
});
