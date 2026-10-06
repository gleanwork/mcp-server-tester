import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { validateManifest } from './manifestValidation.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type {
  DatasetSource,
  ClientDefinition,
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
  const host: ClientDefinition = {
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
    clients: { sdk: host },
    judges: { correctness: judge },
    pairwiseJudges: {},
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
    clients: { ...base.clients, ...extra.clients },
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
        clients: { x: { schema, createConfig: () => ({ hostType: 'sdk' }) } },
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
      clients: {
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
      clients: {
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
      clients: {
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

describe('settings a host would ignore', () => {
  const overrides = {
    id: 'v2',
    tools: { search: { description: 'Find it.' } },
  };
  const base = (extra: Record<string, unknown>): EvalManifest => ({
    name: 'loud',
    datasets: [{ type: 'file', path: 'x.json' }],
    ...extra,
  });

  function installHosts() {
    installTestPlugin({
      clients: {
        runner: { schema, run: async () => ({ finalText: '', events: [] }) },
        elsewhere: {
          schema,
          toolSurfaceProxy: false,
          run: async () => ({ finalText: '', events: [] }),
        },
      },
    });
  }

  it.each(['cowork', 'chatgpt', 'test/elsewhere'])(
    'rejects toolOverrides for %s, which never shows them to the model',
    (type) => {
      installHosts();
      const host = type === 'chatgpt' ? { type, model: 'gpt-5' } : { type };
      expect(() =>
        validateManifest(base({ host, toolOverrides: overrides }), {
          namespaces: ['test'],
        })
      ).toThrow(`The manifest: host "${type}" can't apply toolOverrides;`);
    }
  );

  it.each(['claude-code', 'test/runner'])(
    'accepts toolOverrides for %s, served through the tool-variant proxy',
    (type) => {
      installHosts();
      expect(() =>
        validateManifest(base({ host: { type }, toolOverrides: overrides }), {
          namespaces: ['test'],
        })
      ).not.toThrow();
    }
  );

  it('rejects toolOverrides on the arm that sets them, and accepts them for vercel-sdk', () => {
    installTestPlugin();
    const manifest = base({
      host: { type: 'mst', provider: 'anthropic' },
      arms: [
        { name: 'sdk', toolOverrides: overrides },
        { name: 'desktop', host: { type: 'cowork' }, toolOverrides: overrides },
      ],
    });
    expect(() => validateManifest(manifest, { namespaces: ['test'] })).toThrow(
      `Arm "desktop": host "cowork" can't apply toolOverrides;`
    );
    expect(() =>
      validateManifest(
        { ...manifest, arms: [manifest.arms![0]!] },
        { namespaces: ['test'] }
      )
    ).not.toThrow();
  });

  it('rejects connection policy claude-code would drop, before anything runs', () => {
    expect(() =>
      validateManifest(
        base({
          host: { type: 'claude-code' },
          servers: [
            {
              transport: 'http',
              serverUrl: 'https://mcp.example.com',
              proxy: { url: 'http://proxy.example.com' },
            },
          ],
        })
      )
    ).toThrow(
      "The manifest: claude-code can't forward proxy for https://mcp.example.com."
    );
  });

  it('rejects an option mst would drop', () => {
    expect(() =>
      validateManifest(base({ host: { type: 'mst', reasoningEffort: 'high' } }))
    ).toThrow(/Unrecognized key.*reasoningEffort/s);
  });

  it.each([
    ['mst', { provider: 'anthropic' }],
    ['mst', {}],
    ['claude-code', {}],
  ])('accepts a systemPrompt for %s', (type, extra) => {
    expect(() =>
      validateManifest(
        base({
          host: { type, ...extra, systemPrompt: 'Use find_skills first.' },
        })
      )
    ).not.toThrow();
  });

  it.each([
    ['cowork', {}],
    ['chatgpt', { model: 'gpt-5' }],
  ])(
    'rejects a systemPrompt for %s, which has no way to apply it',
    (type, extra) => {
      expect(() =>
        validateManifest(
          base({
            host: { type, ...extra, systemPrompt: 'Use find_skills first.' },
          })
        )
      ).toThrow(/systemPrompt/);
    }
  );
});

describe('settings a host would ignore: defaults, inheritance, opt-in', () => {
  const overrides = {
    id: 'v2',
    tools: { search: { description: 'Find it.' } },
  };
  const manifest = (extra: Record<string, unknown>): EvalManifest => ({
    name: 'loud',
    datasets: [{ type: 'file', path: 'x.json' }],
    ...extra,
  });

  it('gives a shared default only to the clients that take it', () => {
    const validated = validateManifest(
      manifest({
        model: 'claude-sonnet-4-6',
        temperature: 0.2,
        host: { type: 'mst' },
        arms: [
          { name: 'mst' },
          { name: 'code', host: { type: 'claude-code' } },
        ],
      })
    );
    expect(validated.arms?.[0]?.host).toMatchObject({
      type: 'mst',
      model: 'claude-sonnet-4-6',
      temperature: 0.2,
    });
    expect(validated.arms?.[1]?.host).toMatchObject({
      type: 'claude-code',
      model: 'claude-sonnet-4-6',
    });
    expect(validated.arms?.[1]?.host).not.toHaveProperty('temperature');
  });

  it('rejects a default that none of the hosts takes', () => {
    expect(() =>
      validateManifest(
        manifest({ temperature: 0.2, host: { type: 'claude-code' } })
      )
    ).toThrow(
      `The manifest sets "temperature", but none of its hosts (claude-code) takes it.`
    );
  });

  it("doesn't give an arm the options of a different host", () => {
    const validated = validateManifest(
      manifest({
        host: { type: 'mst', provider: 'openai', apiKeyEnvVar: 'KEY' },
        arms: [{ name: 'code', host: { type: 'claude-code' } }],
      })
    );
    expect(validated.arms?.[0]?.host).not.toHaveProperty('apiKeyEnvVar');
  });

  it('accepts toolOverrides for a plugin host that applies them', () => {
    installTestPlugin({
      clients: {
        variants: {
          schema,
          toolOverrides: true,
          run: async () => ({ finalText: '', events: [] }),
        },
      },
    });
    expect(() =>
      validateManifest(
        manifest({ host: { type: 'test/variants' }, toolOverrides: overrides }),
        { namespaces: ['test'] }
      )
    ).not.toThrow();
  });

  it('rejects a concurrency the host cannot run', () => {
    installTestPlugin({
      clients: {
        serial: {
          schema,
          maxConcurrency: 1,
          run: async () => ({ finalText: '', events: [] }),
        },
      },
    });
    expect(() =>
      validateManifest(
        manifest({ host: { type: 'test/serial' }, concurrency: 4 }),
        { namespaces: ['test'] }
      )
    ).toThrow(
      'host "test/serial" runs at most 1 case at a time; set concurrency to 1.'
    );
  });
});
