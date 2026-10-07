/**
 * Private token directories for runs (`mst-run-tokens-<uuid>`): removal even
 * when the run does not reach `stop()`.
 *
 * - Interrupted (Ctrl-C, SIGTERM, SIGHUP) or exiting: every live directory is
 *   removed synchronously before the process goes.
 * - Killed outright (SIGKILL, a crash): the next run removes directories whose
 *   owner process is gone.
 */
import { readFileSync, rmSync } from 'node:fs';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TOKEN_DIRECTORY_PREFIX = 'mst-run-tokens-';
const OWNER_FILE = '.owner';
/** A directory without an owner file is from a run killed while creating it. */
const UNOWNED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const live = new Set<string>();
let installed = false;

function removeLiveNow(): void {
  for (const directory of live) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort: the process is going.
    }
  }
  live.clear();
}

function onSignal(signal: NodeJS.Signals): void {
  removeLiveNow();
  uninstall();
  // Removing tokens must not change how the process stops: with no other
  // handler, re-raise so the default action (exit by that signal) applies.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on('exit', removeLiveNow);
  for (const signal of SIGNALS) process.on(signal, onSignal);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  process.off('exit', removeLiveNow);
  for (const signal of SIGNALS) process.off(signal, onSignal);
}

/** Mark a new token directory as this process's; it is removed if the run ends early. */
export async function claimTokenDirectory(directory: string): Promise<void> {
  await writeFile(
    join(directory, OWNER_FILE),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { mode: 0o600, flag: 'wx' }
  );
  live.add(directory);
  install();
}

/** Remove a token directory and stop guarding it. */
export async function releaseTokenDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  live.delete(directory);
  if (live.size === 0) uninstall();
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, as another user's process.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerPid(directory: string): number | undefined {
  try {
    const { pid } = JSON.parse(
      readFileSync(join(directory, OWNER_FILE), 'utf8')
    ) as { pid?: unknown };
    return Number.isInteger(pid) && (pid as number) > 0
      ? (pid as number)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove token directories in `parent` left by runs that no longer exist.
 * Only this user's private directories; anything else is left alone.
 */
export async function sweepStaleTokenDirectories(
  parent: string,
  options: { now?: () => number } = {}
): Promise<string[]> {
  const now = options.now ?? Date.now;
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(TOKEN_DIRECTORY_PREFIX)) continue;
    const directory = join(parent, name);
    if (live.has(directory)) continue;
    try {
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        continue;
      const pid = ownerPid(directory);
      const stale =
        pid === undefined
          ? now() - info.mtimeMs > UNOWNED_MAX_AGE_MS &&
            // An owner file that exists but cannot be parsed: leave it.
            !(await readFile(join(directory, OWNER_FILE)).then(
              () => true,
              () => false
            ))
          : !running(pid);
      if (!stale) continue;
      await rm(directory, { recursive: true, force: true });
      removed.push(directory);
    } catch {
      // Raced with its owner or another sweep.
    }
  }
  return removed;
}

/** For tests. */
export function liveTokenDirectoriesForTests(): ReadonlySet<string> {
  return live;
}
