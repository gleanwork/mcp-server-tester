import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { assertPlugin, parseExtensionReference } from './plugin.js';

const schema = z.object({}).passthrough();

function plugin(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { meta: { name: 'acme-plugin', namespace: 'acme' }, ...extra };
}

describe('assertPlugin', () => {
  it('accepts every extension kind', () => {
    const value = plugin({
      datasetSources: { legacy: { schema, load: async () => ({}) } },
      clients: { desk: { schema, run: async () => ({}) } },
      judges: { complete: { schema, evaluate: async () => ({ score: 1 }) } },
      metrics: { hits: { schema, kind: 'continuous', compute: () => 1 } },
      resultStores: { bucket: { schema, create: () => ({}) } },
      environments: { vm: { schema, open: async () => ({}) } },
      configs: { recommended: {} },
    });

    expect(assertPlugin(value, './acme.js')).toBe(value);
  });

  it('accepts a scoped namespace', () => {
    const value = plugin({ meta: { name: 'x', namespace: '@acme/tools' } });
    expect(() => assertPlugin(value, 'x')).not.toThrow();
  });

  it.each([
    [undefined, 'meta.namespace is required'],
    ['Acme', 'meta.namespace must be lowercase'],
    ['acme/tools', 'meta.namespace must be lowercase'],
    ['mst', 'meta.namespace "mst" is reserved for MST\'s built-ins'],
  ])('rejects namespace %s', (namespace, message) => {
    const value = plugin({ meta: { name: 'x', namespace } });
    expect(() => assertPlugin(value, './x.js')).toThrow(message);
  });

  it('requires a metric kind', () => {
    const metric = { schema: z.object({}), compute: () => 1 };

    expect(() =>
      assertPlugin(
        {
          meta: { name: 'acme', namespace: 'acme' },
          metrics: { hits: metric },
        },
        'inline'
      )
    ).toThrow(
      'Invalid plugin "acme": metrics.hits needs a kind: binary, continuous, categorical, object.'
    );
  });

  it('rejects a module that still exports a register function', () => {
    expect(() => assertPlugin(() => undefined, './old.js')).toThrow(
      'Plugin at ./old.js exports a function. MST 2.0 plugins are objects'
    );
    expect(() =>
      assertPlugin({ register: () => undefined }, './old.js')
    ).toThrow('Plugin at ./old.js exports a function. MST 2.0 plugins');
  });

  it('rejects unknown top-level keys', () => {
    expect(() => assertPlugin(plugin({ rules: {} }), './x.js')).toThrow(
      'Invalid plugin "acme-plugin": unknown key "rules"'
    );
  });

  it('rejects extension names that contain a slash', () => {
    const value = plugin({
      judges: { 'a/b': { schema, evaluate: async () => ({ score: 1 }) } },
    });
    expect(() => assertPlugin(value, './x.js')).toThrow(
      'Invalid plugin "acme-plugin": judges."a/b" is not a valid name'
    );
  });

  it.each([
    ['datasetSources', { schema }, 'datasetSources.x needs a load function'],
    ['clients', { schema }, 'clients.x needs a run or runBatch function'],
    [
      'clients',
      {
        schema,
        run: async () => ({ finalText: '', events: [] }),
        toolOverrides: true,
      },
      'clients.x: `toolOverrides` is now `toolMetadata`',
    ],
    ['judges', { schema }, 'judges.x needs an evaluate function'],
    [
      'metrics',
      { schema, kind: 'binary' },
      'metrics.x needs a compute function',
    ],
    ['resultStores', { schema }, 'resultStores.x needs a create function'],
    ['environments', { schema }, 'environments.x needs an open function'],
    [
      'environments',
      { schema, open: async () => ({}), maxShards: 0 },
      'environments.x: maxShards must be a positive integer',
    ],
    [
      'judges',
      { evaluate: async () => ({ score: 1 }) },
      'judges.x needs a Zod schema',
    ],
  ])('checks the %s contract', (kind, definition, message) => {
    expect(() =>
      assertPlugin(plugin({ [kind]: { x: definition } }), './x.js')
    ).toThrow(message);
  });
});

describe('parseExtensionReference', () => {
  it.each([
    // A bare name is a built-in.
    ['file', { name: 'file' }],
    [
      'acme/judge/quality',
      { namespace: 'acme', kind: 'judge', name: 'quality' },
    ],
    [
      'acme/pairwise-judge/prefer',
      { namespace: 'acme', kind: 'pairwise-judge', name: 'prefer' },
    ],
    [
      'acme/result-store/bucket',
      { namespace: 'acme', kind: 'result-store', name: 'bucket' },
    ],
    [
      'acme/config/recommended',
      { namespace: 'acme', kind: 'config', name: 'recommended' },
    ],
    ['mst/judge/rubric', { namespace: 'mst', kind: 'judge', name: 'rubric' }],
    [
      '@scope/pkg/judge/x',
      { namespace: '@scope/pkg', kind: 'judge', name: 'x' },
    ],
    // Two parts: no kind, which lookups reject with the full name.
    ['acme/legacy', { namespace: 'acme', name: 'legacy' }],
    ['@acme/tools/legacy', { namespace: '@acme/tools', name: 'legacy' }],
    // An unknown kind is kept so the lookup can name it.
    ['acme/judges/x', { namespace: 'acme', kind: 'judges', name: 'x' }],
    [
      '@scope/pkg/widget/x',
      { namespace: '@scope/pkg', kind: 'widget', name: 'x' },
    ],
    ['acme/a/b/c', { namespace: 'acme', kind: 'a/b', name: 'c' }],
  ])('parses %s', (reference, expected) => {
    expect(parseExtensionReference(reference)).toEqual(expected);
  });
});
