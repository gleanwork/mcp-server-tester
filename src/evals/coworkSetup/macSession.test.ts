import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalManifest } from '../evalManifest.js';
import { hostStdioServers, resolveHostStdioServer } from '../hostPlugins.js';
import {
  COWORK_SETTINGS_MAX_BYTES as LIMIT,
  createCoworkBundlePlan,
} from './bundle.js';
import { getMacCoworkController } from './macController.js';
import {
  acquireMacCoworkApp,
  readMacCoworkAppVersion,
  removeMacCoworkApp,
  verifyMacCoworkAppVersion,
} from './macApp.js';
import type * as MacApp from './macApp.js';
import { prepareMacCoworkSession } from './macSession.js';
import { configureMacToolDefaults } from './macToolPermissions.js';

vi.mock('./macToolPermissions.js', () => ({
  configureMacToolDefaults: vi.fn(),
}));

vi.mock('./macController.js', () => ({ getMacCoworkController: vi.fn() }));
vi.mock('./macApp.js', async (original) => ({
  ...(await original<typeof MacApp>()),
  acquireMacCoworkApp: vi.fn(),
  removeMacCoworkApp: vi.fn(),
  readMacCoworkAppVersion: vi.fn(),
  verifyMacCoworkAppVersion: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    lstat: vi.fn(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).startsWith('/Library/Managed Preferences/'))
        throw Object.assign(new Error('Synthetic absent managed preferences'), {
          code: 'ENOENT',
        });
      return actual.lstat(...args);
    }),
  };
});
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  tmpdir: vi.fn(),
  homedir: vi.fn(),
  userInfo: vi.fn(),
}));
const actualOs = await vi.importActual<typeof os>('node:os');
const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
const actualMacApp = await vi.importActual<typeof MacApp>('./macApp.js');
const SOURCE = '11111111-2222-3333-4444-555555555555';
// A manifest pin (host.options.appVersion) and the installed app's version.
const PIN = '1.52386.6';
const INSTALLED = '2.19675.1';
const ORIGINAL =
  JSON.stringify({
    appliedId: SOURCE,
    entries: [{ id: SOURCE, name: 'Original' }],
  }) + '\n';
const ERROR = 'Unable to prepare the Mac Cowork session safely.';
const CLEANUP_ERROR =
  'Unable to restore the Mac Cowork session safely. Recovery state retained.';
const PERSONAL =
  ' { "mcpServers": {"personal": {"command": "never-run"}}, "theme": "dark" }\n';
const env = {
  ANTHROPIC_API_KEY: 'synthetic-inference',
  MCP_KEY: 'synthetic-mcp',
};
let root: string;
let profileDirectory: string;
let localConfig: string;
let lease: string;
let lock: string;
let running: boolean;
let events: string[];
const controller = {
  state: vi.fn(async () => ({ running })),
  stop: vi.fn(async () => {
    events.push('stop');
    running = false;
  }),
  start: vi.fn(async () => {
    events.push('start');
    running = true;
  }),
};
function manifest(): EvalManifest {
  return {
    name: 'synthetic',
    datasets: [],
    servers: [
      {
        transport: 'http',
        label: 'Search',
        serverUrl: 'https://search.example.test/mcp',
        auth: { accessTokenEnv: 'MCP_KEY' },
      },
    ],
    coworkSetup: { approveWriteTools: true },
  };
}
function prepare(
  overrides: Partial<Parameters<typeof prepareMacCoworkSession>[0]> = {}
) {
  return prepareMacCoworkSession({
    manifest: manifest(),
    env,
    profileDirectory,
    ...overrides,
  });
}
async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
}
async function stage(): Promise<string> {
  return (await json(join(lease, 'session.json'))).stagingDirectory as string;
}
async function clean(original = ORIGINAL) {
  expect(await fs.readFile(localConfig, 'utf8')).toBe(PERSONAL);
  expect(await fs.readFile(join(profileDirectory, '_meta.json'), 'utf8')).toBe(
    original
  );
  expect((await fs.readdir(profileDirectory)).sort()).toEqual(
    [`${SOURCE}.json`, '_meta.json'].sort()
  );
  expect(
    (await fs.readdir(root)).filter((name) =>
      name.startsWith('mst-cowork-session-')
    )
  ).toEqual([]);
}
beforeEach(async () => {
  vi.mocked(configureMacToolDefaults).mockReset();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  root = await fs.realpath(
    await fs.mkdtemp(join(actualOs.tmpdir(), 'mst-mac-session-test-'))
  );
  await fs.chmod(root, 0o700);
  profileDirectory = join(
    root,
    'Library/Application Support/Claude-3p/configLibrary'
  );
  lease = join(profileDirectory, '.mst-session-lock');
  lock = join(profileDirectory, '.mst-setup-lock');
  await fs.mkdir(profileDirectory, { mode: 0o700, recursive: true });
  localConfig = join(profileDirectory, '../claude_desktop_config.json');
  await fs.writeFile(localConfig, PERSONAL, { mode: 0o600 });
  await fs.writeFile(join(profileDirectory, '_meta.json'), ORIGINAL, {
    mode: 0o600,
  });
  await fs.writeFile(join(profileDirectory, `${SOURCE}.json`), '{}\n', {
    mode: 0o600,
  });
  vi.mocked(os.tmpdir).mockReturnValue(root);
  vi.mocked(os.homedir).mockReturnValue(root);
  vi.mocked(os.userInfo).mockReturnValue({
    username: 'mst-synthetic-no-managed-profile',
    homedir: root,
    uid: process.getuid!(),
    gid: process.getgid!(),
    shell: '/bin/sh',
  });
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename);
  vi.mocked(acquireMacCoworkApp)
    .mockReset()
    .mockImplementation(async (directory) => {
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(join(directory, 'synthetic-app'), 'test bundle');
      return '/synthetic/Claude.app';
    });
  vi.mocked(removeMacCoworkApp)
    .mockReset()
    .mockImplementation(actualMacApp.removeMacCoworkApp);
  vi.mocked(verifyMacCoworkAppVersion).mockReset().mockResolvedValue();
  vi.mocked(readMacCoworkAppVersion)
    .mockReset()
    .mockImplementation(async (app) =>
      app === '/synthetic/Claude.app' ? PIN : INSTALLED
    );
  running = true;
  events = [];
  controller.state.mockReset().mockImplementation(async () => ({ running }));
  controller.stop.mockReset().mockImplementation(async () => {
    events.push('stop');
    running = false;
  });
  controller.start.mockReset().mockImplementation(async () => {
    events.push('start');
    running = true;
  });
  vi.mocked(getMacCoworkController).mockReset().mockResolvedValue(controller);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function nativeManifest(): EvalManifest {
  return {
    name: 'native',
    datasets: [],
    servers: [
      {
        transport: 'stdio',
        label: 'Native',
        command: '/synthetic/proxy',
        url: 'https://native.example.test/mcp',
        args: ['${url}', '${dataDir}/headers.json'],
        auth: { accessTokenEnv: 'MCP_KEY' },
        files: { 'headers.json': { Authorization: 'Bearer ${bearerToken}' } },
      },
    ],
  };
}

// Four individually valid stdio declarations can exceed the aggregate read cap.
function sizedNativeManifest(bytes: number): EvalManifest {
  const servers = Array.from({ length: 4 }, (_, index) => ({
    transport: 'stdio' as const,
    label: `Native${index}`,
    command: '/synthetic/proxy',
    args: Array.from({ length: 64 }, () => 'é'),
  }));
  const input = { name: 'bounded', datasets: [], servers };
  const { settingsBytes } = createCoworkBundlePlan({
    manifest: input,
    runtimeDirectory: join(root, 'unused'),
  });
  const launches = hostStdioServers(servers).map((server) =>
    resolveHostStdioServer(server, {})
  );
  let remaining =
    bytes - settingsBytes.length - Buffer.byteLength(JSON.stringify(launches));
  for (const server of servers) {
    server.args = server.args.map((arg) => {
      const count = Math.min(4095, remaining);
      remaining -= count;
      return arg + 'x'.repeat(count);
    });
  }
  expect(remaining).toBe(0);
  return input;
}

async function expectNoSessionMutation(original = ORIGINAL): Promise<void> {
  expect(getMacCoworkController).not.toHaveBeenCalled();
  expect(events).toEqual([]);
  await expect(fs.lstat(lease)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  await clean(original);
}

describe('automatic Mac Cowork session (no native execution)', () => {
  it('rejects oversized stdio journal inventory before controller, lease, or writes', async () => {
    const input: EvalManifest = {
      name: 'large-inventory',
      datasets: [],
      servers: Array.from({ length: 750 }, (_, index) => ({
        transport: 'stdio',
        label: `Native${index}`,
        command: '/synthetic/proxy',
        files: Object.fromEntries(
          Array.from({ length: 8 }, (_, file) => [
            `${file}${'x'.repeat(122)}.json`,
            {},
          ])
        ),
      })),
    };
    const plan = createCoworkBundlePlan({
      manifest: input,
      runtimeDirectory: join(root, `mst-cowork-session-${SOURCE}`),
    });
    expect(plan.privateFiles).toHaveLength(6000);
    expect(plan.settingsBytes.length).toBeLessThan(LIMIT);
    const mkdir = vi.spyOn(fs, 'mkdir');
    const writeFile = vi.spyOn(fs, 'writeFile');
    const open = vi.spyOn(fs, 'open');
    await expect(prepare({ manifest: input })).rejects.toThrow(ERROR);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(
      open.mock.calls.every(([, flags]) => typeof flags === 'number')
    ).toBe(true);
    expect(fs.rename).not.toHaveBeenCalled();
    await expectNoSessionMutation();
  });

  it('rejects metadata whose installed serialization exceeds the read bound', async () => {
    const meta = JSON.parse(ORIGINAL) as Record<string, unknown>;
    const original =
      JSON.stringify({
        ...meta,
        extra: Array.from({ length: 150_000 }, () => 0),
      }) + '\n';
    expect(Buffer.byteLength(original)).toBeLessThan(LIMIT / 2);
    expect(
      Buffer.byteLength(JSON.stringify(JSON.parse(original), null, 2))
    ).toBeGreaterThan(LIMIT);
    await fs.writeFile(join(profileDirectory, '_meta.json'), original);
    const mkdir = vi.spyOn(fs, 'mkdir');
    const writeFile = vi.spyOn(fs, 'writeFile');
    const open = vi.spyOn(fs, 'open');
    await expect(prepare()).rejects.toThrow(ERROR);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(
      open.mock.calls.every(([, flags]) => typeof flags === 'number')
    ).toBe(true);
    expect(fs.rename).not.toHaveBeenCalled();
    await expectNoSessionMutation(original);
  });
  it('rejects oversized aggregate stdio launches before controller or lease acquisition', async () => {
    const input = sizedNativeManifest(LIMIT + 1);
    const mkdir = vi.spyOn(fs, 'mkdir');
    const writeFile = vi.spyOn(fs, 'writeFile');
    await expect(prepare({ manifest: input })).rejects.toThrow(ERROR);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    await expectNoSessionMutation();
  });

  it('bounds the final profile including model, marketplace, and helper fields before ownership', async () => {
    const model = 'synthetic-model';
    const plugins = [
      {
        name: 'acme',
        marketplace: { source: 'acme/plugins', ref: 'e'.repeat(40) },
        blockMcpServers: ['PluginNative'],
      },
    ];
    const input = { ...manifest(), servers: [] };
    const session = await prepare({ manifest: input, model, plugins });
    const meta = await json(join(profileDirectory, '_meta.json'));
    const profile = await fs.readFile(
      join(profileDirectory, `${String(meta.appliedId)}.json`)
    );
    const overhead = profile.length - model.length;
    expect(overhead).toBeGreaterThan(0);
    await session.dispose();
    await clean();
    vi.clearAllMocks();
    events = [];
    const mkdir = vi.spyOn(fs, 'mkdir');
    const writeFile = vi.spyOn(fs, 'writeFile');
    await expect(
      prepare({
        manifest: input,
        model: 'x'.repeat(LIMIT - overhead + 1),
        plugins,
      })
    ).rejects.toThrow(ERROR);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    await expectNoSessionMutation();
  });

  it.each(['empty', 'plain', 'private'])(
    'isolates personal MCP for %s sessions and restores exact bytes',
    async (kind) => {
      const input = nativeManifest();
      if (kind === 'empty') input.servers = [];
      if (kind === 'plain')
        input.servers = [
          {
            transport: 'stdio',
            command: '/synthetic/plain',
            env: { ONLY: 'declared' },
          },
        ];
      const session = await prepare({ manifest: input });
      const directory = await stage();
      expect(session.stdioPaths).toEqual({
        dataRoot: join(directory, 'stdio'),
      });
      const local = await json(localConfig);
      expect(local.theme).toBe('dark');
      const entries = local.mcpServers as Record<
        string,
        { command: string; args: string[] }
      >;
      const label = kind === 'plain' ? 'server-1' : 'Native';
      expect(Object.keys(entries)).toEqual(kind === 'empty' ? [] : [label]);
      if (kind !== 'empty') {
        expect(entries[label]).toEqual({
          command: process.execPath,
          args: [
            join(`${directory}-mcp`, `${label}.cjs`),
            join(`${directory}-mcp`, `${label}.json`),
          ],
        });
        expect(await json(entries[label]!.args[1]!)).toEqual({
          command: kind === 'plain' ? '/synthetic/plain' : '/synthetic/proxy',
          args:
            kind === 'plain'
              ? []
              : [
                  'https://native.example.test/mcp',
                  join(directory, 'stdio/Native/headers.json'),
                ],
          env: kind === 'plain' ? { ONLY: 'declared' } : {},
        });
        expect(
          await fs.readFile(entries[label]!.args[0]!, 'utf8')
        ).not.toContain(env.MCP_KEY);
      }
      expect(await json(join(directory, 'managed-mcp.json'))).toMatchObject({
        managedMcpServers: [],
        allowedMcpServers: [],
      });
      if (kind === 'private')
        expect(
          await json(join(directory, 'stdio/Native/headers.json'))
        ).toEqual({ Authorization: `Bearer ${env.MCP_KEY}` });
      await session.dispose();
      await clean();
    }
  );

  it('rejects a missing stdio credential before controller or lease acquisition', async () => {
    vi.stubEnv('MCP_KEY', env.MCP_KEY);
    await expect(
      prepare({
        manifest: nativeManifest(),
        env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY },
      })
    ).rejects.toThrow(ERROR);
    await expectNoSessionMutation();
  });

  it('retains the lease and journal if private stdio files changed', async () => {
    const session = await prepare({ manifest: nativeManifest() });
    const file = join(await stage(), 'stdio/Native/headers.json');
    await fs.writeFile(file, 'changed');
    await expect(session.dispose()).rejects.toThrow(CLEANUP_ERROR);
    expect(events).toEqual(['stop', 'start', 'stop']);
    expect(await fs.readFile(file, 'utf8')).toBe('changed');
    expect(await fs.readFile(localConfig, 'utf8')).toBe(PERSONAL);
    await fs.access(join(lock, 'journal.json'));
    await fs.access(join(lease, 'session.json'));
  });

  it('runs the installed app by default, records its version and checks it at the end', async () => {
    const session = await prepare();
    expect(acquireMacCoworkApp).not.toHaveBeenCalled();
    expect(getMacCoworkController).toHaveBeenCalledWith(
      '/Applications/Claude.app'
    );
    expect(session.app).toEqual({
      name: 'Claude Desktop',
      version: INSTALLED,
      source: 'installed',
    });
    expect((await json(join(lease, 'session.json'))).pinnedApp).toBeUndefined();
    await session.dispose();
    expect(verifyMacCoworkAppVersion).toHaveBeenCalledWith(
      '/Applications/Claude.app',
      INSTALLED
    );
    expect(removeMacCoworkApp).not.toHaveBeenCalled();
    await clean();
  });
  it('refuses results when the installed app changes during evaluation', async () => {
    const session = await prepare();
    vi.mocked(verifyMacCoworkAppVersion).mockRejectedValueOnce(
      new Error('changed bundle')
    );
    await expect(session.dispose()).rejects.toThrow('changed bundle');
    expect(removeMacCoworkApp).not.toHaveBeenCalled();
    await clean();
  });
  it('rejects the removed MST_COWORK_APP_VERSION before any app action', async () => {
    await expect(
      prepare({ env: { ...env, MST_COWORK_APP_VERSION: PIN } })
    ).rejects.toThrow('host.options.appVersion');
    await expectNoSessionMutation();
  });
  it('journals the pin before acquisition and restores the installed app before removing it', async () => {
    vi.mocked(acquireMacCoworkApp).mockImplementationOnce(
      async (directory, version) => {
        expect(version).toBe(PIN);
        const receipt = await json(join(lease, 'session.json'));
        expect(receipt.pinnedApp).toBe(true);
        expect(directory).toBe(`${String(receipt.stagingDirectory)}-app`);
        expect(events).toEqual([]);
        return '/synthetic/Claude.app';
      }
    );
    vi.mocked(removeMacCoworkApp).mockImplementationOnce(async () => {
      expect(events).toEqual(['stop', 'start', 'stop', 'start']);
    });
    const session = await prepare({ appVersion: PIN });
    expect(getMacCoworkController).toHaveBeenCalledWith(
      '/synthetic/Claude.app'
    );
    expect(session.app).toEqual({
      name: 'Claude Desktop',
      version: PIN,
      source: 'pinned',
    });
    await session.dispose();
    expect(removeMacCoworkApp).toHaveBeenCalledTimes(1);
    await clean();
  });
  it('cleans a failed acquisition without touching the running installed app', async () => {
    vi.mocked(acquireMacCoworkApp).mockImplementationOnce(async (directory) => {
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(join(directory, 'Claude.zip'), 'partial download');
      throw new Error(
        'Unable to acquire Claude Desktop 1.52386.6: checksum verification failed.'
      );
    });
    await expect(prepare({ appVersion: PIN })).rejects.toThrow(
      'checksum verification failed'
    );
    expect(events).toEqual([]);
    expect(removeMacCoworkApp).toHaveBeenCalledTimes(1);
    await clean();
  });
  it('still restores and removes the app when the pin changes during evaluation', async () => {
    const session = await prepare({ appVersion: PIN });
    vi.mocked(verifyMacCoworkAppVersion).mockRejectedValueOnce(
      new Error('changed bundle')
    );
    await expect(session.dispose()).rejects.toThrow('changed bundle');
    expect(events).toEqual(['stop', 'start', 'stop', 'start']);
    expect(removeMacCoworkApp).toHaveBeenCalledTimes(1);
    await clean();
  });
  it('retains the receipt when temporary app removal fails', async () => {
    const session = await prepare({ appVersion: PIN });
    vi.mocked(removeMacCoworkApp).mockRejectedValueOnce(new Error('busy'));
    await expect(session.dispose()).rejects.toThrow('Recovery state retained');
    expect((await fs.stat(join(lease, 'session.json'))).isFile()).toBe(true);
  });
  it('does not download or remove a caller-owned override', async () => {
    const session = await prepare({
      env: { ...env, MST_COWORK_APP_PATH: '/custom/Claude.app' },
    });
    expect(getMacCoworkController).toHaveBeenCalledWith('/custom/Claude.app');
    await session.dispose();
    expect(acquireMacCoworkApp).not.toHaveBeenCalled();
    expect(removeMacCoworkApp).not.toHaveBeenCalled();
  });
  it('rejects alternate profile directories before a lease or native action', async () => {
    const alternate = join(root, 'unused-profile');
    await fs.mkdir(alternate, { mode: 0o700 });
    await expect(prepare({ profileDirectory: alternate })).rejects.toThrow(
      ERROR
    );
    expect(getMacCoworkController).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(await fs.readdir(alternate)).toEqual([]);
  });
  it.each([true, false])(
    'holds private helpers until disposal and restores prior running=%s',
    async (initial) => {
      running = initial;
      controller.stop.mockImplementation(async () => {
        await fs.access(join(lease, 'session.json'));
        events.push('stop');
        running = false;
      });
      controller.start.mockImplementation(async () => {
        const meta = await json(join(profileDirectory, '_meta.json'));
        if (!events.includes('start')) {
          expect(meta.appliedId).not.toBe(SOURCE);
          expect(
            await json(join(profileDirectory, `${String(meta.appliedId)}.json`))
          ).toMatchObject({
            managedMcpServers: [],
          });
        } else expect(meta.appliedId).toBe(SOURCE);
        events.push('start');
        running = true;
      });
      const session = await prepare();
      expect(running).toBe(true);
      const directory = await stage();
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(join(`${directory}-mcp`, 'Search.json'))).mode & 0o777
      ).toBe(0o600);
      for (const file of ['credentials/inference.json']) {
        expect((await fs.stat(join(directory, file))).mode & 0o777).toBe(0o600);
      }
      for (const file of ['inference-helper.sh']) {
        expect((await fs.stat(join(directory, file))).mode & 0o777).toBe(0o700);
        expect(await fs.readFile(join(directory, file), 'utf8')).not.toContain(
          'synthetic-'
        );
      }
      expect(await json(join(directory, 'credentials/inference.json'))).toEqual(
        { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
      );
      const first = session.dispose();
      expect(session.dispose()).toBe(first);
      await Promise.all([first, session.dispose()]);
      await session.dispose();
      expect(running).toBe(initial);
      expect(events).toEqual(
        initial ? ['stop', 'start', 'stop', 'start'] : ['start', 'stop']
      );
      await clean();
    }
  );
  it('uses the documented default profile under the supplied home', async () => {
    const defaultProfile = join(
      root,
      'Library/Application Support/Claude-3p/configLibrary'
    );
    await fs.mkdir(join(root, 'Library/Application Support/Claude-3p'), {
      recursive: true,
      mode: 0o700,
    });
    await fs.rename(profileDirectory, defaultProfile);
    const session = await prepare({ profileDirectory: undefined });
    await session.dispose();
    expect(await fs.readFile(join(defaultProfile, '_meta.json'), 'utf8')).toBe(
      ORIGINAL
    );
  });
  it('rejects non-macOS before controller, profile, or credentials access', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    await expect(prepare()).rejects.toThrow(ERROR);
    expect(getMacCoworkController).not.toHaveBeenCalled();
    await clean();
  });
  it('fails missing app/GUI availability before acquiring a lease or stopping', async () => {
    controller.state.mockRejectedValue(new Error(env.ANTHROPIC_API_KEY));
    await expect(prepare()).rejects.toThrow(ERROR);
    expect(events).toEqual([]);
    await clean();
  });
  it.each([
    'source',
    'permissions',
    'symlink',
    'missing-env',
    'invalid-token',
    'invalid-server',
    'unresolved-launch',
    'oversize-private-file',
    'oversize-header',
    'reserved-label',
    'reserved-label-case',
    'helper-label-case-collision',
  ])('rejects unsafe %s before mutation', async (kind) => {
    const input = manifest();
    let explicitEnv = env;
    if (kind === 'source')
      await fs.writeFile(
        join(profileDirectory, `${SOURCE}.json`),
        '{"user":"keep"}'
      );
    if (kind === 'permissions') await fs.chmod(profileDirectory, 0o777);
    if (kind === 'symlink') {
      await fs.rename(profileDirectory, join(root, 'actual-library'));
      await fs.symlink(join(root, 'actual-library'), profileDirectory);
    }
    if (kind === 'missing-env') {
      vi.stubEnv('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
      explicitEnv = {} as typeof env;
    }
    if (kind === 'invalid-token')
      explicitEnv = { ...env, ANTHROPIC_API_KEY: 'synthetic invalid' };
    if (kind === 'invalid-server')
      input.servers = [{ transport: 'stdio', command: '' }];
    if (kind === 'unresolved-launch')
      input.servers = [
        { transport: 'stdio', command: '${pluginRoot:missing}/proxy' },
      ];
    if (kind === 'oversize-private-file')
      input.servers = [
        {
          transport: 'stdio',
          command: '/synthetic/proxy',
          files: { 'large.json': 'x'.repeat(65536) },
        },
      ];
    if (kind === 'oversize-header')
      input.servers = [
        {
          transport: 'http',
          label: 'Search',
          serverUrl: 'https://example.test/mcp',
          headers: { Huge: 'x'.repeat(65536) },
        },
      ];
    if (kind === 'reserved-label') input.servers![0]!.label = 'inference';
    if (kind === 'reserved-label-case') input.servers![0]!.label = 'Inference';
    if (kind === 'helper-label-case-collision')
      input.servers!.push({
        transport: 'http',
        label: 'search',
        serverUrl: 'https://second.example.test/mcp',
        auth: { accessTokenEnv: 'MCP_KEY' },
      });
    await expect(
      prepare({ manifest: input, env: explicitEnv })
    ).rejects.toThrow(ERROR);
    expect(getMacCoworkController).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    await expect(fs.lstat(lease)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['Search', 'Native'])(
    'rejects a case-insensitive blocked %s declaration before transport splitting',
    async (label) => {
      const input = manifest();
      input.servers!.push({
        transport: 'stdio',
        label: 'Native',
        command: '/synthetic/plain',
      });
      await expect(
        prepare({
          manifest: input,
          plugins: [
            {
              name: 'workflows',
              marketplace: {
                source: 'example/workflows',
                ref: 'e'.repeat(40),
              },
              blockMcpServers: [label.toLowerCase()],
            },
          ],
        })
      ).rejects.toThrow(ERROR);
      expect(getMacCoworkController).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      await expectNoSessionMutation();
    }
  );
  it.each([false, true])(
    'stages default tool permissions only on opt-in (%s)',
    async (approved) => {
      const input = nativeManifest();
      input.coworkSetup = { approveWriteTools: approved };
      const session = await prepare({ manifest: input });
      if (approved)
        expect(configureMacToolDefaults).toHaveBeenCalledWith(
          `${await stage()}-mcp`,
          ['Native']
        );
      else expect(configureMacToolDefaults).not.toHaveBeenCalled();
      await session.dispose();
      await clean();
    }
  );
  it('restores setup without starting Claude if tool-default staging fails', async () => {
    vi.mocked(configureMacToolDefaults).mockRejectedValueOnce(
      new Error('synthetic failure')
    );
    await expect(prepare()).rejects.toThrow(ERROR);
    await clean();
  });
  it.each(['.mst-session-lock', '.mst-setup-lock'])(
    'rejects existing %s without app actions',
    async (name) => {
      await fs.mkdir(join(profileDirectory, name), { mode: 0o700 });
      await expect(prepare()).rejects.toThrow(ERROR);
      expect(getMacCoworkController).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(await fs.readdir(join(profileDirectory, name))).toEqual([]);
    }
  );
  it('a second invocation cannot stop an active session app', async () => {
    const first = await prepare();
    const before = [...events];
    const receipt = await fs.readFile(join(lease, 'session.json'));
    await expect(prepare()).rejects.toThrow(ERROR);
    expect(events).toEqual(before);
    expect(running).toBe(true);
    expect(await fs.readFile(join(lease, 'session.json'))).toEqual(receipt);
    await first.dispose();
    await clean();
  });
  it('serializes simultaneous preparations before stopping the app', async () => {
    const results = await Promise.allSettled([prepare(), prepare()]);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    expect(events).toEqual(['stop', 'start']);
    for (const result of results)
      if (result.status === 'fulfilled') await result.value.dispose();
    await clean();
  });
  it.each([manifest(), nativeManifest(), { ...manifest(), servers: [] }])(
    'rolls back a failed launch and restores personal MCP (#%#)',
    async (input) => {
      controller.start.mockImplementationOnce(async () => {
        events.push('failed-start');
        running = true;
        throw new Error(env.MCP_KEY);
      });
      await expect(prepare({ manifest: input })).rejects.toThrow(ERROR);
      expect(events).toEqual(['stop', 'failed-start', 'stop', 'start']);
      expect(running).toBe(true);
      await clean();
    }
  );
  it('self-rolls back a partial install and restores the prior running state', async () => {
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === join(profileDirectory, '_meta.json'))
        throw new Error(env.MCP_KEY);
      await actualFs.rename(from, to);
    });
    await expect(prepare()).rejects.toThrow(ERROR);
    expect(events).toEqual(['stop', 'start']);
    expect(running).toBe(true);
    await clean();
  });
  it('retains private recovery state when a partial prepare cannot safely roll back', async () => {
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === join(profileDirectory, '_meta.json')) {
        await fs.writeFile(join(await stage(), 'unknown-file'), 'user-change', {
          mode: 0o600,
        });
        throw new Error(env.MCP_KEY);
      }
      await actualFs.rename(from, to);
    });
    await expect(prepare()).rejects.toThrow(CLEANUP_ERROR);
    expect(events).toEqual(['stop']);
    expect(running).toBe(false);
    await fs.access(join(lock, 'journal.json'));
    await fs.access(join(await stage(), 'credentials/inference.json'));
    await fs.access(join(lease, 'session.json'));
  });
  it('does not install when graceful stop fails, never force-kills', async () => {
    controller.stop.mockRejectedValueOnce(new Error(env.MCP_KEY));
    await expect(prepare()).rejects.toThrow(ERROR);
    expect(controller.start).not.toHaveBeenCalled();
    expect(running).toBe(true);
    await clean();
  });
  it('does not restore while the app refuses to stop; retains recovery state', async () => {
    const session = await prepare();
    const directory = await stage();
    controller.stop.mockRejectedValue(new Error(env.MCP_KEY));
    await expect(session.dispose()).rejects.toThrow(CLEANUP_ERROR);
    await expect(session.dispose()).rejects.toThrow(CLEANUP_ERROR);
    expect(controller.stop).toHaveBeenCalledTimes(2);
    expect(running).toBe(true);
    await fs.access(join(lock, 'journal.json'));
    await fs.access(join(directory, 'credentials/inference.json'));
    await fs.access(join(lease, 'session.json'));
  });
  it('retains journal, credentials and lease after unsafe restore; does not relaunch', async () => {
    const session = await prepare();
    const directory = await stage();
    const meta = await json(join(profileDirectory, '_meta.json'));
    const target = join(profileDirectory, `${String(meta.appliedId)}.json`);
    await fs.writeFile(target, '{"user":"changed"}');
    await expect(session.dispose()).rejects.toThrow(CLEANUP_ERROR);
    expect(running).toBe(false);
    expect(events).toEqual(['stop', 'start', 'stop']);
    expect(await fs.readFile(target, 'utf8')).toBe('{"user":"changed"}');
    await fs.access(join(lock, 'journal.json'));
    await fs.access(join(directory, 'credentials/inference.json'));
    await fs.access(join(lease, 'session.json'));
  });
  it('refuses disposal before app actions when lease ownership changes', async () => {
    const session = await prepare();
    await fs.writeFile(join(lease, 'session.json'), '{}');
    await expect(session.dispose()).rejects.toThrow(CLEANUP_ERROR);
    expect(events).toEqual(['stop', 'start']);
    expect(running).toBe(true);
  });
  it('refuses disposal before app actions when transaction ownership changes', async () => {
    const session = await prepare();
    const file = join(lock, 'journal.json');
    await fs.writeFile(
      file,
      JSON.stringify({ ...(await json(file)), id: SOURCE })
    );
    await expect(session.dispose()).rejects.toThrow(CLEANUP_ERROR);
    expect(events).toEqual(['stop', 'start']);
  });
  it('retains session recovery receipt if prior-state relaunch fails after restore', async () => {
    const session = await prepare();
    const directory = await stage();
    controller.start.mockRejectedValue(new Error(env.MCP_KEY));
    await expect(session.dispose()).rejects.toThrow(CLEANUP_ERROR);
    expect(
      await fs.readFile(join(profileDirectory, '_meta.json'), 'utf8')
    ).toBe(ORIGINAL);
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.access(join(lease, 'session.json'));
    expect(running).toBe(false);
  });
});
