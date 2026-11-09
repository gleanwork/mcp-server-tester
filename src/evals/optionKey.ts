/**
 * The key a run hashes its sensitive client option values with, the
 * `hmac:…` values in `run.json`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEY_FILE = 'option-key';
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** The environment variable that gives the key, for machines that don't keep one. */
const OPTION_KEY_ENV = 'MST_OPTION_KEY';

/** The eval's option key, and how to keep it for the eval's next runs. */
export interface OptionKey {
  key: Buffer;
  /**
   * A fingerprint of the key, which run.json records so history can tell
   * whether two runs' hashes are comparable. It says nothing about the key.
   */
  id: string;
  /**
   * Writes the key to the eval's directory, unless it came from there or
   * from `MST_OPTION_KEY`. Call it when the run first writes its own files,
   * so a run that stops before then leaves nothing behind.
   */
  save(): Promise<void>;
}

/**
 * The eval's option key: `MST_OPTION_KEY` (64 hex digits) when set, else
 * one per eval directory, made by its first run that writes anything. Two
 * runs of the eval record the same option value as the same hash, so its
 * history can tell a setting stayed the same; without the key, nobody can
 * test a guess against a hash. It stays beside the eval's runs, in no run
 * and no result store, so runs collected elsewhere hash with another key
 * and never match these, unless each machine gets the same `MST_OPTION_KEY`.
 */
export async function optionKey(evalDirectory: string): Promise<OptionKey> {
  const fromEnv = process.env[OPTION_KEY_ENV]?.trim();
  if (fromEnv) {
    if (!KEY_PATTERN.test(fromEnv))
      throw new Error(
        `${OPTION_KEY_ENV} isn't an option key: it must be 64 hex digits, as \`openssl rand -hex 32\` prints.`
      );
    return keyed(Buffer.from(fromEnv, 'hex'), async () => {});
  }
  const file = path.join(evalDirectory, KEY_FILE);
  const existing = await readKey(file);
  if (existing) return keyed(existing, async () => {});
  const key = randomBytes(32);
  let saved = false;
  return keyed(key, async () => {
    if (saved) return;
    await mkdir(evalDirectory, { recursive: true });
    // Written whole, then linked into place, so no run reads a partial key.
    // When another run saved one first, it stays: this run's hashes then
    // match neither, which only starts a new era.
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
    await writeFile(temporary, key.toString('hex'), { mode: 0o600 });
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await rm(temporary, { force: true });
    }
    saved = true;
  });
}

function keyed(key: Buffer, save: () => Promise<void>): OptionKey {
  const id = createHash('sha256')
    .update('mst option key\0')
    .update(key)
    .digest('hex')
    .slice(0, 16);
  return { key, id, save };
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
