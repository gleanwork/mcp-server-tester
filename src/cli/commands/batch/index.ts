import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runEvalBatch,
  type RunEvalBatchOptions,
} from '../../../evals/runEvalBatch.js';
import type {
  EvalCampaignMode,
  EvalConfig,
  MetricSpec,
} from '../../../evals/evalConfigSchema.js';

export interface BatchOptions {
  configs?: string[];
  configDir?: string;
  rootDir?: string;
  outputRoot?: string;
  parallel?: number;
  mode?: EvalCampaignMode;
  clientHost?: string;
  mcpUrl?: string;
  tools?: string;
  maxCases?: number;
  concurrency?: number;
  iterations?: number;
  maxToolCalls?: number;
  judges?: string[];
  metrics?: string[];
  plugins?: string[];
}

async function resolveConfigPaths(options: BatchOptions): Promise<string[]> {
  if (options.configs?.length) return options.configs;
  if (!options.configDir) throw new Error('Provide --configs or --config-dir');
  const names = (await fs.readdir(options.configDir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  return names.map((name) => path.join(options.configDir!, name));
}

export async function batch(options: BatchOptions): Promise<void> {
  const overrides = Object.fromEntries(
    Object.entries({
      mode: options.mode,
      clientHost: options.clientHost,
      mcpUrl: options.mcpUrl,
      tools: options.tools,
      maxCases: options.maxCases,
      concurrency: options.concurrency,
      iterations: options.iterations,
      maxToolCalls: options.maxToolCalls,
      judges: options.judges,
      metrics: options.metrics as MetricSpec[] | undefined,
    }).filter(([, value]) => value !== undefined)
  ) as Partial<EvalConfig>;
  const batchOptions: RunEvalBatchOptions = {
    configPaths: await resolveConfigPaths(options),
    rootDir: options.rootDir,
    outputRoot: options.outputRoot,
    parallel: options.parallel,
    configOverrides: overrides,
    pluginPaths: options.plugins,
  };
  const result = await runEvalBatch(batchOptions);
  for (const item of result.items) {
    if (item.error) console.error(`${item.configPath}: ${item.error}`);
    else
      console.log(
        `${item.configPath}: ${item.result!.merged.metrics.passed}/${item.result!.merged.metrics.total} passed`
      );
  }
  console.log(
    `\nBatch complete: ${result.passed} passed, ${result.failed} failed`
  );
  if (result.failed > 0) process.exitCode = 1;
}
