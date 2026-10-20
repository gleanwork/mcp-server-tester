import { z } from 'zod';
import { describeError } from '../../../utils/describeError.js';
import { gradeRun } from '../../../evals/runEval.js';
import { detach } from '../../../evals/detach/launch.js';
import {
  parseEnvOptions,
  printDetached,
  printRunResult,
  readLoadedDatasets,
} from '../run/index.js';

export interface GradeOptions {
  config: string;
  plugins?: string[];
  rootDir?: string;
  outputDir?: string;
  secretsFile?: string;
  /** `--no-report`: don't write the regrade's report. */
  report?: boolean;
  /** `--env`: grade in this environment (ADR 0005). */
  env?: string;
  /** `--env-option key=value`, each time it was given. */
  envOption?: string[];
  /** `--results <store>`: the result store that keeps the regrade. */
  results?: string;
  /** `--detach`: grade from a coordinator machine the environment creates (ADR 0007). */
  detach?: boolean;
  /** `--loaded-datasets <file>` (hidden): datasets loaded where a detached run started. */
  loadedDatasets?: string;
}

/** `mst grade <run>`: grade a stored run's traces again, as a new run. */
export async function grade(run: string, options: GradeOptions): Promise<void> {
  if (options.detach) {
    if (options.outputDir)
      throw new Error(
        '--detach grades the run in its result store, not --output-dir.'
      );
    const detached = await detach({
      command: 'grade',
      configPath: options.config,
      ...(options.rootDir ? { rootDir: options.rootDir } : {}),
      run,
      ...(options.env ? { env: options.env } : {}),
      envOptions: options.envOption ?? [],
      ...(options.results ? { results: options.results } : {}),
      ...(options.secretsFile ? { secretsFile: options.secretsFile } : {}),
      ...(options.plugins ? { plugins: options.plugins } : {}),
      runArgs: options.report === false ? ['--no-report'] : [],
      noGrade: false,
      gradeEnv: false,
    });
    printDetached(detached, options.config, options.results);
    return;
  }
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
      ...(options.results ? { results: options.results } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.envOption?.length
        ? { envOptions: parseEnvOptions(options.envOption) }
        : {}),
      ...(await readLoadedDatasets(options.loadedDatasets)),
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
