import fs from 'node:fs';
import { z } from 'zod';
import { MCPConfigSchema } from '../config/mcpConfig.js';
import { describe, expect, it } from 'vitest';
import type { ToolOverrideVariant } from '../types/index.js';
import {
  EvalManifestSchema,
  loadEvalManifestFromObject,
  resolveDatasetPaths,
} from './evalManifest.js';

describe('EvalManifestSchema', () => {
  it('accepts partial arm host options without weakening the base host tag', () => {
    const base = {
      name: 'patch',
      datasets: ['cases.json'],
      host: { type: 'sdk', model: 'base' },
    };
    const manifest = loadEvalManifestFromObject(
      { ...base, arms: [{ name: 'candidate', host: { model: 'candidate' } }] },
      { skipDatasetValidation: true }
    );
    expect(manifest.arms?.[0]?.host).toEqual({ model: 'candidate' });
    expect(() =>
      EvalManifestSchema.parse({ ...base, host: { model: 'untagged' } })
    ).toThrow();
    expect(() =>
      EvalManifestSchema.parse({
        ...base,
        arms: [{ name: 'invalid', host: { type: '' } }],
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
    'uses canonical transport validation on defaults and arms: %j',
    (server) => {
      const base = { name: 'invalid', datasets: ['cases.json'] };
      expect(() =>
        EvalManifestSchema.parse({ ...base, servers: [server] })
      ).toThrow();
      expect(() =>
        EvalManifestSchema.parse({
          ...base,
          arms: [{ name: 'candidate', servers: [server] }],
        })
      ).toThrow();
    }
  );

  it('keeps editor transport schema synchronized with canonical MCPConfigSchema', () => {
    const schema = JSON.parse(
      fs.readFileSync(
        new URL('../../schema/eval-manifest.schema.json', import.meta.url),
        'utf8'
      )
    ) as {
      definitions: { mcpConfig: unknown };
      properties: {
        servers: { items: unknown };
        arms: { items: { properties: { host: { required?: string[] } } } };
      };
    };
    expect(schema.definitions.mcpConfig).toEqual(
      z.toJSONSchema(MCPConfigSchema, { target: 'draft-7', io: 'input' })
    );
    expect(schema.properties.servers.items).toEqual({
      $ref: '#/definitions/mcpConfig',
    });
    expect(
      schema.properties.arms.items.properties.host.required
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

  it('accepts shared tool override variants and multi-name mappings on defaults and arms', () => {
    const toolMap = { search: ['search', 'search_v2'], removed: [] };
    const manifest = loadEvalManifestFromObject(
      {
        name: 'variants',
        datasets: ['cases.json'],
        toolMap,
        toolOverrides: overrides,
        scenarioTemplate: '{{scenario}}',
        arms: [{ name: 'candidate', toolMap, toolOverrides: overrides }],
      },
      { skipDatasetValidation: true }
    );
    expect(manifest.toolOverrides).toEqual(overrides);
    expect(manifest.arms?.[0]?.toolOverrides).toEqual(overrides);
    expect(manifest.toolMap).toEqual(toolMap);
    expect(manifest.arms?.[0]?.toolMap).toEqual(toolMap);
  });

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
    'rejects invalid mappings/overrides consistently on defaults and arms',
    (fields) => {
      const base = { name: 'invalid', datasets: ['cases.json'] };
      expect(() => EvalManifestSchema.parse({ ...base, ...fields })).toThrow();
      expect(() =>
        EvalManifestSchema.parse({
          ...base,
          arms: [{ name: 'candidate', ...fields }],
        })
      ).toThrow();
    }
  );

  it('shares override definitions and array-valued maps in the editor schema', () => {
    const schema = JSON.parse(
      fs.readFileSync(
        new URL('../../schema/eval-manifest.schema.json', import.meta.url),
        'utf8'
      )
    ) as {
      properties: {
        toolMap: unknown;
        toolOverrides: unknown;
        arms: {
          items: { properties: { toolMap: unknown; toolOverrides: unknown } };
        };
      };
      definitions: { toolOverrideVariant: { required: string[] } };
    };
    expect(schema.properties.toolMap).toEqual({
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    });
    expect(schema.properties.arms.items.properties.toolMap).toEqual({
      $ref: '#/properties/toolMap',
    });
    expect(schema.properties.toolOverrides).toEqual({
      $ref: '#/definitions/toolOverrideVariant',
    });
    expect(schema.properties.arms.items.properties.toolOverrides).toEqual(
      schema.properties.toolOverrides
    );
    expect(schema.definitions.toolOverrideVariant.required).toEqual([
      'id',
      'tools',
    ]);
  });
  it('normalizes file paths to tagged file dataset sources', () => {
    const manifest = loadEvalManifestFromObject(
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
        host: { type: 'sdk' },
        arms: [
          { name: 'baseline' },
          {
            name: 'variant',
            servers: [],
            host: { type: 'cli', model: 'test-model' },
          },
        ],
        metrics: ['passed'],
        judges: [{ type: 'correctness' }],
        results: { store: { type: 'file', directory: '.results' } },
      },
      { skipDatasetValidation: true }
    );

    expect(manifest.datasets).toEqual([
      { type: 'file', path: 'evalsets/search.json' },
    ]);
    expect(manifest.arms?.map((arm) => arm.name)).toEqual([
      'baseline',
      'variant',
    ]);
    expect(resolveDatasetPaths(manifest, '/workspace')).toEqual([
      '/workspace/evalsets/search.json',
    ]);
  });

  it('accepts a local manifest with an empty server set', () => {
    expect(
      EvalManifestSchema.parse({
        name: 'host-only',
        datasets: [{ type: 'file', path: './cases.json' }],
        servers: [],
      }).servers
    ).toEqual([]);
  });

  it('requires a tagged source for non-shorthand extension blocks', () => {
    expect(() =>
      EvalManifestSchema.parse({
        name: 'invalid',
        datasets: [{ path: './cases.json' }],
      })
    ).toThrow();
  });
});
