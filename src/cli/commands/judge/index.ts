import path from 'node:path';
import { z } from 'zod';
import { describeError } from '../../../utils/describeError.js';
import { judgeSuite } from '../../../evals/judgeSuite.js';

export interface JudgeOptions {
  manifest: string;
  results: string;
  plugins?: string[];
  rootDir?: string;
  arm?: string;
  judges?: string;
  artifactsRoot?: string;
  dataset?: string;
  baseline?: string;
  baselineArtifactsRoot?: string;
  outputDir?: string;
  concurrency?: string;
}

export async function judge(options: JudgeOptions): Promise<void> {
  let result: Awaited<ReturnType<typeof judgeSuite>>;
  try {
    result = await judgeSuite({
      manifestPath: options.manifest,
      resultsPath: options.results,
      rootDir: options.rootDir,
      pluginPaths: options.plugins,
      arm: options.arm,
      judgesPath: options.judges,
      artifactsRoot: options.artifactsRoot,
      datasetPath: options.dataset,
      baselinePath: options.baseline,
      baselineArtifactsRoot: options.baselineArtifactsRoot,
      outputDir: options.outputDir,
      concurrency: options.concurrency
        ? Number(options.concurrency)
        : undefined,
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error(
        `${options.judges ?? options.manifest}: ${describeError(error)}`,
        {
          cause: error,
        }
      );
    throw error;
  }
  const metrics = result.summary.metrics as {
    passed?: number;
    total?: number;
  };
  console.log(`\nJudged: ${result.summary.manifestName}`);
  console.log(`Results: ${metrics.passed ?? 0}/${metrics.total ?? 0} passed`);
  const usage = result.summary.telemetry?.totalJudgeUsage;
  if (usage?.totalCostUsd !== undefined)
    console.log(`Judge cost: $${usage.totalCostUsd.toFixed(2)}`);
  for (const summary of result.pairwise?.summary ?? [])
    console.log(
      `${summary.judge}: candidate ${summary.candidateWins}, baseline ${summary.baselineWins}, tie ${summary.ties}` +
        (summary.errors ? `, errors ${summary.errors}` : '')
    );
  console.log(`Output: ${path.join(result.outputDir, 'results.json')}`);
}
