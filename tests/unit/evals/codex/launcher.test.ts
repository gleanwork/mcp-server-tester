import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchCodexApp,
  type CodexExit,
  type CodexProcessFacade,
  type CodexSpawnRequest,
} from '../../../../src/evals/codex/launcher.js';
import {
  createCodexProfileOwner,
  prepareCodexProfile,
  saveCodexProfileOwner,
} from '../../../../src/evals/codex/profile.js';

let root: string;
let executablePath: string;
let profilePath: string;
let finish: (exit: CodexExit) => void;
let processes: CodexProcessFacade;
let requests: CodexSpawnRequest[];
let signatureChecks: string[];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex-launch-test-')));
  executablePath = join(root, 'ChatGPT.app/Contents/MacOS/ChatGPT');
  profilePath = join(root, 'profile');
  await mkdir(join(root, 'ChatGPT.app/Contents/MacOS'), { recursive: true });
  await writeFile(executablePath, 'test fixture; never execute', {
    mode: 0o700,
  });
  const exited = new Promise<CodexExit>((resolve) => {
    finish = resolve;
  });
  requests = [];
  signatureChecks = [];
  processes = {
    platform: 'darwin',
    readBundleInfo: async () => ({
      identifier: 'com.openai.codex',
      executable: 'ChatGPT',
      version: '26.903.71938',
    }),
    verifyBundleSignature: async (bundlePath) => {
      signatureChecks.push(bundlePath);
      return { teamIdentifier: '2DC432GLL2' };
    },
    listProcesses: async () => [],
    spawn(request) {
      requests.push(request);
      return { pid: 4242, exited };
    },
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('Codex desktop launch contract', () => {
  it('launches the exact app into private paths without inherited credentials, prompts, or output capture', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'must-not-inherit');
    vi.stubEnv('CODEX_HOME', '/normal/codex');
    vi.stubEnv('NODE_OPTIONS', '--require=/normal/inject.js');
    vi.stubEnv('HTTPS_PROXY', 'https://must-not-inherit');
    const session = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );

    expect(signatureChecks).toEqual([join(root, 'ChatGPT.app')]);
    expect(requests).toEqual([
      {
        executablePath,
        args: [
          `--user-data-dir=${profilePath}/electron`,
          '--force-renderer-accessibility',
        ],
        cwd: `${profilePath}/workspace`,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'en_US.UTF-8',
          HOME: `${profilePath}/home`,
          CFFIXED_USER_HOME: `${profilePath}/home`,
          CODEX_HOME: `${profilePath}/codex`,
          CODEX_ELECTRON_USER_DATA_PATH: `${profilePath}/electron`,
          CODEX_SPARKLE_ENABLED: 'false',
          XDG_CONFIG_HOME: `${profilePath}/xdg-config`,
          XDG_CACHE_HOME: `${profilePath}/xdg-cache`,
          XDG_DATA_HOME: `${profilePath}/xdg-data`,
          XDG_STATE_HOME: `${profilePath}/xdg-state`,
          XDG_RUNTIME_DIR: `${profilePath}/xdg-runtime`,
          TMPDIR: `${profilePath}/tmp`,
          TMP: `${profilePath}/tmp`,
          TEMP: `${profilePath}/tmp`,
        },
        stdio: 'ignore',
        shell: false,
        detached: true,
      },
    ]);
    expect(session.process.pid).toBe(4242);
    expect(session.profile.root).toBe(profilePath);
    for (const directory of Object.values(session.profile.paths)) {
      expect(await realpath(directory)).toBe(directory);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    finish({ code: 0, signal: null });
    expect(await session.exited).toMatchObject({
      status: 'exited',
      code: 0,
      signal: null,
    });
  });

  it('keeps an exclusive durable lease until observed exit, then reuses the same owned profile', async () => {
    const first = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );
    await expect(
      launchCodexApp({ executablePath, profilePath }, processes)
    ).rejects.toThrow(/leased/i);
    expect(requests).toHaveLength(1);
    finish({ code: 0, signal: null });
    await first.exited;
    const second = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );
    expect(second.profile.id).toBe(first.profile.id);
    expect(second.profile.paths).toEqual(first.profile.paths);
    await second.exited;
  });

  it('does not claim to quarantine a lifecycle that already released its lease', async () => {
    const session = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );
    finish({ code: 0, signal: null });
    await session.exited;
    await expect(session.quarantine()).rejects.toThrow(/already finalized/i);
  });

  it('permits one host-owned lease across matching host and fixture state', async () => {
    const profile = await prepareCodexProfile(profilePath);
    const owner = createCodexProfileOwner(profile);
    for (const marker of ['.host-active', '.fixture-config']) {
      const directory = join(profile.root, marker);
      await mkdir(directory, { mode: 0o700 });
      await saveCodexProfileOwner(directory, profile, owner);
    }

    const session = await launchCodexApp(
      { executablePath, profilePath, profileOwner: owner },
      processes
    );
    expect(requests).toHaveLength(1);
    finish({ code: 0, signal: null });
    await expect(session.exited).resolves.toMatchObject({ status: 'exited' });
  });

  it.each(['.fixture-config', '.host-active'])(
    'refuses to create a lease while conflicting %s state exists',
    async (marker) => {
      const profile = await prepareCodexProfile(profilePath);
      await mkdir(join(profile.root, marker), { mode: 0o700 });

      await expect(
        launchCodexApp({ executablePath, profilePath }, processes)
      ).rejects.toThrow(/conflicting|quarantined/i);
      expect(requests).toHaveLength(0);
      await expect(stat(join(profile.root, '.lease'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it('refuses a stale profile operation guard without creating a lease', async () => {
    const profile = await prepareCodexProfile(profilePath);
    await mkdir(join(profile.root, '.profile-operation'), { mode: 0o700 });

    await expect(
      launchCodexApp({ executablePath, profilePath }, processes)
    ).rejects.toThrow(/operation.*quarantined/i);
    expect(requests).toHaveLength(0);
    await expect(stat(join(profile.root, '.lease'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not reclaim an incomplete stale lease even when no Codex process is running', async () => {
    const session = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );
    finish({ code: 0, signal: null });
    await session.exited;
    await mkdir(join(profilePath, '.lease'), { mode: 0o700 });
    await expect(
      launchCodexApp({ executablePath, profilePath }, processes)
    ).rejects.toThrow(/leased|quarantined/i);
    expect(requests).toHaveLength(1);
  });

  it('allows only one of two simultaneous launch attempts for an owned profile', async () => {
    const first = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );
    finish({ code: 0, signal: null });
    await first.exited;
    const attempts = await Promise.allSettled([
      launchCodexApp({ executablePath, profilePath }, processes),
      launchCodexApp({ executablePath, profilePath }, processes),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled')
    ).toHaveLength(1);
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled') await attempt.value.exited;
    }
    expect(requests).toHaveLength(2);
  });

  it.each([
    { code: 1, signal: null },
    { code: null, signal: 'SIGTERM' as const },
  ])(
    'quarantines abnormal app exit without signaling a passive helper or allowing reuse: %j',
    async (exit) => {
      const passive = {
        pid: 5150,
        executablePath: join(
          root,
          'ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers/browser_crashpad_handler'
        ),
        startIdentity: 'passive-start',
      };
      let launched = false;
      processes.listProcesses = async () => (launched ? [passive] : []);
      processes.spawn = (request) => {
        requests.push(request);
        launched = true;
        return {
          pid: 4242,
          exited: new Promise<CodexExit>((resolve) => {
            finish = resolve;
          }),
        };
      };
      const session = await launchCodexApp(
        { executablePath, profilePath },
        processes
      );
      finish(exit);
      expect(await session.exited).toEqual({ ...exit, status: 'quarantined' });
      launched = false;
      await expect(
        launchCodexApp({ executablePath, profilePath }, processes)
      ).rejects.toThrow(/leased|quarantined/i);
      expect(requests).toHaveLength(1);
    }
  );

  it('keeps explicit quarantine durable even after a clean exit; never performs auth inference', async () => {
    const session = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );
    await session.quarantine();
    finish({ code: 0, signal: null });
    expect(await session.exited).toEqual({
      code: 0,
      signal: null,
      status: 'quarantined',
    });
    const record: unknown = JSON.parse(
      await readFile(join(profilePath, '.lease/status.json'), 'utf8')
    );
    expect(record).toMatchObject({
      status: 'quarantined',
      appPid: 4242,
      executablePath,
    });
    await expect(
      launchCodexApp({ executablePath, profilePath }, processes)
    ).rejects.toThrow(/leased|quarantined/i);
  });

  it('keeps a failed spawn quarantined and never exposes raw process errors', async () => {
    processes.spawn = () => {
      throw new Error('secret raw stderr');
    };
    await expect(
      launchCodexApp({ executablePath, profilePath }, processes)
    ).rejects.toThrow(/^Codex launch failed; profile quarantined\.$/);
    await expect(
      launchCodexApp({ executablePath, profilePath }, processes)
    ).rejects.toThrow(/leased|quarantined/i);
  });

  it.each(['selected-main', 'selected-helper', 'other-install'])(
    'rejects an existing Codex app by executable or bundle identity: %s',
    async (kind) => {
      processes.listProcesses = async () => [
        {
          pid: 999,
          startIdentity: 'existing-start',
          executablePath:
            kind === 'selected-main'
              ? executablePath
              : kind === 'selected-helper'
                ? join(
                    root,
                    'ChatGPT.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper'
                  )
                : '/other/Renamed.app/Contents/MacOS/ChatGPT',
        },
      ];
      await expect(
        launchCodexApp({ executablePath, profilePath }, processes)
      ).rejects.toThrow(/already running/i);
      expect(requests).toHaveLength(0);
    }
  );

  it('allows an unrelated app with the same executable basename', async () => {
    const original = processes.readBundleInfo;
    processes.readBundleInfo = async (bundle) =>
      bundle === '/other/ChatGPT.app'
        ? {
            identifier: 'com.example.unrelated',
            executable: 'ChatGPT',
            version: '26.903.71938',
          }
        : original(bundle);
    processes.listProcesses = async () => [
      {
        pid: 999,
        executablePath: '/other/ChatGPT.app/Contents/MacOS/ChatGPT',
        startIdentity: 'unrelated-start',
      },
    ];
    const session = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );
    finish({ code: 0, signal: null });
    expect((await session.exited).status).toBe('exited');
  });

  it('does not let unrelated app metadata failures block launch ownership', async () => {
    const original = processes.readBundleInfo;
    processes.readBundleInfo = async (bundle) => {
      if (bundle === '/other/Notes.app')
        throw new Error('unrelated metadata failure');
      return original(bundle);
    };
    processes.listProcesses = async () => [
      {
        pid: 1000,
        executablePath: '/other/Notes.app/Contents/MacOS/Notes',
        startIdentity: 'unrelated-start',
      },
    ];

    const session = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );
    finish({ code: 0, signal: null });
    expect((await session.exited).status).toBe('exited');
  });

  it.each([
    'wrong-bundle',
    'wrong-binary',
    'wrong-build',
    'wrong-team',
    'missing-signature-check',
    'not-app',
    'not-macos',
  ])(
    'rejects CLI substitution or unverified app identity: %s',
    async (kind) => {
      if (kind === 'wrong-bundle')
        processes.readBundleInfo = async () => ({
          identifier: 'com.openai.chat',
          executable: 'ChatGPT',
          version: '26.903.71938',
        });
      if (kind === 'wrong-binary')
        processes.readBundleInfo = async () => ({
          identifier: 'com.openai.codex',
          executable: 'CodexCLI',
          version: '26.903.71938',
        });
      if (kind === 'wrong-build')
        processes.readBundleInfo = async () => ({
          identifier: 'com.openai.codex',
          executable: 'ChatGPT',
          version: '26.903.71939',
        });
      if (kind === 'wrong-team')
        processes.verifyBundleSignature = async () => ({
          teamIdentifier: 'WRONGTEAM',
        });
      if (kind === 'missing-signature-check')
        processes.verifyBundleSignature = undefined;
      if (kind === 'not-macos') processes.platform = 'linux';
      if (kind === 'not-app') {
        executablePath = join(root, 'codex');
        await writeFile(executablePath, 'do not execute', { mode: 0o700 });
      }
      await expect(
        launchCodexApp({ executablePath, profilePath }, processes)
      ).rejects.toThrow(/Codex app|macOS/i);
      expect(requests).toHaveLength(0);
    }
  );

  it.each(['remaining-helper', 'scan-failed'])(
    'quarantines rather than reusing a profile when app exit is uncertain: %s',
    async (kind) => {
      const session = await launchCodexApp(
        {
          executablePath,
          profilePath,
          ownedProcessCleanupTimeoutMs: 20,
        },
        processes
      );
      processes.listProcesses = async () => {
        if (kind === 'scan-failed') throw new Error('raw process inventory');
        return [
          {
            pid: 5151,
            executablePath: join(
              root,
              'ChatGPT.app/Contents/Frameworks/Helper'
            ),
            startIdentity: 'helper-start',
          },
        ];
      };
      finish({ code: 0, signal: null });
      expect((await session.exited).status).toBe('quarantined');
      processes.listProcesses = async () => [];
      await expect(
        launchCodexApp({ executablePath, profilePath }, processes)
      ).rejects.toThrow(/leased|quarantined/i);
    }
  );

  it('does not observe a bundle helper that was present in the launch baseline as owned', async () => {
    const preexisting = {
      pid: 5151,
      executablePath: join(
        root,
        'ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers/browser_crashpad_handler'
      ),
      startIdentity: 'preexisting-start',
    };
    let scans = 0;
    let launched = false;
    processes.listProcesses = async () => {
      scans++;
      if (scans === 2 || (launched && scans >= 4)) return [preexisting];
      return [];
    };
    processes.spawn = (request) => {
      requests.push(request);
      launched = true;
      return {
        pid: 4242,
        exited: new Promise<CodexExit>((resolve) => {
          finish = resolve;
        }),
      };
    };
    const session = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );

    finish({ code: 0, signal: null });

    expect((await session.exited).status).toBe('exited');
  });

  it.each([
    'ChatGPT.app/Contents/Resources/browser_crashpad_handler',
    'ChatGPT.app/Contents/Resources/bare-modifier-monitor',
    'ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/browser_crashpad_handler',
    'ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Other/../Helpers/browser_crashpad_handler',
    'ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0/7977.83/Helpers/browser_crashpad_handler',
    'ChatGPT.app/Contents/Frameworks/Other Framework.framework/Versions/152.0.7977.83/Helpers/browser_crashpad_handler',
    'ChatGPT.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper',
    'ChatGPT.app/Contents/Frameworks/Codex Service.app/Contents/MacOS/Codex Service',
    'ChatGPT.app/Contents/Frameworks/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer)',
    'ChatGPT.app/Contents/Resources/codex runtime',
  ])(
    'only observes a new bundle path and quarantines if it remains: %s',
    async (relativePath) => {
      const unknown = {
        pid: 5152,
        executablePath: `${root}/${relativePath}`,
        startIdentity: 'unknown-start',
      };
      let launched = false;
      processes.listProcesses = async () => (launched ? [unknown] : []);
      processes.spawn = (request) => {
        requests.push(request);
        launched = true;
        return {
          pid: 4242,
          exited: new Promise<CodexExit>((resolve) => {
            finish = resolve;
          }),
        };
      };
      const session = await launchCodexApp(
        {
          executablePath,
          profilePath,
          ownedProcessCleanupTimeoutMs: 20,
        },
        processes
      );

      finish({ code: 0, signal: null });

      expect((await session.exited).status).toBe('quarantined');
    }
  );

  it.each([
    'ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers/browser_crashpad_handler',
    'ChatGPT.app/Contents/Resources/native/bare-modifier-monitor',
  ])(
    'only observes a bundle helper and releases after it exits independently: %s',
    async (relativePath) => {
      const helper = {
        pid: 5153,
        executablePath: join(root, relativePath),
        startIdentity: 'helper-start',
      };
      let launched = false;
      let observedScans = 0;
      processes.listProcesses = async () => {
        if (!launched) return [];
        observedScans++;
        return observedScans <= 2 ? [helper] : [];
      };
      processes.spawn = (request) => {
        requests.push(request);
        launched = true;
        return {
          pid: 4242,
          exited: new Promise<CodexExit>((resolve) => {
            finish = resolve;
          }),
        };
      };
      const session = await launchCodexApp(
        {
          executablePath,
          profilePath,
          ownedProcessCleanupTimeoutMs: 100,
        },
        processes
      );

      finish({ code: 0, signal: null });

      expect(await session.exited).toEqual({
        code: 0,
        signal: null,
        status: 'exited',
      });
      expect(observedScans).toBeGreaterThanOrEqual(3);
    }
  );

  it('quarantines when an observed helper PID identity changes', async () => {
    const helperPath = join(
      root,
      'ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers/browser_crashpad_handler'
    );
    const first = {
      pid: 5154,
      executablePath: helperPath,
      startIdentity: 'first-start',
    };
    const reused = { ...first, startIdentity: 'reused-start' };
    let launched = false;
    let exitScans = 0;
    processes.listProcesses = async () => {
      if (!launched) return [];
      exitScans++;
      return exitScans < 3 ? [first] : [reused];
    };
    processes.spawn = (request) => {
      requests.push(request);
      launched = true;
      return {
        pid: 4242,
        exited: new Promise<CodexExit>((resolve) => {
          finish = resolve;
        }),
      };
    };
    const session = await launchCodexApp(
      {
        executablePath,
        profilePath,
        ownedProcessCleanupTimeoutMs: 20,
      },
      processes
    );

    finish({ code: 0, signal: null });

    expect((await session.exited).status).toBe('quarantined');
  });

  it('quarantines when a known bundle helper remains after the observation bound', async () => {
    const helper = {
      pid: 5155,
      executablePath: join(
        root,
        'ChatGPT.app/Contents/Resources/native/bare-modifier-monitor'
      ),
      startIdentity: 'helper-start',
    };
    let launched = false;
    processes.listProcesses = async () => (launched ? [helper] : []);
    processes.spawn = (request) => {
      requests.push(request);
      launched = true;
      return {
        pid: 4242,
        exited: new Promise<CodexExit>((resolve) => {
          finish = resolve;
        }),
      };
    };
    const session = await launchCodexApp(
      {
        executablePath,
        profilePath,
        ownedProcessCleanupTimeoutMs: 20,
      },
      processes
    );

    finish({ code: 0, signal: null });

    expect((await session.exited).status).toBe('quarantined');
  });

  it.each([
    'root-symlink',
    'directory-symlink',
    'public-root',
    'public-directory',
    'marker-symlink',
    'marker-hardlink',
    'wrong-owner',
    'unmarked',
  ])('rejects unsafe profile ownership: %s', async (damage) => {
    const first = await launchCodexApp(
      { executablePath, profilePath },
      processes
    );
    finish({ code: 0, signal: null });
    await first.exited;
    const marker = join(profilePath, '.owner.json');
    if (damage === 'root-symlink') {
      const alias = join(root, 'alias');
      await symlink(profilePath, alias);
      profilePath = alias;
    } else if (damage === 'directory-symlink') {
      await rm(first.profile.paths.home, { recursive: true });
      await symlink(root, first.profile.paths.home);
    } else if (damage === 'public-root') {
      await chmod(profilePath, 0o755);
    } else if (damage === 'public-directory') {
      await chmod(first.profile.paths.temp, 0o777);
    } else if (damage === 'wrong-owner') {
      await writeFile(
        marker,
        JSON.stringify({ kind: 'foreign', uid: process.getuid?.() })
      );
    } else {
      const saved = await readFile(marker);
      await rm(marker);
      if (damage !== 'unmarked') {
        const target = join(root, 'not-owned');
        await writeFile(target, saved, { mode: 0o600 });
        if (damage === 'marker-hardlink') await link(target, marker);
        else await symlink(target, marker);
      }
    }
    await expect(
      launchCodexApp({ executablePath, profilePath }, processes)
    ).rejects.toThrow(/profile/i);
    expect(requests).toHaveLength(1);
  });
});
