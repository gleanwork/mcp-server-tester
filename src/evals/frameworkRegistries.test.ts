import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDatasetSources,
  clearHosts,
  clearJudges,
  clearMetrics,
  clearResultStores,
  registerDatasetSource,
  registerHost,
  registerJudge,
  registerMetric,
  registerResultStore,
  validateManifestRegistrations,
} from './frameworkRegistries.js';
import type {
  DatasetSource,
  HostDefinition,
  JudgeDefinition,
  MetricDefinition,
  ResultStoreDefinition,
} from './evalFrameworkTypes.js';
import type { EvalManifest } from './evalManifest.js';

const schema = z.object({}).passthrough();

function registerAll(): void {
  const datasetSource: DatasetSource = {
    name: 'file',
    schema,
    load: async () => ({ name: 'file', cases: [] }),
  };
  const host: HostDefinition = {
    name: 'sdk',
    schema,
    createConfig: () => ({ hostType: 'sdk' }),
  };
  const judge: JudgeDefinition = {
    name: 'correctness',
    schema,
    evaluate: async () => ({ score: 1 }),
  };
  const metric: MetricDefinition = {
    name: 'passed',
    schema,
    kind: 'binary',
    compute: () => true,
  };
  const resultStore: ResultStoreDefinition = {
    name: 'file',
    schema,
    create: () => {
      throw new Error('not used in registry validation');
    },
  };
  registerDatasetSource(datasetSource);
  registerHost(host);
  registerJudge(judge);
  registerMetric(metric);
  registerResultStore(resultStore);
}

afterEach(() => {
  clearDatasetSources();
  clearHosts();
  clearJudges();
  clearMetrics();
  clearResultStores();
});

describe('framework registries', () => {
  it('validates all manifest references and labeled server sets', () => {
    registerAll();
    const manifest: EvalManifest = {
      name: 'search',
      datasets: [{ type: 'file', path: './search.json' }],
      servers: [
        { transport: 'http', serverUrl: 'https://one.example', label: 'one' },
        { transport: 'http', serverUrl: 'https://two.example', label: 'two' },
      ],
      host: { type: 'sdk' },
      metrics: [{ type: 'passed' }],
      judges: [{ type: 'correctness' }],
      results: { store: { type: 'file' } },
      arms: [{ name: 'baseline', servers: [] }],
    };

    expect(() => validateManifestRegistrations(manifest)).not.toThrow();
  });

  it('parses every extension schema and preserves defaults, transforms, and routing aliases', () => {
    const optionsSchema = z.object({
      count: z
        .number()
        .default(2)
        .transform((value) => value * 3),
    });
    registerDatasetSource({
      name: 'custom',
      schema: optionsSchema,
      load: async () => ({ name: 'data', cases: [] }),
    });
    registerHost({
      name: 'custom',
      schema: optionsSchema,
      createConfig: () => ({ hostType: 'sdk' }),
    });
    registerJudge({
      name: 'custom',
      schema: optionsSchema,
      evaluate: async () => ({ score: 1 }),
    });
    registerMetric({
      name: 'custom',
      schema: optionsSchema,
      kind: 'binary',
      compute: () => true,
    });
    registerResultStore({
      name: 'custom',
      schema: optionsSchema,
      create: () => {
        throw new Error('unused');
      },
    });
    const manifest: EvalManifest = {
      name: 'parsed',
      datasets: [{ type: 'custom', ignored: true }],
      host: { type: 'custom' },
      metrics: [{ type: 'custom', name: 'alias' }],
      judges: [{ type: 'custom' }],
      results: { store: { type: 'custom' } },
      arms: [
        { name: 'inherited' },
        {
          name: 'override',
          host: { type: 'custom', count: 4 },
          metrics: [],
          judges: [],
        },
      ],
    };
    const parsed = validateManifestRegistrations(manifest);
    expect(parsed.datasets).toEqual([{ type: 'custom', count: 6 }]);
    expect(parsed.host).toEqual({ type: 'custom', count: 6 });
    expect(parsed.metrics).toEqual([
      { type: 'custom', name: 'alias', count: 6 },
    ]);
    expect(parsed.judges).toEqual([{ type: 'custom', count: 6 }]);
    expect(parsed.results?.store).toEqual({ type: 'custom', count: 6 });
    expect(parsed.arms?.[0]?.host).toEqual(parsed.host);
    expect(parsed.arms?.[0]?.metrics).toEqual(parsed.metrics);
    expect(parsed.arms?.[1]?.host).toEqual({ type: 'custom', count: 12 });
    expect(parsed.arms?.[1]?.metrics).toEqual([]);
    expect(manifest.datasets[0]).toEqual({ type: 'custom', ignored: true });
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
  ] as const)('rejects invalid registered %s options', (kind) => {
    registerAll();
    const required = z.object({ required: z.number() });
    registerDatasetSource({
      name: 'strict',
      schema: required,
      load: async () => ({ name: 'data', cases: [] }),
    });
    registerHost({
      name: 'strict',
      schema: required,
      createConfig: () => ({ hostType: 'sdk' }),
    });
    registerMetric({
      name: 'strict',
      schema: required,
      kind: 'binary',
      compute: () => true,
    });
    registerJudge({
      name: 'strict',
      schema: required,
      evaluate: async () => ({ score: 1 }),
    });
    registerResultStore({
      name: 'strict',
      schema: required,
      create: () => {
        throw new Error('unused');
      },
    });
    const config = { type: 'strict', required: 'invalid' };
    const manifest: EvalManifest = {
      name: 'invalid-options',
      datasets: [{ type: 'file' }],
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
    expect(() => validateManifestRegistrations(manifest)).toThrow(
      /Invalid .* options "strict"/
    );
  });

  it('validates effective top-level host options in arm overrides', () => {
    registerAll();
    registerHost({
      name: 'limited',
      schema: z.object({
        maxToolCalls: z.number().max(2),
        model: z.string().default('default'),
      }),
      createConfig: () => ({ hostType: 'sdk' }),
    });
    const manifest: EvalManifest = {
      name: 'effective',
      datasets: [{ type: 'file' }],
      maxToolCalls: 5,
      arms: [{ name: 'arm', host: { type: 'limited' } }],
    };
    expect(() => validateManifestRegistrations(manifest)).toThrow(
      'Invalid host options "limited"'
    );
    const parsed = validateManifestRegistrations({
      ...manifest,
      maxToolCalls: 2,
    });
    expect(parsed.arms?.[0]?.host).toEqual({
      type: 'limited',
      maxToolCalls: 2,
      model: 'default',
    });
    expect(
      validateManifestRegistrations({
        ...manifest,
        arms: [{ name: 'arm', host: { type: 'limited', maxToolCalls: 1 } }],
      }).arms?.[0]?.host?.maxToolCalls
    ).toBe(1);
  });

  it('rejects an unknown extension or duplicate server label', () => {
    registerAll();
    expect(() =>
      validateManifestRegistrations({
        name: 'invalid',
        datasets: [{ type: 'missing' }],
      })
    ).toThrow('Dataset source "missing" is not registered');

    expect(() =>
      validateManifestRegistrations({
        name: 'duplicate-labels',
        datasets: [{ type: 'file' }],
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
