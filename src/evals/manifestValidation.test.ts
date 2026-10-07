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
import { clientPatchOf } from './clientFields.js';

const schema = z.object({}).passthrough();

type TestExtensions = Omit<Plugin, 'meta' | 'configs'>;

function baseExtensions(): Required<TestExtensions> {
  const datasetSource: DatasetSource = {
    schema,
    load: async () => ({ name: 'file', cases: [] }),
  };
  const host: ClientDefinition = {
    schema,
    run: async () => ({ finalText: '', events: [] }),
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
      client: 'test/sdk',
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
        clients: {
          x: { schema, run: async () => ({ finalText: '', events: [] }) },
        },
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
          run: async () => ({ finalText: '', events: [] }),
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
      client: 'test/custom',
      metrics: [{ type: 'test/custom', name: 'alias' }],
      judges: [{ type: 'test/custom' }],
      results: { store: { type: 'test/custom' } },
      arms: [
        { name: 'inherited' },
        {
          name: 'override',
          client: 'test/custom',
          clientOptions: { count: 4 },
          metrics: [],
          judges: [],
        },
      ],
    };
    const parsed = validateManifest(manifest);
    expect(parsed.datasets).toEqual([{ type: 'test/custom', count: 6 }]);
    expect(clientPatchOf(parsed)).toEqual({ type: 'test/custom', count: 6 });
    expect(parsed.metrics).toEqual([
      { type: 'test/custom', name: 'alias', count: 6 },
    ]);
    expect(parsed.judges).toEqual([{ type: 'test/custom', count: 6 }]);
    expect(parsed.results?.store).toEqual({ type: 'test/custom', count: 6 });
    expect(clientPatchOf(parsed.arms?.[0])).toEqual(clientPatchOf(parsed));
    expect(parsed.arms?.[0]?.metrics).toEqual(parsed.metrics);
    expect(clientPatchOf(parsed.arms?.[1])).toEqual({
      type: 'test/custom',
      count: 12,
    });
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
          run: async () => ({ finalText: '', events: [] }),
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
    if (kind === 'host') {
      const { type, ...options } = config;
      manifest.client = type;
      manifest.clientOptions = options;
    }
    if (kind === 'metric') manifest.metrics = [config];
    if (kind === 'judge') manifest.judges = [config];
    if (kind === 'store') manifest.results = { store: config };
    if (kind === 'armHost') {
      const { type, ...options } = config;
      manifest.arms = [{ name: 'arm', client: type, clientOptions: options }];
    }
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
          run: async () => ({ finalText: '', events: [] }),
        },
      },
    });
    const manifest: EvalManifest = {
      name: 'effective',
      datasets: [{ type: 'test/file' }],
      maxToolCalls: 5,
      arms: [{ name: 'arm', client: 'test/limited' }],
    };
    expect(() => validateManifest(manifest)).toThrow(
      'Invalid host options "test/limited"'
    );
    const parsed = validateManifest({
      ...manifest,
      maxToolCalls: 2,
    });
    expect(clientPatchOf(parsed.arms?.[0])).toEqual({
      type: 'test/limited',
      maxToolCalls: 2,
      model: 'default',
    });
    expect(
      clientPatchOf(
        validateManifest({
          ...manifest,
          arms: [
            {
              name: 'arm',
              client: 'test/limited',
              clientOptions: { maxToolCalls: 1 },
            },
          ],
        }).arms?.[0]
      )?.maxToolCalls
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

  it.each(['chatgpt', 'test/elsewhere'])(
    'rejects toolOverrides for %s, which never shows them to the model',
    (type) => {
      installHosts();
      const client =
        type === 'chatgpt'
          ? { client: type, model: 'gpt-5' }
          : { client: type };
      expect(() =>
        validateManifest(base({ ...client, toolOverrides: overrides }), {
          namespaces: ['test'],
        })
      ).toThrow(`The manifest: client "${type}" can't apply toolOverrides;`);
    }
  );

  it.each(['claude-code', 'test/runner'])(
    'accepts toolOverrides for %s, served through the tool-variant proxy',
    (type) => {
      installHosts();
      expect(() =>
        validateManifest(base({ client: type, toolOverrides: overrides }), {
          namespaces: ['test'],
        })
      ).not.toThrow();
    }
  );

  it('accepts toolOverrides for cowork, served through the tool-variant proxy', () => {
    expect(() =>
      validateManifest(base({ client: 'cowork', toolOverrides: overrides }))
    ).not.toThrow();
  });

  it('rejects toolOverrides on the arm that sets them, and accepts them for mst', () => {
    installTestPlugin();
    const manifest = base({
      client: 'mst',
      clientOptions: { provider: 'anthropic' },
      arms: [
        { name: 'sdk', toolOverrides: overrides },
        {
          name: 'desktop',
          client: 'chatgpt',
          model: 'gpt-5',
          toolOverrides: overrides,
        },
      ],
    });
    expect(() => validateManifest(manifest, { namespaces: ['test'] })).toThrow(
      `Arm "desktop": client "chatgpt" can't apply toolOverrides;`
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
          client: 'claude-code',
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
      validateManifest(
        base({ client: 'mst', clientOptions: { reasoningEffort: 'high' } })
      )
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
          client: type,
          ...extra,
          clientOptions: { systemPrompt: 'Use find_skills first.' },
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
            client: type,
            ...extra,
            clientOptions: { systemPrompt: 'Use find_skills first.' },
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
        client: 'mst',
        arms: [{ name: 'mst' }, { name: 'code', client: 'claude-code' }],
      })
    );
    expect(clientPatchOf(validated.arms?.[0])).toMatchObject({
      type: 'mst',
      model: 'claude-sonnet-4-6',
      temperature: 0.2,
    });
    expect(clientPatchOf(validated.arms?.[1])).toMatchObject({
      type: 'claude-code',
      model: 'claude-sonnet-4-6',
    });
    expect(clientPatchOf(validated.arms?.[1])).not.toHaveProperty(
      'temperature'
    );
  });

  it('rejects a default that none of the hosts takes', () => {
    expect(() =>
      validateManifest(manifest({ temperature: 0.2, client: 'claude-code' }))
    ).toThrow(
      `The manifest sets "temperature", but none of its clients (claude-code) takes it.`
    );
  });

  it("doesn't give an arm the options of a different host", () => {
    const validated = validateManifest(
      manifest({
        client: 'mst',
        clientOptions: { provider: 'openai', apiKeyEnvVar: 'KEY' },
        arms: [{ name: 'code', client: 'claude-code' }],
      })
    );
    expect(clientPatchOf(validated.arms?.[0])).not.toHaveProperty(
      'apiKeyEnvVar'
    );
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
        manifest({ client: 'test/variants', toolOverrides: overrides }),
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
      validateManifest(manifest({ client: 'test/serial', concurrency: 4 }), {
        namespaces: ['test'],
      })
    ).toThrow(
      'client "test/serial" runs at most 1 case at a time; set concurrency to 1.'
    );
  });
});
