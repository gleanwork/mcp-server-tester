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
import { runEvalSuite } from './runEvalSuite.js';
import { loadEvalManifest, type EvalManifest } from './evalManifest.js';
import { resolveManifestExtends } from './manifestExtends.js';
import type { EvaluationSummary } from './evalFrameworkTypes.js';
import type { EvalCaseResult } from '../types/reporter.js';
import {
  createStoredEvalArtifact,
  FileEvalResultStore,
  type StoredEvalArtifact,
} from './resultStore.js';

vi.mock('./runEvalSuite.js', () => ({ runEvalSuite: vi.fn() }));

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

function completedSummary(manifest: EvalManifest): EvaluationSummary {
  const caseResults: EvalCaseResult[] = [
    {
      id: 'case-1',
      datasetName: 'dataset',
      toolName: 'tool',
      source: 'eval',
      pass: true,
      durationMs: 1,
      expectations: {},
    },
  ];
  return {
    schemaVersion: 1,
    manifestId: manifest.name,
    contentHash: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
    manifestName: manifest.name,
    timestamp: '2026-09-10T00:00:00.000Z',
    durationMs: 1,
    arms: [
      {
        name: 'default',
        servers: [],
        result: { total: 1, passed: 1, failed: 0, durationMs: 1, caseResults },
      },
    ],
    metrics: { total: 1, passed: 1, failed: 0 },
    armDeltas: {},
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
        manifestId: summary.manifestId,
        contentHash: summary.contentHash,
      },
    },
    createdAt: summary.timestamp,
  });
}

describe('runEvalBatch skipExisting', () => {
  let rootDir: string;
  let manifestPath: string;
  let storeDir: string;
  let outputRoot: string;
  let store: FileEvalResultStore;
  let manifestInput: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-resume-'));
    manifestPath = path.join(rootDir, 'manifest.json');
    storeDir = path.join(rootDir, 'store');
    outputRoot = path.join(rootDir, 'output');
    store = new FileEvalResultStore({ provider: 'file', dir: storeDir });
    globals[STORE_GLOBAL] = store;
    manifestInput = {
      name: 'resume-test',
      datasets: [{ type: 'test-source' }],
      results: { store: { type: 'file', dir: storeDir } },
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    vi.mocked(runEvalSuite).mockImplementation(async (options) => {
      const manifest = loadEvalManifest(options.manifestPath, { rootDir });
      const summary = completedSummary(manifest);
      return {
        manifest,
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
      completedSummary(loadEvalManifest(manifestPath, { rootDir }))
    );
    await store.saveArtifact(artifact);
    return artifact;
  }

  async function run(options: Partial<RunEvalBatchOptions> = {}) {
    return runEvalBatch({
      manifestPaths: [manifestPath],
      rootDir,
      outputRoot,
      skipExisting: true,
      ...options,
    });
  }

  it('rejects invalid worker counts before scheduling any manifest', async () => {
    await expect(
      runEvalBatch({
        manifestPaths: [manifestPath],
        rootDir,
        workers: Number.NaN,
      })
    ).rejects.toThrow(/workers must be a finite positive integer/);
    expect(runEvalSuite).not.toHaveBeenCalled();
  });

  it('supports manifest directories and disambiguates colliding output basenames', async () => {
    const first = path.join(rootDir, 'one', 'same.json');
    const second = path.join(rootDir, 'two', 'same.json');
    await fs.mkdir(path.dirname(first), { recursive: true });
    await fs.mkdir(path.dirname(second), { recursive: true });
    await fs.writeFile(
      first,
      JSON.stringify({ ...manifestInput, name: 'one' })
    );
    await fs.writeFile(
      second,
      JSON.stringify({ ...manifestInput, name: 'two' })
    );
    const result = await runEvalBatch({
      manifestPaths: [first, second],
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
    expect(runEvalSuite).not.toHaveBeenCalled();
  });

  it('resumes completed failing evaluations, not only passing ones', async () => {
    const artifact = await saveValidSummary();
    artifact.data.results[0]!.pass = false;
    artifact.data.metrics.passed = 0;
    artifact.data.metrics.failed = 1;
    artifact.data.arms[0]!.result!.passed = 0;
    artifact.data.arms[0]!.result!.failed = 1;
    await store.saveArtifact(artifact);
    expect((await run()).skipped).toBe(1);
    expect(runEvalSuite).not.toHaveBeenCalled();
  });

  it('reruns when skipExisting is disabled', async () => {
    await saveValidSummary();
    const result = await runEvalBatch({
      manifestPaths: [manifestPath],
      rootDir,
      skipExisting: false,
    });
    expect(result.skipped).toBe(0);
    expect(runEvalSuite).toHaveBeenCalledOnce();
  });

  it('resumes through the configured store even without outputRoot', async () => {
    await saveValidSummary();
    const result = await runEvalBatch({
      manifestPaths: [manifestPath],
      rootDir,
      skipExisting: true,
    });
    expect(result.skipped).toBe(1);
    expect(runEvalSuite).not.toHaveBeenCalled();
  });

  it('uses a custom result store from a plugin object by configured type', async () => {
    const create = vi.fn(() => store);
    const plugin: Plugin = {
      meta: { name: 'batch-test-plugin', namespace: 'test' },
      resultStores: {
        custom: { schema: z.object({ type: z.string() }), create },
      },
    };
    manifestInput.results = { store: { type: 'test/custom' } };
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    expect((await run({ plugins: [plugin] })).skipped).toBe(1);
    expect(create).toHaveBeenCalledWith({ type: 'test/custom' });
    expect(runEvalSuite).not.toHaveBeenCalled();
  });

  it('passes plugin objects through to the suite it runs', async () => {
    const plugin: Plugin = { meta: { name: 'passed', namespace: 'passed' } };
    await run({ plugins: [plugin], skipExisting: false });
    expect(runEvalSuite).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: [plugin] })
    );
  });

  it('loads manifest plugins before checking the configured result store', async () => {
    await fs.writeFile(
      path.join(rootDir, 'plugin.mjs'),
      storePluginSource('batch')
    );
    manifestInput.plugins = ['./plugin.mjs'];
    manifestInput.results = { store: { type: 'batch/store' } };
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(1);
    expect(loadedNamespaces()).toEqual(['batch']);
    expect(runEvalSuite).not.toHaveBeenCalled();
  });

  it('adds configured plugin paths to the manifest plugins', async () => {
    const manifestDir = path.join(rootDir, 'suite');
    await fs.mkdir(manifestDir);
    await fs.writeFile(
      path.join(manifestDir, 'manifest-plugin.mjs'),
      `export default { meta: { name: 'manifest-plugin', namespace: 'mp' } };`
    );
    // Resolves against rootDir, not the manifest's directory.
    await fs.writeFile(
      path.join(rootDir, 'cli-plugin.mjs'),
      storePluginSource('cli')
    );
    manifestPath = path.join(manifestDir, 'manifest.json');
    manifestInput.plugins = ['./manifest-plugin.mjs'];
    manifestInput.results = { store: { type: 'cli/store' } };
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    const result = await run({ pluginPaths: ['./cli-plugin.mjs'] });
    expect(result.skipped).toBe(1);
    expect(loadedNamespaces()).toEqual(['cli', 'mp']);
    expect(runEvalSuite).not.toHaveBeenCalled();
  });

  it('does not resume through a store from a plugin the manifest does not load', async () => {
    const create = vi.fn(() => store);
    installPlugins([
      {
        meta: { name: 'elsewhere-plugin', namespace: 'elsewhere' },
        resultStores: {
          custom: { schema: z.object({ type: z.string() }), create },
        },
      },
    ]);
    manifestInput.results = { store: { type: 'elsewhere/custom' } };
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(runEvalSuite).toHaveBeenCalledOnce();
  });

  describe('with a shared config', () => {
    function configPlugin(create: () => FileEvalResultStore): Plugin {
      return {
        meta: { name: 'config-plugin', namespace: 'test' },
        resultStores: {
          custom: { schema: z.object({ type: z.string() }), create },
        },
        configs: {
          recommended: { results: { store: { type: 'test/custom' } } },
        },
      };
    }

    beforeEach(async () => {
      delete manifestInput.results;
      manifestInput.extends = ['test/recommended'];
      await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    });

    it('resumes through the store the config supplies, identified with the config applied', async () => {
      const create = vi.fn(() => store);
      const plugin = configPlugin(create);
      installPlugins([plugin]);
      const resolved = resolveManifestExtends(
        loadEvalManifest(manifestPath, { rootDir }),
        ['test']
      );
      await store.saveArtifact(summaryArtifact(completedSummary(resolved)));

      expect((await run({ plugins: [plugin] })).skipped).toBe(1);
      expect(create).toHaveBeenCalledWith({ type: 'test/custom' });
      expect(runEvalSuite).not.toHaveBeenCalled();
    });

    it('reruns when a saved run predates the config', async () => {
      const create = vi.fn(() => store);
      // Saved under the manifest without its config: a different identity.
      await saveValidSummary();

      expect((await run({ plugins: [configPlugin(create)] })).skipped).toBe(0);
      expect(create).toHaveBeenCalled();
      expect(runEvalSuite).toHaveBeenCalledOnce();
    });
  });

  it('reruns safely when plugin loading fails', async () => {
    await fs.writeFile(
      path.join(rootDir, 'broken-plugin.mjs'),
      `throw new Error('plugin load failed');`
    );
    manifestInput.plugins = ['./broken-plugin.mjs'];
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(0);
    expect(runEvalSuite).toHaveBeenCalledOnce();
  });

  it('reruns safely when a plugin store is not loaded', async () => {
    manifestInput.results = {
      store: { type: 'missing/unavailable-plugin-store' },
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(0);
    expect(runEvalSuite).toHaveBeenCalledOnce();
  });

  it('does not trust an existing results.json when no stored summary exists', async () => {
    const outputDir = path.join(outputRoot, 'manifest');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, 'results.json'),
      JSON.stringify(
        completedSummary(loadEvalManifest(manifestPath, { rootDir }))
      )
    );
    expect((await run()).skipped).toBe(0);
    expect(runEvalSuite).toHaveBeenCalledOnce();
  });

  it('reruns without a configured result store', async () => {
    delete manifestInput.results;
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(0);
    expect(runEvalSuite).toHaveBeenCalledOnce();
  });

  it.each(['content', 'id'])(
    'reruns when manifest %s changes',
    async (change) => {
      await saveValidSummary();
      if (change === 'id') manifestInput.name = 'renamed-manifest';
      else manifestInput.model = 'different-model';
      await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
      expect((await run()).skipped).toBe(0);
      expect(runEvalSuite).toHaveBeenCalledOnce();
    }
  );

  it.each(['missing', 'corrupt'])(
    'does not skip a %s current manifest',
    async (state) => {
      await saveValidSummary();
      if (state === 'missing') await fs.rm(manifestPath);
      else await fs.writeFile(manifestPath, '{broken json');
      expect(await run()).toMatchObject({ skipped: 0, failed: 1 });
      expect(runEvalSuite).toHaveBeenCalledOnce();
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
      expect(runEvalSuite).toHaveBeenCalledOnce();
    }
  );

  const corruptions: Array<
    [string, (artifact: StoredEvalArtifact<EvaluationSummary>) => void]
  > = [
    [
      'summary manifest ID',
      (artifact) => {
        artifact.data.manifestId = 'wrong';
      },
    ],
    [
      'summary content hash',
      (artifact) => {
        artifact.data.contentHash = 'wrong';
      },
    ],
    [
      'metadata manifest ID',
      (artifact) => {
        artifact.metadata.labels!.manifestId = 'wrong';
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
        artifact.data.arms = [];
        artifact.data.metrics = {};
        artifact.data.results = [];
      },
    ],
    [
      'incomplete arms',
      (artifact) => {
        artifact.data.arms[0]!.result = undefined;
      },
    ],
    [
      'inconsistent counts',
      (artifact) => {
        artifact.data.metrics.total = 2;
      },
    ],
    [
      'inconsistent arm counts',
      (artifact) => {
        artifact.data.arms[0]!.result!.passed = 0;
      },
    ],
    [
      'missing case results',
      (artifact) => {
        artifact.data.results = [];
      },
    ],
    [
      'wrong arm',
      (artifact) => {
        artifact.data.arms[0]!.name = 'other';
      },
    ],
  ];

  it.each(corruptions)('reruns for %s', async (_name, corrupt) => {
    const artifact = await saveValidSummary();
    corrupt(artifact);
    await store.saveArtifact(artifact);
    expect((await run()).skipped).toBe(0);
    expect(runEvalSuite).toHaveBeenCalledOnce();
  });

  it('finds an older matching summary when the latest belongs to another manifest', async () => {
    await saveValidSummary();
    const other = summaryArtifact(
      completedSummary({
        ...loadEvalManifest(manifestPath, { rootDir }),
        name: 'another',
      })
    );
    other.id = 'newer-run';
    other.createdAt = '2026-09-10T01:00:00.000Z';
    await store.saveArtifact(other);
    expect((await run()).skipped).toBe(1);
    expect(runEvalSuite).not.toHaveBeenCalled();
  });

  it('does not treat dry runs as resumed executions', async () => {
    await saveValidSummary();
    const result = await runEvalBatch({
      manifestPaths: [manifestPath],
      rootDir,
      skipExisting: true,
      dryRun: true,
    });
    expect(result.skipped).toBe(0);
    expect(runEvalSuite).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
  });
});
