import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isolatedDesktopEnvironment,
  prepareIsolatedDesktopProfile,
} from '../../../../src/evals/externalHost/isolatedProfile.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('isolated desktop profiles', () => {
  it('creates private paths and a minimal environment without ambient secrets', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'isolated-profile-test-'));
    roots.push(parent);
    const profile = await prepareIsolatedDesktopProfile(
      join(parent, 'profile')
    );
    const env = isolatedDesktopEnvironment(profile, {
      CLAUDE_USER_DATA_DIR: profile.paths.userData,
      CLAUDE_CONFIG_DIR: profile.paths.config,
    });
    expect(env).toMatchObject({
      HOME: profile.paths.home,
      CLAUDE_USER_DATA_DIR: profile.paths.userData,
      CLAUDE_CONFIG_DIR: profile.paths.config,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('rejects noncanonical, public, and unsafe environment inputs', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'isolated-profile-test-'));
    roots.push(parent);
    const target = join(parent, 'target');
    const alias = join(parent, 'alias');
    const profile = await prepareIsolatedDesktopProfile(target);
    await symlink(target, alias);
    await expect(prepareIsolatedDesktopProfile(alias)).rejects.toThrow(
      /canonical|symlink/
    );
    await chmod(profile.paths.cache, 0o755);
    await expect(prepareIsolatedDesktopProfile(target)).rejects.toThrow(
      /not private/
    );
    expect(() =>
      isolatedDesktopEnvironment(profile, { NODE_OPTIONS: '--inspect' })
    ).toThrow(/Unsafe/);
    expect(() =>
      isolatedDesktopEnvironment(profile, { DYLD_INSERT_LIBRARIES: '/tmp/x' })
    ).toThrow(/Unsafe/);
  });
});
