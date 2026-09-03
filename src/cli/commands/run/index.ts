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
  mode?:
    | 'tool-selection'
    | 'tool-call'
    | 'e2e-quality'
    | 'mcp-host'
    | 'sxs'
    | 'direct'
    | 'all';
  clientHost?: string;
  mcpUrl?: string;
  serverB?: string;
  tools?: string;
  version?: string;
  maxCases?: number;
  concurrency?: number;
  iterations?: number;
  maxToolCalls?: number;
  judges?: string[];
  metrics?: string[];
}

export async function run(options: RunOptions): Promise<void> {
  const overrides = Object.fromEntries(
    Object.entries({
      mode: options.mode,
      clientHost: options.clientHost,
      mcpUrl: options.mcpUrl,
      serverB: options.serverB,
      tools: options.tools,
      version: options.version,
      maxCases: options.maxCases,
      concurrency: options.concurrency,
      iterations: options.iterations,
      maxToolCalls: options.maxToolCalls,
      judges: options.judges,
      metrics: options.metrics,
    }).filter(([, value]) => value !== undefined)
  ) as RunEvalSuiteOptions['configOverrides'];

  const suiteOptions: RunEvalSuiteOptions = {
    configPath: options.config,
    rootDir: options.rootDir,
    pluginPaths: options.plugins,
    outputDir: options.outputDir,
    dryRun: options.dryRun,
    configOverrides: overrides,
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
  if (result.comparison) {
    const aWins = result.comparison.reduce(
      (sum, comparison) => sum + comparison.aWins,
      0
    );
    const bWins = result.comparison.reduce(
      (sum, comparison) => sum + comparison.bWins,
      0
    );
    const ties = result.comparison.reduce(
      (sum, comparison) => sum + comparison.ties,
      0
    );
    const bothFail = result.comparison.reduce(
      (sum, comparison) => sum + comparison.bothFail,
      0
    );
    console.log(
      `SxS: A wins ${aWins}, B wins ${bWins}, ties ${ties}, both fail ${bothFail}`
    );
  }
  console.log(`Output: ${path.join(result.outputDir, 'results.json')}`);
}
