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
