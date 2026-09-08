import { describe, expect, it } from 'vitest';
import {
  EvalManifestSchema,
  loadEvalManifestFromObject,
  resolveDatasetPaths,
} from './evalManifest.js';

describe('EvalManifestSchema', () => {
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
