import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runEvalBatch } from './runEvalBatch.js';
import { loadPlugins } from '../plugins/loadPlugins.js';
import { runEvalSuite } from './runEvalSuite.js';
import { loadEvalManifest, type EvalManifest } from './evalManifest.js';
import type { EvaluationSummary } from './evalFrameworkTypes.js';
import type { EvalCaseResult } from '../types/reporter.js';
import { registerResultStore } from './frameworkRegistries.js';
import {
  createStoredEvalArtifact,
  FileEvalResultStore,
  type StoredEvalArtifact,
} from './resultStore.js';

vi.mock('./runEvalSuite.js', () => ({ runEvalSuite: vi.fn() }));
vi.mock('../plugins/loadPlugins.js', () => ({ loadPlugins: vi.fn() }));

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
    vi.mocked(loadPlugins).mockReset().mockResolvedValue(undefined);
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-resume-'));
    manifestPath = path.join(rootDir, 'manifest.json');
    storeDir = path.join(rootDir, 'store');
    outputRoot = path.join(rootDir, 'output');
    store = new FileEvalResultStore({ provider: 'file', dir: storeDir });
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

  async function run() {
    return runEvalBatch({
      manifestPaths: [manifestPath],
      rootDir,
      outputRoot,
      skipExisting: true,
    });
  }

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

  it('uses a registered custom result store by configured name', async () => {
    const create = vi.fn(() => store);
    registerResultStore({
      name: 'batch-custom-store',
      schema: z.object({ type: z.string(), name: z.string() }),
      create,
    });
    manifestInput.results = {
      store: { type: 'custom', name: 'batch-custom-store' },
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    expect((await run()).skipped).toBe(1);
    expect(create).toHaveBeenCalledWith({
      type: 'custom',
      name: 'batch-custom-store',
    });
  });

  it('loads manifest plugins before checking the configured result store', async () => {
    manifestInput.plugins = ['./plugin.ts'];
    manifestInput.results = { store: { type: 'batch-loaded-plugin-store' } };
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    vi.mocked(loadPlugins).mockImplementation(async () => {
      registerResultStore({
        name: 'batch-loaded-plugin-store',
        schema: z.object({ type: z.string() }),
        create: () => store,
      });
    });
    expect((await run()).skipped).toBe(1);
    expect(loadPlugins).toHaveBeenCalledWith([path.join(rootDir, 'plugin.ts')]);
    expect(runEvalSuite).not.toHaveBeenCalled();
  });

  it('honors explicitly configured plugin paths instead of manifest plugins', async () => {
    manifestInput.plugins = ['./manifest-plugin.ts'];
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    const result = await runEvalBatch({
      manifestPaths: [manifestPath],
      rootDir,
      skipExisting: true,
      pluginPaths: ['./override.ts'],
    });
    expect(result.skipped).toBe(1);
    expect(loadPlugins).toHaveBeenCalledWith([
      path.join(rootDir, 'override.ts'),
    ]);
  });

  it('reruns safely when plugin loading fails', async () => {
    manifestInput.plugins = ['./broken-plugin.ts'];
    await fs.writeFile(manifestPath, JSON.stringify(manifestInput));
    await saveValidSummary();
    vi.mocked(loadPlugins).mockRejectedValue(new Error('plugin load failed'));
    expect((await run()).skipped).toBe(0);
    expect(runEvalSuite).toHaveBeenCalledOnce();
  });

  it('reruns safely when a plugin store is not registered', async () => {
    manifestInput.results = { store: { type: 'unavailable-plugin-store' } };
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
