import { lstat, mkdir, readdir, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// These hold general configuration or agent instructions, not just auth state.
const RESERVED_DIRECTORIES = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.config',
  '.local',
]);
const MARKER = '.mst-auth-cache-v1';

/** Explicit opt-in: dedicated auth state, never the operator's application home. */
export const AuthCacheDirectoriesSchema = z.record(
  z
    .string()
    .regex(
      /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'Use one dot-prefixed directory name'
    )
    .refine(
      (name) => !RESERVED_DIRECTORIES.has(name.toLowerCase()),
      'Cannot share a configuration or agent-instruction directory'
    ),
  z
    .string()
    .min(1)
    .refine(
      (value) => path.isAbsolute(value),
      'Use an absolute cache directory'
    )
);

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function privateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o777) !== 0o700 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())))
  )
    throw new Error(
      `Auth cache ${directory} must be a private directory (0700 on POSIX) owned by the current user; existing permissions are not changed.`
    );
}

async function prepareCache(cache: string, home: string): Promise<string> {
  // Never put persistent state in a directory the trial will remove, or mount
  // an ancestor containing the trial itself (which would create a cycle).
  const independent = (directory: string) =>
    !contains(home, directory) && !contains(directory, home);
  if (!independent(cache))
    throw new Error('An auth cache must be separate from the trial home.');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await privateDirectory(cache);
  const target = await realpath(cache);
  if (!independent(target))
    throw new Error('An auth cache must be separate from the trial home.');
  const marker = path.join(target, MARKER);
  try {
    await lstat(marker);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    const entries = await readdir(target);
    // Never adopt an existing credential store or other nonempty directory.
    // Another trial may have just initialized the same cache; its marker is
    // created atomically before any helper can write credentials there.
    if (entries.length > 0 && !entries.includes(MARKER))
      throw new Error(
        `Auth cache ${cache} is not an MST cache. Choose a new or empty dedicated directory; existing credentials are not imported.`
      );
    try {
      await mkdir(marker, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  await privateDirectory(marker);
  return target;
}

/**
 * Mount only explicitly configured authentication caches into a fresh HOME.
 * Credential files are never read, copied, logged or removed by MST. Removing
 * the trial home removes these links, not the private persistent directories.
 */
export async function linkAuthCacheDirectories(
  home: string,
  directories: Record<string, string> | undefined
): Promise<void> {
  if (!directories || Object.keys(directories).length === 0) return;
  const caches = AuthCacheDirectoriesSchema.parse(directories);
  const trialHome = await realpath(home);
  for (const [name, cache] of Object.entries(caches)) {
    const target = await prepareCache(path.resolve(cache), trialHome);
    await symlink(
      target,
      path.join(trialHome, name),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  }
}
