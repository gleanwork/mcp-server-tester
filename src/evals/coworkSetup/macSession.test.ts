import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalManifest } from '../evalManifest.js';
import { getMacCoworkController } from './macController.js';
import { prepareMacCoworkSession } from './macSession.js';

vi.mock('./macController.js', () => ({ getMacCoworkController: vi.fn() }));
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
const SOURCE = '11111111-2222-3333-4444-555555555555';
const ORIGINAL =
  JSON.stringify({
    appliedId: SOURCE,
    entries: [{ id: SOURCE, name: 'Original' }],
  }) + '\n';
const ERROR = 'Unable to prepare the Mac Cowork session safely.';
const CLEANUP_ERROR =
  'Unable to restore the Mac Cowork session safely. Recovery state retained.';
const env = {
  ANTHROPIC_API_KEY: 'synthetic-inference',
  MCP_KEY: 'synthetic-mcp',
};
let root: string;
let profileDirectory: string;
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
async function clean() {
  expect(await fs.readFile(join(profileDirectory, '_meta.json'), 'utf8')).toBe(
    ORIGINAL
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

describe('automatic Mac Cowork session (no native execution)', () => {
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
            managedMcpServers: [
              { name: 'Search', toolPolicy: { '*': 'allow' } },
            ],
          });
        } else expect(meta.appliedId).toBe(SOURCE);
        events.push('start');
        running = true;
      });
      const session = await prepare();
      expect(running).toBe(true);
      const directory = await stage();
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of [
        'credentials/inference.json',
        'credentials/Search.json',
      ]) {
        expect((await fs.stat(join(directory, file))).mode & 0o777).toBe(0o600);
      }
      for (const file of ['inference-helper.sh', 'mcp-Search-headers.sh']) {
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
      input.servers = [{ transport: 'stdio', command: 'unsafe' }];
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
  it('rolls back a failed launch even if it partially started the app', async () => {
    controller.start.mockImplementationOnce(async () => {
      events.push('failed-start');
      running = true;
      throw new Error(env.MCP_KEY);
    });
    await expect(prepare()).rejects.toThrow(ERROR);
    expect(events).toEqual(['stop', 'failed-start', 'stop', 'start']);
    expect(running).toBe(true);
    await clean();
  });
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
