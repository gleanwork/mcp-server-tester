import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { optionKey } from './optionKey.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function evalDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'option-key-'));
  dirs.push(dir);
  return path.join(dir, 'eval');
}

describe('optionKey', () => {
  it('writes nothing until saved, then is the same for the next runs, readable only by its owner', async () => {
    const dir = await evalDirectory();
    const first = await optionKey(dir);
    expect(first.key).toHaveLength(32);
    await expect(fs.stat(dir)).rejects.toThrow();
    await first.save();
    await first.save();
    const next = await optionKey(dir);
    expect(next.key).toEqual(first.key);
    await next.save();
    const stat = await fs.stat(path.join(dir, 'option-key'));
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    // Another eval has its own.
    expect((await optionKey(await evalDirectory())).key).not.toEqual(first.key);
  });

  it('keeps the first key saved when runs start at once, with nothing left behind', async () => {
    const dir = await evalDirectory();
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => optionKey(dir))
    );
    await keys[3]!.save();
    await Promise.all(keys.map((key) => key.save()));
    expect((await optionKey(dir)).key).toEqual(keys[3]!.key);
    expect(await fs.readdir(dir)).toEqual(['option-key']);
  });

  it('takes MST_OPTION_KEY when set, and writes no file', async () => {
    const dir = await evalDirectory();
    const hex = 'ab'.repeat(32);
    vi.stubEnv('MST_OPTION_KEY', hex);
    try {
      const key = await optionKey(dir);
      expect(key.key.toString('hex')).toBe(hex);
      await key.save();
      await expect(fs.stat(dir)).rejects.toThrow();
      // The fingerprint names the key, not its bytes.
      expect(key.id).toMatch(/^[0-9a-f]{16}$/);
      expect(hex).not.toContain(key.id);
      vi.stubEnv('MST_OPTION_KEY', 'short');
      await expect(optionKey(dir)).rejects.toThrow(/64 hex digits/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('saves again after a save that failed', async () => {
    const root = await evalDirectory();
    const key = await optionKey(path.join(root, 'eval'));
    // The eval directory's place is a file, so the first save fails.
    await fs.writeFile(root, 'in the way');
    await expect(key.save()).rejects.toThrow();
    await fs.rm(root);
    await key.save();
    expect((await optionKey(path.join(root, 'eval'))).key).toEqual(key.key);
  });

  it("refuses a file that isn't a key, saying to delete it", async () => {
    const dir = await evalDirectory();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'option-key'), 'not a key');
    await expect(optionKey(dir)).rejects.toThrow(
      /option-key isn't an option key: delete it/
    );
  });
});
