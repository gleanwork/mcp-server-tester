import path from 'node:path';
import {
  runEvalSuite,
  type RunEvalSuiteOptions,
  type RunEvalSuiteResult,
} from './runEvalSuite.js';
import type { EvalConfig } from './evalConfigSchema.js';

export interface RunEvalBatchOptions {
  configPaths: string[];
  rootDir?: string;
  parallel?: number;
  outputRoot?: string;
  configOverrides?: Partial<EvalConfig>;
  pluginPaths?: string[];
}

export interface EvalBatchItem {
  configPath: string;
  result?: RunEvalSuiteResult;
  error?: string;
}

export interface RunEvalBatchResult {
  items: EvalBatchItem[];
  passed: number;
  failed: number;
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

/** Run multiple campaign configs with bounded process-level concurrency. */
export async function runEvalBatch(
  options: RunEvalBatchOptions
): Promise<RunEvalBatchResult> {
  if (options.configPaths.length === 0) {
    throw new Error('At least one config path is required');
  }
  const rootDir = options.rootDir ?? process.cwd();
  const tasks = options.configPaths.map(
    (configPath) => async (): Promise<EvalBatchItem> => {
      try {
        const suiteOptions: RunEvalSuiteOptions = {
          configPath,
          rootDir,
          pluginPaths: options.pluginPaths,
          configOverrides: options.configOverrides,
          ...(options.outputRoot
            ? {
                outputDir: path.join(
                  options.outputRoot,
                  path.basename(configPath, '.json')
                ),
              }
            : {}),
        };
        return { configPath, result: await runEvalSuite(suiteOptions) };
      } catch (error) {
        return {
          configPath,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );
  const items = await runWithConcurrency(tasks, options.parallel ?? 1);
  const failed = items.filter(
    (item) =>
      item.error !== undefined || (item.result?.merged.metrics.failed ?? 0) > 0
  ).length;
  return { items, passed: items.length - failed, failed };
}
