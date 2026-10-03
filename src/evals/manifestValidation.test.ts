import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { validateManifest } from './manifestValidation.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type {
  DatasetSource,
  HostDefinition,
  JudgeDefinition,
  MetricDefinition,
  ResultStoreDefinition,
} from './evalFrameworkTypes.js';
import type { EvalManifest } from './evalManifest.js';

const schema = z.object({}).passthrough();

type TestExtensions = Omit<Plugin, 'meta' | 'configs'>;

function baseExtensions(): Required<TestExtensions> {
  const datasetSource: DatasetSource = {
    schema,
    load: async () => ({ name: 'file', cases: [] }),
  };
  const host: HostDefinition = {
    schema,
    createConfig: () => ({ hostType: 'sdk' }),
  };
  const judge: JudgeDefinition = {
    schema,
    evaluate: async () => ({ score: 1 }),
  };
  const metric: MetricDefinition = {
    schema,
    kind: 'binary',
    compute: () => true,
  };
  const resultStore: ResultStoreDefinition = {
    schema,
    create: () => {
      throw new Error('not used in manifest validation');
    },
  };
  return {
    datasetSources: { file: datasetSource },
    hosts: { sdk: host },
    judges: { correctness: judge },
    metrics: { passed: metric },
    resultStores: { file: resultStore },
  };
}

/** Install one `test` plugin: the base extensions plus `extra`, per kind. */
function installTestPlugin(extra: TestExtensions = {}): void {
  const base = baseExtensions();
  const plugin: Plugin = {
    meta: { name: 'test-plugin', namespace: 'test' },
    datasetSources: { ...base.datasetSources, ...extra.datasetSources },
    hosts: { ...base.hosts, ...extra.hosts },
    judges: { ...base.judges, ...extra.judges },
    metrics: { ...base.metrics, ...extra.metrics },
    resultStores: { ...base.resultStores, ...extra.resultStores },
  };
  installPlugins([plugin]);
}

afterEach(() => resetPluginsForTests());

describe('manifest validation', () => {
  it('validates all manifest references and labeled server sets', () => {
    installTestPlugin();
    const manifest: EvalManifest = {
      name: 'search',
      datasets: [{ type: 'test/file', path: './search.json' }],
      servers: [
        { transport: 'http', serverUrl: 'https://one.example', label: 'one' },
        { transport: 'http', serverUrl: 'https://two.example', label: 'two' },
      ],
      host: { type: 'test/sdk' },
      metrics: [{ type: 'test/passed' }],
      judges: [{ type: 'test/correctness' }],
      results: { store: { type: 'test/file' } },
      arms: [{ name: 'baseline', servers: [] }],
    };

    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it.each(['dataset', 'host', 'judge'] as const)(
    'rejects a %s reference to a namespace the suite does not load',
    (kind) => {
      installTestPlugin({
        datasetSources: {
          x: { schema, load: async () => ({ name: 'x', cases: [] }) },
        },
        hosts: { x: { schema, createConfig: () => ({ hostType: 'sdk' }) } },
        judges: { x: { schema, evaluate: async () => ({ score: 1 }) } },
      });
      const manifest: EvalManifest = {
        name: 'namespaces',
        datasets: [{ type: 'test/file' }],
      };
      if (kind === 'dataset') manifest.datasets = [{ type: 'test/x' }];
      if (kind === 'host') manifest.host = { type: 'test/x' };
      if (kind === 'judge') manifest.judges = [{ type: 'test/x' }];

      // The plugin is installed process-wide, but this suite didn't list it.
      expect(() => validateManifest(manifest, { namespaces: [] })).toThrow(
        /references "test\/[a-z]+", but doesn't load the "test" plugin/
      );
      expect(() => validateManifest(manifest, { namespaces: [] })).toThrow(
        `doesn't load the "test" plugin`
      );
      expect(() =>
        validateManifest(manifest, { namespaces: ['test'] })
      ).not.toThrow();
    }
  );

  it("validates the metric a spec's metric key names, against its own schema", () => {
    installTestPlugin();
    const manifest: EvalManifest = {
      name: 'metric-key',
      datasets: [{ type: 'file', path: './search.json' }],
      metrics: [{ type: 'passed', metric: 'test/missing' }],
    };

    expect(() => validateManifest(manifest, { namespaces: ['test'] })).toThrow(
      'Metric "test/missing" is not available.'
    );
  });

  it('checks the metric a metric spec names, not only its type', () => {
    const manifest: EvalManifest = {
      name: 'metric-key',
      datasets: [{ type: 'file', path: './search.json' }],
      // resolveMetric prefers `metric` over `type`.
      metrics: [{ type: 'passed', metric: 'test/hits' }],
    };

    expect(() => validateManifest(manifest, { namespaces: [] })).toThrow(
      `references "test/hits", but doesn't load the "test" plugin`
    );
  });

  it('parses every extension schema and preserves defaults, transforms, and routing aliases', () => {
    const optionsSchema = z.object({
      count: z
        .number()
        .default(2)
        .transform((value) => value * 3),
    });
    installTestPlugin({
      datasetSources: {
        custom: {
          schema: optionsSchema,
          load: async () => ({ name: 'data', cases: [] }),
        },
      },
      hosts: {
        custom: {
          schema: optionsSchema,
          createConfig: () => ({ hostType: 'sdk' }),
        },
      },
      judges: {
        custom: {
          schema: optionsSchema,
          evaluate: async () => ({ score: 1 }),
        },
      },
      metrics: {
        custom: {
          schema: optionsSchema,
          kind: 'binary',
          compute: () => true,
        },
      },
      resultStores: {
        custom: {
          schema: optionsSchema,
          create: () => {
            throw new Error('unused');
          },
        },
      },
    });
    const manifest: EvalManifest = {
      name: 'parsed',
      datasets: [{ type: 'test/custom', ignored: true }],
      host: { type: 'test/custom' },
      metrics: [{ type: 'test/custom', name: 'alias' }],
      judges: [{ type: 'test/custom' }],
      results: { store: { type: 'test/custom' } },
      arms: [
        { name: 'inherited' },
        {
          name: 'override',
          host: { type: 'test/custom', count: 4 },
          metrics: [],
          judges: [],
        },
      ],
    };
    const parsed = validateManifest(manifest);
    expect(parsed.datasets).toEqual([{ type: 'test/custom', count: 6 }]);
    expect(parsed.host).toEqual({ type: 'test/custom', count: 6 });
    expect(parsed.metrics).toEqual([
      { type: 'test/custom', name: 'alias', count: 6 },
    ]);
    expect(parsed.judges).toEqual([{ type: 'test/custom', count: 6 }]);
    expect(parsed.results?.store).toEqual({ type: 'test/custom', count: 6 });
    expect(parsed.arms?.[0]?.host).toEqual(parsed.host);
    expect(parsed.arms?.[0]?.metrics).toEqual(parsed.metrics);
    expect(parsed.arms?.[1]?.host).toEqual({ type: 'test/custom', count: 12 });
    expect(parsed.arms?.[1]?.metrics).toEqual([]);
    expect(manifest.datasets[0]).toEqual({
      type: 'test/custom',
      ignored: true,
    });
  });

  it('accepts the built-in rubric judge and checks its options', () => {
    installTestPlugin();
    const manifest: EvalManifest = {
      name: 'rubric-judges',
      datasets: [{ type: 'test/file' }],
      judges: [{ type: 'rubric', rubric: 'correctness', threshold: 0.8 }],
    };
    expect(validateManifest(manifest).judges).toEqual([
      { type: 'rubric', rubric: 'correctness', threshold: 0.8 },
    ]);
    expect(() =>
      validateManifest({
        ...manifest,
        judges: [{ type: 'rubric', rubric: 'not-a-rubric' }],
      })
    ).toThrow(/Invalid judge options "rubric"/);
  });

  it('preserves framework judge settings when policy schemas strip unknown fields', () => {
    installTestPlugin({
      judges: {
        policy: {
          schema: z.object({
            count: z.number().transform((value) => value * 3),
          }),
          evaluate: async () => ({ score: 0.8 }),
        },
      },
    });
    const manifest: EvalManifest = {
      name: 'judge-settings',
      datasets: [{ type: 'test/file' }],
      judges: [
        {
          type: 'test/policy',
          count: 2,
          threshold: 0.9,
          reference: 'base-gold',
        },
      ],
      arms: [
        { name: 'inherited' },
        {
          name: 'override',
          judges: [
            {
              type: 'test/policy',
              count: 4,
              threshold: 0,
              reference: 'arm-gold',
            },
          ],
        },
      ],
    };
    const parsed = validateManifest(manifest);
    expect(parsed.judges).toEqual([
      { type: 'test/policy', count: 6, threshold: 0.9, reference: 'base-gold' },
    ]);
    expect(parsed.arms?.[0]?.judges).toEqual(parsed.judges);
    expect(parsed.arms?.[1]?.judges).toEqual([
      { type: 'test/policy', count: 12, threshold: 0, reference: 'arm-gold' },
    ]);
    expect(manifest.judges?.[0]?.count).toBe(2);
  });

  it.each([
    'dataset',
    'host',
    'metric',
    'judge',
    'store',
    'armHost',
    'armMetric',
    'armJudge',
  ] as const)('rejects invalid plugin %s options', (kind) => {
    const required = z.object({ required: z.number() });
    installTestPlugin({
      datasetSources: {
        strict: {
          schema: required,
          load: async () => ({ name: 'data', cases: [] }),
        },
      },
      hosts: {
        strict: {
          schema: required,
          createConfig: () => ({ hostType: 'sdk' }),
        },
      },
      metrics: {
        strict: {
          schema: required,
          kind: 'binary',
          compute: () => true,
        },
      },
      judges: {
        strict: {
          schema: required,
          evaluate: async () => ({ score: 1 }),
        },
      },
      resultStores: {
        strict: {
          schema: required,
          create: () => {
            throw new Error('unused');
          },
        },
      },
    });
    const config = { type: 'test/strict', required: 'invalid' };
    const manifest: EvalManifest = {
      name: 'invalid-options',
      datasets: [{ type: 'test/file' }],
    };
    if (kind === 'dataset') manifest.datasets = [config];
    if (kind === 'host') manifest.host = config;
    if (kind === 'metric') manifest.metrics = [config];
    if (kind === 'judge') manifest.judges = [config];
    if (kind === 'store') manifest.results = { store: config };
    if (kind === 'armHost') manifest.arms = [{ name: 'arm', host: config }];
    if (kind === 'armMetric')
      manifest.arms = [{ name: 'arm', metrics: [config] }];
    if (kind === 'armJudge')
      manifest.arms = [{ name: 'arm', judges: [config] }];
    expect(() => validateManifest(manifest)).toThrow(
      /Invalid .* options "test\/strict"/
    );
  });

  it('validates effective top-level host options in arm overrides', () => {
    installTestPlugin({
      hosts: {
        limited: {
          schema: z.object({
            maxToolCalls: z.number().max(2),
            model: z.string().default('default'),
          }),
          createConfig: () => ({ hostType: 'sdk' }),
        },
      },
    });
    const manifest: EvalManifest = {
      name: 'effective',
      datasets: [{ type: 'test/file' }],
      maxToolCalls: 5,
      arms: [{ name: 'arm', host: { type: 'test/limited' } }],
    };
    expect(() => validateManifest(manifest)).toThrow(
      'Invalid host options "test/limited"'
    );
    const parsed = validateManifest({
      ...manifest,
      maxToolCalls: 2,
    });
    expect(parsed.arms?.[0]?.host).toEqual({
      type: 'test/limited',
      maxToolCalls: 2,
      model: 'default',
    });
    expect(
      validateManifest({
        ...manifest,
        arms: [
          { name: 'arm', host: { type: 'test/limited', maxToolCalls: 1 } },
        ],
      }).arms?.[0]?.host?.maxToolCalls
    ).toBe(1);
  });

  it('rejects an unknown extension or duplicate server label', () => {
    installTestPlugin();
    expect(() =>
      validateManifest({
        name: 'invalid',
        datasets: [{ type: 'missing' }],
      })
    ).toThrow('Dataset source "missing" is not available');
    expect(() =>
      validateManifest({
        name: 'invalid',
        datasets: [{ type: 'test/missing' }],
      })
    ).toThrow('Dataset source "test/missing" is not available');
    expect(() =>
      validateManifest({
        name: 'unloaded',
        datasets: [{ type: 'other/file' }],
      })
    ).toThrow(
      'Dataset source "other/file" needs the "other" plugin, which is not loaded.'
    );

    expect(() =>
      validateManifest({
        name: 'duplicate-labels',
        datasets: [{ type: 'test/file' }],
        servers: [
          {
            transport: 'http',
            serverUrl: 'https://one.example',
            label: 'same',
          },
          {
            transport: 'http',
            serverUrl: 'https://two.example',
            label: 'same',
          },
        ],
      })
    ).toThrow('MCP server labels must be unique');
  });
});
