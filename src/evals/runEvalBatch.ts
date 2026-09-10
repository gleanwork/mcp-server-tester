import path from 'node:path';
import { z } from 'zod';
import { loadEvalManifest, type EvalManifest } from './evalManifest.js';
import { registerBuiltinResultStores } from './builtinResultStores.js';
import { getResultStore } from './frameworkRegistries.js';
import { manifestIdentity } from './manifestIdentity.js';
import { loadPlugins } from '../plugins/loadPlugins.js';
import {
  runEvalSuite,
  type RunEvalSuiteOptions,
  type RunEvalSuiteResult,
} from './runEvalSuite.js';

export interface RunEvalBatchOptions {
  manifestPaths: string[];
  rootDir?: string;
  workers?: number;
  outputRoot?: string;
  skipExisting?: boolean;
  secretsFile?: string;
  pluginPaths?: string[];
  dryRun?: boolean;
}

export interface EvalBatchItem {
  manifestPath: string;
  outputDir?: string;
  result?: RunEvalSuiteResult;
  error?: string;
  skipped?: boolean;
}

export interface RunEvalBatchResult {
  items: EvalBatchItem[];
  passed: number;
  failed: number;
  skipped: number;
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), tasks.length) }, worker)
  );
  return results;
}

const CompletedCaseSchema = z
  .object({ id: z.string(), pass: z.boolean() })
  .passthrough();
const CompletedResultSchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  caseResults: z.array(CompletedCaseSchema),
});
const CompletedSummarySchema = z.object({
  schemaVersion: z.literal(1),
  manifestId: z.string(),
  contentHash: z.string(),
  manifestName: z.string(),
  timestamp: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  arms: z.array(z.object({ name: z.string(), result: CompletedResultSchema })),
  metrics: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  results: z.array(CompletedCaseSchema),
});
const StoredSummarySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('eval-run-summary'),
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  metadata: z.object({
    labels: z.object({ manifestId: z.string(), contentHash: z.string() }),
  }),
  data: CompletedSummarySchema,
});

function isMatchingCompletedSummary(
  artifact: unknown,
  artifactId: string,
  manifest: EvalManifest
): boolean {
  const parsed = StoredSummarySchema.safeParse(artifact);
  if (!parsed.success) return false;
  const { data: summary, metadata } = parsed.data;
  const identity = manifestIdentity(manifest);
  if (
    parsed.data.id !== artifactId ||
    metadata.labels.manifestId !== identity.manifestId ||
    metadata.labels.contentHash !== identity.contentHash ||
    summary.manifestId !== identity.manifestId ||
    summary.contentHash !== identity.contentHash ||
    summary.manifestName !== manifest.name
  ) {
    return false;
  }
  const expectedArms = manifest.arms?.length
    ? manifest.arms.map((arm) => arm.name)
    : ['default'];
  if (
    summary.arms.length !== expectedArms.length ||
    summary.arms.some((arm, index) => arm.name !== expectedArms[index])
  ) {
    return false;
  }
  const results = summary.arms.flatMap((arm) => arm.result.caseResults);
  if (
    results.length !== summary.results.length ||
    results.some(
      (result, index) =>
        result.id !== summary.results[index]?.id ||
        result.pass !== summary.results[index]?.pass
    )
  ) {
    return false;
  }
  return [
    { ...summary.metrics, caseResults: summary.results },
    ...summary.arms.map((arm) => arm.result),
  ].every(
    (result) =>
      result.total === result.caseResults.length &&
      result.passed === result.caseResults.filter((item) => item.pass).length &&
      result.failed === result.total - result.passed
  );
}

async function hasMatchingSavedResult(
  manifestPath: string,
  rootDir: string,
  pluginPaths?: string[]
): Promise<boolean> {
  try {
    // Load and validate the current manifest even when a local results.json exists.
    const manifest = loadEvalManifest(manifestPath, { rootDir });
    if (!manifest.results?.store) return false;
    registerBuiltinResultStores();
    const plugins = pluginPaths ?? manifest.plugins ?? [];
    if (plugins.length > 0) {
      await loadPlugins(
        plugins.map((pluginPath) =>
          path.isAbsolute(pluginPath)
            ? pluginPath
            : path.resolve(rootDir, pluginPath)
        )
      );
    }
    const config = manifest.results.store;
    const definition = getResultStore(config.name ?? config.type);
    definition.schema.parse(config);
    const store = definition.create(config);
    const identity = manifestIdentity(manifest);
    const candidates = await store.listArtifacts('eval-run-summary');
    for (const candidate of candidates) {
      if (
        candidate.metadata?.labels?.manifestId !== identity.manifestId ||
        candidate.metadata?.labels?.contentHash !== identity.contentHash
      ) {
        continue;
      }
      try {
        const artifact = await store.loadArtifact<unknown>(
          'eval-run-summary',
          candidate.id
        );
        if (isMatchingCompletedSummary(artifact, candidate.id, manifest)) {
          return true;
        }
      } catch {
        // A missing/corrupt candidate does not prevent checking older runs.
      }
    }
  } catch {
    // Missing manifests, unavailable stores, and corrupt indexes must never skip.
  }
  return false;
}

/** Run multiple manifests with bounded process-level concurrency. */
export async function runEvalBatch(
  options: RunEvalBatchOptions
): Promise<RunEvalBatchResult> {
  if (options.manifestPaths.length === 0) {
    throw new Error('At least one manifest path is required.');
  }
  const rootDir = options.rootDir ?? process.cwd();
  const tasks = options.manifestPaths.map(
    (manifestPath) => async (): Promise<EvalBatchItem> => {
      try {
        const outputDir = options.outputRoot
          ? path.join(
              options.outputRoot,
              path.basename(manifestPath, path.extname(manifestPath))
            )
          : undefined;
        if (
          options.skipExisting &&
          !options.dryRun &&
          (await hasMatchingSavedResult(
            manifestPath,
            rootDir,
            options.pluginPaths
          ))
        ) {
          return { manifestPath, outputDir, skipped: true };
        }
        const suiteOptions: RunEvalSuiteOptions = {
          manifestPath,
          rootDir,
          pluginPaths: options.pluginPaths,
          outputDir,
          secretsFile: options.secretsFile,
          dryRun: options.dryRun,
        };
        const result = await runEvalSuite(suiteOptions);
        return { manifestPath, result };
      } catch (error) {
        return {
          manifestPath,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );
  const items = await runWithConcurrency(tasks, options.workers ?? 1);
  const skipped = items.filter((item) => item.skipped).length;
  const failed = items.filter(
    (item) =>
      item.error !== undefined ||
      ((item.result?.summary.metrics.failed as number | undefined) ?? 0) > 0
  ).length;
  return { items, passed: items.length - failed - skipped, failed, skipped };
}
