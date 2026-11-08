/**
 * The key a run hashes its sensitive client option values with, the
 * `hmac:…` values in `run.json`.
 */
import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEY_FILE = 'option-key';
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** The eval's option key, and how to keep it for the eval's next runs. */
export interface OptionKey {
  key: Buffer;
  /**
   * Writes the key to the eval's directory, unless it came from there. Call
   * it when the run first writes its own files, so a run that stops before
   * then leaves nothing behind.
   */
  save(): Promise<void>;
}

/**
 * The eval's option key: one per eval directory, made by its first run that
 * writes anything. Two runs of the eval record the same option value as the
 * same hash, so its history can tell a setting stayed the same; without the
 * key, nobody can test a guess against a hash. It stays beside the eval's
 * runs, in no run and no result store, so runs collected elsewhere hash
 * with another key and never match these.
 */
export async function optionKey(evalDirectory: string): Promise<OptionKey> {
  const file = path.join(evalDirectory, KEY_FILE);
  const existing = await readKey(file);
  if (existing) return { key: existing, save: async () => {} };
  const key = randomBytes(32);
  let saved = false;
  return {
    key,
    async save() {
      if (saved) return;
      saved = true;
      await mkdir(evalDirectory, { recursive: true });
      // Written whole, then linked into place, so no run reads a partial
      // key. When another run saved one first, it stays: this run's hashes
      // then match neither, which only starts a new era.
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
      await writeFile(temporary, key.toString('hex'), { mode: 0o600 });
      try {
        await link(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

async function readKey(file: string): Promise<Buffer | undefined> {
  let text: string;
  try {
    text = (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!KEY_PATTERN.test(text))
    throw new Error(`${file} isn't an option key: delete it.`);
  return Buffer.from(text, 'hex');
}
