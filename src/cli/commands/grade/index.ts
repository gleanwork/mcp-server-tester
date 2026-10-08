import { z } from 'zod';
import { describeError } from '../../../utils/describeError.js';
import { gradeRun } from '../../../evals/runEval.js';
import { printRunResult } from '../run/index.js';

export interface GradeOptions {
  config: string;
  plugins?: string[];
  rootDir?: string;
  outputDir?: string;
  secretsFile?: string;
  /** `--no-report`: don't write the regrade's report. */
  report?: boolean;
}

/** `mst grade <run>`: grade a stored run's traces again, as a new run. */
export async function grade(run: string, options: GradeOptions): Promise<void> {
  let result: Awaited<ReturnType<typeof gradeRun>>;
  try {
    result = await gradeRun({
      run,
      configPath: options.config,
      rootDir: options.rootDir,
      pluginPaths: options.plugins,
      outputDir: options.outputDir,
      secretsFile: options.secretsFile,
      ...(options.report === false ? { report: false } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error(`${options.config}: ${describeError(error)}`, {
        cause: error,
      });
    throw error;
  }
  console.log(`Graded the traces of run ${result.gradedFrom}.`);
  printRunResult(result, options.config);
}
