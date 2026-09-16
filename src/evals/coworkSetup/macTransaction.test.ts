import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalManifest } from '../evalManifest.js';
import {
  installMacCoworkSettings,
  restoreMacCoworkSettings,
} from './macTransaction.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    rmdir: vi.fn(actual.rmdir),
    lstat: vi.fn(actual.lstat),
  };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');
const ERROR = 'Unable to change Cowork configuration safely.';
const TOKEN = 'synthetic-inference-key';
const MCP_TOKEN = 'synthetic-mcp-key';
const ENV = { ANTHROPIC_API_KEY: TOKEN, TOKEN_Search: MCP_TOKEN };
const SOURCE = '11111111-2222-3333-4444-555555555555';
const META = {
  appliedId: SOURCE,
  entries: [{ id: SOURCE, name: 'Original' }],
  ui: { color: 'blue' },
};
const ORIGINAL = JSON.stringify(META, null, 4) + '\n';
let root: string;
let profileDirectory: string;
let stagingDirectory: string;
let lock: string;
let meta: string;
let source: string;
let journal: string;

type Options = Parameters<typeof installMacCoworkSettings>[0];
type Profile = {
  managedMcpServers: Array<{
    name: string;
    url: string;
    headersHelper: string;
    toolPolicy?: object;
  }>;
  allowedMcpServers: Array<{ serverName: string }>;
};
function stage(name: string): string {
  return join(stagingDirectory, name);
}
function profile(id: string): string {
  return join(profileDirectory, `${id}.json`);
}
function manifest(labels = ['Search']): EvalManifest {
  return {
    name: 'synthetic',
    datasets: [],
    servers: labels.map((label) => ({
      transport: 'http',
      label,
      serverUrl: `https://${label.toLowerCase()}.example.test/mcp`,
      auth: { accessTokenEnv: `TOKEN_${label}` },
    })),
  };
}
function options(overrides: Partial<Options> = {}): Options {
  return {
    profileDirectory,
    stagingDirectory,
    env: { ...ENV },
    managedPreferencePaths: [join(root, 'managed.plist')],
    manifest: manifest(),
    ...overrides,
  };
}
async function readJson<T = Record<string, unknown>>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}
async function text(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}
async function expectGone(...files: string[]): Promise<void> {
  for (const file of files)
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
}
async function expectOriginal(): Promise<void> {
  expect(await text(meta)).toBe(ORIGINAL);
  expect(await text(source)).toBe(' { } \n');
}
async function expectClean(): Promise<void> {
  await expectOriginal();
  await expectGone(stagingDirectory, lock);
  expect((await fs.readdir(profileDirectory)).sort()).toEqual(
    [`${SOURCE}.json`, '_meta.json'].sort()
  );
}
async function rejectInstall(overrides: Partial<Options> = {}): Promise<void> {
  const failure: unknown = await installMacCoworkSettings(
    options(overrides)
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ message: ERROR });
  expect((failure as Error).cause).toBeUndefined();
  expect((failure as Error).stack).not.toContain(TOKEN);
}
function invokeHelper(
  file = stage('inference-helper.sh')
): ReturnType<typeof spawnSync> {
  return spawnSync(file, [], {
    env: {},
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
}

beforeEach(async () => {
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink);
  vi.mocked(fs.rmdir).mockReset().mockImplementation(actual.rmdir);
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat);
  root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'mst_mac-transaction-'))
  );
  await fs.chmod(root, 0o700);
  profileDirectory = join(root, 'library');
  stagingDirectory = join(root, 'staged');
  lock = join(profileDirectory, '.mst-setup-lock');
  meta = join(profileDirectory, '_meta.json');
  source = profile(SOURCE);
  journal = join(lock, 'journal.json');
  await fs.mkdir(profileDirectory, { mode: 0o700 });
  await fs.writeFile(meta, ORIGINAL, { mode: 0o600 });
  await fs.writeFile(source, ' { } \n', { mode: 0o600 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await actual.rm(root, { recursive: true, force: true });
});

describe('Mac Cowork settings transaction', () => {
  it('isolates exact replacement/empty server sets and opt-in policies across runs', async () => {
    for (const labels of [
      ['first', 'second'],
      ['replacement'],
      [],
      ['a', 'b', 'c', 'd', 'e', 'f'],
    ]) {
      const input = manifest(labels);
      const approved = labels.length === 2;
      input.coworkSetup = { approveWriteTools: approved };
      const env = {
        ...ENV,
        ...Object.fromEntries(
          labels.map((label) => [`TOKEN_${label}`, `synthetic-${label}`])
        ),
      };
      const installed = await installMacCoworkSettings(
        options({ manifest: input, env })
      );
      const configured = await readJson<Profile>(profile(installed.id));
      expect(configured.managedMcpServers).toEqual(
        labels.map((label) => ({
          name: label,
          transport: 'http',
          url: `https://${label}.example.test/mcp`,
          headersHelper: stage(`mcp-${label}-headers.sh`),
          ...(approved ? { toolPolicy: { '*': 'allow' } } : {}),
        }))
      );
      expect(configured.allowedMcpServers).toEqual(
        labels.map((serverName) => ({ serverName }))
      );
      expect(configured).not.toHaveProperty('builtinToolPolicy');
      expect(configured).not.toHaveProperty('disableBypassPermissionsMode');
      for (const server of configured.managedMcpServers) {
        const reply = invokeHelper(server.headersHelper);
        expect(reply).toMatchObject({ status: 0, stderr: '' });
        expect(JSON.parse(String(reply.stdout))).toEqual({
          Authorization: `Bearer synthetic-${server.name}`,
        });
        expect(JSON.stringify(configured)).not.toContain(
          `synthetic-${server.name}`
        );
      }
      await installed.restore();
      await expectClean();
    }
  });

  it('installs a private, secret-free flat profile and recovers exact original bytes', async () => {
    const result = await installMacCoworkSettings(options());
    expect(result).toMatchObject({
      status: 'applied-not-verified',
      directory: stagingDirectory,
    });
    expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.id).not.toBe(SOURCE);
    expect(await readJson(profile(result.id))).toEqual({
      managedMcpServers: [
        {
          name: 'Search',
          transport: 'http',
          url: 'https://search.example.test/mcp',
          headersHelper: stage('mcp-Search-headers.sh'),
        },
      ],
      allowedMcpServers: [{ serverName: 'Search' }],
      allowManagedMcpServersOnly: true,
      inferenceProvider: 'anthropic',
      inferenceCredentialKind: 'helper-script',
      inferenceCredentialHelper: stage('inference-helper.sh'),
    });
    expect(await readJson(meta)).toEqual({
      ...META,
      appliedId: result.id,
      entries: [...META.entries, { id: result.id, name: 'MST test' }],
    });
    expect(await text(source)).toBe(' { } \n');
    for (const file of [
      profile(result.id),
      meta,
      journal,
      stage('credentials/inference.json'),
    ]) {
      const info = await fs.stat(file);
      expect([info.uid, info.mode & 0o777]).toEqual([process.getuid!(), 0o600]);
    }
    expect((await fs.stat(lock)).mode & 0o777).toBe(0o700);
    for (const file of [
      profile(result.id),
      meta,
      journal,
      stage('inference-helper.sh'),
      stage('managed-mcp.json'),
    ]) {
      expect(await text(file)).not.toMatch(
        new RegExp(`${TOKEN}|${MCP_TOKEN}|inferenceModels`)
      );
    }
    expect(
      Buffer.from(
        (await readJson(journal)).originalMeta as string,
        'base64'
      ).toString()
    ).toBe(ORIGINAL);
    expect(await readJson(stage('credentials/inference.json'))).toEqual({
      ANTHROPIC_API_KEY: TOKEN,
    });
    expect(await readJson(stage('credentials/Search.json'))).toEqual({
      Authorization: `Bearer ${MCP_TOKEN}`,
    });
    const invoked = invokeHelper();
    expect(invoked.error).toBeUndefined();
    expect(invoked).toMatchObject({
      status: 0,
      stdout: TOKEN + '\n',
      stderr: '',
    });
    await restoreMacCoworkSettings(profileDirectory);
    await expectClean();
  });

  it('selects an explicit empty arm', async () => {
    const input = manifest();
    input.arms = [{ name: 'empty', servers: [] }];
    const result = await installMacCoworkSettings(
      options({ manifest: input, arm: 'empty' })
    );
    expect((await readJson(profile(result.id))).managedMcpServers).toEqual([]);
    await result.restore();
    await expectClean();
  });

  it.each([
    undefined,
    {},
    { ANTHROPIC_API_KEY: TOKEN },
    { TOKEN_Search: MCP_TOKEN },
    { ...ENV, ANTHROPIC_API_KEY: 'bad value' },
    { ...ENV, ANTHROPIC_API_KEY: 'x'.repeat(65536) },
    Object.create(ENV) as Record<string, string>,
  ])(
    'requires valid explicit inference and MCP credentials (#%#)',
    async (env) => {
      vi.stubEnv('ANTHROPIC_API_KEY', TOKEN);
      vi.stubEnv('TOKEN_Search', MCP_TOKEN);
      await rejectInstall({ env });
      await expectClean();
    }
  );

  it('rejects a second install and prevents an old closure from restoring a newer transaction', async () => {
    const first = await installMacCoworkSettings(options());
    const before = await text(journal);
    const otherStage = join(root, 'other-stage');
    await rejectInstall({ stagingDirectory: otherStage });
    expect(await text(journal)).toBe(before);
    await expectGone(otherStage);
    await first.restore();
    const second = await installMacCoworkSettings(options());
    await expect(first.restore()).rejects.toThrow(ERROR);
    expect((await readJson(meta)).appliedId).toBe(second.id);
    await second.restore();
    await expectClean();
  });

  it.each(['../escape', '', 'not-a-uuid'])(
    'rejects invalid applied UUID %s',
    async (id) => {
      await fs.writeFile(
        meta,
        JSON.stringify({ appliedId: id, entries: [{ id, name: 'bad' }] })
      );
      await rejectInstall();
      await expectGone(lock, stagingDirectory);
    }
  );
  it.each([{ inferenceProvider: 'anthropic' }, { settings: {} }, []])(
    'preserves unsupported source %j',
    async (value) => {
      const bytes = JSON.stringify(value);
      await fs.writeFile(source, bytes);
      await rejectInstall();
      expect(await text(source)).toBe(bytes);
      await expectGone(lock, stagingDirectory);
    }
  );

  it.each([
    'managed-symlink',
    'managed-permission',
    'library-mode',
    'library-symlink',
    'wrong-owner',
  ])('refuses unsafe %s', async (kind) => {
    const managed = join(root, 'managed.plist');
    let overrides: Partial<Options> = {};
    if (kind === 'managed-symlink')
      await fs.symlink(join(root, 'missing'), managed);
    if (kind === 'managed-permission')
      vi.mocked(fs.lstat).mockImplementation(
        async (...args: Parameters<typeof fs.lstat>) => {
          if (args[0] === managed)
            throw Object.assign(new Error(TOKEN), { code: 'EACCES' });
          return actual.lstat(...args);
        }
      );
    if (kind === 'library-mode') await fs.chmod(profileDirectory, 0o777);
    if (kind === 'library-symlink') {
      const alias = join(root, 'alias');
      await fs.symlink(profileDirectory, alias);
      overrides = { profileDirectory: alias };
    }
    if (kind === 'wrong-owner')
      vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    await rejectInstall(overrides);
    await expectClean();
  });
  it.each(['stage with spaces', '../outside'])(
    'rejects unsafe staging path %s',
    async (name) => {
      await rejectInstall({ stagingDirectory: `${stagingDirectory}/${name}` });
      await expectClean();
    }
  );
  it('never removes a preexisting staging directory', async () => {
    await fs.mkdir(stagingDirectory, { mode: 0o700 });
    await fs.writeFile(stage('user-file'), 'keep');
    await rejectInstall();
    expect(await text(stage('user-file'))).toBe('keep');
    await expectGone(lock);
    await expectOriginal();
  });

  it.each(['no-final-newline', 'compact', 'four-space', 'crlf'])(
    'recovers metadata formatting changes: %s',
    async (format) => {
      await installMacCoworkSettings(options());
      const before = await text(meta);
      const value: unknown = JSON.parse(before);
      const rewritten = {
        'no-final-newline': before.trimEnd(),
        compact: JSON.stringify(value),
        'four-space': JSON.stringify(value, null, 4) + '\n',
        crlf: before.replaceAll('\n', '\r\n'),
      }[format]!;
      expect(rewritten).not.toBe(before);
      await fs.writeFile(meta, rewritten);
      await restoreMacCoworkSettings(profileDirectory);
      await expectClean();
    }
  );
  it('preserves whitespace and escaped characters inside metadata strings', async () => {
    const original =
      JSON.stringify(
        {
          ...META,
          entries: [{ id: SOURCE, name: 'Original "quoted" \\ path' }],
          note: 'line one\nline two  spaces',
        },
        null,
        4
      ) + '\n';
    await fs.writeFile(meta, original);
    const installed = await installMacCoworkSettings(options());
    await fs.writeFile(meta, JSON.stringify(await readJson(meta)));
    await installed.restore();
    expect(await text(meta)).toBe(original);
    await expectGone(lock, stagingDirectory);
  });
  it.each([
    'renamed-entry',
    'changed-selection',
    'extra-field',
    'duplicate-key',
    'changed-string-space',
  ])('refuses substantive metadata changes: %s', async (change) => {
    const installed = await installMacCoworkSettings(options());
    const value = await readJson<typeof META & { extra?: boolean }>(meta);
    if (change === 'renamed-entry') value.entries[1]!.name = 'user edit';
    if (change === 'changed-selection') value.appliedId = SOURCE;
    if (change === 'extra-field') value.extra = true;
    if (change === 'changed-string-space') value.entries[1]!.name = 'MSTtest';
    let rewritten = JSON.stringify(value);
    if (change === 'duplicate-key')
      rewritten = rewritten.replace(
        '"appliedId":',
        `"appliedId":"${SOURCE}","appliedId":`
      );
    await fs.writeFile(meta, rewritten);
    await expect(installed.restore()).rejects.toThrow(ERROR);
    expect(await text(meta)).toBe(rewritten);
    await fs.access(journal);
    await fs.access(stagingDirectory);
  });
  it.each([
    'metadata',
    'profile',
    'staged-file',
    'extra-file',
    'marker',
    'tool-policy',
  ])('retains ownership and never clobbers changed %s', async (kind) => {
    const result = await installMacCoworkSettings(options());
    const target = {
      metadata: meta,
      profile: profile(result.id),
      'staged-file': stage('credentials/inference.json'),
      'extra-file': stage('user-file'),
      marker: stage('.mst-setup-marker'),
      'tool-policy': profile(result.id),
    }[kind]!;
    const previousMeta = await text(meta);
    let changed = 'user-change';
    if (kind === 'tool-policy') {
      const configured = await readJson<Profile>(target);
      configured.managedMcpServers[0]!.toolPolicy = { '*': 'ask' };
      changed = JSON.stringify(configured);
    }
    await fs.writeFile(target, changed, { mode: 0o600 });
    await expect(result.restore()).rejects.toThrow(ERROR);
    expect(await text(target)).toBe(changed);
    expect(await text(meta)).toBe(kind === 'metadata' ? changed : previousMeta);
    await fs.access(journal);
    await fs.access(profile(result.id));
    await fs.access(stagingDirectory);
  });

  it.each(['metadata', 'journal', 'inference-helper.sh', 'managed-mcp.json'])(
    'rolls back owned files on %s write failure',
    async (kind) => {
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (
          (kind === 'metadata' && to === meta) ||
          (kind === 'journal' && to === journal)
        )
          throw new Error(TOKEN);
        await actual.rename(from, to);
      });
      vi.mocked(fs.writeFile).mockImplementation(
        async (...args: Parameters<typeof fs.writeFile>) => {
          if (args[0] === stage(kind)) throw new Error(TOKEN);
          await actual.writeFile(...args);
        }
      );
      await fs.writeFile(join(root, 'unrelated'), 'keep');
      await rejectInstall();
      await expectClean();
      expect(await text(join(root, 'unrelated'))).toBe('keep');
    }
  );
  it('detects concurrent metadata changes immediately before rename', async () => {
    vi.mocked(fs.writeFile).mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        await actual.writeFile(...args);
        if (
          typeof args[0] === 'string' &&
          args[0].startsWith(profileDirectory + '/') &&
          args[0].endsWith('.json') &&
          args[0] !== meta &&
          args[0] !== source
        ) {
          await actual.writeFile(meta, 'user-change');
        }
      }
    );
    await rejectInstall();
    expect(await text(meta)).toBe('user-change');
    await fs.access(journal);
  });
  it.each(['first-unlink', 'partial-unlink', 'stage-rmdir', 'lock-rmdir'])(
    'retains a journal and recovers after %s failure',
    async (kind) => {
      const result = await installMacCoworkSettings(options());
      if (kind === 'first-unlink')
        vi.mocked(fs.unlink).mockRejectedValueOnce(new Error(TOKEN));
      if (kind === 'partial-unlink')
        vi.mocked(fs.unlink).mockImplementation(async (file) => {
          if (file === stage('inference-helper.sh')) throw new Error(TOKEN);
          await actual.unlink(file);
        });
      vi.mocked(fs.rmdir).mockImplementation(
        async (...args: Parameters<typeof fs.rmdir>) => {
          if (
            (kind === 'stage-rmdir' && args[0] === stagingDirectory) ||
            (kind === 'lock-rmdir' && args[0] === lock)
          )
            throw new Error(TOKEN);
          await actual.rmdir(...args);
        }
      );
      await expect(result.restore()).rejects.toThrow(ERROR);
      await expectOriginal();
      await fs.access(journal);
      if (kind === 'stage-rmdir') await fs.access(stage('.mst-setup-marker'));
      vi.mocked(fs.unlink).mockImplementation(actual.unlink);
      vi.mocked(fs.rmdir).mockImplementation(actual.rmdir);
      await restoreMacCoworkSettings(profileDirectory);
      await expectClean();
    }
  );

  it.each(['id', 'directory', 'files'])(
    'rejects malicious recovery journal %s paths',
    async (field) => {
      const result = await installMacCoworkSettings(options());
      const value = await readJson(journal);
      const victim = join(root, 'victim');
      await fs.mkdir(victim, { mode: 0o700 });
      await fs.writeFile(join(victim, 'keep'), 'keep', { mode: 0o600 });
      value[field] = {
        id: '../victim/keep',
        directory: victim,
        files: { '../victim/keep': '0'.repeat(64) },
      }[field];
      await fs.writeFile(journal, JSON.stringify(value));
      await expect(restoreMacCoworkSettings(profileDirectory)).rejects.toThrow(
        ERROR
      );
      expect(await text(join(victim, 'keep'))).toBe('keep');
      expect((await readJson(meta)).appliedId).toBe(result.id);
      await fs.access(journal);
    }
  );

  it.each([
    'missing',
    'malformed',
    'duplicate',
    'public',
    'symlink',
    'oversize',
    'directory',
    'fifo',
    'invalid-token',
  ])(
    'helper rejects %s credentials with bounded generic output',
    async (kind) => {
      await installMacCoworkSettings(options());
      const file = stage('credentials/inference.json');
      if (['missing', 'symlink', 'directory', 'fifo'].includes(kind))
        await fs.unlink(file);
      if (kind === 'malformed') await fs.writeFile(file, TOKEN);
      if (kind === 'duplicate')
        await fs.writeFile(
          file,
          `{"ANTHROPIC_API_KEY":"${TOKEN}","ANTHROPIC_API_KEY":"other"}`
        );
      if (kind === 'invalid-token')
        await fs.writeFile(file, '{"ANTHROPIC_API_KEY":"bad value"}');
      if (kind === 'public') await fs.chmod(file, 0o644);
      if (kind === 'symlink')
        await fs.symlink(stage('credentials/Search.json'), file);
      if (kind === 'oversize') await fs.writeFile(file, 'a'.repeat(65537));
      if (kind === 'directory') await fs.mkdir(file, { mode: 0o700 });
      if (kind === 'fifo')
        expect(
          spawnSync('/usr/bin/mkfifo', ['-m', '600', file], { timeout: 5000 })
            .status
        ).toBe(0);
      const invoked = invokeHelper();
      expect(invoked.error).toBeUndefined();
      expect(invoked).toMatchObject({
        status: 1,
        stdout: '',
        stderr: 'Unable to read Cowork inference credential.\n',
      });
    }
  );
});
