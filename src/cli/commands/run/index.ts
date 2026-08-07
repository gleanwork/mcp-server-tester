import path from 'node:path';
import {
  runEvalSuite,
  type RunEvalSuiteOptions,
} from '../../../evals/runEvalSuite.js';

export interface RunOptions {
  config: string;
  plugins?: string[];
  rootDir?: string;
  dryRun?: boolean;
  outputDir?: string;
}

export async function run(options: RunOptions): Promise<void> {
  const suiteOptions: RunEvalSuiteOptions = {
    configPath: options.config,
    rootDir: options.rootDir,
    pluginPaths: options.plugins,
    outputDir: options.outputDir,
    dryRun: options.dryRun,
  };

  const result = await runEvalSuite(suiteOptions);

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          name: result.config.name,
          mode: result.config.mode,
          outputDir: result.outputDir,
          datasets: result.datasets.map((d) => d.path),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const { merged } = result;
  console.log(`\nEval complete: ${merged.configName}`);
  console.log(
    `Results: ${merged.metrics.passed}/${merged.metrics.total} passed (${(merged.metrics.passRate * 100).toFixed(1)}%)`
  );
  console.log(`Output: ${path.join(result.outputDir, 'results.json')}`);
}
