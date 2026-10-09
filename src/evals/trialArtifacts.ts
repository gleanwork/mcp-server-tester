/**
 * Client artifacts (see `ClientRunResult.artifacts`): what each trial's
 * client names as evidence is copied before anything grades the trial, and
 * judges read the copy. A run that keeps full traces keeps the copies in its
 * directory (`artifacts/<variant>/<case-id>/<trial>/`), so `mst grade` reads
 * exactly what the first grading read.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EvalCase } from './datasetTypes.js';
import type { CaseExecution } from './caseExecution.js';
import type { ClientArtifacts } from './evalFrameworkTypes.js';
import { trialArtifactsPath } from './runFormat.js';

/** The most a trial's copy may hold. A copy over a limit fails. */
export const ARTIFACT_LIMITS = {
  /** Bytes in one file. */
  fileBytes: 16 * 1024 * 1024,
  /** Bytes in the whole copy. */
  totalBytes: 64 * 1024 * 1024,
  /** Files and directories visited, included or not. */
  entries: 4096,
  /** Directories below the root. */
  depth: 16,
} as const;

/**
 * Copies everything, hidden names too: for a stored copy, which only holds
 * what its client included.
 */
export const ALL_ARTIFACTS: readonly string[] = ['**'];

type Match = 'included' | 'ancestor' | 'none';

/**
 * Whether a path (segments, relative to the artifacts' root) is included: it
 * or a directory above it matches a pattern. `ancestor`: a directory to look
 * in, as a pattern may match below it.
 */
function matchInclude(
  segments: readonly string[],
  include: ReadonlyArray<readonly RegExp[] | 'all'>
): Match {
  let match: Match = 'none';
  for (const pattern of include) {
    if (pattern === 'all') return 'included';
    const n = Math.min(segments.length, pattern.length);
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = pattern[i]!.test(segments[i]!);
    if (!ok) continue;
    if (segments.length < pattern.length) {
      match = 'ancestor';
      continue;
    }
    // Under an included directory, a hidden name (`outputs/.claude/…`) is
    // only included when a pattern names it.
    if (segments.slice(pattern.length).some((name) => name.startsWith('.')))
      continue;
    return 'included';
  }
  return match;
}

/**
 * One segment of a pattern: `*` matches any characters in a name, but not a
 * leading `.` unless the pattern starts with one, as in a shell.
 */
function segmentPattern(segment: string): RegExp {
  return new RegExp(
    `^${segment.startsWith('.') ? '' : '(?!\\.)'}${segment
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  );
}

/** `include`'s patterns as segments. Fails for one that could leave `dir`. */
function parseInclude(include: readonly string[]): Array<RegExp[] | 'all'> {
  return include.map((entry) => {
    if (entry === '**') return 'all';
    const segments = entry.split('/').filter((part) => part !== '');
    if (
      segments.length === 0 ||
      path.isAbsolute(entry) ||
      segments.some((part) => part === '.' || part === '..')
    )
      throw new Error(
        `The client's artifact path "${entry}" must be relative, without "." or "..".`
      );
    return segments.map(segmentPattern);
  });
}

/**
 * Copy what `artifacts.include` names from `artifacts.dir` to `target`:
 * regular files and the directories that hold them, never a symbolic link
 * or another kind of file, within `ARTIFACT_LIMITS`. Fails, leaving no
 * `target`, when the root isn't a directory or the copy exceeds a limit.
 */
export async function copyArtifacts(
  artifacts: ClientArtifacts,
  target: string,
  limits: {
    readonly [K in keyof typeof ARTIFACT_LIMITS]: number;
  } = ARTIFACT_LIMITS
): Promise<void> {
  const include = parseInclude(artifacts.include);
  const root = await fs.lstat(artifacts.dir);
  if (!root.isDirectory())
    throw new Error('the artifacts directory is not a directory');
  let entries = 0;
  let totalBytes = 0;
  const walk = async (relative: string[]): Promise<void> => {
    if (relative.length > limits.depth)
      throw new Error(`it is more than ${limits.depth} directories deep`);
    const from = path.join(artifacts.dir, ...relative);
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (++entries > limits.entries)
        throw new Error(`it has more than ${limits.entries} entries`);
      const segments = [...relative, entry.name];
      const match = matchInclude(segments, include);
      if (match === 'none') continue;
      if (entry.isDirectory()) {
        await walk(segments);
        continue;
      }
      // Only a regular file an included path names: never a link.
      if (match !== 'included' || !entry.isFile()) continue;
      const source = path.join(artifacts.dir, ...segments);
      const { size } = await fs.lstat(source);
      if (size > limits.fileBytes)
        throw new Error(
          `${segments.join('/')} is larger than ${limits.fileBytes} bytes`
        );
      totalBytes += size;
      if (totalBytes > limits.totalBytes)
        throw new Error(`it holds more than ${limits.totalBytes} bytes`);
      const destination = path.join(target, ...segments);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }
  };
  try {
    await fs.mkdir(target, { recursive: true });
    await walk([]);
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A case executor whose trials' artifacts are copied under `root` (by
 * variant, case and trial) and point there. A copy that fails makes the
 * trial an infrastructure failure: judges must not grade without the
 * evidence the client reported, and no result keeps the source's path.
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
    if (execution.kind !== 'completed') return execution;
    const { artifacts, ...response } = execution.response;
    if (!artifacts) return execution;
    const target = path.join(
      root,
      trialArtifactsPath(variant, evalCase.id, trial)
    );
    // A resumed run's stored trials: their copy is already where it belongs.
    if (path.resolve(artifacts.dir) === path.resolve(target))
      return {
        ...execution,
        response: {
          ...response,
          artifacts: { dir: target, include: ALL_ARTIFACTS },
        },
      };
    try {
      await copyArtifacts(artifacts, target);
    } catch (error) {
      const diagnostics = {
        ...(execution.diagnostics ?? response.diagnostics),
        failureKind: 'artifacts' as const,
      };
      return {
        ...execution,
        response: { ...response, diagnostics },
        diagnostics,
        error: `Couldn't copy the trial's client artifacts: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      ...execution,
      response: {
        ...response,
        artifacts: { dir: target, include: ALL_ARTIFACTS },
      },
    };
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
