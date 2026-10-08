import fs from 'node:fs';
import { z } from 'zod';
import { MCPConfigSchema } from '../config/mcpConfig.js';
import { describe, expect, it } from 'vitest';
import type { ToolOverrideVariant } from '../types/index.js';
import {
  EvalConfigSchema,
  RENAMED_CONFIG_KEYS,
  loadEvalConfigFromObject,
  resolveDatasetPaths,
  variantToolMetadata,
} from './evalConfig.js';

describe('EvalConfigSchema', () => {
  it('accepts partial variant client options without weakening the base client tag', () => {
    const base = {
      name: 'patch',
      datasets: ['cases.json'],
      client: 'sdk',
      model: 'base',
    };
    const evalConfig = loadEvalConfigFromObject(
      { ...base, variants: [{ name: 'candidate', model: 'candidate' }] },
      { skipDatasetValidation: true }
    );
    expect(evalConfig.variants?.[0]?.model).toBe('candidate');
    expect(() =>
      EvalConfigSchema.parse({ ...base, host: { type: 'sdk' } })
    ).toThrow(
      '`host` is now `client` (the client’s name), `model` and `clientOptions` (its other options)'
    );
    expect(() =>
      EvalConfigSchema.parse({
        ...base,
        variants: [{ name: 'invalid', client: '' }],
      })
    ).toThrow();
  });

  it.each([
    { transport: 'http', serverUrl: 17 },
    { transport: 'http' },
    { transport: 'http', serverUrl: 'not-a-url' },
    {
      transport: 'http',
      serverUrl: 'https://example.com',
      headers: { Authorization: 17 },
    },
    {
      transport: 'http',
      serverUrl: 'https://example.com',
      requestTimeoutMs: -1,
    },
    {
      transport: 'http',
      serverUrl: 'https://example.com',
      tls: { rejectUnauthorized: 'false' },
    },
    { transport: 'http', serverUrl: 'https://example.com', retryAttempts: 0.5 },
    {
      transport: 'http',
      serverUrl: 'https://example.com',
      auth: { oauth: { serverUrl: 17 } },
    },
    { transport: 'stdio' },
    { transport: 'stdio', command: 17 },
    { transport: 'stdio', command: 'node', args: [17] },
    { transport: 'stdio', command: 'node', env: { PORT: 17 } },
  ])(
    'uses canonical transport validation on defaults and variants: %j',
    (server) => {
      const base = { name: 'invalid', datasets: ['cases.json'] };
      expect(() =>
        EvalConfigSchema.parse({ ...base, servers: [server] })
      ).toThrow();
      expect(() =>
        EvalConfigSchema.parse({
          ...base,
          variants: [{ name: 'candidate', servers: [server] }],
        })
      ).toThrow();
    }
  );

  it('keeps editor transport schema synchronized with canonical MCPConfigSchema', () => {
    const schema = JSON.parse(
      fs.readFileSync(
        new URL('../../schema/eval-config.schema.json', import.meta.url),
        'utf8'
      )
    ) as {
      definitions: { mcpConfig: unknown };
      properties: {
        servers: { items: unknown };
        variants: {
          items: { properties: { client: { required?: string[] } } };
        };
      };
    };
    expect(schema.definitions.mcpConfig).toEqual(
      z.toJSONSchema(MCPConfigSchema, { target: 'draft-7', io: 'input' })
    );
    expect(schema.properties.servers.items).toEqual({
      anyOf: [
        { $ref: '#/definitions/mcpConfig' },
        { $ref: '#/definitions/connectorServer' },
      ],
    });
    expect(
      schema.properties.variants.items.properties.client.required
    ).toBeUndefined();
  });
  const overrides: ToolOverrideVariant = {
    id: 'search-v2',
    description: 'More precise search metadata',
    tools: {
      search: {
        description: 'Find workplace documents',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    },
  };

  it('accepts tool metadata and multi-name mappings on the config and its variants', () => {
    const toolMap = { search: ['search', 'search_v2'], removed: [] };
    const evalConfig = loadEvalConfigFromObject(
      {
        name: 'variants',
        datasets: ['cases.json'],
        toolMap,
        tools: overrides.tools,
        inputTemplate: '{{input}}',
        variants: [
          {
            name: 'candidate',
            description: overrides.description,
            toolMap,
            tools: overrides.tools,
          },
        ],
      },
      { skipDatasetValidation: true }
    );
    expect(evalConfig.tools).toEqual(overrides.tools);
    expect(evalConfig.variants?.[0]?.tools).toEqual(overrides.tools);
    expect(variantToolMetadata(evalConfig, evalConfig.variants?.[0])).toEqual({
      ...overrides,
      id: 'candidate',
    });
    expect(variantToolMetadata(evalConfig)).toEqual({
      id: 'variants',
      tools: overrides.tools,
    });
    expect(evalConfig.toolMap).toEqual(toolMap);
    expect(evalConfig.variants?.[0]?.toolMap).toEqual(toolMap);
  });

  it.each([
    [{ arms: [{ name: 'a' }] }, ['arms'], '`arms` is now `variants`'],
    [
      { toolOverrides: { id: 'x', tools: {} } },
      ['toolOverrides'],
      '`toolOverrides` is gone: set the tool metadata itself in `tools`',
    ],
    [
      { variants: [{ name: 'a', toolOverrides: { id: 'x', tools: {} } }] },
      ['variants', 0, 'toolOverrides'],
      '`toolOverrides` is gone',
    ],
    [{ tools: 'search' }, ['tools'], '`tools` is tool metadata'],
  ])(
    'rejects the old config key %j, naming its replacement',
    (old, where, message) => {
      const result = EvalConfigSchema.safeParse({
        name: 'old',
        datasets: ['cases.json'],
        ...old,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({
          path: where,
          message: expect.stringContaining(message),
        }),
      ]);
    }
  );

  it.each([
    { toolMap: { search: 'search_v2' } },
    { toolMap: { search: [1] } },
    { toolOverrides: { tools: {} } },
    {
      toolOverrides: {
        id: 'variant',
        tools: { search: { inputSchema: 'not-object' } },
      },
    },
    {
      toolOverrides: { id: 'variant', tools: { search: { description: 123 } } },
    },
  ])(
    'rejects invalid mappings/overrides consistently on defaults and variants',
    (fields) => {
      const base = { name: 'invalid', datasets: ['cases.json'] };
      expect(() => EvalConfigSchema.parse({ ...base, ...fields })).toThrow();
      expect(() =>
        EvalConfigSchema.parse({
          ...base,
          variants: [{ name: 'candidate', ...fields }],
        })
      ).toThrow();
    }
  );

  it('shares the tool metadata definition and array-valued maps in the editor schema', () => {
    const schema = JSON.parse(
      fs.readFileSync(
        new URL('../../schema/eval-config.schema.json', import.meta.url),
        'utf8'
      )
    ) as {
      properties: {
        toolMap: unknown;
        tools: { $ref: string };
        variants: {
          items: { properties: { toolMap: unknown; tools: { $ref: string } } };
        };
      };
      definitions: { toolMetadata: { type: string } };
    };
    expect(schema.properties.toolMap).toEqual({
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    });
    expect(schema.properties.variants.items.properties.toolMap).toEqual({
      $ref: '#/properties/toolMap',
    });
    expect(schema.properties.tools.$ref).toBe('#/definitions/toolMetadata');
    expect(schema.properties.variants.items.properties.tools.$ref).toBe(
      '#/definitions/toolMetadata'
    );
    expect(schema.definitions.toolMetadata.type).toBe('object');
  });
  it('normalizes a result store shorthand to a tagged store, and leaves a tagged one as is', () => {
    const load = (store: unknown) =>
      loadEvalConfigFromObject(
        { name: 'm', datasets: ['x.json'], results: { store } },
        { skipDatasetValidation: true }
      ).results;
    expect(load('file')).toEqual({ store: { type: 'file' } });
    const tagged = { type: 'file', dir: '.results' };
    expect(load(tagged)).toEqual({ store: tagged });
  });

  it('normalizes file paths to tagged file dataset sources', () => {
    const evalConfig = loadEvalConfigFromObject(
      {
        name: 'search',
        datasets: ['evalsets/search.json'],
        servers: [
          {
            transport: 'http',
            serverUrl: 'https://example.com/mcp',
            label: 'prod',
          },
        ],
        client: 'sdk',
        variants: [
          { name: 'baseline' },
          {
            name: 'variant',
            servers: [],
            client: 'cli',
            model: 'test-model',
          },
        ],
        metrics: ['passed'],
        judges: [{ type: 'correctness' }],
        results: { store: { type: 'file', directory: '.results' } },
      },
      { skipDatasetValidation: true }
    );

    expect(evalConfig.datasets).toEqual([
      { type: 'file', path: 'evalsets/search.json' },
    ]);
    expect(evalConfig.variants?.map((variant) => variant.name)).toEqual([
      'baseline',
      'variant',
    ]);
    expect(resolveDatasetPaths(evalConfig, '/workspace')).toEqual([
      '/workspace/evalsets/search.json',
    ]);
  });

  it('accepts a local eval config with an empty server set', () => {
    expect(
      EvalConfigSchema.parse({
        name: 'host-only',
        datasets: [{ type: 'file', path: './cases.json' }],
        servers: [],
      }).servers
    ).toEqual([]);
  });

  it('requires a tagged source for non-shorthand extension blocks', () => {
    expect(() =>
      EvalConfigSchema.parse({
        name: 'invalid',
        datasets: [{ path: './cases.json' }],
      })
    ).toThrow();
  });
});

describe('strict eval configs', () => {
  const load = (extra: Record<string, unknown>) =>
    loadEvalConfigFromObject(
      { name: 'm', datasets: ['x.json'], ...extra },
      { skipDatasetValidation: true }
    );

  it('rejects a key it does not know, instead of ignoring it', () => {
    expect(() => load({ iteration: 5 })).toThrow(
      /Unrecognized key.*iteration/s
    );
  });

  it('accepts run controls, including the default pass threshold', () => {
    expect(load({ run: { trials: 5, passThreshold: 0.8 } }).run).toEqual({
      trials: 5,
      passThreshold: 0.8,
    });
    expect(load({ passThreshold: 0.8 }).passThreshold).toBe(0.8);
    expect(() => load({ run: { passThreshold: 2 } })).toThrow();
  });
});

describe('the editor schema', () => {
  it('declares the same top-level keys as EvalConfigSchema, and no others', () => {
    const editor = JSON.parse(
      fs.readFileSync(
        new URL('../../schema/eval-config.schema.json', import.meta.url),
        'utf8'
      )
    ) as { properties: Record<string, unknown>; additionalProperties: unknown };
    const runtime = Object.keys(EvalConfigSchema.shape).filter(
      // Kept only so validation can explain what replaced them.
      (key) =>
        key !== 'profile' &&
        key !== 'host' &&
        key !== 'toolOverrides' &&
        !(key in RENAMED_CONFIG_KEYS)
    );
    expect(Object.keys(editor.properties).sort()).toEqual(runtime.sort());
    expect(editor.additionalProperties).toBe(false);
  });
});

describe('connector servers', () => {
  it('accepts connector entries in servers and variants, and rejects bad ones', () => {
    const config = loadEvalConfigFromObject(
      {
        name: 'connectors',
        datasets: [{ type: 'file', path: 'cases.json' }],
        servers: [{ connector: 'acme/connector/glean' }],
        variants: [
          {
            name: 'native',
            servers: [
              { connector: 'acme/connector/slack', label: 'slack' },
              {
                connector: '@acme/evals/connector/jira',
                url: 'https://jira.example/mcp',
              },
            ],
          },
        ],
      },
      { skipDatasetValidation: true }
    );
    expect(config.servers).toEqual([{ connector: 'acme/connector/glean' }]);
    expect(config.variants?.[0]?.servers).toHaveLength(2);
    for (const bad of [
      { connector: 'slack' },
      { connector: 'acme/connector/slack', transport: 'http' },
      { connector: 'acme/connector/slack', token: 'x' },
      { connector: 'acme/connector/slack', label: '1bad' },
    ])
      expect(() =>
        loadEvalConfigFromObject(
          {
            name: 'x',
            datasets: [{ type: 'file', path: 'c.json' }],
            servers: [bad],
          },
          { skipDatasetValidation: true }
        )
      ).toThrow();
  });
});

describe('built-ins written in full', () => {
  it('reads mst/<kind>/<name> as the built-in short name in every slot', () => {
    const config = loadEvalConfigFromObject(
      {
        name: 'full-names',
        datasets: [{ type: 'mst/dataset/file', path: './cases.json' }],
        client: 'mst/client/mst',
        variants: [{ name: 'cli', client: 'mst/client/claude-code' }],
        metrics: ['mst/metric/passed', { type: 'mst/metric/tool_count' }],
        judges: [{ type: 'mst/judge/rubric', rubric: 'correctness' }],
        results: { store: { type: 'mst/result-store/file', dir: './out' } },
      },
      { skipDatasetValidation: true }
    );
    expect(config.datasets).toEqual([{ type: 'file', path: './cases.json' }]);
    expect(config.client).toBe('mst');
    expect(config.variants?.[0]?.client).toBe('claude-code');
    expect(config.metrics).toEqual([
      expect.objectContaining({ type: 'passed' }),
      expect.objectContaining({ type: 'tool_count' }),
    ]);
    expect(config.judges?.[0]).toEqual(
      expect.objectContaining({ type: 'rubric' })
    );
    expect(config.results?.store).toEqual(
      expect.objectContaining({ type: 'file' })
    );
  });

  it.each([
    [{ client: 'mst/judge/rubric' }, 'is a judge, not a client'],
    [{ metrics: ['mst/client/mst'] }, 'is a client, not a metric'],
    [{ judges: ['mst/metric/passed'] }, 'is a metric, not a judge'],
    [
      { results: { store: { type: 'mst/dataset/file' } } },
      'is a dataset source, not a result store',
    ],
    [
      { datasets: [{ type: 'mst/judge/rubric' }] },
      'is a judge, not a dataset source',
    ],
  ])('rejects a full built-in name of the wrong kind: %j', (patch, message) => {
    expect(() =>
      loadEvalConfigFromObject(
        { name: 'wrong-kind', datasets: ['./cases.json'], ...patch },
        { skipDatasetValidation: true }
      )
    ).toThrow(message);
  });

  it('checks a connector name by kind', () => {
    for (const [connector, message] of [
      ['acme/judge/slack', 'is a judge, not a connector'],
      ['acme/slack', 'needs its kind'],
      ['slack', '<namespace>/connector/slack'],
    ] as const) {
      expect(() =>
        loadEvalConfigFromObject(
          {
            name: 'connectors',
            datasets: ['./cases.json'],
            servers: [{ connector }],
          },
          { skipDatasetValidation: true }
        )
      ).toThrow(message);
    }
  });
});
