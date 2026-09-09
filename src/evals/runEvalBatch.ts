import fs from 'node:fs/promises';
import path from 'node:path';
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
        if (options.skipExisting && outputDir) {
          try {
            await fs.access(path.join(outputDir, 'results.json'));
            return { manifestPath, outputDir, skipped: true };
          } catch {
            // No existing result; continue with the run.
          }
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
