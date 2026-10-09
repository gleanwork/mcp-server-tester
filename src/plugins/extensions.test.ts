import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installPlugins,
  loadedNamespaces,
  resetPluginsForTests,
} from './extensions.js';
import { getDatasetSource } from '../evals/builtinDatasetSources.js';
import { getClient } from '../evals/builtinClients.js';
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
    expect(getClient('claude-code')).toBeDefined();
    expect(getMetric('passed')).toBeDefined();
    expect(getResultStore('file')).toBeDefined();
    expect(loadedNamespaces()).toEqual([]);
  });

  it('serves plugin extensions as namespace/kind/name', () => {
    installPlugins([acme()]);

    expect(getJudge('acme/judge/completeness')).toBe(judge);
    expect(loadedNamespaces()).toEqual(['acme']);
  });

  it('never resolves a plugin extension by its bare name, and suggests the full name', () => {
    installPlugins([acme()]);

    expect(() => getJudge('completeness')).toThrow(
      '"completeness" is not a built-in judge. Did you mean "acme/judge/completeness"?'
    );
  });

  it('names the missing plugin namespace for an unknown namespaced reference', () => {
    expect(() => getJudge('other/judge/completeness')).toThrow(
      'Judge "other/judge/completeness" needs the "other" plugin, which is not loaded.'
    );
  });

  it('lists what is available when a name is unknown', () => {
    installPlugins([acme()]);

    expect(() => getJudge('acme/judge/missing')).toThrow(
      'Judge "acme/judge/missing" is not available. Available: acme/judge/completeness, rubric.'
    );
  });

  it('installs the same plugin twice as a no-op', () => {
    const plugin = acme();
    installPlugins([plugin]);
    installPlugins([plugin]);
    // A rebuilt object over the same definitions is the same plugin.
    installPlugins([acme()]);

    expect(loadedNamespaces()).toEqual(['acme']);
    expect(getJudge('acme/judge/completeness')).toBe(judge);
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
    expect(getClient('claude-code')).toBeDefined();
  });
});

describe('extension kinds in references', () => {
  it.each(['acme/', '@scope/pkg', 'acme//x'])(
    'rejects %s, which is not an extension name',
    (reference) => {
      expect(() => getJudge(reference)).toThrow(
        'is not an extension name: use "<namespace>/judge/<name>"'
      );
    }
  );

  it('treats an inherited key as an unknown kind', () => {
    expect(() => getJudge('acme/constructor/x')).toThrow(
      'has an unknown kind "constructor"'
    );
  });

  const source = {
    schema,
    load: async () => ({ name: 'x', cases: [] }),
  };

  it('rejects a two-part namespace/name and names the full reference', () => {
    installPlugins([acme()]);

    expect(() => getJudge('acme/completeness')).toThrow(
      'Judge "acme/completeness" needs its kind: use "acme/judge/completeness".'
    );
    expect(() => getDatasetSource('acme/cases')).toThrow(
      'Dataset source "acme/cases" needs its kind: use "acme/dataset/cases".'
    );
  });

  it('rejects an extension of one kind used as another', () => {
    installPlugins([acme({ judges: { x: judge } })]);

    expect(() => getDatasetSource('acme/judge/x')).toThrow(
      '"acme/judge/x" is a judge, not a dataset source.'
    );
    expect(() => getJudge('acme/pairwise-judge/x')).toThrow(
      '"acme/pairwise-judge/x" is a pairwise judge, not a judge.'
    );
    // With the right article for a kind that starts with a vowel.
    expect(() => getJudge('acme/env/x')).toThrow(
      '"acme/env/x" is an environment, not a judge.'
    );
  });

  it('rejects an unknown kind and names the right one', () => {
    installPlugins([acme()]);

    expect(() => getJudge('acme/judges/completeness')).toThrow(
      'Judge "acme/judges/completeness" has an unknown kind "judges": use "acme/judge/completeness".'
    );
  });

  it('keeps plugin keys apart from kind segments', () => {
    installPlugins([
      acme({ judges: { x: judge }, datasetSources: { x: source } }),
    ]);

    expect(getJudge('acme/judge/x')).toBe(judge);
    expect(getDatasetSource('acme/dataset/x')).toBe(source);
  });

  it('resolves built-ins by their full mst/<kind>/<name> name', () => {
    expect(getJudge('mst/judge/rubric')).toBe(getJudge('rubric'));
    expect(getDatasetSource('mst/dataset/file')).toBe(getDatasetSource('file'));
    expect(getClient('mst/client/mst')).toBe(getClient('mst'));
    expect(getMetric('mst/metric/passed')).toBe(getMetric('passed'));
    expect(getResultStore('mst/result-store/file')).toBe(
      getResultStore('file')
    );
  });

  it('checks the kind of an mst/ reference too', () => {
    expect(() => getDatasetSource('mst/judge/rubric')).toThrow(
      '"mst/judge/rubric" is a judge, not a dataset source.'
    );
    expect(() => getJudge('mst/judge/missing')).toThrow(
      'Judge "mst/judge/missing" is not available.'
    );
  });

  it('suggests the full name for a bare name only a plugin has', () => {
    installPlugins([acme({ judges: { x: judge } })]);

    expect(() => getJudge('x')).toThrow(
      '"x" is not a built-in judge. Did you mean "acme/judge/x"?'
    );
  });

  it('resolves a scoped namespace', () => {
    installPlugins([
      acme({ meta: { name: '@scope/pkg', namespace: '@scope/pkg' } }),
    ]);

    expect(getJudge('@scope/pkg/judge/completeness')).toBe(judge);
    expect(() => getJudge('@scope/pkg/completeness')).toThrow(
      'Judge "@scope/pkg/completeness" needs its kind: use "@scope/pkg/judge/completeness".'
    );
  });
});
