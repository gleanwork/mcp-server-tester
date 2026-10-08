import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runEvalBatch, type RunEvalBatchOptions } from './runEvalBatch.js';
import {
  installPlugins,
  loadedNamespaces,
  resetPluginsForTests,
} from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import { runEval } from './runEval.js';
import { loadEvalConfig, type EvalConfig } from './evalConfig.js';
import { resolveConfigExtends } from './configExtends.js';
import type { EvaluationSummary } from './evalFrameworkTypes.js';
import type { EvalCaseResult } from '../types/reporter.js';
import {
  createStoredEvalArtifact,
  FileEvalResultStore,
  type StoredEvalArtifact,
} from './resultStore.js';

vi.mock('./runEval.js', () => ({ runEval: vi.fn() }));

// Temp plugin modules hand back the test's store through this global.
const STORE_GLOBAL = '__mstBatchTestStore';
const globals = globalThis as unknown as Record<string, unknown>;

/** Source for a plugin module whose `store` result store returns the test's store. */
function storePluginSource(namespace: string): string {
  return `export default {
    meta: { name: '${namespace}-plugin', namespace: '${namespace}' },
    resultStores: {
      store: {
        schema: { safeParse: (value) => ({ success: true, data: value }) },
        create: () => globalThis.${STORE_GLOBAL},
      },
    },
  };`;
}

function completedSummary(evalConfig: EvalConfig): EvaluationSummary {
  const caseResults: EvalCaseResult[] = [
    {
      id: 'case-1',
      datasetName: 'dataset',
      toolName: 'tool',
      source: 'eval',
      pass: true,
      durationMs: 1,
      scores: {},
    },
  ];
  return {
    schemaVersion: 2,
    configId: evalConfig.name,
    contentHash: createHash('sha256')
      .update(JSON.stringify(evalConfig))
      .digest('hex'),
    configName: evalConfig.name,
    timestamp: '2026-09-10T00:00:00.000Z',
    durationMs: 1,
    variants: [
      {
        name: 'default',
        servers: [],
        result: { total: 1, passed: 1, failed: 0, durationMs: 1, caseResults },
      },
    ],
    metrics: { total: 1, passed: 1, failed: 0 },
    variantDeltas: {},
    results: caseResults,
  };
}

function summaryArtifact(
  summary: EvaluationSummary
): StoredEvalArtifact<EvaluationSummary> {
  return createStoredEvalArtifact({
    kind: 'eval-run-summary',
    id: 'saved-run',
    data: summary,
    metadata: {
      labels: {
        configId: summary.configId,
        contentHash: summary.contentHash,
      },
    },
    createdAt: summary.timestamp,
  });
}

describe('runEvalBatch skipExisting', () => {
  let rootDir: string;
  let configPath: string;
  let storeDir: string;
  let outputRoot: string;
  let store: FileEvalResultStore;
  let configInput: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-resume-'));
    configPath = path.join(rootDir, 'eval.json');
    storeDir = path.join(rootDir, 'store');
    outputRoot = path.join(rootDir, 'output');
    store = new FileEvalResultStore({ provider: 'file', dir: storeDir });
    globals[STORE_GLOBAL] = store;
    configInput = {
      name: 'resume-test',
      datasets: [{ type: 'test-source' }],
      results: { store: { type: 'file', dir: storeDir } },
    };
    await fs.writeFile(configPath, JSON.stringify(configInput));
    vi.mocked(runEval).mockImplementation(async (options) => {
      const evalConfig = loadEvalConfig(options.configPath, { rootDir });
      const summary = completedSummary(evalConfig);
      return {
        evalConfig,
        summary,
        outputDir: options.outputDir ?? rootDir,
        datasets: [],
      };
    });
  });

  afterEach(async () => {
    resetPluginsForTests();
    delete globals[STORE_GLOBAL];
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function saveValidSummary(): Promise<
    StoredEvalArtifact<EvaluationSummary>
  > {
    const artifact = summaryArtifact(
      completedSummary(loadEvalConfig(configPath, { rootDir }))
    );
    await store.saveArtifact(artifact);
    return artifact;
  }

  async function run(options: Partial<RunEvalBatchOptions> = {}) {
    return runEvalBatch({
      configPaths: [configPath],
      rootDir,
      outputRoot,
      skipExisting: true,
      ...options,
    });
  }

  it('rejects invalid worker counts before scheduling any eval config', async () => {
    await expect(
      runEvalBatch({
        configPaths: [configPath],
        rootDir,
        workers: Number.NaN,
      })
    ).rejects.toThrow(/workers must be a finite positive integer/);
    expect(runEval).not.toHaveBeenCalled();
  });

  it('supports eval config directories and disambiguates colliding output basenames', async () => {
    const first = path.join(rootDir, 'one', 'same.json');
    const second = path.join(rootDir, 'two', 'same.json');
    await fs.mkdir(path.dirname(first), { recursive: true });
    await fs.mkdir(path.dirname(second), { recursive: true });
    await fs.writeFile(first, JSON.stringify({ ...configInput, name: 'one' }));
    await fs.writeFile(second, JSON.stringify({ ...configInput, name: 'two' }));
    const result = await runEvalBatch({
      configPaths: [first, second],
      rootDir,
      outputRoot,
      workers: 2,
    });
    expect(result.items.map((item) => item.outputDir)).toHaveLength(2);
    expect(new Set(result.items.map((item) => item.outputDir)).size).toBe(2);
  });

  it('resumes a valid stored summary repeatedly without relying on results.json', async () => {
    await saveValidSummary();
    for (let i = 0; i < 3; i++) {
      expect(await run()).toMatchObject({ skipped: 1, failed: 0, passed: 0 });
    }
    expect(runEval).not.toHaveBeenCalled();
  });

  it('resumes completed failing evaluations, not only passing ones', async () => {
    const artifact = await saveValidSummary();
    artifact.data.results[0]!.pass = false;
    artifact.data.metrics.passed = 0;
    artifact.data.metrics.failed = 1;
    artifact.data.variants[0]!.result!.passed = 0;
    artifact.data.variants[0]!.result!.failed = 1;
    await store.saveArtifact(artifact);
    expect((await run()).skipped).toBe(1);
    expect(runEval).not.toHaveBeenCalled();
  });

  it('reruns when skipExisting is disabled', async () => {
    await saveValidSummary();
    const result = await runEvalBatch({
      configPaths: [configPath],
      rootDir,
      skipExisting: false,
    });
    expect(result.skipped).toBe(0);
    expect(runEval).toHaveBeenCalledOnce();
  });

  it('resumes through the configured store even without outputRoot', async () => {
    await saveValidSummary();
    const result = await runEvalBatch({
      configPaths: [configPath],
      rootDir,
      skipExisting: true,
    });
    expect(result.skipped).toBe(1);
    expect(runEval).not.toHaveBeenCalled();
  });

  it('uses a custom result store from a plugin object by configured type', async () => {
    const create = vi.fn(() => store);
    const plugin: Plugin = {
      meta: { name: 'batch-test-plugin', namespace: 'test' },
      resultStores: {
        custom: { schema: z.object({ type: z.string() }), create },
      },
    };
    configInput.results = { store: { type: 'test/result-store/custom' } };
    await fs.writeFile(configPath, JSON.stringify(configInput));
    await saveValidSummary();
    expect((await run({ plugins: [plugin] })).skipped).toBe(1);
    expect(create).toHaveBeenCalledWith({ type: 'test/result-store/custom' });
    expect(runEval).not.toHaveBeenCalled();
  });

  it('passes plugin objects through to the eval it runs', async () => {
    const plugin: Plugin = { meta: { name: 'passed', namespace: 'passed' } };
    await run({ plugins: [plugin], skipExisting: false });
    expect(runEval).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: [plugin] })
    );
  });

  it('loads eval config plugins before checking the configured result store', async () => {
    await fs.writeFile(
      path.join(rootDir, 'plugin.mjs'),
      storePluginSource('batch')
    );
    configInput.plugins = ['./plugin.mjs'];
    configInput.results = { store: { type: 'batch/result-store/store' } };
    await fs.writeFile(configPath, JSON.stringify(configInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(1);
    expect(loadedNamespaces()).toEqual(['batch']);
    expect(runEval).not.toHaveBeenCalled();
  });

  it('adds configured plugin paths to the eval config plugins', async () => {
    const configDir = path.join(rootDir, 'suite');
    await fs.mkdir(configDir);
    await fs.writeFile(
      path.join(configDir, 'config-plugin.mjs'),
      `export default { meta: { name: 'config-plugin', namespace: 'mp' } };`
    );
    // Resolves against rootDir, not the eval config's directory.
    await fs.writeFile(
      path.join(rootDir, 'cli-plugin.mjs'),
      storePluginSource('cli')
    );
    configPath = path.join(configDir, 'eval.json');
    configInput.plugins = ['./config-plugin.mjs'];
    configInput.results = { store: { type: 'cli/result-store/store' } };
    await fs.writeFile(configPath, JSON.stringify(configInput));
    await saveValidSummary();
    const result = await run({ pluginPaths: ['./cli-plugin.mjs'] });
    expect(result.skipped).toBe(1);
    expect(loadedNamespaces()).toEqual(['cli', 'mp']);
    expect(runEval).not.toHaveBeenCalled();
  });

  it('does not resume through a store from a plugin the eval config does not load', async () => {
    const create = vi.fn(() => store);
    installPlugins([
      {
        meta: { name: 'elsewhere-plugin', namespace: 'elsewhere' },
        resultStores: {
          custom: { schema: z.object({ type: z.string() }), create },
        },
      },
    ]);
    configInput.results = { store: { type: 'elsewhere/result-store/custom' } };
    await fs.writeFile(configPath, JSON.stringify(configInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(runEval).toHaveBeenCalledOnce();
  });

  describe('with a shared config', () => {
    function configPlugin(create: () => FileEvalResultStore): Plugin {
      return {
        meta: { name: 'config-plugin', namespace: 'test' },
        resultStores: {
          custom: { schema: z.object({ type: z.string() }), create },
        },
        configs: {
          recommended: {
            results: { store: { type: 'test/result-store/custom' } },
          },
        },
      };
    }

    beforeEach(async () => {
      delete configInput.results;
      configInput.extends = ['test/config/recommended'];
      await fs.writeFile(configPath, JSON.stringify(configInput));
    });

    it('resumes through the store the config supplies, identified with the config applied', async () => {
      const create = vi.fn(() => store);
      const plugin = configPlugin(create);
      installPlugins([plugin]);
      const resolved = resolveConfigExtends(
        loadEvalConfig(configPath, { rootDir }),
        ['test']
      );
      await store.saveArtifact(summaryArtifact(completedSummary(resolved)));

      expect((await run({ plugins: [plugin] })).skipped).toBe(1);
      expect(create).toHaveBeenCalledWith({ type: 'test/result-store/custom' });
      expect(runEval).not.toHaveBeenCalled();
    });

    it('reruns when a saved run predates the config', async () => {
      const create = vi.fn(() => store);
      // Saved under the eval config without its config: a different identity.
      await saveValidSummary();

      expect((await run({ plugins: [configPlugin(create)] })).skipped).toBe(0);
      expect(create).toHaveBeenCalled();
      expect(runEval).toHaveBeenCalledOnce();
    });
  });

  it('reruns safely when plugin loading fails', async () => {
    await fs.writeFile(
      path.join(rootDir, 'broken-plugin.mjs'),
      `throw new Error('plugin load failed');`
    );
    configInput.plugins = ['./broken-plugin.mjs'];
    await fs.writeFile(configPath, JSON.stringify(configInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(0);
    expect(runEval).toHaveBeenCalledOnce();
  });

  it('reruns safely when a plugin store is not loaded', async () => {
    configInput.results = {
      store: { type: 'missing/result-store/unavailable-plugin-store' },
    };
    await fs.writeFile(configPath, JSON.stringify(configInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(0);
    expect(runEval).toHaveBeenCalledOnce();
  });

  it('does not trust an existing results.json when no stored summary exists', async () => {
    const outputDir = path.join(outputRoot, 'config');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, 'results.json'),
      JSON.stringify(completedSummary(loadEvalConfig(configPath, { rootDir })))
    );
    expect((await run()).skipped).toBe(0);
    expect(runEval).toHaveBeenCalledOnce();
  });

  it('reruns without a configured result store', async () => {
    delete configInput.results;
    await fs.writeFile(configPath, JSON.stringify(configInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(0);
    expect(runEval).toHaveBeenCalledOnce();
  });

  it.each(['content', 'id'])(
    'reruns when eval config %s changes',
    async (change) => {
      await saveValidSummary();
      if (change === 'id') configInput.name = 'renamed-config';
      else configInput.model = 'different-model';
      await fs.writeFile(configPath, JSON.stringify(configInput));
      expect((await run()).skipped).toBe(0);
      expect(runEval).toHaveBeenCalledOnce();
    }
  );

  it.each(['missing', 'corrupt'])(
    'does not skip a %s current eval config',
    async (state) => {
      await saveValidSummary();
      if (state === 'missing') await fs.rm(configPath);
      else await fs.writeFile(configPath, '{broken json');
      expect(await run()).toMatchObject({ skipped: 0, failed: 1 });
      expect(runEval).toHaveBeenCalledOnce();
    }
  );

  it.each(['missing', 'corrupt'])(
    'reruns with a %s saved artifact',
    async (state) => {
      await saveValidSummary();
      const artifactPath = path.join(
        storeDir,
        'eval-summaries',
        'saved-run.json'
      );
      if (state === 'missing') await fs.rm(artifactPath);
      else await fs.writeFile(artifactPath, '{broken json');
      expect((await run()).skipped).toBe(0);
      expect(runEval).toHaveBeenCalledOnce();
    }
  );

  const corruptions: Array<
    [string, (artifact: StoredEvalArtifact<EvaluationSummary>) => void]
  > = [
    [
      'summary eval config ID',
      (artifact) => {
        artifact.data.configId = 'wrong';
      },
    ],
    [
      'summary content hash',
      (artifact) => {
        artifact.data.contentHash = 'wrong';
      },
    ],
    [
      'metadata eval config ID',
      (artifact) => {
        artifact.metadata.labels!.configId = 'wrong';
      },
    ],
    [
      'metadata content hash',
      (artifact) => {
        artifact.metadata.labels!.contentHash = 'wrong';
      },
    ],
    [
      'missing metadata',
      (artifact) => {
        artifact.metadata = {};
      },
    ],
    [
      'dry-run summary',
      (artifact) => {
        artifact.data.variants = [];
        artifact.data.metrics = {};
        artifact.data.results = [];
      },
    ],
    [
      'incomplete variants',
      (artifact) => {
        artifact.data.variants[0]!.result = undefined;
      },
    ],
    [
      'inconsistent counts',
      (artifact) => {
        artifact.data.metrics.total = 2;
      },
    ],
    [
      'inconsistent variant counts',
      (artifact) => {
        artifact.data.variants[0]!.result!.passed = 0;
      },
    ],
    [
      'missing case results',
      (artifact) => {
        artifact.data.results = [];
      },
    ],
    [
      'wrong variant',
      (artifact) => {
        artifact.data.variants[0]!.name = 'other';
      },
    ],
  ];

  it.each(corruptions)('reruns for %s', async (_name, corrupt) => {
    const artifact = await saveValidSummary();
    corrupt(artifact);
    await store.saveArtifact(artifact);
    expect((await run()).skipped).toBe(0);
    expect(runEval).toHaveBeenCalledOnce();
  });

  it('finds an older matching summary when the latest belongs to another eval config', async () => {
    await saveValidSummary();
    const other = summaryArtifact(
      completedSummary({
        ...loadEvalConfig(configPath, { rootDir }),
        name: 'another',
      })
    );
    other.id = 'newer-run';
    other.createdAt = '2026-09-10T01:00:00.000Z';
    await store.saveArtifact(other);
    expect((await run()).skipped).toBe(1);
    expect(runEval).not.toHaveBeenCalled();
  });

  it('does not treat dry runs as resumed executions', async () => {
    await saveValidSummary();
    const result = await runEvalBatch({
      configPaths: [configPath],
      rootDir,
      skipExisting: true,
      dryRun: true,
    });
    expect(result.skipped).toBe(0);
    expect(runEval).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
  });
});
