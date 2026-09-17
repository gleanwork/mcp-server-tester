import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeMacCoworkProfile } from './macTransaction.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('initializeMacCoworkProfile', () => {
  it('creates a minimal empty profile atomically when it is missing', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const root = await mkdtemp(join(tmpdir(), 'mst-cowork-profile-'));
    roots.push(root);
    const profileDirectory = join(root, 'configLibrary');

    await expect(initializeMacCoworkProfile(profileDirectory)).resolves.toEqual(
      {
        profileDirectory,
        created: true,
      }
    );
    const meta = JSON.parse(
      await readFile(join(profileDirectory, '_meta.json'), 'utf8')
    );
    expect(meta.entries).toHaveLength(1);
    expect(
      await readFile(join(profileDirectory, `${meta.appliedId}.json`), 'utf8')
    ).toBe('{}\n');
  });

  it('does not modify an existing valid empty profile', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const root = await mkdtemp(join(tmpdir(), 'mst-cowork-profile-'));
    roots.push(root);
    const profileDirectory = join(root, 'configLibrary');
    await fs.mkdir(profileDirectory, { mode: 0o700 });
    const id = '11111111-2222-3333-4444-555555555555';
    await fs.writeFile(
      join(profileDirectory, '_meta.json'),
      JSON.stringify({ appliedId: id, entries: [{ id, name: 'Original' }] }) +
        '\n'
    );
    await fs.writeFile(join(profileDirectory, `${id}.json`), '{}\n');

    await expect(initializeMacCoworkProfile(profileDirectory)).resolves.toEqual(
      {
        profileDirectory,
        created: false,
      }
    );
  });

  it('refuses to modify an existing non-empty profile', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const root = await mkdtemp(join(tmpdir(), 'mst-cowork-profile-'));
    roots.push(root);
    const profileDirectory = join(root, 'configLibrary');
    await fs.mkdir(profileDirectory, { mode: 0o700 });
    const id = '11111111-2222-3333-4444-555555555555';
    await fs.writeFile(
      join(profileDirectory, '_meta.json'),
      JSON.stringify({ appliedId: id, entries: [{ id, name: 'Original' }] }) +
        '\n'
    );
    await fs.writeFile(
      join(profileDirectory, `${id}.json`),
      '{"managedMcpServers":[]}\n'
    );

    await expect(initializeMacCoworkProfile(profileDirectory)).rejects.toThrow(
      'No files were changed'
    );
  });
});
