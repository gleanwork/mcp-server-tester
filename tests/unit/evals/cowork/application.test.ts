import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_DESKTOP_BUILD,
  CLAUDE_DESKTOP_BUNDLE_ID,
  CLAUDE_DESKTOP_TEAM_ID,
  createNativeCoworkApplicationFacade,
  prepareCoworkApplication,
  type CoworkApplicationFacade,
  type CoworkNativeProcessOperations,
  type CoworkSpawnRequest,
} from '../../../../src/evals/cowork/application.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('isolated Claude Desktop application', () => {
  it('version-gates the signed app and launches with only the dedicated profile environment', async () => {
    const fixture = await applicationFixture();
    const requests: CoworkSpawnRequest[] = [];
    const activations: Array<{ pid: number; url: string }> = [];
    const stops: Array<{ pid: number; timeoutMs: number }> = [];
    const acquired = vi.fn();
    const facade = validFacade(
      async (request, own) => {
        requests.push(request);
        own(4242);
      },
      async (pid, _request, timeoutMs) => {
        stops.push({ pid, timeoutMs });
      },
      async (pid, _request, url) => {
        activations.push({ pid, url });
      }
    );
    const application = await prepareCoworkApplication(
      {
        executablePath: fixture.executablePath,
        profilePath: fixture.profilePath,
      },
      facade
    );

    await application.launch(acquired);

    expect(acquired).toHaveBeenCalledOnce();
    expect(acquired).toHaveBeenCalledWith(4242);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      executablePath: application.executablePath,
      args: [
        '--force-renderer-accessibility',
        '--use-mock-keychain',
        'claude://cowork/new',
      ],
      cwd: application.profile.paths.workspace,
      env: {
        CLAUDE_USER_DATA_DIR: application.userDataPath,
        CLAUDE_CONFIG_DIR: application.profile.paths.config,
        CLAUDE_SECURESTORAGE_CONFIG_DIR:
          application.profile.paths.secureStorage,
        HOME: application.profile.paths.home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    });
    expect(requests[0]!.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(requests[0]!.env).not.toHaveProperty('GITHUB_TOKEN');

    await application.activate(4242, 'claude://cowork/new');
    expect(activations).toEqual([{ pid: 4242, url: 'claude://cowork/new' }]);
    await application.stop(4242, 1500);
    expect(stops).toEqual([{ pid: 4242, timeoutMs: 1500 }]);
  });

  it.each([
    ['bundleId', 'other.bundle'],
    ['version', '0.0.0'],
    ['teamId', 'OTHERTEAM'],
  ] as const)(
    'rejects an unsupported %s before profile creation or spawn',
    async (field, value) => {
      const fixture = await applicationFixture();
      const metadata = {
        bundleId: CLAUDE_DESKTOP_BUNDLE_ID,
        version: CLAUDE_DESKTOP_BUILD,
        teamId: CLAUDE_DESKTOP_TEAM_ID,
        [field]: value,
      };
      const spawn = vi.fn<CoworkApplicationFacade['spawn']>();
      await expect(
        prepareCoworkApplication(
          {
            executablePath: fixture.executablePath,
            profilePath: fixture.profilePath,
          },
          {
            metadata: async () => metadata,
            spawn,
            activate: async () => {},
            openFile: async () => {},
            stop: async () => {},
          }
        )
      ).rejects.toThrow(/Unsupported or unverified/);
      expect(spawn).not.toHaveBeenCalled();
    }
  );
});

describe('native Claude Desktop PID safety', () => {
  it('routes Cowork in launch argv without bundle-wide open', async () => {
    const request = nativeRequest();
    const calls: Array<{ executable: string; args: string[] }> = [];
    const operations = fakeOperations(async (executable, args) => {
      calls.push({ executable, args });
      return processIdentityResult(request, args);
    });
    const facade = createNativeCoworkApplicationFacade(operations);

    await facade.activate(73, request, 'claude://cowork/new');

    expect(request.args).toContain('claude://cowork/new');
    expect(calls.every((call) => call.executable === '/bin/ps')).toBe(true);
    expect(calls.map((call) => call.executable)).not.toContain('/usr/bin/open');
  });

  it('routes a bundle through the sole exact isolated process', async () => {
    const request = nativeRequest();
    const bundle = '/fixtures/desktop_records.mcpb';
    const calls: Array<{ executable: string; args: string[] }> = [];
    const operations = fakeOperations(async (executable, args) => {
      calls.push({ executable, args });
      if (executable === request.executablePath) return commandResult();
      if (args.includes('pid=,comm=')) {
        return commandResult(`  73 ${request.executablePath}\n`);
      }
      return processIdentityResult(request, args);
    });
    const facade = createNativeCoworkApplicationFacade(operations);

    await facade.openFile(73, request, bundle);

    expect(calls).toContainEqual({
      executable: request.executablePath,
      args: [bundle],
    });
    expect(calls.map((call) => call.executable)).not.toContain('/usr/bin/open');
  });

  it('retries a transient lsof exit-one during application startup', async () => {
    const request = nativeRequest();
    let lsofCalls = 0;
    const operations = fakeOperations(
      async (executable, args) => {
        if (executable === '/usr/sbin/lsof') {
          lsofCalls++;
          if (lsofCalls === 1) throw codedError('no files yet', '1');
          return commandResult(`n${request.expectedUserDataPath}/Lock\n`);
        }
        return processIdentityResult(request, args);
      },
      () => {},
      spawnedProcess(73)
    );
    const acquired = vi.fn();

    await createNativeCoworkApplicationFacade(operations).spawn(
      request,
      acquired
    );

    expect(acquired).toHaveBeenCalledWith(73);
    expect(lsofCalls).toBe(2);
  });

  it('signals only a freshly re-attested PID and verifies absence', async () => {
    const request = nativeRequest();
    let presenceChecks = 0;
    const signals: Array<NodeJS.Signals | 0> = [];
    const operations = fakeOperations(
      async (_executable, args) => {
        if (args.includes('state=')) {
          presenceChecks++;
          if (presenceChecks === 1) return commandResult('R\n');
          throw codedError('process absent', 1);
        }
        return processIdentityResult(request, args);
      },
      (pid, signal) => {
        expect(pid).toBe(73);
        signals.push(signal);
        if (signal === 0) throw codedError('process absent', 'ESRCH');
      }
    );
    const facade = createNativeCoworkApplicationFacade(operations);

    await facade.stop(73, request, 1000);

    expect(signals).toEqual(['SIGTERM', 0]);
  });

  it('refuses to signal a PID whose exact executable cannot be re-attested', async () => {
    const request = nativeRequest();
    const signals: Array<NodeJS.Signals | 0> = [];
    const operations = fakeOperations(
      async (_executable, args) => {
        if (args.includes('state=')) return commandResult('R\n');
        if (args.includes('comm=')) return commandResult('/other/process\n');
        return processIdentityResult(request, args);
      },
      (_pid, signal) => {
        signals.push(signal);
      }
    );
    const facade = createNativeCoworkApplicationFacade(operations);

    await expect(facade.stop(73, request, 1000)).rejects.toThrow(
      /unverified Claude process/
    );
    expect(signals).toEqual([]);
  });

  it('propagates ps failures when a zero-signal probe does not verify absence', async () => {
    const request = nativeRequest();
    const psError = codedError('ps permission failure', 'EACCES');
    const signals: Array<NodeJS.Signals | 0> = [];
    const operations = fakeOperations(
      async () => {
        throw psError;
      },
      (_pid, signal) => {
        signals.push(signal);
      }
    );
    const facade = createNativeCoworkApplicationFacade(operations);

    await expect(facade.stop(73, request, 1000)).rejects.toBe(psError);
    expect(signals).toEqual([0]);
  });

  it('rolls back the exact child and verifies exit after isolation failure', async () => {
    const request = nativeRequest();
    let presenceChecks = 0;
    const signals: Array<NodeJS.Signals | 0> = [];
    const operations = fakeOperations(
      async (executable, args) => {
        if (executable === '/usr/sbin/lsof') {
          throw codedError('lsof failed', 'EIO');
        }
        if (args.includes('state=')) {
          presenceChecks++;
          if (presenceChecks === 1) return commandResult('R\n');
          throw codedError('process absent', 1);
        }
        return processIdentityResult(request, args);
      },
      (pid, signal) => {
        expect(pid).toBe(73);
        signals.push(signal);
        if (signal === 0) throw codedError('process absent', 'ESRCH');
      },
      spawnedProcess(73)
    );
    const facade = createNativeCoworkApplicationFacade(operations);
    const acquired = vi.fn();

    await expect(facade.spawn(request, acquired)).rejects.toThrow(
      /lsof failed/
    );
    expect(acquired).toHaveBeenCalledWith(73);
    expect(signals).toEqual(['SIGTERM', 0]);
  });

  it('fails closed when rollback exit cannot be verified', async () => {
    const request = nativeRequest();
    let presenceChecks = 0;
    const signals: Array<NodeJS.Signals | 0> = [];
    const operations = fakeOperations(
      async (executable, args) => {
        if (executable === '/usr/sbin/lsof') {
          throw codedError('lsof failed', 'EIO');
        }
        if (args.includes('state=')) {
          presenceChecks++;
          if (presenceChecks === 1) return commandResult('R\n');
          throw codedError('ps uncertain', 'EACCES');
        }
        return processIdentityResult(request, args);
      },
      (_pid, signal) => {
        signals.push(signal);
      },
      spawnedProcess(73)
    );
    const facade = createNativeCoworkApplicationFacade(operations);

    await expect(facade.spawn(request, vi.fn())).rejects.toThrow(
      /rollback could not be verified/
    );
    expect(signals).toEqual(['SIGTERM', 0]);
  });
});

function validFacade(
  spawn: CoworkApplicationFacade['spawn'],
  stop: CoworkApplicationFacade['stop'] = async () => {},
  activate: CoworkApplicationFacade['activate'] = async () => {}
): CoworkApplicationFacade {
  return {
    async metadata() {
      return {
        bundleId: CLAUDE_DESKTOP_BUNDLE_ID,
        version: CLAUDE_DESKTOP_BUILD,
        teamId: CLAUDE_DESKTOP_TEAM_ID,
      };
    },
    spawn,
    activate,
    async openFile() {},
    stop,
  };
}

function nativeRequest(): CoworkSpawnRequest {
  return {
    executablePath: '/Applications/Claude.app/Contents/MacOS/Claude',
    args: [
      '--force-renderer-accessibility',
      '--use-mock-keychain',
      'claude://cowork/new',
    ],
    cwd: '/isolated/workspace',
    env: {
      CLAUDE_USER_DATA_DIR: '/isolated/user-data',
      CLAUDE_CONFIG_DIR: '/isolated/config',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/isolated/secure-storage',
      HOME: '/isolated/home',
      CFFIXED_USER_HOME: '/isolated/home',
    },
    profileRoot: '/isolated',
    expectedUserDataPath: '/isolated/user-data',
  };
}

function commandResult(stdout = '', stderr = '') {
  return { stdout, stderr };
}

function processIdentityResult(request: CoworkSpawnRequest, args: string[]) {
  if (args.includes('comm='))
    return commandResult(`${request.executablePath}\n`);
  if (args.includes('command=')) {
    return commandResult(
      [
        request.executablePath,
        `CLAUDE_USER_DATA_DIR=${request.expectedUserDataPath}`,
        `CLAUDE_CONFIG_DIR=${request.env.CLAUDE_CONFIG_DIR}`,
        `CLAUDE_SECURESTORAGE_CONFIG_DIR=${request.env.CLAUDE_SECURESTORAGE_CONFIG_DIR}`,
        `HOME=${request.env.HOME}`,
        `CFFIXED_USER_HOME=${request.env.CFFIXED_USER_HOME}`,
      ].join(' ')
    );
  }
  throw new Error(`Unexpected command arguments: ${args.join(' ')}`);
}

function codedError(message: string, code: string | number): Error {
  return Object.assign(new Error(message), { code });
}

function spawnedProcess(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref(): void;
  };
  child.pid = pid;
  child.unref = vi.fn();
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

function fakeOperations(
  run: CoworkNativeProcessOperations['execFile'],
  kill: CoworkNativeProcessOperations['kill'] = () => {},
  child = spawnedProcess(0)
): CoworkNativeProcessOperations {
  let now = 0;
  return {
    execFile: run,
    spawn() {
      return child;
    },
    kill,
    now() {
      return now;
    },
    async wait(milliseconds) {
      now += milliseconds;
    },
  };
}

async function applicationFixture(): Promise<{
  executablePath: string;
  profilePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'cowork-app-test-'));
  roots.push(root);
  const executablePath = join(
    root,
    'Claude.app',
    'Contents',
    'MacOS',
    'Claude'
  );
  await mkdir(join(root, 'Claude.app', 'Contents', 'MacOS'), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(executablePath, '#!/bin/sh\n', { mode: 0o700 });
  await chmod(executablePath, 0o700);
  return { executablePath, profilePath: join(root, 'profile') };
}
