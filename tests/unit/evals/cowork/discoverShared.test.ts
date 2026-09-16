import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSharedCoworkDataDir,
  matchesExactFixtureBytes,
  matchesFixtureInstallation,
} from '../../../manual/cowork/discoverShared.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('shared Cowork fixture discovery', () => {
  it('matches each exact generated label and run without a duplicated desktop segment', () => {
    const runId = '48ab9ffc-f5e6-473d-855a-e7e638d12de1';
    expect(
      matchesFixtureInstallation(
        `local.mcpb.mcp-server-tester.mcp-server-tester-desktop-records-${runId}`,
        'desktop-records',
        runId
      )
    ).toBe(true);
    expect(
      matchesFixtureInstallation(
        `local.mcpb.mcp-server-tester.mcp-server-tester-desktop-decoy-${runId}`,
        'desktop-records',
        runId
      )
    ).toBe(false);
    expect(
      matchesFixtureInstallation(
        `mcp-server-tester-desktop-desktop-records-${runId}`,
        'desktop-records',
        runId
      )
    ).toBe(false);
  });

  it('requires byte-identical installed fixture sources', () => {
    const expected = Buffer.from('{"version":1,"seed":{"runId":"run"}}');
    expect(matchesExactFixtureBytes(Buffer.from(expected), expected)).toBe(
      true
    );
    expect(
      matchesExactFixtureBytes(
        Buffer.from('{"version": 1,"seed":{"runId":"run"}}'),
        expected
      )
    ).toBe(false);
    expect(
      matchesExactFixtureBytes(
        Buffer.from('{"seed":{"runId":"run"},"version":1}'),
        expected
      )
    ).toBe(false);
  });

  it('accepts only the canonical account directory under prepared app roots', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cowork-discovery-test-'));
    roots.push(parent);
    const canonicalParent = await realpath(parent);
    const profileRoot = join(canonicalParent, 'profile');
    const userDataPath = join(
      profileRoot,
      'home',
      'Library',
      'Application Support',
      'Claude'
    );
    const accountId = '48ab9ffc-f5e6-473d-855a-e7e638d12de1';
    const organizationId = 'a62f5778-3218-4dcf-986a-d960bd9e4381';
    const dataDir = join(
      userDataPath,
      'local-agent-mode-sessions',
      accountId,
      organizationId
    );
    await mkdir(dataDir, { recursive: true });
    await expect(
      assertSharedCoworkDataDir(dataDir, userDataPath, profileRoot)
    ).resolves.toBe(dataDir);

    const outsideAccount = join(canonicalParent, 'outside', accountId);
    const outsideDataDir = join(outsideAccount, organizationId);
    await mkdir(outsideDataDir, { recursive: true });
    await expect(
      assertSharedCoworkDataDir(outsideDataDir, userDataPath, profileRoot)
    ).rejects.toThrow(/escaped/);

    const linkedAccountId = 'edcc144f-9d9f-4479-a7fd-f78f791d13c4';
    const linkedAccount = join(
      userDataPath,
      'local-agent-mode-sessions',
      linkedAccountId
    );
    await symlink(outsideAccount, linkedAccount);
    await expect(
      assertSharedCoworkDataDir(
        join(linkedAccount, organizationId),
        userDataPath,
        profileRoot
      )
    ).rejects.toThrow(/symbolic links/);

    await expect(
      assertSharedCoworkDataDir(
        `${dataDir}/../${organizationId}`,
        userDataPath,
        profileRoot
      )
    ).rejects.toThrow(/canonical absolute syntax/);
  });
});
