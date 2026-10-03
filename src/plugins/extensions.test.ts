import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installPlugins,
  loadedNamespaces,
  resetPluginsForTests,
} from './extensions.js';
import { getDatasetSource } from '../evals/builtinDatasetSources.js';
import { getHost } from '../evals/builtinHosts.js';
import { getResultStore } from '../evals/builtinResultStores.js';
import { getMetric } from '../evals/metrics.js';
import { getJudge } from '../judge/builtinJudges.js';
import type { Plugin } from './plugin.js';
import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';

const schema = z.object({}).passthrough();
const judge: JudgeDefinition = {
  schema,
  evaluate: async () => ({ score: 1 }),
};

function acme(overrides: Partial<Plugin> = {}): Plugin {
  return {
    meta: { name: '@acme/mst-plugin', version: '1.0.0', namespace: 'acme' },
    judges: { completeness: judge },
    ...overrides,
  };
}

afterEach(() => resetPluginsForTests());

describe('extension table', () => {
  it('serves built-ins under bare names without any plugin loaded', () => {
    expect(getDatasetSource('file')).toBeDefined();
    expect(getHost('claude-cli')).toBeDefined();
    expect(getMetric('passed')).toBeDefined();
    expect(getResultStore('file')).toBeDefined();
    expect(loadedNamespaces()).toEqual([]);
  });

  it('serves plugin extensions as namespace/name', () => {
    installPlugins([acme()]);

    expect(getJudge('acme/completeness')).toBe(judge);
    expect(loadedNamespaces()).toEqual(['acme']);
  });

  it('never resolves a plugin extension by its bare name', () => {
    installPlugins([acme()]);

    expect(() => getJudge('completeness')).toThrow(
      'Judge "completeness" is not available.'
    );
  });

  it('names the missing plugin namespace for an unknown namespaced reference', () => {
    expect(() => getJudge('other/completeness')).toThrow(
      'Judge "other/completeness" needs the "other" plugin, which is not loaded.'
    );
  });

  it('lists what is available when a name is unknown', () => {
    installPlugins([acme()]);

    expect(() => getJudge('acme/missing')).toThrow(
      'Judge "acme/missing" is not available. Available: acme/completeness, rubric.'
    );
  });

  it('installs the same plugin twice as a no-op', () => {
    const plugin = acme();
    installPlugins([plugin]);
    installPlugins([plugin]);
    // A rebuilt object over the same definitions is the same plugin.
    installPlugins([acme()]);

    expect(loadedNamespaces()).toEqual(['acme']);
    expect(getJudge('acme/completeness')).toBe(judge);
  });

  it('treats a rebuilt unversioned object over the same definitions as the same plugin', () => {
    const meta = { name: 'acme-inline', namespace: 'acme' };
    installPlugins([acme({ meta })]);

    expect(() => installPlugins([acme({ meta: { ...meta } })])).not.toThrow();
  });

  it('rejects a same-version copy whose definitions differ (a configured factory)', () => {
    installPlugins([acme()]);
    const configured: JudgeDefinition = { ...judge };

    expect(() =>
      installPlugins([acme({ judges: { completeness: configured } })])
    ).toThrow('uses namespace "acme", which "@acme/mst-plugin" already uses');
  });

  it('rejects a same-version plugin whose extensions differ', () => {
    installPlugins([acme()]);

    expect(() => installPlugins([acme({ judges: { other: judge } })])).toThrow(
      'uses namespace "acme", which "@acme/mst-plugin" already uses'
    );
  });

  it('rejects a different plugin that claims a loaded namespace', () => {
    installPlugins([acme()]);

    expect(() =>
      installPlugins([
        acme({
          meta: { name: '@other/mst-plugin', namespace: 'acme' },
        }),
      ])
    ).toThrow(
      'Plugin "@other/mst-plugin" uses namespace "acme", which "@acme/mst-plugin" already uses.'
    );
  });

  it('validates every plugin before installing any of them', () => {
    expect(() =>
      installPlugins([
        acme(),
        { meta: { name: 'broken', namespace: 'broken' }, judges: { x: {} } },
      ] as Plugin[])
    ).toThrow('Invalid plugin "broken": judges.x');
    expect(loadedNamespaces()).toEqual([]);
  });

  it('resets to built-ins only', () => {
    installPlugins([acme()]);
    resetPluginsForTests();

    expect(loadedNamespaces()).toEqual([]);
    expect(getHost('claude-cli')).toBeDefined();
  });
});
