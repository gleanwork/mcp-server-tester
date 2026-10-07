/**
 * `mst/credential-store/local`: grants as private files on this machine.
 *
 * `<root>/<key>.json` (0600) in a 0700 directory, written atomically
 * (temporary file, then rename). A lock file serializes refreshes across
 * processes: a rotating refresh token must never be redeemed twice.
 */
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { CredentialStore, StoredGrant } from './types.js';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 100;

const StoredGrantSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(['oauth', 'token']),
    tokenEndpoint: z.string().url().optional(),
    revocationEndpoint: z.string().url().optional(),
    clientId: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    accessTokenExpiresAt: z.string().optional(),
    scopes: z.array(z.string()),
    resource: z.string(),
    signedInAt: z.string(),
  })
  .strict() satisfies z.ZodType<StoredGrant>;

/** The default directory: `$MST_CREDENTIALS_DIR`, else `~/.mcp-server-tester/grants`. */
export function defaultGrantsDirectory(
  env: Record<string, string | undefined> = process.env
): string {
  return (
    env.MST_CREDENTIALS_DIR || join(homedir(), '.mcp-server-tester', 'grants')
  );
}

function checkKey(key: string): void {
  if (!KEY.test(key))
    throw new Error(`Invalid grant key: ${JSON.stringify(key)}`);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${directory} is not a directory.`);
  if (process.getuid && info.uid !== process.getuid())
    throw new Error(`${directory} is not owned by the current user.`);
  if (info.mode & 0o077) await chmod(directory, 0o700);
}

/** A credential store in a local directory. */
export function localCredentialStore(
  directory: string = defaultGrantsDirectory()
): CredentialStore {
  const file = (key: string) => join(directory, `${key}.json`);

  async function acquire(key: string): Promise<() => Promise<void>> {
    await ensurePrivateDirectory(directory);
    const lock = join(directory, `${key}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lock, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        return async () => {
          await unlink(lock).catch(() => {});
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A lock left by a crashed process expires.
        const info = await stat(lock).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lock).catch(() => {});
          continue;
        }
        if (Date.now() > deadline)
          throw new Error(
            `Timed out waiting for another MST process to finish refreshing ${key}.`
          );
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
  }

  return {
    describe: () => directory,
    async get(key) {
      checkKey(key);
      let raw: string;
      try {
        const info = await lstat(file(key));
        if (!info.isFile()) throw new Error(`${file(key)} is not a file.`);
        if (info.mode & 0o077)
          throw new Error(
            `${file(key)} is readable by other users; run \`mst auth revoke\` and sign in again.`
          );
        raw = await readFile(file(key), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      }
      const parsed = StoredGrantSchema.safeParse(JSON.parse(raw));
      if (!parsed.success)
        throw new Error(`${file(key)} is not a valid grant; sign in again.`);
      return parsed.data;
    },
    async put(key, grant) {
      checkKey(key);
      await ensurePrivateDirectory(directory);
      const value = StoredGrantSchema.parse(grant);
      const temporary = join(directory, `.${key}.${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, file(key));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async delete(key) {
      checkKey(key);
      await rm(file(key), { force: true });
    },
    async withLock(key, fn) {
      checkKey(key);
      const release = await acquire(key);
      try {
        return await fn();
      } finally {
        await release();
      }
    },
  };
}
