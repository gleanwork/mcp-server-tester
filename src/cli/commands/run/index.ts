import path from 'node:path';
import {
  runEvalSuite,
  type RunEvalSuiteOptions,
} from '../../../evals/runEvalSuite.js';

export interface RunOptions {
  manifest: string;
  plugins?: string[];
  rootDir?: string;
  dryRun?: boolean;
  arm?: string;
  outputDir?: string;
  secretsFile?: string;
}

export async function run(options: RunOptions): Promise<void> {
  const suiteOptions: RunEvalSuiteOptions = {
    manifestPath: options.manifest,
    rootDir: options.rootDir,
    pluginPaths: options.plugins,
    outputDir: options.outputDir,
    secretsFile: options.secretsFile,
    dryRun: options.dryRun,
    arm: options.arm,
  };
  const result = await runEvalSuite(suiteOptions);

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          name: result.manifest.name,
          outputDir: result.outputDir,
          datasets: result.datasets.map((item) => item.source),
          arms: result.manifest.arms?.map((arm) => arm.name) ?? ['default'],
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const metrics = result.summary.metrics as {
    passed?: number;
    failed?: number;
    total?: number;
    passRate?: number;
  };
  console.log(`\nEval complete: ${result.manifest.name}`);
  console.log(
    `Results: ${metrics.passed ?? 0}/${metrics.total ?? 0} passed (${((metrics.passRate ?? 0) * 100).toFixed(1)}%)`
  );
  console.log(`Output: ${path.join(result.outputDir, 'results.json')}`);
  if ((metrics.failed ?? 0) > 0) process.exitCode = 1;
}
