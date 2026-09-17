import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpMCPConfig } from '../../config/mcpConfig.js';
import type { EvalManifest } from '../evalManifest.js';
import { prepareCoworkMcpBundle } from './bundle.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const ERROR = 'Unable to prepare Cowork MCP bundle.';
const TOKEN = 'synthetic-only-token';
let root: string;
let directory: string;
let credential: string;
type Options = Parameters<typeof prepareCoworkMcpBundle>[0];
function http(overrides: Partial<HttpMCPConfig> = {}): HttpMCPConfig {
  return {
    transport: 'http',
    label: 'Search_1',
    serverUrl: 'https://search.example.test/mcp',
    auth: { accessTokenEnv: 'SYNTHETIC_COWORK_TOKEN' },
    ...overrides,
  };
}
function manifest(overrides: Partial<EvalManifest> = {}): EvalManifest {
  return { name: 'synthetic', datasets: [], servers: [http()], ...overrides };
}
function options(overrides: Partial<Options> = {}): Options {
  return {
    manifest: manifest(),
    directory,
    runtimeDirectory: directory,
    env: { SYNTHETIC_COWORK_TOKEN: TOKEN },
    ...overrides,
  };
}
function path(name: string): string {
  return join(directory, name);
}
async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}
async function expectPrivate(file: string, mode: number): Promise<void> {
  const stat = await fs.stat(file);
  expect([stat.mode & 0o777, stat.uid]).toEqual([mode, process.getuid!()]);
}
function invokeHelper(label = 'Search_1'): ReturnType<typeof spawnSync> {
  return spawnSync(path(`mcp-${label}-headers.sh`), [], {
    encoding: 'utf8',
    env: {},
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
}
function expectHelperFailure(): void {
  const result = invokeHelper();
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({
    status: 1,
    stdout: '',
    stderr: 'Unable to read Cowork MCP runtime headers.\n',
  });
}
function expectHeaders(headers: object, label = 'Search_1'): void {
  const result = invokeHelper(label);
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ status: 0, stderr: '' });
  expect(JSON.parse(String(result.stdout))).toEqual(headers);
}
async function expectRejected(overrides: Partial<Options> = {}): Promise<void> {
  const failure: unknown = await prepareCoworkMcpBundle(
    options(overrides)
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ message: ERROR });
  expect((failure as Error).cause).toBeUndefined();
  expect((failure as Error).stack).not.toContain(TOKEN);
  expect((failure as Error).stack).not.toContain(directory);
}
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'cowork_bundle-test-'))
  );
  directory = join(root, 'bundle_safe-1');
  credential = path('credentials/Search_1.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('prepareCoworkMcpBundle', () => {
  it.each([
    [undefined, undefined, false],
    [false, undefined, false],
    [true, undefined, true],
    [true, false, false],
    [false, true, true],
  ] as const)(
    'applies base=%s arm=%s approval only to the selected server',
    async (base, override, approved) => {
      const input = manifest({
        coworkSetup:
          base === undefined ? undefined : { approveWriteTools: base },
        arms: [
          {
            name: 'selected',
            servers: [http({ label: 'selected' })],
            coworkSetup:
              override === undefined
                ? undefined
                : { approveWriteTools: override },
          },
        ],
      });
      const result = await prepareCoworkMcpBundle(
        options({ manifest: input, arm: 'selected' })
      );
      expect(await readJson(result.settingsPath)).toEqual({
        managedMcpServers: [
          {
            name: 'selected',
            transport: 'http',
            url: http().serverUrl,
            headersHelper: path('mcp-selected-headers.sh'),
            ...(approved ? { toolPolicy: { '*': 'allow' } } : {}),
          },
        ],
        allowedMcpServers: [{ serverName: 'selected' }],
        allowManagedMcpServersOnly: true,
      });
      expect(await fs.readdir(directory)).not.toContain(
        'mcp-Search_1-headers.sh'
      );
    }
  );

  it('stages private, isolated credentials with secret-free settings/status/helpers', async () => {
    const staticHeaders = { 'X-Key': 'second-synthetic-secret' };
    const servers = [
      http(),
      http({
        label: 'Other',
        serverUrl: 'https://other.example.test/',
        auth: undefined,
        headers: staticHeaders,
      }),
      http({
        label: 'Public',
        serverUrl: 'https://public.example.test/',
        auth: {},
        headers: {},
      }),
    ];
    const result = await prepareCoworkMcpBundle(
      options({ manifest: manifest({ servers }) })
    );
    expect(result).toEqual({
      directory,
      settingsPath: path('managed-mcp.json'),
      serverCount: 3,
    });
    expect(await readJson(result.settingsPath)).toEqual({
      managedMcpServers: servers.map(({ label, serverUrl }, index) => ({
        name: label,
        transport: 'http',
        url: serverUrl,
        ...(index < 2
          ? { headersHelper: path(`mcp-${label}-headers.sh`) }
          : {}),
      })),
      allowedMcpServers: servers.map(({ label }) => ({ serverName: label })),
      allowManagedMcpServersOnly: true,
    });
    expect(await readJson(path('status.json'))).toEqual({
      status: 'prepared-not-applied',
      desktopVerified: false,
      serverCount: 3,
    });
    const files = [
      'managed-mcp.json',
      'mcp-Other-headers.sh',
      'mcp-Search_1-headers.sh',
      'status.json',
    ];
    expect(await fs.readdir(directory)).toEqual(['credentials', ...files]);
    expect(await fs.readdir(path('credentials'))).toEqual([
      'Other.json',
      'Search_1.json',
    ]);
    const bearer = { Authorization: `Bearer ${TOKEN}` };
    expect(await readJson(credential)).toEqual(bearer);
    expect(await readJson(path('credentials/Other.json'))).toEqual(
      staticHeaders
    );
    for (const file of files) {
      const content = await fs.readFile(path(file), 'utf8');
      expect(content).not.toMatch(
        new RegExp(`${TOKEN}|second-synthetic-secret|SYNTHETIC_COWORK_TOKEN`)
      );
      await expectPrivate(path(file), file.endsWith('.sh') ? 0o700 : 0o600);
    }
    for (const file of [directory, path('credentials')])
      await expectPrivate(file, 0o700);
    for (const file of [credential, path('credentials/Other.json')])
      await expectPrivate(file, 0o600);
    expectHeaders(bearer);
    expectHeaders(staticHeaders, 'Other');
  });

  it('uses runtime layout with no staging fallback', async () => {
    const runtimeDirectory = join(root, 'runtime_safe-2');
    await prepareCoworkMcpBundle(options({ runtimeDirectory }));
    expectHelperFailure();
    await expect(fs.stat(runtimeDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fs.cp(directory, runtimeDirectory, { recursive: true });
    expectHeaders({ Authorization: `Bearer ${TOKEN}` });
    await fs.rm(join(runtimeDirectory, 'credentials/Search_1.json'));
    expectHelperFailure(); // Staging credential still exists.
  });

  it.each([
    { servers: [] },
    { servers: [http()], arms: [{ name: 'empty', servers: [] }] },
    { arms: [{ name: 'empty', servers: [] }] },
  ])('accepts explicit empty server lists: %j', async (configuration) => {
    const input = manifest({
      ...configuration,
      coworkSetup: { approveWriteTools: true },
    });
    if (!Object.hasOwn(configuration, 'servers')) delete input.servers;
    const result = await prepareCoworkMcpBundle(
      options({
        manifest: input,
        arm: configuration.arms ? 'empty' : undefined,
        env: {},
      })
    );
    expect(result.serverCount).toBe(0);
    expect(await fs.readdir(path('credentials'))).toEqual([]);
    expect(await readJson(result.settingsPath)).toEqual({
      managedMcpServers: [],
      allowedMcpServers: [],
      allowManagedMcpServersOnly: true,
    });
  });
  it.each(['base', 'inherit', 'replace'])(
    'resolves %s canonical servers',
    async (selection) => {
      const input = manifest({
        arms: [
          { name: 'inherit' },
          {
            name: 'replace',
            servers: [http({ label: 'Replacement', auth: undefined })],
          },
        ],
      });
      const result = await prepareCoworkMcpBundle(
        options({
          manifest: input,
          arm: selection === 'base' ? undefined : selection,
        })
      );
      expect(await readJson(result.settingsPath)).toMatchObject({
        managedMcpServers: [
          { name: selection === 'replace' ? 'Replacement' : 'Search_1' },
        ],
      });
    }
  );

  it.each([
    { manifest: manifest({ servers: undefined }) },
    {
      manifest: manifest({ servers: undefined, arms: [{ name: 'inherit' }] }),
      arm: 'inherit',
    },
    { arm: 'no-match' },
    {
      manifest: manifest({
        arms: [{ name: 'same' }, { name: 'same', servers: [] }],
      }),
    },
    {
      manifest: manifest({ arms: [{ name: 'same' }, { name: 'same' }] }),
      arm: 'same',
    },
    { manifest: manifest({ servers: [http(), http()] }) },
    {
      manifest: manifest({
        coworkSetup: { approveWriteTools: 'true' } as unknown as NonNullable<
          EvalManifest['coworkSetup']
        >,
      }),
    },
    { env: {} },
    { env: { SYNTHETIC_COWORK_TOKEN: 'synthetic\r\nInjected: yes' } },
    {
      manifest: manifest({
        servers: [http({ headers: { 'X-Bad': 'synthetic\nsecret' } })],
      }),
    },
    {
      manifest: manifest({
        servers: [http({ headers: { 'X-Large': 'x'.repeat(65536) } })],
      }),
    },
  ])(
    'rejects invalid selection/config/credentials before writes (#%#)',
    async (overrides) => {
      await expectRejected(overrides);
      expect(await fs.readdir(root)).toEqual([]);
    }
  );
  it.each([
    'relative/path',
    '/safe/../unsafe',
    '/safe//unsafe',
    '/safe;echo-secret',
    '/safe\nsecret',
  ])('rejects unsafe runtime paths: %j', async (runtimeDirectory) => {
    await expectRejected({ runtimeDirectory });
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('never reads ambient process.env', async () => {
    vi.stubEnv('SYNTHETIC_COWORK_TOKEN', TOKEN);
    await expectRejected({ env: undefined });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(['directory', 'file', 'symlink', 'dangling-symlink', 'bundle'])(
    'refuses an existing %s without modifying it',
    async (kind) => {
      const sentinel = join(root, 'sentinel');
      await fs.mkdir(sentinel);
      await fs.writeFile(join(sentinel, 'untouched'), 'synthetic-sentinel');
      if (kind === 'bundle') await prepareCoworkMcpBundle(options());
      else if (kind === 'directory') await fs.mkdir(directory);
      else if (kind === 'file')
        await fs.writeFile(directory, 'synthetic-existing');
      else
        await fs.symlink(
          kind === 'symlink' ? sentinel : join(root, 'absent'),
          directory
        );
      const before = await fs.lstat(directory);
      await expectRejected({
        env: { SYNTHETIC_COWORK_TOKEN: 'different-synthetic-secret' },
      });
      expect((await fs.lstat(directory)).ino).toBe(before.ino);
      expect(await fs.readFile(join(sentinel, 'untouched'), 'utf8')).toBe(
        'synthetic-sentinel'
      );
      if (kind === 'file')
        expect(await fs.readFile(directory, 'utf8')).toBe('synthetic-existing');
      if (kind === 'directory') expect(await fs.readdir(directory)).toEqual([]);
      if (kind === 'bundle')
        expect(await readJson(credential)).toEqual({
          Authorization: `Bearer ${TOKEN}`,
        });
    }
  );
  it('never recursively creates missing parents', async () => {
    await expectRejected({ directory: join(root, 'absent/child') });
    expect(await fs.readdir(root)).toEqual([]);
  });
  it.each([0, 3])(
    'cleans only owned staging on write failure #%i, with sanitized errors',
    async (successfulWrites) => {
      const untouched = join(root, 'untouched');
      await fs.writeFile(untouched, 'synthetic-sentinel');
      const mock = vi.mocked(fs.writeFile);
      const original = mock.getMockImplementation()!;
      for (let i = 0; i < successfulWrites; i++)
        mock.mockImplementationOnce(original);
      mock.mockRejectedValueOnce(new Error(`${directory}: ${TOKEN}`));
      await expectRejected();
      expect(await fs.readdir(root)).toEqual(['untouched']);
      expect(await fs.readFile(untouched, 'utf8')).toBe('synthetic-sentinel');
    }
  );
});

describe('generated runtime helper', () => {
  it.each(['missing', 'symlink', 'directory', 'public'])(
    'rejects unsafe %s credential files',
    async (kind) => {
      await prepareCoworkMcpBundle(options());
      if (kind === 'public') await fs.chmod(credential, 0o644);
      else {
        const target = join(root, 'synthetic-target');
        await fs.rename(credential, target);
        if (kind === 'symlink') await fs.symlink(target, credential);
        if (kind === 'directory') await fs.mkdir(credential, { mode: 0o700 });
      }
      expectHelperFailure();
    }
  );
  it.each([
    `not-json-${TOKEN}`,
    '[]',
    '{}',
    JSON.stringify({ Authorization: `Bearer ${TOKEN}`, 'X-Extra': TOKEN }),
    '{"Authorization":"Bearer one","Authorization":"Bearer two"}',
    ...['\r\nX-Injected: yes', '\t', '\u0085', '\u2603'].map((suffix) =>
      JSON.stringify({ Authorization: `Bearer ${TOKEN}${suffix}` })
    ),
    '{"Authorization":42}',
    '{"Authorization":"Basic synthetic"}',
    JSON.stringify({ 'Authorization\r\nX-Injected': TOKEN }),
  ])(
    'rejects malformed runtime headers with empty stdout and fixed stderr (#%#)',
    async (payload) => {
      await prepareCoworkMcpBundle(options());
      await fs.writeFile(credential, payload);
      expectHelperFailure();
    }
  );
  it('allows validated static header bytes/punctuation without Python interpolation', async () => {
    const headers = {
      "X-!#$%&'*+.^_`|~": 'synthetic "quote" \\ literal $HOME café',
      Authorization: 'Basic synthetic-static',
    };
    await prepareCoworkMcpBundle(
      options({
        manifest: manifest({ servers: [http({ auth: undefined, headers })] }),
      })
    );
    expectHeaders(headers);
  });
  it('accepts exactly 64 KiB, rejects one byte more, and rereads rotated/deleted credentials', async () => {
    await prepareCoworkMcpBundle(options());
    const empty = JSON.stringify({ Authorization: 'Bearer ' });
    const headers = {
      Authorization: `Bearer ${'x'.repeat(65536 - empty.length)}`,
    };
    const content = JSON.stringify(headers);
    expect(Buffer.byteLength(content)).toBe(65536);
    await fs.writeFile(credential, content);
    expectHeaders(headers);
    await fs.appendFile(credential, ' ');
    expectHelperFailure();
    const rotated = { Authorization: 'Bearer rotated-synthetic' };
    await fs.writeFile(credential, JSON.stringify(rotated));
    expectHeaders(rotated);
    await fs.rm(credential);
    expectHelperFailure();
  });
});
