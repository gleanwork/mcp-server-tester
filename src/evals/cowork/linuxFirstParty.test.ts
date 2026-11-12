import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import {
  coworkLinuxFirstParty,
  coworkLinux as coworkLinuxThirdParty,
} from './linux.js';
import type { EvalConfig } from '../evalConfig.js';

const runtime = vi.hoisted(() => ({
  open: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  statfs: vi.fn(),
  exec: vi.fn(),
  payloads: [] as Array<Record<string, unknown>>,
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromises>()),
  open: runtime.open,
  lstat: runtime.lstat,
  realpath: runtime.realpath,
  statfs: runtime.statfs,
}));
vi.mock('node:child_process', () => ({ execFile: runtime.exec }));
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../installedApp.js', () => ({
  installedDebApp: vi.fn().mockResolvedValue({
    name: 'Claude',
    version: '1.2.3',
    source: 'installed',
  }),
}));

const owner = '01234567-89ab-cdef-0123-456789abcdef';
const root = `/run/mst/cowork-account/${owner}`;
const profile = `${root}/config/Claude`;
const env = {
  DISPLAY: ':1',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture',
  HOME: `${root}/home`,
  XDG_CONFIG_HOME: `${root}/config`,
  XDG_CACHE_HOME: `${root}/cache`,
  XDG_DATA_HOME: `${root}/data`,
  TMPDIR: `${root}/tmp`,
  CLAUDE_CONFIG_DIR: `${root}/home/.claude`,
  MST_COWORK_ACCOUNT_OWNER: owner,
  MST_COWORK_ACCOUNT_PROFILE: profile,
  MST_COWORK_ACCOUNT_MARKER: `${root}/owner.json`,
  MST_COWORK_CLOUD_CONTROL_SOCKET: `${root}/control.sock`,
  MST_COWORK_URL_OPENER: '/opt/mst/plugin-account/open-url',
  MST_COWORK_SETTINGS_FILE: `${root}/managed-settings.json`,
  MST_COWORK_WARM_VM: '0',
  MST_DESKTOP_OWNED: '1',
  MST_DESKTOP_RESTART: '/must-not-run',
};
const config: EvalConfig = { name: 'account-linux', datasets: [], servers: [] };
let marker: Record<string, unknown>;
let settings: string | undefined;
const directoryInfo = () => ({
  isDirectory: () => true,
  isSocket: () => false,
  uid: process.getuid?.(),
  mode: 0o40700,
});
const fileInfo = () => ({
  isFile: () => true,
  uid: process.getuid?.(),
  mode: 0o100600,
  size: 512,
  nlink: 1,
});
function prepare(overrides: Record<string, string | undefined> = {}) {
  return coworkLinuxFirstParty.prepare({
    evalConfig: config,
    model: 'claude-opus-4-6',
    env: { ...env, ...overrides },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.payloads.length = 0;
  marker = {
    version: 1,
    owner,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accountId: 'account',
    organizationId: 'org',
    profileDir: profile,
    schemaVersion: 24,
    mode: 'first-party',
  };
  settings = '{}';
  runtime.open.mockImplementation(async (path: string) => {
    if (path === env.MST_COWORK_SETTINGS_FILE && settings === undefined)
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return {
      stat: async () => fileInfo(),
      readFile: async () =>
        path === env.MST_COWORK_ACCOUNT_MARKER
          ? JSON.stringify(marker)
          : settings,
      close: vi.fn(),
    };
  });
  runtime.lstat.mockImplementation(async (path: string) => {
    if (path === '/run/mst/inference-token')
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return path.endsWith('.sock')
      ? {
          ...directoryInfo(),
          isDirectory: () => false,
          isSocket: () => true,
          mode: 0o140600,
        }
      : directoryInfo();
  });
  runtime.realpath.mockImplementation(async (path: string) => path);
  runtime.statfs.mockResolvedValue({ type: 0x01021994 });
  runtime.exec.mockImplementation((_command, args, _options, callback) => ({
    stdin: {
      on: vi.fn(),
      end(payload: string) {
        runtime.payloads.push(JSON.parse(payload) as Record<string, unknown>);
        const mode = args[args.indexOf('--mode') + 1];
        callback(
          null,
          JSON.stringify({
            status:
              mode === 'submit'
                ? 'submitted'
                : mode === 'hitl' || mode === 'answer'
                  ? 'hitl_checked'
                  : 'ready',
            action_count: mode === 'probe' ? 0 : 1,
            duration_ms: 1,
          })
        );
      },
    },
  }));
});

describe('plugin-staged first-party Linux desktop', () => {
  it('rejects the managed adapter on an account runtime before settings access', async () => {
    await expect(
      coworkLinuxThirdParty.prepare({ evalConfig: config, env })
    ).rejects.toThrow('no settings were changed');
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it.each(['{}', undefined])(
    'only probes an unmanaged runtime (%s); never writes, restarts or warms up',
    async (value) => {
      settings = value;
      const session = await prepare();
      await session.dispose();
      expect(session.app).toMatchObject({ name: 'Claude', version: '1.2.3' });
      expect(session.restart).toBeUndefined();
      expect(runtime.exec).toHaveBeenCalledOnce();
      expect(runtime.exec.mock.calls[0]![0]).toBe(process.execPath);
      expect(runtime.exec.mock.calls[0]![1]).toContain('probe');
      expect(runtime.exec.mock.calls[0]![1][0]).toMatch(
        /\/cowork\/linuxFirstParty\.js$/
      );
      expect(runtime.payloads).toEqual([{}]);
      expect(
        runtime.open.mock.calls.every(([, flags]) => (Number(flags) & 3) === 0)
      ).toBe(true);
      expect(
        runtime.open.mock.calls.some(([path]) =>
          String(path).includes('Cookies')
        )
      ).toBe(false);
    }
  );

  it('preserves exact model/prompt and the action budget through one first-party submission', async () => {
    const prompt = '  Find 中文 & "quotes"\nunchanged  ';
    await coworkLinuxFirstParty.submit(prompt, {
      deadlineAt: Date.now() + 10_000,
      maxActions: 9,
      targetModel: 'claude-opus-4-6',
      env,
    });
    expect(runtime.payloads).toEqual([
      { prompt, targetModel: 'claude-opus-4-6' },
    ]);
    expect(runtime.exec).toHaveBeenCalledOnce();
    const [, args, options] = runtime.exec.mock.calls[0]!;
    expect(args).toContain('9');
    expect(runtime.exec.mock.calls[0]![0]).toBe(process.execPath);
    expect(args[0]).toMatch(/\/cowork\/linuxFirstParty\.js$/);
    expect(options.env.MST_COWORK_URL_OPENER).toBe(env.MST_COWORK_URL_OPENER);
    expect(options.env.HOME).toBe(env.HOME);
    expect(options.env.XDG_CONFIG_HOME).toBe(env.XDG_CONFIG_HOME);
    expect(options.env.MST_COWORK_ACCOUNT_MARKER).toBe(
      env.MST_COWORK_ACCOUNT_MARKER
    );
    expect(options.env.MST_COWORK_ACCOUNT_PROFILE).toBe(
      env.MST_COWORK_ACCOUNT_PROFILE
    );
    expect(options.env.MST_COWORK_ACCOUNT_OWNER).toBe(owner);
    expect(options.env).not.toHaveProperty('MST_COWORK_CLOUD_CONTROL_SOCKET');
  });

  it('routes account HITL to its own helper without a payload mode flag', async () => {
    await coworkLinuxFirstParty.handleHitl({
      deadlineAt: Date.now() + 10_000,
      env,
      approveWriteTools: true,
      isComplete: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });
    expect(runtime.payloads).toEqual([{ approveWriteTools: true }]);
    expect(runtime.exec.mock.calls[0]![1][0]).toMatch(
      /\/cowork\/linuxFirstParty\.js$/
    );
  });

  it('uses the same profile-preserving launcher for reset, without managed restart', async () => {
    await coworkLinuxFirstParty.reset!({
      deadlineAt: Date.now() + 10_000,
      env,
    });
    expect(runtime.payloads).toEqual([{}]);
    expect(runtime.exec.mock.calls[0]![1][0]).toMatch(
      /\/cowork\/linuxFirstParty\.js$/
    );
    expect(runtime.exec).toHaveBeenCalledOnce();
    expect(runtime.exec.mock.calls[0]![1]).toContain('reset');
    expect(runtime.exec.mock.calls[0]![2].env.MST_COWORK_URL_OPENER).toBe(
      env.MST_COWORK_URL_OPENER
    );
  });

  it('routes clarifying answers to the account helper too', async () => {
    const questions = [{ labels: ['First', 'Second'], multiSelect: false }];
    await coworkLinuxFirstParty.handleHitl({
      deadlineAt: Date.now() + 10_000,
      env,
      pendingQuestion: async () => ({ id: 'question', questions }),
      isComplete: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });
    expect(runtime.payloads).toEqual([{ questions }]);
    expect(runtime.exec.mock.calls[0]![1]).toContain('answer');
    expect(runtime.exec.mock.calls[0]![1][0]).toMatch(
      /\/cowork\/linuxFirstParty\.js$/
    );
  });

  it('does not infer account mode from environment on the third-party adapter', async () => {
    await coworkLinuxThirdParty.submit('query', {
      deadlineAt: Date.now() + 10_000,
      env,
    });
    expect(runtime.exec.mock.calls[0]![1][0]).toMatch(/\/cowork_linux\.py$/);
    expect(runtime.payloads).toEqual([{ prompt: 'query' }]);
  });

  it('requires source-owned recovery instead of inheriting managed recovery', async () => {
    expect(coworkLinuxFirstParty.recover).not.toBe(
      coworkLinuxThirdParty.recover
    );
    await expect(coworkLinuxFirstParty.recover()).rejects.toThrow(
      'account source runtime'
    );
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it.each([
    ['owner absent', { MST_COWORK_ACCOUNT_OWNER: undefined }],
    ['owner traversal', { MST_COWORK_ACCOUNT_OWNER: '../other' }],
    ['profile absent', { MST_COWORK_ACCOUNT_PROFILE: undefined }],
    ['profile mismatch', { MST_COWORK_ACCOUNT_PROFILE: `${root}/other` }],
    ['marker mismatch', { MST_COWORK_ACCOUNT_MARKER: `${root}/other.json` }],
    ['config mismatch', { XDG_CONFIG_HOME: '/home/mst/.config' }],
    ['home mismatch', { HOME: '/home/mst' }],
    ['cache mismatch', { XDG_CACHE_HOME: '/home/mst/.cache' }],
    ['data mismatch', { XDG_DATA_HOME: '/home/mst/.local/share' }],
    ['temp mismatch', { TMPDIR: '/tmp' }],
    ['cache absent', { XDG_CACHE_HOME: undefined }],
    ['data absent', { XDG_DATA_HOME: undefined }],
    ['temp absent', { TMPDIR: undefined }],
    ['Claude config mismatch', { CLAUDE_CONFIG_DIR: '/home/mst/.claude' }],
    ['warmup enabled', { MST_COWORK_WARM_VM: '1' }],
    ['warmup contract absent', { MST_COWORK_WARM_VM: undefined }],
    ['opener absent', { MST_COWORK_URL_OPENER: undefined }],
    ['opener relative', { MST_COWORK_URL_OPENER: 'xdg-open' }],
    ['socket absent', { MST_COWORK_CLOUD_CONTROL_SOCKET: undefined }],
    ['socket relative', { MST_COWORK_CLOUD_CONTROL_SOCKET: 'control.sock' }],
    ['gateway env', { MST_INFERENCE_BASE_URL: 'https://gateway.invalid' }],
    ['gateway base URL', { ANTHROPIC_BASE_URL: 'https://gateway.invalid' }],
    ['API inference', { ANTHROPIC_API_KEY: 'not-an-account-session' }],
  ] as const)('rejects %s before any UI action', async (_name, override) => {
    await expect(prepare(override)).rejects.toThrow('plugin-staged');
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it.each([
    ['mode', 'third-party'],
    ['version', 2],
    ['owner', 'other-owner'],
    ['profileDir', '/wrong'],
    ['schemaVersion', 25],
    ['accountId', ''],
    ['organizationId', ''],
    ['expiresAt', 'invalid'],
    ['expiresAt', new Date(0).toISOString()],
    ['expiresAt', new Date(Date.now() + 48 * 60 * 60_000).toISOString()],
    ['cookies', 'must-not-appear'],
  ])(
    'rejects marker %s=%s without exposing its contents',
    async (key, value) => {
      marker[key] = value;
      await expect(prepare()).rejects.toThrow('plugin-staged');
      expect(runtime.exec).not.toHaveBeenCalled();
    }
  );

  it.each([
    { inferenceModels: [{ name: 'claude-opus-4-6' }] },
    { managedMcpServers: [] },
    { allowManagedMcpServersOnly: true },
    { inferenceProvider: 'gateway' },
    { otlpEndpoint: 'http://collector' },
    [],
    null,
  ])('rejects any managed/gateway settings: %j', async (value) => {
    settings = JSON.stringify(value);
    await expect(prepare()).rejects.toThrow('Managed/gateway runtimes');
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it('does not let an alternate empty settings path hide stock managed configuration', async () => {
    const original = runtime.open.getMockImplementation()!;
    runtime.open.mockImplementation(async (path: string) => {
      if (path === '/etc/claude-desktop/managed-settings.json')
        return {
          stat: async () => fileInfo(),
          readFile: async () =>
            JSON.stringify({ inferenceModels: [{ name: 'gateway' }] }),
          close: vi.fn(),
        };
      return original(path) as unknown;
    });
    await expect(prepare()).rejects.toThrow('Managed/gateway runtimes');
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it('rejects an existing gateway token without opening or reading it', async () => {
    const original = runtime.lstat.getMockImplementation()!;
    runtime.lstat.mockImplementation(async (path: string) =>
      path === '/run/mst/inference-token'
        ? fileInfo()
        : (original(path) as unknown)
    );
    await expect(prepare()).rejects.toThrow('Managed/gateway runtimes');
    expect(
      runtime.open.mock.calls.some(
        ([path]) => path === '/run/mst/inference-token'
      )
    ).toBe(false);
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it.each([
    { appVersion: '1.2.3' },
    { otlpSettings: { otlpEndpoint: 'http://collector' } },
  ])('never mutates an account profile to install %j', async (unsupported) => {
    await expect(
      coworkLinuxFirstParty.prepare({ evalConfig: config, env, ...unsupported })
    ).rejects.toThrow('cannot install managed');
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it('rejects a disk-backed profile, symlink or nonprivate directory', async () => {
    runtime.statfs.mockResolvedValueOnce({ type: 0xef53 });
    await expect(prepare()).rejects.toThrow('tmpfs');
    runtime.realpath.mockResolvedValueOnce('/elsewhere');
    await expect(prepare()).rejects.toThrow('plugin-staged');
    runtime.lstat.mockResolvedValueOnce({ ...directoryInfo(), mode: 0o40755 });
    await expect(prepare()).rejects.toThrow('plugin-staged');
    runtime.lstat.mockResolvedValueOnce({ ...directoryInfo(), uid: -1 });
    await expect(prepare()).rejects.toThrow('plugin-staged');
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 0o100644 },
    { uid: -1 },
    { size: 16 * 1024 + 1 },
    { nlink: 2 },
    { isFile: () => false },
  ])('rejects an unsafe marker file: %j', async (metadata) => {
    runtime.open.mockResolvedValueOnce({
      stat: async () => ({ ...fileInfo(), ...metadata }),
      close: vi.fn(),
    });
    await expect(prepare()).rejects.toThrow('plugin-staged');
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it.each([{ mode: 0o140666 }, { uid: -1 }, { isSocket: () => false }])(
    'rejects an unsafe or fake socket: %j',
    async (metadata) => {
      runtime.lstat.mockImplementation(async (path: string) => {
        if (path === '/run/mst/inference-token')
          throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        return path.endsWith('.sock')
          ? {
              ...directoryInfo(),
              isSocket: () => true,
              mode: 0o140600,
              ...metadata,
            }
          : directoryInfo();
      });
      await expect(prepare()).rejects.toThrow('plugin-staged');
      expect(runtime.exec).not.toHaveBeenCalled();
    }
  );

  it('rechecks expiry on submit and never sends after TTL', async () => {
    await prepare();
    runtime.exec.mockClear();
    marker.expiresAt = new Date(0).toISOString();
    await expect(
      coworkLinuxFirstParty.submit('query', {
        deadlineAt: Date.now() + 10_000,
        env,
      })
    ).rejects.toThrow('unexpired');
    expect(runtime.exec).not.toHaveBeenCalled();
  });
});
