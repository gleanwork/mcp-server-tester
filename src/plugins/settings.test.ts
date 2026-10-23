import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEval } from '../evals/runEval.js';
import { loadEvalConfig } from '../evals/evalConfig.js';
import { resetPluginsForTests } from './extensions.js';
import { assertPlugin, type Plugin } from './plugin.js';
import { findSettingsFile, SETTINGS_FILE } from './settingsFile.js';
import { grantTargets } from '../auth/grants/connectors.js';
import { accessToken } from '../auth/grants/grants.js';
import { connectorUses } from '../evals/connectorServers.js';
import { installPlugins } from './extensions.js';
import type { CredentialStore } from '../auth/grants/types.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/**
 * A repo (it holds `.git`) with an eval config in `evals/`, and an
 * `mst.config.json` at its root when `settings` is given.
 */
async function repo(
  evalConfig: Record<string, unknown>,
  settings?: Record<string, unknown>
): Promise<{ root: string; configPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-settings-'));
  dirs.push(root);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'evals'));
  if (settings)
    await fs.writeFile(
      path.join(root, SETTINGS_FILE),
      JSON.stringify({ settings })
    );
  const configPath = path.join(root, 'evals', 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'settings',
      plugins: [],
      datasets: ['acme/dataset/cases'],
      client: 'acme/client/echo',
      judges: ['acme/judge/fixed'],
      metrics: ['acme/metric/seen'],
      ...evalConfig,
    })
  );
  return { root, configPath };
}

/** What each of the acme plugin's extensions was given as `settings`. */
type Seen = Record<string, unknown[]>;

/** A plugin whose settings need a `project`; each extension records its settings. */
function acme(seen: Seen = {}): Plugin {
  const record = (kind: string, settings: unknown) =>
    (seen[kind] ??= []).push(settings);
  return {
    meta: { name: 'acme-plugin', namespace: 'acme' },
    settings: {
      schema: z
        .object({ project: z.string(), region: z.string().default('us') })
        .strict(),
    },
    datasetSources: {
      cases: {
        schema: z.object({ type: z.string() }),
        load: async (_config, context) => {
          record('dataset', context.settings);
          return { name: 'cases', cases: [{ id: 'one', input: 'hi' }] };
        },
      },
    },
    clients: {
      echo: {
        schema: z.object({ type: z.string() }).passthrough(),
        evidence: 'structured',
        run: async (_input, _config, context) => {
          record('client', context.settings);
          return { finalText: 'hello', events: [] };
        },
      },
    },
    judges: {
      fixed: {
        schema: z.object({}).passthrough(),
        preflight: async (_options, context) => {
          record('judge preflight', context?.settings);
        },
        evaluate: async (_input, _options, context) => {
          record('judge', context?.settings);
          return { score: 1 };
        },
      },
    },
    metrics: {
      seen: {
        schema: z.object({}).passthrough(),
        kind: 'binary',
        compute: (_result, _params, context) => {
          record('metric', context?.settings);
          return true;
        },
      },
    },
  };
}

/** A plugin that takes no settings. */
const plain: Plugin = { meta: { name: 'plain-plugin', namespace: 'plain' } };

describe('plugin settings', () => {
  it('gives every extension its plugin settings from mst.config.json', async () => {
    const seen: Seen = {};
    const { root, configPath } = await repo({}, { acme: { project: 'p1' } });
    const result = await runEval({
      configPath,
      rootDir: root,
      plugins: [acme(seen)],
    });
    expect(result.summary.results.map((entry) => entry.pass)).toEqual([true]);
    const expected = { project: 'p1', region: 'us' };
    expect(seen).toEqual({
      dataset: [expected],
      'judge preflight': [expected],
      client: [expected],
      judge: [expected],
      metric: [expected],
    });
  });

  it("replaces the file's section with the eval config's, whole", async () => {
    const { configPath } = await repo(
      { settings: { acme: { project: 'p2' } } },
      { acme: { project: 'p1', region: 'eu' } }
    );
    expect(loadEvalConfig(configPath).settings).toEqual({
      acme: { project: 'p2' },
    });
  });

  it('fails before the run when its settings are missing or wrong', async () => {
    const seen: Seen = {};
    const { root, configPath } = await repo({});
    await expect(
      runEval({ configPath, rootDir: root, plugins: [acme(seen)] })
    ).rejects.toThrow(/Invalid settings "acme"/);
    expect(seen).toEqual({});
  });

  it("refuses settings for a plugin that doesn't take them", async () => {
    const { root, configPath } = await repo(
      {},
      { acme: { project: 'p1' }, plain: { x: 1 } }
    );
    await expect(
      runEval({
        configPath,
        rootDir: root,
        plugins: [acme(), plain],
        dryRun: true,
      })
    ).rejects.toThrow(
      'Settings "plain": plugin "plain-plugin" takes no settings.'
    );
  });

  it("keeps only the eval's plugins' sections, and counts them in its identity", async () => {
    const identity = async (settings: Record<string, unknown>) => {
      resetPluginsForTests();
      const { root, configPath } = await repo({}, settings);
      const { summary, evalConfig } = await runEval({
        configPath,
        rootDir: root,
        plugins: [acme()],
        dryRun: true,
      });
      return { hash: summary.contentHash, settings: evalConfig.settings };
    };
    const first = await identity({ acme: { project: 'p1' } });
    // Another plugin's section is dropped, so it doesn't change the identity.
    const other = await identity({
      acme: { project: 'p1' },
      other: { anything: true },
    });
    const changed = await identity({ acme: { project: 'p2' } });
    expect(first.settings).toEqual({ acme: { project: 'p1' } });
    expect(other).toEqual(first);
    expect(changed.hash).not.toBe(first.hash);
  });

  it('reads no file when told not to', async () => {
    const { configPath } = await repo({}, { acme: { project: 'p1' } });
    expect(
      loadEvalConfig(configPath, { settingsFile: false }).settings
    ).toBeUndefined();
  });
});

describe('findSettingsFile', () => {
  it('finds the nearest file, and stops at the repository root', async () => {
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-settings-'));
    dirs.push(outer);
    const root = path.join(outer, 'repo');
    const nested = path.join(root, 'a', 'b');
    await fs.mkdir(nested, { recursive: true });
    // Above the repository: never read.
    await fs.writeFile(path.join(outer, SETTINGS_FILE), '{}');
    await fs.mkdir(path.join(root, '.git'));
    expect(findSettingsFile(nested)).toBeUndefined();
    await fs.writeFile(path.join(root, SETTINGS_FILE), '{}');
    expect(findSettingsFile(nested)).toBe(path.join(root, SETTINGS_FILE));
    await fs.writeFile(path.join(root, 'a', SETTINGS_FILE), '{}');
    expect(findSettingsFile(nested)).toBe(path.join(root, 'a', SETTINGS_FILE));
  });
});

describe('plugin shape', () => {
  it('needs a schema for its settings', () => {
    expect(() =>
      assertPlugin({ meta: { name: 'x', namespace: 'x' }, settings: {} }, 'x')
    ).toThrow('settings needs a Zod schema');
    expect(() =>
      assertPlugin(
        {
          meta: { name: 'x', namespace: 'x' },
          settings: { schema: z.object({}), defaults: {} },
        },
        'x'
      )
    ).toThrow('settings: unknown key "defaults"');
  });
});

describe('connector settings', () => {
  it("passes a connector's auth its plugin settings", async () => {
    let given: unknown;
    installPlugins([
      {
        meta: { name: 'acme-plugin', namespace: 'acme' },
        settings: { schema: z.object({ project: z.string() }) },
        connectors: {
          docs: {
            url: 'https://docs.example.com/mcp',
            auth: {
              type: 'static',
              token: async (context) => {
                given = context?.settings;
                return 'token';
              },
            },
          },
        },
      },
    ]);
    const uses = connectorUses({
      name: 'connectors',
      datasets: [],
      servers: [{ connector: 'acme/connector/docs', label: 'docs' }],
      settings: { acme: { project: 'p1' } },
    });
    const [target] = grantTargets(uses);
    await accessToken(target!, {} as CredentialStore);
    expect(given).toEqual({ project: 'p1' });
  });
});
