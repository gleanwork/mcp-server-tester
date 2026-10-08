import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { configIdentity } from './configIdentity.js';
import { resolveConfigExtends } from './configExtends.js';
import { loadEvalConfig } from './evalConfig.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import { assertPlugin, type Plugin } from '../plugins/plugin.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** An eval directory with one file dataset and the given eval config. */
async function evalDir(evalConfig: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-configs-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [{ id: 'one', input: 'Say hello' }],
    })
  );
  await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify(evalConfig));
  return dir;
}

describe('eval config identity', () => {
  it('is unchanged for an eval config without extends', async () => {
    const dir = await evalDir({
      name: 'identity',
      datasets: ['./cases.json'],
      judges: [{ type: 'rubric', rubric: 'correctness' }],
      trials: 2,
    });
    const { summary } = await runEval({
      configPath: path.join(dir, 'eval.json'),
      rootDir: dir,
      dryRun: true,
    });
    expect({
      configId: summary.configId,
      contentHash: summary.contentHash,
    }).toEqual({
      configId: 'identity',
      contentHash:
        'ffb64e7252b1d335266b8f5d27a02801c62ffea003a6e1e6e724419fa6c231d4',
    });
  });
});

/** A plugin with an echo client, a fixed-score judge and the given configs. */
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
  evalConfig: Record<string, unknown>,
  plugins: Plugin[]
): Promise<Awaited<ReturnType<typeof runEval>>> {
  const dir = await evalDir(evalConfig);
  return runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins,
    dryRun: true,
  });
}

describe('shared configs', () => {
  it('applies a config under the eval config, which wins per key', async () => {
    const { evalConfig } = await dryRun(
      {
        name: 'extends',
        extends: ['acme/config/recommended'],
        datasets: ['./cases.json'],
        trials: 3,
      },
      [
        acme({
          recommended: {
            client: 'acme/client/echo',
            judges: ['acme/judge/fixed'],
            trials: 2,
            maxToolCalls: 4,
          },
        }),
      ]
    );
    expect(evalConfig).toMatchObject({
      client: 'acme/client/echo',
      judges: [{ type: 'acme/judge/fixed', score: 1 }],
      trials: 3,
      maxToolCalls: 4,
      extends: ['acme/config/recommended'],
    });
  });

  it('applies configs in order and replaces lists rather than merging them', async () => {
    const plugin = acme({
      base: { judges: [{ type: 'acme/judge/fixed', score: 0.2 }], timeout: 10 },
      strict: { judges: [{ type: 'acme/judge/fixed', score: 0.9 }] },
    });
    const later = await dryRun(
      {
        name: 'order',
        extends: ['acme/config/base', 'acme/config/strict'],
        datasets: ['./cases.json'],
      },
      [plugin]
    );
    expect(later.evalConfig.judges).toEqual([
      { type: 'acme/judge/fixed', score: 0.9 },
    ]);
    expect(later.evalConfig.timeout).toBe(10);

    const own = await dryRun(
      {
        name: 'own',
        extends: ['acme/config/base'],
        datasets: ['./cases.json'],
        judges: [{ type: 'rubric', rubric: 'correctness' }],
      },
      [plugin]
    );
    expect(own.evalConfig.judges).toEqual([
      expect.objectContaining({ type: 'rubric', rubric: 'correctness' }),
    ]);
  });

  it("identifies an eval by its resolved settings, so a changed config isn't a saved run", async () => {
    const evalConfig = {
      name: 'identity',
      extends: ['acme/config/recommended'],
      datasets: ['./cases.json'],
    };
    const first = await dryRun(evalConfig, [
      acme({ recommended: { trials: 2 } }),
    ]);
    resetPluginsForTests();
    const second = await dryRun(evalConfig, [
      acme({ recommended: { trials: 5 } }),
    ]);
    expect(first.summary.contentHash).not.toBe(second.summary.contentHash);

    // The hash is the resolved eval config's, the one a batch resume compares.
    const dir = await evalDir(evalConfig);
    const resolved = resolveConfigExtends(
      loadEvalConfig(path.join(dir, 'eval.json'), { rootDir: dir }),
      ['acme']
    );
    expect(configIdentity(resolved).contentHash).toBe(
      second.summary.contentHash
    );
  });

  it('runs an eval whose client and judge come from a config', async () => {
    const dir = await evalDir({
      name: 'run',
      extends: ['acme/config/recommended'],
      datasets: ['./cases.json'],
    });
    const result = await runEval({
      configPath: path.join(dir, 'eval.json'),
      rootDir: dir,
      plugins: [
        acme({
          recommended: {
            client: 'acme/client/echo',
            judges: [{ type: 'acme/judge/fixed', score: 0.9 }],
          },
        }),
      ],
    });
    expect(
      result.summary.results.map((entry) => ({
        pass: entry.pass,
        judge: entry.scores.judge?.pass,
      }))
    ).toEqual([{ pass: true, judge: true }]);
  });

  it.each([
    [
      'a bare config name',
      { extends: ['recommended'] },
      [acme({ recommended: {} })],
      'MST has no built-in configs. Name a plugin\'s config: "<namespace>/config/recommended"',
    ],
    [
      'a plugin the eval config does not load',
      { extends: ['other/config/recommended'] },
      [acme({ recommended: {} })],
      `references "other/config/recommended", but doesn't load the "other" plugin`,
    ],
    [
      'a config the plugin does not have',
      { extends: ['acme/config/strict'] },
      [acme({ recommended: {}, base: {} })],
      'Plugin "acme-plugin" has no config "strict". Available: base, recommended.',
    ],
    [
      "a key that is the eval config's own",
      { extends: ['acme/config/recommended'] },
      [acme({ recommended: { datasets: ['x.json'] } as never })],
      `Shared config "acme/config/recommended" can't set "datasets"`,
    ],
    [
      'an unknown key',
      { extends: ['acme/config/recommended'] },
      [acme({ recommended: { iteration: 2 } as never })],
      'Invalid Shared config "acme/config/recommended"',
    ],
    [
      'the same config twice',
      { extends: ['acme/config/recommended', 'acme/config/recommended'] },
      [acme({ recommended: {} })],
      'The eval config extends "acme/config/recommended" more than once.',
    ],
    [
      "another plugin's metric",
      { extends: ['acme/config/recommended'] },
      [
        acme({
          recommended: {
            metrics: [{ type: 'pass_rate', metric: 'beta/metric/y' }],
          },
        }),
        acme({}, 'beta'),
      ],
      `Shared config "acme/config/recommended" references "beta/metric/y"`,
    ],
    [
      "another plugin's connector",
      { extends: ['acme/config/recommended'] },
      [
        acme({
          recommended: {
            servers: [{ connector: 'beta/connector/slack' }],
          },
        }),
        acme({}, 'beta'),
      ],
      `Shared config "acme/config/recommended" references "beta/connector/slack"`,
    ],
    [
      "another plugin's extension",
      { extends: ['acme/config/recommended'] },
      [
        acme({ recommended: { judges: ['beta/judge/fixed'] } }),
        acme({}, 'beta'),
      ],
      `Shared config "acme/config/recommended" references "beta/judge/fixed". A shared config may use only its own plugin's extensions ("acme/<kind>/...") and built-ins.`,
    ],
  ])('rejects %s', async (_, extra, plugins, message) => {
    await expect(
      dryRun({ name: 'bad', datasets: ['./cases.json'], ...extra }, plugins)
    ).rejects.toThrow(message);
  });

  it("lets the eval config's run controls win over a config's", async () => {
    const { evalConfig } = await dryRun(
      {
        name: 'run-controls',
        extends: ['acme/config/recommended'],
        datasets: ['./cases.json'],
        run: { trials: 5 },
      },
      [acme({ recommended: { trials: 3, concurrency: 2 } })]
    );
    expect(evalConfig).toMatchObject({ trials: 5, concurrency: 2 });
  });

  it('lets a config use built-ins', async () => {
    const { evalConfig } = await dryRun(
      {
        name: 'builtins',
        extends: ['acme/config/recommended'],
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
    expect(evalConfig.metrics).toEqual([
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
          judges: ['acme/judge/fixed'],
          metrics: ['passed'],
          results: { store: 'file' },
        },
      }),
    ]);
    const resolved = resolveConfigExtends(
      { name: 'm', datasets: [], extends: ['acme/config/recommended'] },
      ['acme']
    );
    expect(resolved).toMatchObject({
      judges: [{ type: 'acme/judge/fixed' }],
      metrics: [{ type: 'passed' }],
      results: { store: { type: 'file' } },
    });
  });
});
