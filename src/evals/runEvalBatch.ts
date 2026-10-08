import { RESULT_SCHEMA_VERSION } from './resultFormat.js';
import { rejectRenamedOptions } from './renamedKeys.js';
import crypto from 'node:crypto';
import { describeError } from '../utils/describeError.js';
import { resolveStorePaths } from './builtinResultStores.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadEvalConfig, type EvalConfig } from './evalConfig.js';
import { resolveResultStoreConfig } from './configValidation.js';
import { configIdentity } from './configIdentity.js';
import { resolveConfigExtends } from './configExtends.js';
import type { Plugin } from '../plugins/plugin.js';
import { loadEvalPlugins } from './evalPlugins.js';
import { runEval, type RunEvalOptions } from './runEval.js';
import type {
  EvaluationBatchItem,
  EvaluationBatchOptions,
  EvaluationBatchResult,
} from './evalFrameworkTypes.js';

export type RunEvalBatchOptions = EvaluationBatchOptions;
export type EvalBatchItem = EvaluationBatchItem;
export type RunEvalBatchResult = EvaluationBatchResult;

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
    Array.from({ length: Math.min(limit, tasks.length) }, worker)
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
  schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
  configId: z.string(),
  contentHash: z.string(),
  configName: z.string(),
  timestamp: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  variants: z.array(
    z.object({ name: z.string(), result: CompletedResultSchema })
  ),
  metrics: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  results: z.array(CompletedCaseSchema),
});
const StoredSummarySchema = z.object({
  schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
  kind: z.literal('eval-run-summary'),
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  metadata: z.object({
    labels: z.object({
      configId: z.string(),
      contentHash: z.string(),
      partial: z.string().optional(),
    }),
  }),
  data: CompletedSummarySchema,
});

function isMatchingCompletedSummary(
  artifact: unknown,
  artifactId: string,
  evalConfig: EvalConfig
): boolean {
  const parsed = StoredSummarySchema.safeParse(artifact);
  if (!parsed.success) return false;
  const { data: summary, metadata } = parsed.data;
  // A narrowed run is not the eval's result.
  if (metadata.labels.partial === 'true') return false;
  const identity = configIdentity(evalConfig);
  if (
    parsed.data.id !== artifactId ||
    metadata.labels.configId !== identity.configId ||
    metadata.labels.contentHash !== identity.contentHash ||
    summary.configId !== identity.configId ||
    summary.contentHash !== identity.contentHash ||
    summary.configName !== evalConfig.name
  )
    return false;
  const expectedVariants = evalConfig.variants?.length
    ? evalConfig.variants.map((variant) => variant.name)
    : ['default'];
  if (
    summary.variants.length !== expectedVariants.length ||
    summary.variants.some(
      (variant, index) => variant.name !== expectedVariants[index]
    )
  )
    return false;
  const results = summary.variants.flatMap(
    (variant) => variant.result.caseResults
  );
  if (
    results.length !== summary.results.length ||
    results.some(
      (result, index) =>
        result.id !== summary.results[index]?.id ||
        result.pass !== summary.results[index]?.pass
    )
  )
    return false;
  return [
    { ...summary.metrics, caseResults: summary.results },
    ...summary.variants.map((variant) => variant.result),
  ].every(
    (result) =>
      result.total === result.caseResults.length &&
      result.passed === result.caseResults.filter((item) => item.pass).length &&
      result.failed === result.total - result.passed
  );
}

async function hasMatchingSavedResult(
  configPath: string,
  rootDir: string,
  pluginPaths?: string[],
  plugins?: readonly Plugin[]
): Promise<boolean> {
  try {
    const loaded = loadEvalConfig(configPath, { rootDir });
    // A shared config may supply the store, so resolve before deciding.
    if (!loaded.results?.store && !loaded.extends?.length) return false;
    const namespaces = await loadEvalPlugins({
      configPath,
      evalConfig: loaded,
      rootDir,
      pluginPaths,
      plugins,
    });
    // Identified as runEval identifies it: with its shared configs applied.
    const evalConfig = resolveConfigExtends(loaded, namespaces);
    if (!evalConfig.results?.store) return false;
    // Another eval config in this batch may have loaded a plugin this one doesn't list.
    const { definition, config } = resolveResultStoreConfig(
      evalConfig.results.store,
      { namespaces }
    );
    // Relative store paths resolve like the eval's: eval config directory, then rootDir.
    const store = definition.create(
      resolveStorePaths(config, {
        configDir: path.dirname(path.resolve(configPath)),
        rootDir,
      })
    );
    const identity = configIdentity(evalConfig);
    for (const candidate of await store.listArtifacts('eval-run-summary')) {
      if (
        candidate.metadata?.labels?.configId !== identity.configId ||
        candidate.metadata?.labels?.contentHash !== identity.contentHash
      )
        continue;
      try {
        if (
          isMatchingCompletedSummary(
            await store.loadArtifact('eval-run-summary', candidate.id),
            candidate.id,
            evalConfig
          )
        )
          return true;
      } catch {
        /* continue checking older runs */
      }
    }
  } catch {
    /* invalid or unavailable inputs must never skip */
  }
  return false;
}

function resolveConfigPaths(
  options: RunEvalBatchOptions,
  rootDir: string
): Promise<string[]> {
  if (options.configPaths?.length) return Promise.resolve(options.configPaths);
  if (!options.configDir)
    return Promise.reject(
      new Error(
        'At least one eval config path or eval config directory is required.'
      )
    );
  return fs.readdir(path.resolve(rootDir, options.configDir)).then((names) =>
    names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.resolve(rootDir, options.configDir!, name))
  );
}

function outputDirectory(
  outputRoot: string | undefined,
  configPath: string,
  rootDir: string
): string | undefined {
  if (!outputRoot) return undefined;
  const absolute = path.resolve(rootDir, configPath);
  const stem = path.basename(absolute, path.extname(absolute));
  const hash = crypto
    .createHash('sha256')
    .update(absolute)
    .digest('hex')
    .slice(0, 12);
  return path.join(outputRoot, `${stem}-${hash}`);
}

/** Run multiple eval configs with bounded process-level concurrency. */
export async function runEvalBatch(
  options: RunEvalBatchOptions
): Promise<RunEvalBatchResult> {
  rejectRenamedOptions(
    options,
    { manifestPaths: 'configPaths', manifestDir: 'configDir' },
    'runEvalBatch'
  );
  const rootDir = options.rootDir ?? process.cwd();
  const configPaths = await resolveConfigPaths(options, rootDir);
  if (
    !Number.isFinite(options.workers ?? 1) ||
    !Number.isInteger(options.workers ?? 1) ||
    (options.workers ?? 1) < 1
  )
    throw new Error('workers must be a finite positive integer.');
  const tasks = configPaths.map(
    (configPath) => async (): Promise<EvalBatchItem> => {
      try {
        const outputDir = outputDirectory(
          options.outputRoot,
          configPath,
          rootDir
        );
        if (
          options.skipExisting &&
          !options.dryRun &&
          (await hasMatchingSavedResult(
            configPath,
            rootDir,
            options.pluginPaths,
            options.plugins
          ))
        )
          return { configPath, outputDir, skipped: true };
        const evalOptions: RunEvalOptions = {
          configPath,
          rootDir,
          pluginPaths: options.pluginPaths,
          plugins: options.plugins,
          outputDir,
          secretsFile: options.secretsFile,
          dryRun: options.dryRun,
        };
        return {
          configPath,
          outputDir,
          result: await runEval(evalOptions),
        };
      } catch (error) {
        return {
          configPath,
          error: describeError(error),
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
