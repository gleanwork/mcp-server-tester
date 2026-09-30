import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installMacToolPermissions,
  restoreMacToolPermissions,
} from './macToolPermissionStore.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: vi.fn(),
  tmpdir: vi.fn(),
}));
const actualOs = await vi.importActual<typeof os>('node:os');
const KEY = 'local:glean-eval:search';
const HASH_KEY = `${KEY}-0123456789abcdef0123456789abcdef`;
const original = Buffer.from(
  ' { "theme": "dark", "enabled_mcp_tools": {"existing":true,"local:glean-eval:search":false} }\n'
);
let root: string,
  directory: string,
  sessions: string,
  target: string,
  receipt: string;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(join(actualOs.tmpdir(), 'mst-permissions-test-'))
  );
  vi.mocked(os.homedir).mockReturnValue(root);
  vi.mocked(os.tmpdir).mockReturnValue(root);
  directory = join(root, `mst-cowork-session-${randomUUID()}-mcp`);
  sessions = join(
    root,
    'Library/Application Support/Claude-3p/local-agent-mode-sessions'
  );
  target = join(
    sessions,
    '1234abcd',
    randomUUID(),
    'cowork_account_settings.json'
  );
  receipt = join(directory, 'permissions.json');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, original, { mode: 0o644 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function settings(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(target, 'utf8')) as Record<
    string,
    unknown
  >;
}
async function writeSettings(value: unknown): Promise<void> {
  await fs.writeFile(target, JSON.stringify(value));
}
async function expectUnchanged(): Promise<void> {
  expect(await fs.readFile(target)).toEqual(original);
  expect(await fs.readdir(directory)).toEqual([]);
}

describe('Mac tool permission transaction', () => {
  it('journals privately, installs only explicit grants, and restores exact bytes and mode', async () => {
    await installMacToolPermissions(directory, {
      [KEY]: true,
      [HASH_KEY]: true,
    });
    expect(await settings()).toEqual({
      theme: 'dark',
      enabled_mcp_tools: { existing: true, [KEY]: true, [HASH_KEY]: true },
    });
    expect((await fs.stat(receipt)).mode & 0o777).toBe(0o600);
    const journal = JSON.parse(await fs.readFile(receipt, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(journal.previous).toEqual({
      [KEY]: { present: true, value: false },
      [HASH_KEY]: { present: false },
    });
    expect(journal.mapPresent).toBe(true);
    await writeSettings(await settings());
    await fs.chmod(target, 0o600);
    await restoreMacToolPermissions(directory);
    expect(await fs.readFile(target)).toEqual(original);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
    expect(await fs.readdir(directory)).toEqual([]);
    await restoreMacToolPermissions(directory);
  });
  it('restores both bare Cowork and local-prefixed grants without retaining approvals', async () => {
    const bare = 'glean-eval:search';
    const bareHash = `${bare}-0123456789abcdef0123456789abcdef`;
    const grants = {
      [KEY]: true,
      [HASH_KEY]: true,
      [bare]: true,
      [bareHash]: true,
    };
    await installMacToolPermissions(directory, grants);
    expect((await settings()).enabled_mcp_tools).toEqual({
      existing: true,
      ...grants,
    });
    await restoreMacToolPermissions(directory);
    expect(await fs.readFile(target)).toEqual(original);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('preserves unrelated nested changes, added fields, and other tool defaults', async () => {
    await installMacToolPermissions(directory, {
      [KEY]: true,
      [HASH_KEY]: true,
    });
    await writeSettings({
      theme: 'light',
      nested: { new: [1, 2] },
      enabled_mcp_tools: {
        existing: false,
        another: true,
        [KEY]: true,
        [HASH_KEY]: true,
      },
    });
    await fs.chmod(target, 0o600);
    await restoreMacToolPermissions(directory);
    expect(await settings()).toEqual({
      theme: 'light',
      nested: { new: [1, 2] },
      enabled_mcp_tools: { existing: false, another: true, [KEY]: false },
    });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('restores an absent permission map, but keeps unrelated new defaults', async () => {
    const absent = Buffer.from(' {"theme":"dark"}\n');
    await fs.writeFile(target, absent);
    await installMacToolPermissions(directory, { [KEY]: true });
    await restoreMacToolPermissions(directory);
    expect(await fs.readFile(target)).toEqual(absent);
    await installMacToolPermissions(directory, { [KEY]: true });
    await writeSettings({
      theme: 'dark',
      enabled_mcp_tools: { [KEY]: true, other: false },
      added: true,
    });
    await restoreMacToolPermissions(directory);
    expect(await settings()).toEqual({
      theme: 'dark',
      enabled_mcp_tools: { other: false },
      added: true,
    });
  });
  it('refuses unexpected changes to an owned key without changing settings or the journal', async () => {
    await installMacToolPermissions(directory, {
      [KEY]: true,
      [HASH_KEY]: true,
    });
    const installed = await settings();
    (installed.enabled_mcp_tools as Record<string, boolean>)[HASH_KEY] = false;
    await writeSettings(installed);
    const before = await fs.readFile(target);
    const saved = await fs.readFile(receipt);
    await expect(restoreMacToolPermissions(directory)).rejects.toThrow(
      'safely'
    );
    expect(await fs.readFile(target)).toEqual(before);
    expect(await fs.readFile(receipt)).toEqual(saved);
  });
  it.each([{ [KEY]: false }, { [KEY]: true }, { [HASH_KEY]: true }])(
    'recovers a pre-replacement journal with original grants %j',
    async (map) => {
      await writeSettings({ enabled_mcp_tools: map });
      const before = await fs.readFile(target);
      const rename = fs.rename;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (to === target) throw new Error('synthetic failure');
        await rename(from, to);
      });
      await expect(
        installMacToolPermissions(directory, { [KEY]: true, [HASH_KEY]: true })
      ).rejects.toThrow('safely');
      expect(await fs.readFile(target)).toEqual(before);
      expect((await fs.stat(receipt)).isFile()).toBe(true);
      vi.restoreAllMocks();
      await restoreMacToolPermissions(directory);
      expect(await fs.readFile(target)).toEqual(before);
      expect(await fs.readdir(directory)).toEqual([]);
    }
  );
  it('accepts a mix of installed and original owned values during partial recovery', async () => {
    await installMacToolPermissions(directory, {
      [KEY]: true,
      [HASH_KEY]: true,
    });
    const partial = await settings();
    (partial.enabled_mcp_tools as Record<string, boolean>)[KEY] = false;
    await writeSettings(partial);
    await restoreMacToolPermissions(directory);
    expect(await fs.readFile(target)).toEqual(original);
  });
  it('retries after restoration succeeded but journal removal was interrupted', async () => {
    await installMacToolPermissions(directory, { [KEY]: true });
    const unlink = fs.unlink;
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (path === receipt) throw new Error('synthetic failure');
      await unlink(path);
    });
    await expect(restoreMacToolPermissions(directory)).rejects.toThrow(
      'safely'
    );
    expect(await fs.readFile(target)).toEqual(original);
    vi.restoreAllMocks();
    await restoreMacToolPermissions(directory);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('fails before reading any account settings when discovery is ambiguous', async () => {
    const second = join(
      sessions,
      '87654321',
      'deadbeef',
      'cowork_account_settings.json'
    );
    await fs.mkdir(dirname(second), { recursive: true, mode: 0o700 });
    await fs.writeFile(second, '{"private":"not read"}', { mode: 0o600 });
    const open = vi.spyOn(fs, 'open');
    await expect(
      installMacToolPermissions(directory, { [KEY]: true })
    ).rejects.toThrow('safely');
    expect(open).not.toHaveBeenCalled();
    await expectUnchanged();
  });
  it('does not recurse into logs or use settings at the wrong depth', async () => {
    await fs.unlink(target);
    const nested = join(
      dirname(target),
      'logs',
      'cowork_account_settings.json'
    );
    await fs.mkdir(dirname(nested), { mode: 0o700 });
    await fs.writeFile(nested, original, { mode: 0o600 });
    await expect(
      installMacToolPermissions(directory, { [KEY]: true })
    ).rejects.toThrow('safely');
    expect(await fs.readFile(nested)).toEqual(original);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it.each([
    { [KEY]: false },
    { 'remote:glean:search': true },
    { 'local:bad.label:search': true },
    { 'local:glean:__proto__': true },
    { 'local:constructor:search': true },
    { [HASH_KEY]: true },
    { [KEY]: true, [`${KEY}:${'a'.repeat(64)}`]: true },
    { [`local:glean:__proto__-${'a'.repeat(32)}`]: true },
    { 'local:glean:*': true },
    { 'local:glean:search\n': true },
    JSON.parse('{"__proto__":true}') as Record<string, boolean>,
  ])('rejects invalid grants without mutation: %j', async (grants) => {
    await expect(installMacToolPermissions(directory, grants)).rejects.toThrow(
      'safely'
    );
    await expectUnchanged();
  });
  it.each([
    'file',
    'org',
    'account',
    'sessions',
    'library',
    'journal directory',
  ])('rejects symlinked %s', async (kind) => {
    const path =
      kind === 'file'
        ? target
        : kind === 'org'
          ? dirname(target)
          : kind === 'account'
            ? dirname(dirname(target))
            : kind === 'sessions'
              ? sessions
              : kind === 'library'
                ? join(root, 'Library')
                : directory;
    const moved = `${path}-original`;
    await fs.rename(path, moved);
    await fs.symlink(moved, path);
    await expect(
      installMacToolPermissions(directory, { [KEY]: true })
    ).rejects.toThrow('safely');
    expect(await fs.readFile(target)).toEqual(original);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it.each(['file', 'org', 'account', 'sessions', 'home', 'journal directory'])(
    'rejects unsafe permissions on %s',
    async (kind) => {
      const path =
        kind === 'file'
          ? target
          : kind === 'org'
            ? dirname(target)
            : kind === 'account'
              ? dirname(dirname(target))
              : kind === 'sessions'
                ? sessions
                : kind === 'home'
                  ? root
                  : directory;
      await fs.chmod(path, kind === 'file' ? 0o666 : 0o777);
      await expect(
        installMacToolPermissions(directory, { [KEY]: true })
      ).rejects.toThrow('safely');
      await expectUnchanged();
    }
  );
  it('rejects a journal directory outside the exact temporary session namespace', async () => {
    const wrong = join(root, 'not-a-session');
    await fs.mkdir(wrong, { mode: 0o700 });
    await expect(
      installMacToolPermissions(wrong, { [KEY]: true })
    ).rejects.toThrow('safely');
    await expectUnchanged();
    expect(await fs.readdir(wrong)).toEqual([]);
  });
  it.each(['target', 'hash', 'previous', 'unknown', 'grants'])(
    'rejects an invalid journal (%s) without mutation',
    async (kind) => {
      await installMacToolPermissions(directory, { [KEY]: true });
      const journal = JSON.parse(await fs.readFile(receipt, 'utf8')) as Record<
        string,
        unknown
      >;
      if (kind === 'target') journal.target = join(root, 'other-profile.json');
      else if (kind === 'hash') journal.originalHash = '0'.repeat(64);
      else if (kind === 'previous')
        journal.previous = { [KEY]: { present: false } };
      else if (kind === 'unknown') journal.unexpected = true;
      else journal.grants = { [KEY]: false };
      await fs.writeFile(receipt, JSON.stringify(journal));
      const before = await fs.readFile(target);
      await expect(restoreMacToolPermissions(directory)).rejects.toThrow(
        'safely'
      );
      expect(await fs.readFile(target)).toEqual(before);
      expect((await fs.stat(receipt)).isFile()).toBe(true);
    }
  );
  it('rejects oversized files and malformed permission maps before mutation', async () => {
    for (const bytes of [
      Buffer.alloc(1024 * 1024 + 1, ' '),
      Buffer.from('{"enabled_mcp_tools":null}'),
      Buffer.from('{"enabled_mcp_tools":[]}'),
      Buffer.from('{"constructor":"secret-fixture"}'),
    ]) {
      await fs.writeFile(target, bytes);
      await expect(
        installMacToolPermissions(directory, { [KEY]: true })
      ).rejects.toThrow('Unable to manage Cowork tool permissions safely.');
      expect(await fs.readFile(target)).toEqual(bytes);
      expect(await fs.readdir(directory)).toEqual([]);
    }
  });
  it('refuses a same-byte replacement race before committing settings', async () => {
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === receipt) {
        const replacement = join(dirname(target), 'replacement');
        await fs.writeFile(replacement, original, { mode: 0o644 });
        await rename(replacement, target);
      }
    });
    await expect(
      installMacToolPermissions(directory, { [KEY]: true })
    ).rejects.toThrow('safely');
    expect(await fs.readFile(target)).toEqual(original);
    expect((await fs.stat(receipt)).isFile()).toBe(true);
  });
  it('rejects a missing account and never creates account settings', async () => {
    await fs.unlink(target);
    await fs.rmdir(dirname(target));
    await fs.rmdir(dirname(dirname(target)));
    await expect(
      installMacToolPermissions(directory, { [KEY]: true })
    ).rejects.toThrow('safely');
    expect(await fs.readdir(sessions)).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('rejects files owned by another user and hard-linked settings', async () => {
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await expect(
      installMacToolPermissions(directory, { [KEY]: true })
    ).rejects.toThrow('safely');
    vi.restoreAllMocks();
    await fs.link(target, join(root, 'hardlink'));
    await expect(
      installMacToolPermissions(directory, { [KEY]: true })
    ).rejects.toThrow('safely');
    await expectUnchanged();
  });
  it.each(['symlink', 'public'])(
    'rejects a %s recovery receipt',
    async (kind) => {
      await installMacToolPermissions(directory, { [KEY]: true });
      if (kind === 'symlink') {
        await fs.rename(receipt, receipt + '.original');
        await fs.symlink(receipt + '.original', receipt);
      } else await fs.chmod(receipt, 0o644);
      const before = await fs.readFile(target);
      await expect(restoreMacToolPermissions(directory)).rejects.toThrow(
        'safely'
      );
      expect(await fs.readFile(target)).toEqual(before);
    }
  );
  it('retains a receipt if settings change after the restore replacement', async () => {
    await installMacToolPermissions(directory, { [KEY]: true });
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === target) await writeSettings({ theme: 'concurrent' });
    });
    await expect(restoreMacToolPermissions(directory)).rejects.toThrow(
      'safely'
    );
    expect(await settings()).toEqual({ theme: 'concurrent' });
    expect((await fs.stat(receipt)).isFile()).toBe(true);
  });
  it('refuses a preexisting journal rather than overwriting recovery state', async () => {
    await fs.writeFile(receipt, 'existing', { mode: 0o600 });
    await expect(
      installMacToolPermissions(directory, { [KEY]: true })
    ).rejects.toThrow('safely');
    expect(await fs.readFile(target)).toEqual(original);
    expect(await fs.readFile(receipt, 'utf8')).toBe('existing');
  });
});
