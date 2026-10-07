import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runEvalBatch,
  type RunEvalBatchOptions,
} from '../../../evals/runEvalBatch.js';

export interface BatchOptions {
  configs?: string[];
  configDir?: string;
  rootDir?: string;
  outputRoot?: string;
  workers?: number;
  secretsFile?: string;
  skipExisting?: boolean;
  plugins?: string[];
  dryRun?: boolean;
}

async function resolveConfigPaths(options: BatchOptions): Promise<string[]> {
  if (options.configs?.length) return options.configs;
  if (!options.configDir) {
    throw new Error('Provide --configs or --config-dir.');
  }
  const names = (
    await fs.readdir(options.configDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `Eval config directory not found: ${options.configDir}`
        );
      throw error;
    })
  )
    .filter((name) => name.endsWith('.json'))
    .sort();
  return names.map((name) => path.join(options.configDir!, name));
}

export async function batch(options: BatchOptions): Promise<void> {
  const batchOptions: RunEvalBatchOptions = {
    configPaths: await resolveConfigPaths(options),
    rootDir: options.rootDir,
    outputRoot: options.outputRoot,
    workers: options.workers,
    secretsFile: options.secretsFile,
    skipExisting: options.skipExisting,
    pluginPaths: options.plugins,
    dryRun: options.dryRun,
  };
  const result = await runEvalBatch(batchOptions);
  for (const item of result.items) {
    if (item.skipped) console.log(`${item.configPath}: skipped`);
    else if (item.error) console.error(`${item.configPath}: ${item.error}`);
    else {
      const metrics = item.result?.summary.metrics as {
        passed?: number;
        total?: number;
      };
      console.log(
        `${item.configPath}: ${metrics.passed ?? 0}/${metrics.total ?? 0} passed`
      );
    }
  }
  console.log(
    `\nBatch complete: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`
  );
  if (result.failed > 0) process.exitCode = 1;
}
