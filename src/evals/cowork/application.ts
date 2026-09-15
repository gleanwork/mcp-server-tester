import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  isolatedDesktopEnvironment,
  prepareIsolatedDesktopProfile,
  type IsolatedDesktopProfile,
} from '../externalHost/isolatedProfile.js';

export const CLAUDE_DESKTOP_BUILD = '2.110.0';
export const CLAUDE_DESKTOP_BUNDLE_ID = 'com.anthropic.claudefordesktop';
export const CLAUDE_DESKTOP_TEAM_ID = 'Q6L2SF6YDW';

export interface CoworkApplicationOptions {
  executablePath: string;
  profilePath: string;
}

export interface CoworkApplicationMetadata {
  bundleId: string;
  version: string;
  teamId: string;
}

export interface CoworkSpawnRequest {
  executablePath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  profileRoot: string;
  expectedUserDataPath: string;
}

export interface CoworkApplicationFacade {
  metadata(bundlePath: string): Promise<CoworkApplicationMetadata>;
  spawn(
    request: CoworkSpawnRequest,
    acquired: (pid: number) => void
  ): Promise<void>;
  activate(
    pid: number,
    request: CoworkSpawnRequest,
    url: string
  ): Promise<void>;
  openFile(
    pid: number,
    request: CoworkSpawnRequest,
    path: string
  ): Promise<void>;
  stop(
    pid: number,
    request: CoworkSpawnRequest,
    timeoutMs: number
  ): Promise<void>;
}

export interface CoworkApplication {
  executablePath: string;
  bundlePath: string;
  profile: IsolatedDesktopProfile;
  userDataPath: string;
  environment: Record<string, string>;
  launch(acquired: (pid: number) => void): Promise<void>;
  activate(pid: number, url: string): Promise<void>;
  openFile(pid: number, path: string): Promise<void>;
  stop(pid: number, timeoutMs: number): Promise<void>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CoworkProcessHandle {
  pid?: number;
  once(event: 'error', listener: (error: Error) => void): CoworkProcessHandle;
  once(event: 'spawn', listener: () => void): CoworkProcessHandle;
  unref(): void;
}

export interface CoworkNativeProcessOperations {
  execFile(
    executable: string,
    args: string[],
    options: {
      cwd?: string;
      env: Record<string, string>;
      timeout: number;
      maxBuffer?: number;
    }
  ): Promise<CommandResult>;
  spawn(
    executable: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      stdio: 'ignore';
      shell: false;
      detached: true;
    }
  ): CoworkProcessHandle;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  now(): number;
  wait(milliseconds: number): Promise<void>;
}

const COWORK_NEW_URL = 'claude://cowork/new';

/** Validate one signed Claude build and bind it to one isolated profile. */
export async function prepareCoworkApplication(
  options: CoworkApplicationOptions,
  facade: CoworkApplicationFacade = createNativeCoworkApplicationFacade()
): Promise<CoworkApplication> {
  const executablePath = await validateExecutable(options.executablePath);
  const bundlePath = dirname(dirname(dirname(executablePath)));
  const metadata = await facade.metadata(bundlePath);
  if (
    metadata.bundleId !== CLAUDE_DESKTOP_BUNDLE_ID ||
    metadata.version !== CLAUDE_DESKTOP_BUILD ||
    metadata.teamId !== CLAUDE_DESKTOP_TEAM_ID
  ) {
    throw new Error('Unsupported or unverified Claude Desktop application.');
  }
  const profile = await prepareIsolatedDesktopProfile(options.profilePath);
  const userDataPath = join(
    profile.paths.home,
    'Library',
    'Application Support',
    'Claude'
  );
  await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await chmod(userDataPath, 0o700);
  const environment = isolatedDesktopEnvironment(profile, {
    CLAUDE_USER_DATA_DIR: userDataPath,
    CLAUDE_CONFIG_DIR: profile.paths.config,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: profile.paths.secureStorage,
  });
  const spawnRequest: CoworkSpawnRequest = {
    executablePath,
    args: [
      '--force-renderer-accessibility',
      '--use-mock-keychain',
      COWORK_NEW_URL,
    ],
    cwd: profile.paths.workspace,
    env: environment,
    profileRoot: profile.paths.root,
    expectedUserDataPath: userDataPath,
  };
  return {
    executablePath,
    bundlePath,
    profile,
    userDataPath,
    environment,
    async launch(acquired) {
      await facade.spawn(spawnRequest, acquired);
    },
    async activate(pid, url) {
      await facade.activate(pid, spawnRequest, url);
    },
    async openFile(pid, path) {
      await facade.openFile(pid, spawnRequest, path);
    },
    async stop(pid, timeoutMs) {
      await facade.stop(pid, spawnRequest, timeoutMs);
    },
  };
}

export function createNativeCoworkApplicationFacade(
  operations: CoworkNativeProcessOperations = nativeProcessOperations()
): CoworkApplicationFacade {
  return {
    async metadata(bundlePath) {
      await operations.execFile(
        '/usr/bin/codesign',
        ['--verify', '--deep', '--strict', bundlePath],
        { env: {}, timeout: 30_000 }
      );
      const [{ stdout: bundleId }, { stdout: version }, signature] =
        await Promise.all([
          operations.execFile(
            '/usr/bin/plutil',
            [
              '-extract',
              'CFBundleIdentifier',
              'raw',
              join(bundlePath, 'Contents/Info.plist'),
            ],
            { env: {}, timeout: 10_000 }
          ),
          operations.execFile(
            '/usr/bin/plutil',
            [
              '-extract',
              'CFBundleShortVersionString',
              'raw',
              join(bundlePath, 'Contents/Info.plist'),
            ],
            { env: {}, timeout: 10_000 }
          ),
          operations.execFile(
            '/usr/bin/codesign',
            ['-dv', '--verbose=4', bundlePath],
            { env: {}, timeout: 30_000 }
          ),
        ]);
      const details = `${signature.stdout}\n${signature.stderr}`;
      const team = /^TeamIdentifier=(.+)$/m.exec(details)?.[1];
      if (!team)
        throw new Error('Claude Desktop signature identity is unavailable.');
      return {
        bundleId: bundleId.trim(),
        version: version.trim(),
        teamId: team.trim(),
      };
    },
    async spawn(request, acquired) {
      await new Promise<void>((resolve, reject) => {
        const child = operations.spawn(request.executablePath, request.args, {
          cwd: request.cwd,
          env: request.env,
          stdio: 'ignore',
          shell: false,
          detached: true,
        });
        let settled = false;
        child.once('error', () => {
          if (settled) return;
          settled = true;
          reject(new Error('Claude Desktop process spawn failed.'));
        });
        child.once('spawn', () => {
          if (settled) return;
          settled = true;
          if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) {
            reject(new Error('Claude Desktop spawn returned no owned PID.'));
            return;
          }
          const pid = child.pid!;
          child.unref();
          void acquireAndAttest(pid, request, acquired, operations).then(
            resolve,
            reject
          );
        });
      });
    },
    async activate(pid, request, url) {
      if (url !== COWORK_NEW_URL || !request.args.includes(url)) {
        throw new TypeError(
          'Claude Cowork must be routed through the owned launch arguments.'
        );
      }
      await validateOwnedProcess(pid, request, operations);
    },
    async openFile(pid, request, path) {
      if (!isAbsolute(path))
        throw new TypeError('Claude Desktop file path must be absolute.');
      await validateExclusiveOwnedProcess(pid, request, operations);
      await operations.execFile(request.executablePath, [path], {
        cwd: request.cwd,
        env: request.env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      await validateExclusiveOwnedProcess(pid, request, operations);
    },
    async stop(pid, request, timeoutMs) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || timeoutMs <= 0)
        throw new TypeError('Invalid owned Claude teardown request.');
      await terminateOwnedProcess(
        pid,
        request,
        timeoutMs,
        operations,
        'teardown'
      );
    },
  };
}

function nativeProcessOperations(): CoworkNativeProcessOperations {
  return {
    async execFile(executable, args, options) {
      return await promisify(execFile)(executable, args, options);
    },
    spawn(executable, args, options) {
      return spawn(executable, args, options);
    },
    kill(pid, signal) {
      process.kill(pid, signal);
    },
    now() {
      return Date.now();
    },
    async wait(milliseconds) {
      await delay(milliseconds);
    },
  };
}

async function acquireAndAttest(
  pid: number,
  request: CoworkSpawnRequest,
  acquired: (pid: number) => void,
  operations: CoworkNativeProcessOperations
): Promise<void> {
  try {
    acquired(pid);
    await attestNativeIsolation(pid, request, operations);
  } catch (error) {
    try {
      await terminateOwnedProcess(
        pid,
        request,
        5000,
        operations,
        'isolation rollback'
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Claude Desktop isolation failed and exact-child rollback could not be verified.'
      );
    }
    throw error;
  }
}

async function processAlive(
  pid: number,
  operations: CoworkNativeProcessOperations
): Promise<boolean> {
  try {
    const { stdout } = await operations.execFile(
      '/bin/ps',
      ['-p', String(pid), '-o', 'state='],
      { env: {}, timeout: 5000, maxBuffer: 1024 * 1024 }
    );
    const state = stdout.trim();
    if (!state)
      throw new Error('Process presence check returned an empty result.');
    return !state.startsWith('Z');
  } catch (error) {
    try {
      operations.kill(pid, 0);
    } catch (probeError) {
      if (errorCode(probeError) === 'ESRCH') return false;
      throw probeError;
    }
    throw error;
  }
}

async function validateOwnedProcess(
  pid: number,
  request: CoworkSpawnRequest,
  operations: CoworkNativeProcessOperations
): Promise<void> {
  let executable: string;
  let command: string;
  try {
    [{ stdout: executable }, { stdout: command }] = await Promise.all([
      operations.execFile('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
        env: {},
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }),
      operations.execFile(
        '/bin/ps',
        ['eww', '-p', String(pid), '-o', 'command='],
        { env: {}, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
      ),
    ]);
  } catch (error) {
    throw new Error('Owned Claude identity could not be revalidated.', {
      cause: error,
    });
  }
  const identityMatches =
    executable.trim() === request.executablePath &&
    [
      `CLAUDE_USER_DATA_DIR=${request.expectedUserDataPath}`,
      `CLAUDE_CONFIG_DIR=${request.env.CLAUDE_CONFIG_DIR}`,
      `CLAUDE_SECURESTORAGE_CONFIG_DIR=${request.env.CLAUDE_SECURESTORAGE_CONFIG_DIR}`,
      `HOME=${request.env.HOME}`,
      `CFFIXED_USER_HOME=${request.env.CFFIXED_USER_HOME}`,
    ].every((entry) => command.includes(entry));
  if (!identityMatches)
    throw new Error('Refusing to control an unverified Claude process.');
}

async function validateExclusiveOwnedProcess(
  pid: number,
  request: CoworkSpawnRequest,
  operations: CoworkNativeProcessOperations
): Promise<void> {
  await validateOwnedProcess(pid, request, operations);
  const { stdout } = await operations.execFile(
    '/bin/ps',
    ['-axo', 'pid=,comm='],
    { env: {}, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
  );
  const matchingPids = stdout
    .split('\n')
    .map((line) => /^(\s*\d+)\s+(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => match[2] === request.executablePath)
    .map((match) => Number(match[1]));
  if (matchingPids.length !== 1 || matchingPids[0] !== pid) {
    throw new Error(
      'Refusing to route a file without one exact owned process.'
    );
  }
}

async function terminateOwnedProcess(
  pid: number,
  request: CoworkSpawnRequest,
  timeoutMs: number,
  operations: CoworkNativeProcessOperations,
  action: string
): Promise<void> {
  if (!(await processAlive(pid, operations))) return;
  await validateOwnedProcess(pid, request, operations);
  operations.kill(pid, 'SIGTERM');
  const deadline = operations.now() + timeoutMs;
  while (operations.now() < deadline) {
    await operations.wait(50);
    if (!(await processAlive(pid, operations))) return;
  }
  throw new Error(`Owned Claude process did not exit during ${action}.`);
}

async function attestNativeIsolation(
  pid: number,
  request: CoworkSpawnRequest,
  operations: CoworkNativeProcessOperations
): Promise<void> {
  const deadline = operations.now() + 10_000;
  while (operations.now() < deadline) {
    const [{ stdout: executable }, { stdout: processLine }, openFiles] =
      await Promise.all([
        operations.execFile('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
          env: {},
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }),
        operations.execFile(
          '/bin/ps',
          ['eww', '-p', String(pid), '-o', 'command='],
          { env: {}, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
        ),
        readOpenFiles(pid, operations),
      ]);
    const environmentMatches = [
      `CLAUDE_USER_DATA_DIR=${request.expectedUserDataPath}`,
      `CLAUDE_CONFIG_DIR=${request.env.CLAUDE_CONFIG_DIR}`,
      `CLAUDE_SECURESTORAGE_CONFIG_DIR=${request.env.CLAUDE_SECURESTORAGE_CONFIG_DIR}`,
      `HOME=${request.env.HOME}`,
      `CFFIXED_USER_HOME=${request.env.CFFIXED_USER_HOME}`,
    ].every((entry) => processLine.includes(entry));
    const paths = openFiles
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1));
    const hasDedicatedPath = paths.some((path) =>
      path.startsWith(`${request.expectedUserDataPath}/`)
    );
    const hasOtherClaudeUserData = paths.some(
      (path) =>
        path.includes('/Library/Application Support/Claude/') &&
        !path.startsWith(`${request.expectedUserDataPath}/`)
    );
    if (
      executable.trim() === request.executablePath &&
      environmentMatches &&
      hasDedicatedPath &&
      !hasOtherClaudeUserData
    ) {
      return;
    }
    await operations.wait(100);
  }
  throw new Error('Claude Desktop isolated-profile attestation failed.');
}

async function readOpenFiles(
  pid: number,
  operations: CoworkNativeProcessOperations
): Promise<string> {
  try {
    return (
      await operations.execFile('/usr/sbin/lsof', ['-p', String(pid), '-Fn'], {
        env: {},
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    const code = errorCode(error);
    if (code === 1 || code === '1') return '';
    throw error;
  }
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  const { code } = error;
  return typeof code === 'string' || typeof code === 'number'
    ? code
    : undefined;
}

async function validateExecutable(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new TypeError('Claude Desktop executable path must be absolute.');
  }
  const canonical = await realpath(path);
  const expectedSuffix = '/Claude.app/Contents/MacOS/Claude';
  if (!canonical.endsWith(expectedSuffix)) {
    throw new Error('Claude Desktop executable has an unexpected bundle path.');
  }
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o111) === 0) {
      throw new Error('Claude Desktop executable is invalid.');
    }
  } finally {
    await file.close();
  }
  if ((await lstat(path)).isSymbolicLink()) {
    throw new Error('Claude Desktop executable must not be a symlink.');
  }
  return canonical;
}
