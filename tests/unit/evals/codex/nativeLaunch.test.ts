import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchCodexApp } from '../../../../src/evals/codex/launcher.js';
import { createNativeCodexProcesses } from '../../../../src/evals/codex/nativeProcesses.js';

const os = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile:
    vi.fn<
      (
        file: string,
        args: string[],
        options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => void
    >(),
}));
vi.mock('node:child_process', () => os);

const originalPlatform = process.platform;
let root: string;
let executablePath: string;
let child: EventEmitter & { pid: number };

beforeEach(async () => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex native test-')));
  executablePath = join(root, 'ChatGPT.app/Contents/MacOS/ChatGPT');
  await mkdir(join(root, 'ChatGPT.app/Contents/MacOS'), { recursive: true });
  await writeFile(executablePath, 'fixture never executed', { mode: 0o700 });
  child = Object.assign(new EventEmitter(), { pid: 4646 });
  os.execFile.mockImplementation((file, args, _options, callback) => {
    const output =
      file === '/bin/ps'
        ? `    1 Mon Sep 14 08:00:00 2026 /sbin/launchd\n    2 Mon Sep 14 08:00:01 2026 /bin/sh -c probe --executable ${executablePath}\n`
        : file === '/usr/sbin/lsof'
          ? 'p2\nftxt\nn/bin/sh\n'
          : args.includes('CFBundleIdentifier')
            ? 'com.openai.codex\n'
            : args.includes('CFBundleShortVersionString')
              ? '26.903.71938\n'
              : file === '/usr/bin/codesign'
                ? ''
                : 'ChatGPT\n';
    const stderr =
      file === '/usr/bin/codesign' && args.includes('-dv')
        ? 'TeamIdentifier=2DC432GLL2\n'
        : '';
    callback(null, output, stderr);
  });
  os.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  await rm(root, { recursive: true, force: true });
});

it('uses the native process boundary only for bounded app metadata, executable inventory, and exact detached spawn', async () => {
  const session = await launchCodexApp({
    executablePath,
    profilePath: join(root, 'profile'),
  });
  expect(os.execFile).toHaveBeenCalledWith(
    '/bin/ps',
    ['-ww', '-axo', 'pid=,lstart=,comm='],
    expect.objectContaining({ timeout: 5000, maxBuffer: 1048576 }),
    expect.any(Function)
  );
  expect(os.execFile).toHaveBeenCalledWith(
    '/usr/sbin/lsof',
    ['-a', '-d', 'txt', '-p', '2', '-Fn'],
    expect.objectContaining({ timeout: 5000, maxBuffer: 1048576 }),
    expect.any(Function)
  );
  expect(os.execFile).toHaveBeenCalledWith(
    '/usr/bin/plutil',
    [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      join(root, 'ChatGPT.app/Contents/Info.plist'),
    ],
    expect.any(Object),
    expect.any(Function)
  );
  expect(os.execFile).toHaveBeenCalledWith(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', join(root, 'ChatGPT.app')],
    expect.objectContaining({ timeout: 30_000, maxBuffer: 1048576 }),
    expect.any(Function)
  );
  expect(os.execFile).toHaveBeenCalledWith(
    '/usr/bin/codesign',
    ['-dv', '--verbose=4', join(root, 'ChatGPT.app')],
    expect.objectContaining({ timeout: 30_000, maxBuffer: 1048576 }),
    expect.any(Function)
  );
  const strictVerificationCall = os.execFile.mock.calls.findIndex(
    ([file, args]) => file === '/usr/bin/codesign' && args.includes('--strict')
  );
  expect(
    os.execFile.mock.invocationCallOrder[strictVerificationCall]!
  ).toBeLessThan(os.spawn.mock.invocationCallOrder[0]!);
  expect(os.spawn).toHaveBeenCalledExactlyOnceWith(
    executablePath,
    [
      `--user-data-dir=${root}/profile/electron`,
      '--force-renderer-accessibility',
    ],
    {
      shell: false,
      stdio: 'ignore',
      detached: true,
      cwd: `${root}/profile/workspace`,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
        HOME: `${root}/profile/home`,
        CFFIXED_USER_HOME: `${root}/profile/home`,
        CODEX_HOME: `${root}/profile/codex`,
        CODEX_ELECTRON_USER_DATA_PATH: `${root}/profile/electron`,
        CODEX_SPARKLE_ENABLED: 'false',
        XDG_CONFIG_HOME: `${root}/profile/xdg-config`,
        XDG_CACHE_HOME: `${root}/profile/xdg-cache`,
        XDG_DATA_HOME: `${root}/profile/xdg-data`,
        XDG_STATE_HOME: `${root}/profile/xdg-state`,
        XDG_RUNTIME_DIR: `${root}/profile/xdg-runtime`,
        TMPDIR: `${root}/profile/tmp`,
        TMP: `${root}/profile/tmp`,
        TEMP: `${root}/profile/tmp`,
      },
    }
  );
  expect(session.process.pid).toBe(4646);
  child.emit('exit', 0, null);
  expect(await session.exited).toEqual({
    status: 'exited',
    code: 0,
    signal: null,
  });
});

it('resolves the selected executable path with spaces without truncation', async () => {
  const candidatePath = executablePath;
  os.execFile.mockImplementation((file, _args, _options, callback) => {
    if (file === '/bin/ps') {
      callback(null, `  71 Tue Sep 15 09:10:11 2026 ${candidatePath}\n`, '');
      return;
    }
    callback(null, `p71\nftxt\nn${candidatePath}\n`, '');
  });

  await expect(createNativeCodexProcesses().listProcesses()).resolves.toEqual([
    {
      pid: 71,
      startIdentity: 'Tue Sep 15 09:10:11 2026',
      executablePath: candidatePath,
    },
  ]);
});

it('resolves a shell argv mention to the shell and does not count it', async () => {
  os.execFile.mockImplementation((file, _args, _options, callback) => {
    if (file === '/bin/ps') {
      callback(
        null,
        `  72 Tue Sep 15 09:10:12 2026 /bin/sh -c probe --executable ${executablePath}\n`,
        ''
      );
      return;
    }
    callback(null, 'p72\nftxt\nn/bin/sh\n', '');
  });

  await expect(createNativeCodexProcesses().listProcesses()).resolves.toEqual(
    []
  );
});

it('blocks launch for a real candidate from another com.openai.codex bundle', async () => {
  const candidatePath =
    '/Applications/OpenAI Desktop Apps/Codex.app/Contents/MacOS/Codex';
  os.execFile.mockImplementation((file, args, _options, callback) => {
    if (file === '/bin/ps') {
      callback(null, `  73 Tue Sep 15 09:10:13 2026 ${candidatePath}\n`, '');
      return;
    }
    if (file === '/usr/sbin/lsof') {
      callback(null, `p73\nftxt\nn${candidatePath}\n`, '');
      return;
    }
    const output = args.includes('CFBundleIdentifier')
      ? 'com.openai.codex\n'
      : args.includes('CFBundleShortVersionString')
        ? '26.903.71938\n'
        : args.includes('CFBundleExecutable')
          ? args.some((arg) => arg.includes('/Codex.app/'))
            ? 'Codex\n'
            : 'ChatGPT\n'
          : '';
    const stderr =
      file === '/usr/bin/codesign' && args.includes('-dv')
        ? 'TeamIdentifier=2DC432GLL2\n'
        : '';
    callback(null, output, stderr);
  });

  await expect(
    launchCodexApp({ executablePath, profilePath: join(root, 'profile') })
  ).rejects.toThrow('A Codex app process is already running.');
  expect(os.spawn).not.toHaveBeenCalled();
});

it.each([
  ['failed', new Error('private lsof failure'), ''],
  ['missing', null, 'p74\nftxt\n'],
] as const)(
  'fails closed when lsof proof for a shortlisted candidate is %s',
  async (_kind, error, output) => {
    os.execFile.mockImplementation((file, _args, _options, callback) => {
      if (file === '/bin/ps') {
        callback(
          null,
          '  74 Tue Sep 15 09:10:14 2026 /Applications/Codex.app/Contents/MacOS/Codex\n',
          ''
        );
        return;
      }
      callback(error, output, 'private stderr');
    });

    await expect(
      createNativeCodexProcesses().listProcesses()
    ).rejects.toThrow();
    expect(os.spawn).not.toHaveBeenCalled();
  }
);

it('uses the first lsof text path as the executable and ignores loaded text mappings', async () => {
  const executable = '/Applications/Codex.app/Contents/MacOS/Codex';
  os.execFile.mockImplementation((file, _args, _options, callback) => {
    if (file === '/bin/ps') {
      callback(null, `  74 Tue Sep 15 09:10:14 2026 ${executable}\n`, '');
      return;
    }
    callback(
      null,
      `p74\nftxt\nn${executable}\nftxt\nn/usr/lib/dyld\nftxt\nn/other/module.node\n`,
      ''
    );
  });

  await expect(createNativeCodexProcesses().listProcesses()).resolves.toEqual([
    {
      pid: 74,
      startIdentity: 'Tue Sep 15 09:10:14 2026',
      executablePath: executable,
    },
  ]);
});

it.each(['empty', 'malformed', 'failed'])(
  'fails closed on an unverifiable native process inventory: %s',
  async (kind) => {
    os.execFile.mockImplementation((file, args, _options, callback) => {
      if (file === '/bin/ps') {
        callback(
          kind === 'failed' ? new Error('sensitive inventory error') : null,
          kind === 'malformed' ? 'not a process record' : '',
          'sensitive stderr'
        );
      } else
        callback(
          null,
          args.includes('CFBundleIdentifier')
            ? 'com.openai.codex'
            : args.includes('CFBundleShortVersionString')
              ? '26.903.71938'
              : file === '/usr/bin/codesign'
                ? ''
                : 'ChatGPT',
          file === '/usr/bin/codesign' && args.includes('-dv')
            ? 'TeamIdentifier=2DC432GLL2'
            : ''
        );
    });
    await expect(
      launchCodexApp({ executablePath, profilePath: join(root, 'profile') })
    ).rejects.toThrow('Cannot verify that no Codex app processes are running.');
    expect(os.spawn).not.toHaveBeenCalled();
  }
);

it('fails closed before spawn when strict codesign verification fails', async () => {
  os.execFile.mockImplementation((file, args, _options, callback) => {
    if (file === '/usr/bin/codesign' && args.includes('--verify')) {
      callback(new Error('invalid signature details'), '', 'sensitive stderr');
      return;
    }
    callback(
      null,
      args.includes('CFBundleIdentifier')
        ? 'com.openai.codex'
        : args.includes('CFBundleShortVersionString')
          ? '26.903.71938'
          : args.includes('CFBundleExecutable')
            ? 'ChatGPT'
            : '',
      ''
    );
  });

  await expect(
    launchCodexApp({ executablePath, profilePath: join(root, 'profile') })
  ).rejects.toThrow(/explicit executable/i);

  expect(os.spawn).not.toHaveBeenCalled();
  expect(os.execFile).toHaveBeenCalledWith(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', join(root, 'ChatGPT.app')],
    expect.any(Object),
    expect.any(Function)
  );
});

it('does not expose a native process-signalling operation', () => {
  expect(createNativeCodexProcesses()).not.toHaveProperty('requestSignal');
});

it('captures an early native spawn error without exposing raw output or retrying a CLI', async () => {
  os.spawn.mockImplementation(() => {
    queueMicrotask(() =>
      child.emit('error', new Error('sensitive raw output'))
    );
    return child;
  });
  await expect(
    launchCodexApp({ executablePath, profilePath: join(root, 'profile') })
  ).rejects.toThrow('Codex launch failed; profile quarantined.');
  expect(os.spawn).toHaveBeenCalledTimes(1);
});
