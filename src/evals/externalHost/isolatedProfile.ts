import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface IsolatedDesktopProfilePaths {
  root: string;
  home: string;
  userData: string;
  config: string;
  secureStorage: string;
  cache: string;
  data: string;
  state: string;
  runtime: string;
  temp: string;
  workspace: string;
}

export interface IsolatedDesktopProfile {
  id: string;
  paths: IsolatedDesktopProfilePaths;
}

/** Prepare or validate one explicit private profile without reading its contents. */
export async function prepareIsolatedDesktopProfile(
  root: string
): Promise<IsolatedDesktopProfile> {
  if (!isAbsolute(root)) {
    throw new TypeError(
      'An absolute isolated desktop profile path is required.'
    );
  }
  await createOrValidatePrivateDirectory(root);
  const canonicalRoot = await realpath(root);
  await assertPrivateDirectory(canonicalRoot);
  const paths: IsolatedDesktopProfilePaths = {
    root: canonicalRoot,
    home: join(canonicalRoot, 'home'),
    userData: join(canonicalRoot, 'user-data'),
    config: join(canonicalRoot, 'config'),
    secureStorage: join(canonicalRoot, 'secure-storage'),
    cache: join(canonicalRoot, 'cache'),
    data: join(canonicalRoot, 'data'),
    state: join(canonicalRoot, 'state'),
    runtime: join(canonicalRoot, 'runtime'),
    temp: join(canonicalRoot, 'temp'),
    workspace: join(canonicalRoot, 'workspace'),
  };
  const profileDirectories: string[] = [
    paths.root,
    paths.home,
    paths.userData,
    paths.config,
    paths.secureStorage,
    paths.cache,
    paths.data,
    paths.state,
    paths.runtime,
    paths.temp,
    paths.workspace,
  ];
  for (const path of profileDirectories) {
    await createOrValidatePrivateDirectory(path);
    if (
      !(await realpath(path)).startsWith(`${canonicalRoot}/`) &&
      path !== canonicalRoot
    ) {
      throw new Error('Isolated desktop profile directory escaped its root.');
    }
  }
  return { id: canonicalRoot, paths };
}

/** Build a minimal environment; ambient secrets are deliberately not inherited. */
export function isolatedDesktopEnvironment(
  profile: IsolatedDesktopProfile,
  additional: Record<string, string> = {}
): Record<string, string> {
  for (const [name, value] of Object.entries(additional)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(name) ||
      value.includes('\0') ||
      name.startsWith('DYLD_') ||
      name === 'NODE_OPTIONS'
    ) {
      throw new TypeError('Unsafe isolated desktop environment override.');
    }
  }
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    HOME: profile.paths.home,
    CFFIXED_USER_HOME: profile.paths.home,
    XDG_CONFIG_HOME: profile.paths.config,
    XDG_CACHE_HOME: profile.paths.cache,
    XDG_DATA_HOME: profile.paths.data,
    XDG_STATE_HOME: profile.paths.state,
    XDG_RUNTIME_DIR: profile.paths.runtime,
    TMPDIR: profile.paths.temp,
    TMP: profile.paths.temp,
    TEMP: profile.paths.temp,
    ...additional,
  };
}

async function createOrValidatePrivateDirectory(path: string): Promise<void> {
  let exists = true;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(
        'Isolated desktop profile directory must not be a symlink.'
      );
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
    exists = false;
  }
  if (!exists) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error('Isolated desktop profile directory is not private.');
    }
  } finally {
    await handle.close();
  }
  const link = await lstat(path);
  if (link.isSymbolicLink()) {
    throw new Error(
      'Isolated desktop profile directory must not be a symlink.'
    );
  }
}
