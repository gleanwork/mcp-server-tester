import { existsSync, statSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthCacheDirectoriesSchema,
  linkAuthCacheDirectories,
} from './isolatedAuthCache.js';

let root: string;
let home: string;
let cache: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mst-auth-cache-test-'));
  home = await mkdtemp(join(root, 'home-'));
  cache = join(root, 'persistent-auth');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('isolated home auth caches', () => {
  it('leaves the default home empty and creates no persistent state', async () => {
    await linkAuthCacheDirectories(home, undefined);
    await linkAuthCacheDirectories(home, {});
    expect(await readdir(home)).toEqual([]);
    expect(existsSync(cache)).toBe(false);
  });

  it('accepts explicit auth directories but not general application settings', () => {
    expect(
      AuthCacheDirectoriesSchema.parse({ '.example-gateway': cache })
    ).toEqual({ '.example-gateway': cache });
    for (const name of [
      '.',
      '..',
      '../credentials',
      '.auth/nested',
      '/absolute',
      'config.toml',
      'skills',
      '.codex',
      '.agents',
      '.claude',
      '.config',
      '.local',
    ])
      expect(() =>
        AuthCacheDirectoriesSchema.parse({ [name]: cache })
      ).toThrow();
    for (const value of ['relative/cache', '~/cache', ''])
      expect(() =>
        AuthCacheDirectoriesSchema.parse({ '.example-gateway': value })
      ).toThrow();
  });

  it('reuses only auth state across different homes, and cleanup removes only links', async () => {
    await linkAuthCacheDirectories(home, { '.example-gateway': cache });
    const first = join(home, '.example-gateway');
    const fixture = '{"testFixture":"not-a-real-credential"}';
    expect((await lstat(first)).isSymbolicLink()).toBe(true);
    expect(await realpath(first)).toBe(await realpath(cache));
    if (process.platform !== 'win32')
      expect(statSync(cache).mode & 0o077).toBe(0);
    await writeFile(join(first, 'credentials.json'), fixture, { mode: 0o600 });
    await rm(home, { recursive: true, force: true });
    expect(await readFile(join(cache, 'credentials.json'), 'utf8')).toBe(
      fixture
    );
    home = await mkdtemp(join(root, 'home-'));
    await linkAuthCacheDirectories(home, { '.example-gateway': cache });
    expect(
      await readFile(join(home, '.example-gateway', 'credentials.json'), 'utf8')
    ).toBe(fixture);
    expect(await readdir(home)).toEqual(['.example-gateway']);
    expect(existsSync(join(home, 'config.toml'))).toBe(false);
    expect(existsSync(join(home, 'skills'))).toBe(false);
  });

  it('initializes the same cache safely for concurrent trial homes', async () => {
    const homes = await Promise.all(
      Array.from({ length: 8 }, () => mkdtemp(join(root, 'home-')))
    );
    await Promise.all(
      homes.map((directory) =>
        linkAuthCacheDirectories(directory, { '.example-gateway': cache })
      )
    );
    expect(await readdir(cache)).toEqual(['.mst-auth-cache-v1']);
    for (const directory of homes)
      expect(await realpath(join(directory, '.example-gateway'))).toBe(
        await realpath(cache)
      );
  });

  it('does not adopt, copy, or modify an existing credential store', async () => {
    await mkdir(cache, { mode: 0o700 });
    const file = join(cache, 'credentials.json');
    await writeFile(file, 'existing-test-fixture', { mode: 0o600 });
    await expect(
      linkAuthCacheDirectories(home, { '.example-gateway': cache })
    ).rejects.toThrow(/not an MST cache/);
    expect(await readFile(file, 'utf8')).toBe('existing-test-fixture');
    expect(await readdir(cache)).toEqual(['credentials.json']);
    expect(await readdir(home)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects public directories without changing their permissions',
    async () => {
      await mkdir(cache, { mode: 0o755 });
      await chmod(cache, 0o755);
      await expect(
        linkAuthCacheDirectories(home, { '.example-gateway': cache })
      ).rejects.toThrow(/private directory/);
      expect(statSync(cache).mode & 0o777).toBe(0o755);
      expect(await readdir(cache)).toEqual([]);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects non-writable private directories without changing permissions',
    async () => {
      await mkdir(cache, { mode: 0o700 });
      await chmod(cache, 0o500);
      await expect(
        linkAuthCacheDirectories(home, { '.example-gateway': cache })
      ).rejects.toThrow(/private directory/);
      expect(statSync(cache).mode & 0o777).toBe(0o500);
      expect(await readdir(cache)).toEqual([]);
    }
  );

  it.skipIf(process.getuid === undefined)(
    'rejects a foreign-owned cache without adopting it',
    async () => {
      const uid = process.getuid!();
      const getuid = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      try {
        await expect(
          linkAuthCacheDirectories(home, { '.example-gateway': cache })
        ).rejects.toThrow(/owned by the current user/);
        expect(await readdir(cache)).toEqual([]);
      } finally {
        getuid.mockRestore();
      }
    }
  );

  it('rejects a file instead of a cache directory', async () => {
    await writeFile(cache, 'keep-this-fixture');
    await expect(
      linkAuthCacheDirectories(home, { '.example-gateway': cache })
    ).rejects.toThrow();
    expect(await readFile(cache, 'utf8')).toBe('keep-this-fixture');
  });

  it('rejects a symlink used as the cache directory', async () => {
    const target = await mkdtemp(join(root, 'other-'));
    await symlink(
      target,
      cache,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(
      linkAuthCacheDirectories(home, { '.example-gateway': cache })
    ).rejects.toThrow(/private directory/);
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects a forged marker symlink', async () => {
    await mkdir(cache, { mode: 0o700 });
    const target = await mkdtemp(join(root, 'other-'));
    await symlink(
      target,
      join(cache, '.mst-auth-cache-v1'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(
      linkAuthCacheDirectories(home, { '.example-gateway': cache })
    ).rejects.toThrow(/private directory/);
    expect(await readdir(home)).toEqual([]);
  });

  it('rejects persistent state inside the trial home', async () => {
    await expect(
      linkAuthCacheDirectories(home, {
        '.example-gateway': join(await realpath(home), 'cache'),
      })
    ).rejects.toThrow(/separate from the trial home/);
  });

  it('rejects a cache containing the trial home', async () => {
    await expect(
      linkAuthCacheDirectories(home, { '.example-gateway': root })
    ).rejects.toThrow(/separate from the trial home/);
  });
});
