import { lstat, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  leaseCodexProfile,
  lockCodexProfileOperation,
  prepareCodexProfile,
} from '../../../../src/evals/codex/profile.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it('serializes profile state transitions and leaves stale guards fail-closed', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'codex-profile-operation-'))
  );
  roots.push(root);
  const profile = await prepareCodexProfile(join(root, 'profile'));
  const operation = await lockCodexProfileOperation(profile);

  await expect(lockCodexProfileOperation(profile)).rejects.toThrow(
    /active|quarantined/i
  );
  await expect(leaseCodexProfile(profile, '/test/Codex')).rejects.toThrow(
    /active|quarantined/i
  );
  await expect(lstat(join(profile.root, '.lease'))).rejects.toMatchObject({
    code: 'ENOENT',
  });

  await operation.release();
  await mkdir(join(profile.root, '.profile-operation'), { mode: 0o700 });
  await expect(leaseCodexProfile(profile, '/test/Codex')).rejects.toThrow(
    /active|quarantined/i
  );
  await expect(lstat(join(profile.root, '.lease'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
