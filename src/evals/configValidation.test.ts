import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEvalConfig } from './configValidation.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type {
  DatasetSource,
  ClientDefinition,
  JudgeDefinition,
  MetricDefinition,
  ResultStoreDefinition,
} from './evalFrameworkTypes.js';
import { loadEvalConfigFromObject, type EvalConfig } from './evalConfig.js';
import { clientPatchOf } from './clientFields.js';

const schema = z.object({}).passthrough();

type TestExtensions = Omit<Plugin, 'meta' | 'configs'>;

function baseExtensions(): Required<TestExtensions> {
  const datasetSource: DatasetSource = {
    schema,
    load: async () => ({ name: 'file', cases: [] }),
  };
  const client: ClientDefinition = {
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
      throw new Error('not used in eval config validation');
    },
  };
  return {
    datasetSources: { file: datasetSource },
    clients: { sdk: client },
    judges: { correctness: judge },
    pairwiseJudges: {},
    metrics: { passed: metric },
    resultStores: { file: resultStore },
    connectors: {},
    environments: {},
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

describe('eval config validation', () => {
  it('validates all eval config references and labeled server sets', () => {
    installTestPlugin();
    const evalConfig: EvalConfig = {
      name: 'search',
      datasets: [{ type: 'test/dataset/file', path: './search.json' }],
      servers: [
        { transport: 'http', serverUrl: 'https://one.example', label: 'one' },
        { transport: 'http', serverUrl: 'https://two.example', label: 'two' },
      ],
      client: 'test/client/sdk',
      metrics: [{ type: 'test/metric/passed' }],
      judges: [{ type: 'test/judge/correctness' }],
      results: { store: { type: 'test/result-store/file' } },
      variants: [{ name: 'baseline', servers: [] }],
    };

    expect(() => validateEvalConfig(evalConfig)).not.toThrow();
  });

  it('rejects a connector server from a namespace the eval does not load', () => {
    const evalConfig: EvalConfig = {
      name: 'namespaces',
      datasets: [{ type: 'file', path: './cases.json' }],
      servers: [{ connector: 'other/connector/slack', label: 'slack' }],
    };
    expect(() => validateEvalConfig(evalConfig, { namespaces: [] })).toThrow(
      `references "other/connector/slack", but doesn't load the "other" plugin`
    );
  });

  it.each(['dataset', 'client', 'judge'] as const)(
    'rejects a %s reference to a namespace the eval does not load',
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
      const evalConfig: EvalConfig = {
        name: 'namespaces',
        datasets: [{ type: 'test/dataset/file' }],
      };
      if (kind === 'dataset')
        evalConfig.datasets = [{ type: 'test/dataset/x' }];
      if (kind === 'client') evalConfig.client = 'test/client/x';
      if (kind === 'judge') evalConfig.judges = [{ type: 'test/judge/x' }];

      // The plugin is installed process-wide, but this eval didn't list it.
      expect(() => validateEvalConfig(evalConfig, { namespaces: [] })).toThrow(
        /references "test\/[a-z-]+\/[a-z]+", but doesn't load the "test" plugin/
      );
      expect(() => validateEvalConfig(evalConfig, { namespaces: [] })).toThrow(
        `doesn't load the "test" plugin`
      );
      expect(() =>
        validateEvalConfig(evalConfig, { namespaces: ['test'] })
      ).not.toThrow();
    }
  );

  it("validates the metric a spec's metric key names, against its own schema", () => {
    installTestPlugin();
    const evalConfig: EvalConfig = {
      name: 'metric-key',
      datasets: [{ type: 'file', path: './search.json' }],
      metrics: [{ type: 'passed', metric: 'test/metric/missing' }],
    };

    expect(() =>
      validateEvalConfig(evalConfig, { namespaces: ['test'] })
    ).toThrow('Metric "test/metric/missing" is not available.');
  });

  it('checks the metric a metric spec names, not only its type', () => {
    const evalConfig: EvalConfig = {
      name: 'metric-key',
      datasets: [{ type: 'file', path: './search.json' }],
      // resolveMetric prefers `metric` over `type`.
      metrics: [{ type: 'passed', metric: 'test/metric/hits' }],
    };

    expect(() => validateEvalConfig(evalConfig, { namespaces: [] })).toThrow(
      `references "test/metric/hits", but doesn't load the "test" plugin`
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
    const evalConfig: EvalConfig = {
      name: 'parsed',
      datasets: [{ type: 'test/dataset/custom', ignored: true }],
      client: 'test/client/custom',
      metrics: [{ type: 'test/metric/custom', name: 'alias' }],
      judges: [{ type: 'test/judge/custom' }],
      results: { store: { type: 'test/result-store/custom' } },
      variants: [
        { name: 'inherited' },
        {
          name: 'override',
          client: 'test/client/custom',
          clientOptions: { count: 4 },
          metrics: [],
          judges: [],
        },
      ],
    };
    const parsed = validateEvalConfig(evalConfig);
    expect(parsed.datasets).toEqual([
      { type: 'test/dataset/custom', count: 6 },
    ]);
    expect(clientPatchOf(parsed)).toEqual({
      type: 'test/client/custom',
      count: 6,
    });
    expect(parsed.metrics).toEqual([
      { type: 'test/metric/custom', name: 'alias', count: 6 },
    ]);
    expect(parsed.judges).toEqual([{ type: 'test/judge/custom', count: 6 }]);
    expect(parsed.results?.store).toEqual({
      type: 'test/result-store/custom',
      count: 6,
    });
    expect(clientPatchOf(parsed.variants?.[0])).toEqual(clientPatchOf(parsed));
    expect(parsed.variants?.[0]?.metrics).toEqual(parsed.metrics);
    expect(clientPatchOf(parsed.variants?.[1])).toEqual({
      type: 'test/client/custom',
      count: 12,
    });
    expect(parsed.variants?.[1]?.metrics).toEqual([]);
    expect(evalConfig.datasets[0]).toEqual({
      type: 'test/dataset/custom',
      ignored: true,
    });
  });

  it('accepts the built-in rubric judge and checks its options', () => {
    installTestPlugin();
    const evalConfig: EvalConfig = {
      name: 'rubric-judges',
      datasets: [{ type: 'test/dataset/file' }],
      judges: [{ type: 'rubric', rubric: 'correctness', threshold: 0.8 }],
    };
    expect(validateEvalConfig(evalConfig).judges).toEqual([
      { type: 'rubric', rubric: 'correctness', threshold: 0.8 },
    ]);
    expect(() =>
      validateEvalConfig({
        ...evalConfig,
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
    const evalConfig: EvalConfig = {
      name: 'judge-settings',
      datasets: [{ type: 'test/dataset/file' }],
      judges: [
        {
          type: 'test/judge/policy',
          count: 2,
          threshold: 0.9,
          reference: 'base-gold',
        },
      ],
      variants: [
        { name: 'inherited' },
        {
          name: 'override',
          judges: [
            {
              type: 'test/judge/policy',
              count: 4,
              threshold: 0,
              reference: 'variant-gold',
            },
          ],
        },
      ],
    };
    const parsed = validateEvalConfig(evalConfig);
    expect(parsed.judges).toEqual([
      {
        type: 'test/judge/policy',
        count: 6,
        threshold: 0.9,
        reference: 'base-gold',
      },
    ]);
    expect(parsed.variants?.[0]?.judges).toEqual(parsed.judges);
    expect(parsed.variants?.[1]?.judges).toEqual([
      {
        type: 'test/judge/policy',
        count: 12,
        threshold: 0,
        reference: 'variant-gold',
      },
    ]);
    expect(evalConfig.judges?.[0]?.count).toBe(2);
  });

  it.each([
    'dataset',
    'client',
    'metric',
    'judge',
    'store',
    'variantClient',
    'variantMetric',
    'variantJudge',
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
    const segment = {
      dataset: 'dataset',
      client: 'client',
      metric: 'metric',
      judge: 'judge',
      store: 'result-store',
      variantClient: 'client',
      variantMetric: 'metric',
      variantJudge: 'judge',
    }[kind];
    const config = { type: `test/${segment}/strict`, required: 'invalid' };
    const evalConfig: EvalConfig = {
      name: 'invalid-options',
      datasets: [{ type: 'test/dataset/file' }],
    };
    if (kind === 'dataset') evalConfig.datasets = [config];
    if (kind === 'client') {
      const { type, ...options } = config;
      evalConfig.client = type;
      evalConfig.clientOptions = options;
    }
    if (kind === 'metric') evalConfig.metrics = [config];
    if (kind === 'judge') evalConfig.judges = [config];
    if (kind === 'store') evalConfig.results = { store: config };
    if (kind === 'variantClient') {
      const { type, ...options } = config;
      evalConfig.variants = [
        { name: 'variant', client: type, clientOptions: options },
      ];
    }
    if (kind === 'variantMetric')
      evalConfig.variants = [{ name: 'variant', metrics: [config] }];
    if (kind === 'variantJudge')
      evalConfig.variants = [{ name: 'variant', judges: [config] }];
    expect(() => validateEvalConfig(evalConfig)).toThrow(
      new RegExp(`Invalid .* options "test/${segment}/strict"`)
    );
  });

  it('validates effective top-level client options in variant overrides', () => {
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
    const evalConfig: EvalConfig = {
      name: 'effective',
      datasets: [{ type: 'test/dataset/file' }],
      maxToolCalls: 5,
      variants: [{ name: 'variant', client: 'test/client/limited' }],
    };
    expect(() => validateEvalConfig(evalConfig)).toThrow(
      'Invalid client options "test/client/limited"'
    );
    const parsed = validateEvalConfig({
      ...evalConfig,
      maxToolCalls: 2,
    });
    expect(clientPatchOf(parsed.variants?.[0])).toEqual({
      type: 'test/client/limited',
      maxToolCalls: 2,
      model: 'default',
    });
    expect(
      clientPatchOf(
        validateEvalConfig({
          ...evalConfig,
          variants: [
            {
              name: 'variant',
              client: 'test/client/limited',
              clientOptions: { maxToolCalls: 1 },
            },
          ],
        }).variants?.[0]
      )?.maxToolCalls
    ).toBe(1);
  });

  it('rejects an unknown extension or duplicate server label', () => {
    installTestPlugin();
    expect(() =>
      validateEvalConfig({
        name: 'invalid',
        datasets: [{ type: 'missing' }],
      })
    ).toThrow('Dataset source "missing" is not available');
    expect(() =>
      validateEvalConfig({
        name: 'invalid',
        datasets: [{ type: 'test/dataset/missing' }],
      })
    ).toThrow('Dataset source "test/dataset/missing" is not available');
    expect(() =>
      validateEvalConfig({
        name: 'unloaded',
        datasets: [{ type: 'other/dataset/file' }],
      })
    ).toThrow(
      'Dataset source "other/dataset/file" needs the "other" plugin, which is not loaded.'
    );

    expect(() =>
      validateEvalConfig({
        name: 'duplicate-labels',
        datasets: [{ type: 'test/dataset/file' }],
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

describe('variant servers named by label', () => {
  const acme = { transport: 'http', serverUrl: 'https://acme.example/mcp' };
  const beta = { transport: 'http', serverUrl: 'https://beta.example/mcp' };
  /** An eval config file with two servers, loaded and validated as runEval does. */
  function validate(
    variants: Array<Record<string, unknown>>,
    servers: Record<string, unknown> = { acme, beta }
  ): EvalConfig {
    return validateEvalConfig(
      loadEvalConfigFromObject(
        {
          name: 'servers',
          datasets: [{ type: 'test/dataset/file' }],
          client: 'test/client/sdk',
          servers,
          variants,
        },
        { skipDatasetValidation: true }
      )
    );
  }
  beforeEach(() => installTestPlugin());
  const urlsOf = (evalConfig: EvalConfig) =>
    evalConfig.variants?.map((variant) =>
      variant.servers?.map((server) => [
        server.label,
        'serverUrl' in server ? server.serverUrl : undefined,
      ])
    );

  it('gives a variant that names no servers every server', () => {
    expect(urlsOf(validate([{ name: 'all' }]))).toEqual([
      [
        ['acme', acme.serverUrl],
        ['beta', beta.serverUrl],
      ],
    ]);
  });

  it('gives a variant that lists no labels no servers', () => {
    expect(urlsOf(validate([{ name: 'none', servers: [] }]))).toEqual([[]]);
  });

  it('resolves labels to the eval config servers, in the order the variant lists them', () => {
    expect(
      urlsOf(
        validate([
          { name: 'reversed', servers: ['beta', 'acme'] },
          { name: 'one', servers: ['beta'] },
        ])
      )
    ).toEqual([
      [
        ['beta', beta.serverUrl],
        ['acme', acme.serverUrl],
      ],
      [['beta', beta.serverUrl]],
    ]);
  });

  it('rejects a label the eval config does not define, listing the ones it does', () => {
    expect(() => validate([{ name: 'typo', servers: ['x'] }])).toThrow(
      'Variant "typo" names server "x", which the eval config doesn\'t define. Its servers are: acme, beta.'
    );
    expect(() => validate([{ name: 'typo', servers: ['x'] }], {})).toThrow(
      'Variant "typo" names server "x", which the eval config doesn\'t define. It defines no servers.'
    );
  });

  it('rejects a label listed more than once', () => {
    expect(() =>
      validate([{ name: 'twice', servers: ['acme', 'beta', 'acme'] }])
    ).toThrow('Variant "twice" lists server "acme" more than once.');
  });
});

describe('settings a client would ignore', () => {
  const overrides = { search: { description: 'Find it.' } };
  const base = (extra: Record<string, unknown>): EvalConfig => ({
    name: 'loud',
    datasets: [{ type: 'file', path: 'x.json' }],
    ...extra,
  });

  function installClients() {
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

  it.each(['chatgpt', 'test/client/elsewhere'])(
    'rejects tool metadata for %s, which never shows it to the model',
    (type) => {
      installClients();
      const client =
        type === 'chatgpt'
          ? { client: type, model: 'gpt-5' }
          : { client: type };
      expect(() =>
        validateEvalConfig(base({ ...client, tools: overrides }), {
          namespaces: ['test'],
        })
      ).toThrow(
        `The eval config: client "${type}" can't show tool metadata (\`tools\`);`
      );
    }
  );

  it.each(['claude-code', 'test/client/runner'])(
    'accepts tool metadata for %s, served through the tool proxy',
    (type) => {
      installClients();
      expect(() =>
        validateEvalConfig(base({ client: type, tools: overrides }), {
          namespaces: ['test'],
        })
      ).not.toThrow();
    }
  );

  it('accepts tool metadata for cowork, served through the tool proxy', () => {
    expect(() =>
      validateEvalConfig(base({ client: 'cowork', tools: overrides }))
    ).not.toThrow();
  });

  it('rejects tool metadata on the variant that sets it, and accepts it for mst', () => {
    installTestPlugin();
    const evalConfig = base({
      client: 'mst',
      clientOptions: { provider: 'anthropic' },
      variants: [
        { name: 'sdk', tools: overrides },
        {
          name: 'desktop',
          client: 'chatgpt',
          model: 'gpt-5',
          tools: overrides,
        },
      ],
    });
    expect(() =>
      validateEvalConfig(evalConfig, { namespaces: ['test'] })
    ).toThrow(
      `Variant "desktop": client "chatgpt" can't show tool metadata (\`tools\`);`
    );
    expect(() =>
      validateEvalConfig(
        { ...evalConfig, variants: [evalConfig.variants![0]!] },
        { namespaces: ['test'] }
      )
    ).not.toThrow();
  });

  it('rejects connection policy claude-code would drop, before anything runs', () => {
    expect(() =>
      validateEvalConfig(
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
      "The eval config: claude-code can't forward proxy for https://mcp.example.com."
    );
  });

  it('rejects an option mst would drop', () => {
    expect(() =>
      validateEvalConfig(
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
      validateEvalConfig(
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
        validateEvalConfig(
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

describe('settings a client would ignore: defaults, inheritance, opt-in', () => {
  const overrides = { search: { description: 'Find it.' } };
  const evalConfig = (extra: Record<string, unknown>): EvalConfig => ({
    name: 'loud',
    datasets: [{ type: 'file', path: 'x.json' }],
    ...extra,
  });

  it('gives a shared default only to the clients that take it', () => {
    const validated = validateEvalConfig(
      evalConfig({
        model: 'claude-sonnet-4-6',
        temperature: 0.2,
        client: 'mst',
        variants: [{ name: 'mst' }, { name: 'code', client: 'claude-code' }],
      })
    );
    expect(clientPatchOf(validated.variants?.[0])).toMatchObject({
      type: 'mst',
      model: 'claude-sonnet-4-6',
      temperature: 0.2,
    });
    expect(clientPatchOf(validated.variants?.[1])).toMatchObject({
      type: 'claude-code',
      model: 'claude-sonnet-4-6',
    });
    expect(clientPatchOf(validated.variants?.[1])).not.toHaveProperty(
      'temperature'
    );
  });

  it('rejects a default that none of the clients takes', () => {
    expect(() =>
      validateEvalConfig(
        evalConfig({ temperature: 0.2, client: 'claude-code' })
      )
    ).toThrow(
      `The eval config sets "temperature", but none of its clients (claude-code) takes it.`
    );
  });

  it("doesn't give a variant the options of a different client", () => {
    const validated = validateEvalConfig(
      evalConfig({
        client: 'mst',
        clientOptions: { provider: 'openai', apiKeyEnvVar: 'KEY' },
        variants: [{ name: 'code', client: 'claude-code' }],
      })
    );
    expect(clientPatchOf(validated.variants?.[0])).not.toHaveProperty(
      'apiKeyEnvVar'
    );
  });

  it('accepts tool metadata for a plugin client that shows it', () => {
    installTestPlugin({
      clients: {
        variants: {
          schema,
          toolMetadata: true,
          run: async () => ({ finalText: '', events: [] }),
        },
      },
    });
    expect(() =>
      validateEvalConfig(
        evalConfig({ client: 'test/client/variants', tools: overrides }),
        { namespaces: ['test'] }
      )
    ).not.toThrow();
  });

  it('rejects a concurrency the client cannot run', () => {
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
      validateEvalConfig(
        evalConfig({ client: 'test/client/serial', concurrency: 4 }),
        {
          namespaces: ['test'],
        }
      )
    ).toThrow(
      'client "test/client/serial" runs at most 1 case at a time; set concurrency to 1.'
    );
  });
});
