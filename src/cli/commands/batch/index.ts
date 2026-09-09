import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runEvalBatch,
  type RunEvalBatchOptions,
} from '../../../evals/runEvalBatch.js';

export interface BatchOptions {
  manifests?: string[];
  manifestDir?: string;
  rootDir?: string;
  outputRoot?: string;
  workers?: number;
  secretsFile?: string;
  resultsGcsUri?: string;
  skipExisting?: boolean;
  plugins?: string[];
  dryRun?: boolean;
}

async function resolveManifestPaths(options: BatchOptions): Promise<string[]> {
  if (options.manifests?.length) return options.manifests;
  if (!options.manifestDir) {
    throw new Error('Provide --manifests or --manifest-dir.');
  }
  const names = (await fs.readdir(options.manifestDir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  return names.map((name) => path.join(options.manifestDir!, name));
}

export async function batch(options: BatchOptions): Promise<void> {
  const batchOptions: RunEvalBatchOptions = {
    manifestPaths: await resolveManifestPaths(options),
    rootDir: options.rootDir,
    outputRoot: options.outputRoot,
    workers: options.workers,
    secretsFile: options.secretsFile,
    resultsGcsUri: options.resultsGcsUri,
    skipExisting: options.skipExisting,
    pluginPaths: options.plugins,
    dryRun: options.dryRun,
  };
  const result = await runEvalBatch(batchOptions);
  for (const item of result.items) {
    if (item.skipped) console.log(`${item.manifestPath}: skipped`);
    else if (item.error) console.error(`${item.manifestPath}: ${item.error}`);
    else {
      const metrics = item.result?.summary.metrics as {
        passed?: number;
        total?: number;
      };
      console.log(
        `${item.manifestPath}: ${metrics.passed ?? 0}/${metrics.total ?? 0} passed`
      );
    }
  }
  console.log(
    `\nBatch complete: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`
  );
  if (result.failed > 0) process.exitCode = 1;
}
