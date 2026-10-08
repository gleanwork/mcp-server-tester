/**
 * Client artifacts (see `ClientRunResult.artifactsDir`): each trial's are
 * copied, without what the client marks private, before anything grades the
 * trial, and judges read the copy. A run that keeps full traces keeps the
 * copies in its directory (`artifacts/<variant>/<case-id>/<trial>/`), so
 * `mst grade` reads exactly what the first grading read.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EvalCase } from './datasetTypes.js';
import type { CaseExecution } from './caseExecution.js';
import { trialArtifactsPath } from './runFormat.js';

/**
 * Copy `source` to `target`, leaving out `exclude` (paths relative to
 * `source`; a directory excludes everything under it) and symbolic links,
 * which could point anywhere.
 */
async function copyArtifacts(
  source: string,
  target: string,
  exclude: readonly string[] = []
): Promise<void> {
  const excluded = exclude.map((entry) => path.normalize(entry));
  await fs.cp(source, target, {
    recursive: true,
    errorOnExist: false,
    async filter(file) {
      const relative = path.relative(source, file);
      if (
        relative !== '' &&
        excluded.some(
          (entry) =>
            relative === entry || relative.startsWith(`${entry}${path.sep}`)
        )
      )
        return false;
      return !(await fs.lstat(file)).isSymbolicLink();
    },
  });
}

/**
 * A case executor whose trials' artifacts are copied under `root` (by
 * variant, case and trial) and point there. A copy that fails fails the
 * trial: judges must not grade without the evidence the client reported.
 */
export function withCopiedArtifacts(
  execute: (evalCase: EvalCase) => Promise<CaseExecution>,
  root: string,
  variant: string
): (evalCase: EvalCase) => Promise<CaseExecution> {
  const trials = new Map<string, number>();
  return async (evalCase) => {
    const trial = trials.get(evalCase.id) ?? 0;
    trials.set(evalCase.id, trial + 1);
    const execution = await execute(evalCase);
    const source =
      execution.kind === 'completed'
        ? execution.response.artifactsDir
        : undefined;
    if (execution.kind !== 'completed' || source === undefined)
      return execution;
    const target = path.join(
      root,
      trialArtifactsPath(variant, evalCase.id, trial)
    );
    try {
      await copyArtifacts(source, target, execution.response.artifactsExclude);
    } catch (error) {
      return {
        ...execution,
        error: `Couldn't copy the trial's client artifacts from ${source}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const { artifactsExclude: _exclude, ...response } = execution.response;
    return { ...execution, response: { ...response, artifactsDir: target } };
  };
}

/**
 * A stored copy of `value` (a run summary or a result) without trials'
 * `artifacts`: their local paths are for graders, never for results.
 */
export function withoutTrialArtifacts<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, field: unknown) =>
      key === 'artifacts' &&
      typeof field === 'object' &&
      field !== null &&
      typeof (field as { dir?: unknown }).dir === 'string'
        ? undefined
        : field
    )
  ) as T;
}
