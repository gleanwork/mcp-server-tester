import type { EvaluationBatchOptions } from '../../../evals/evalFrameworkTypes.js';

export type BatchOptions = EvaluationBatchOptions & {
  dryRun?: boolean;
};

/**
 * CLI contract for multi-config evaluation runs.
 *
 * The execution implementation is intentionally deferred to a later branch;
 * the scaffold only validates the command shape and reports its plan.
 */
export async function batch(options: BatchOptions): Promise<void> {
  if (!options.dryRun) {
    throw new Error(
      'Batch evaluation execution is not implemented yet; use --dry-run to inspect the plan.'
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        configPaths: options.configPaths ?? [],
        configDir: options.configDir,
        parallel: options.parallel ?? 1,
      },
      null,
      2
    )}\n`
  );
}
