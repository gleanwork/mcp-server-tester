/**
 * The judge workspace: one run's evidence, written to a private temporary
 * directory for an agentic judge to read.
 *
 * Layout (pointwise; a pairwise workspace has one such tree per side):
 *
 *   case.json          the case: input, expected data, tags, metadata
 *   response.md        the final response text
 *   trace/events.json  client events in order, with full tool output
 *   trace/messages.json conversation turns, when the client reported them
 *   artifacts/...      the client's artifacts stored with the trial (a Cowork
 *                      session's audit log, outputs, transcripts and saved
 *                      tool output), when it has them
 *   files/...          files a judge or plugin adds (deliverables, raw logs)
 *
 * Nothing is truncated. The directory is created with mode 0700, files with
 * 0600, and it is removed when the judge finishes unless `keep` is set.
 * Credentials never go into a workspace: only what the judge input carries
 * and what the caller adds explicitly.
 */

import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { JudgeCase, JudgeTrial } from '../judgeContract.js';

/** A file added to a workspace, relative to its root. */
export interface WorkspaceFile {
  path: string;
  content: string | Uint8Array;
}

/** A trial's stored client artifacts, copied into the workspace at `at`. */
export interface WorkspaceArtifacts {
  dir: string;
  at: string;
}

/** A workspace on disk. */
export interface JudgeWorkspace {
  root: string;
  /** Remove the workspace. Safe to call twice. */
  dispose(): Promise<void>;
}

/**
 * `path` joined under `root`, or an error when it would leave `root`
 * (absolute paths, `..` segments, empty paths).
 */
function confinedPath(root: string, path: string): string {
  if (path === '' || path.includes('\0'))
    throw new Error(`Invalid workspace path: ${JSON.stringify(path)}`);
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..'))
    throw new Error(`Workspace path escapes the workspace: ${path}`);
  if (resolve(root, rel) !== full)
    throw new Error(`Workspace path escapes the workspace: ${path}`);
  return full;
}

async function put(root: string, file: WorkspaceFile): Promise<void> {
  const full = confinedPath(root, file.path);
  await mkdir(dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, file.content, { mode: 0o600, flag: 'wx' });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The standard files for one run of a case, under `prefix`. */
export function trialFiles(
  evalCase: JudgeCase,
  trial: JudgeTrial,
  prefix = ''
): WorkspaceFile[] {
  const at = (path: string) => (prefix ? `${prefix}/${path}` : path);
  const files: WorkspaceFile[] = [
    { path: at('case.json'), content: json(evalCase) },
    { path: at('response.md'), content: trial.text },
    { path: at('trace/events.json'), content: json(trial.events) },
  ];
  if (trial.messages)
    files.push({
      path: at('trace/messages.json'),
      content: json(trial.messages),
    });
  return files;
}

/**
 * The trial's stored client artifacts, as `artifacts/` (under `prefix`):
 * none when the trial has none.
 */
export function trialArtifacts(
  trial: JudgeTrial,
  prefix = ''
): WorkspaceArtifacts[] {
  if (!trial.artifactsDir) return [];
  return [
    {
      dir: trial.artifactsDir,
      at: prefix ? `${prefix}/artifacts` : 'artifacts',
    },
  ];
}

/**
 * A copy, not a link: a runtime confined to the workspace can't read past
 * it. Symlinks are left out; a stored artifact copy has none.
 */
async function copyArtifacts(
  root: string,
  { dir, at }: WorkspaceArtifacts
): Promise<void> {
  const target = confinedPath(root, at);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await cp(dir, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (source) => !(await lstat(source)).isSymbolicLink(),
  });
}

/**
 * Writes `files` to a new private directory, and copies the trials' stored
 * `artifacts` into it. Paths that would leave the directory, and duplicate
 * paths, are errors.
 */
export async function createWorkspace(
  files: readonly WorkspaceFile[],
  options: {
    keep?: boolean;
    parent?: string;
    artifacts?: readonly WorkspaceArtifacts[];
  } = {}
): Promise<JudgeWorkspace> {
  const root = await mkdtemp(join(options.parent ?? tmpdir(), 'mst-judge-'));
  await chmod(root, 0o700);
  try {
    for (const file of files) await put(root, file);
    for (const artifacts of options.artifacts ?? [])
      await copyArtifacts(root, artifacts);
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
  return {
    root,
    dispose: async () => {
      if (!options.keep) await rm(root, { recursive: true, force: true });
    },
  };
}
