import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing an existing path: ${path}`);
}

export async function createPrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await syncDirectory(dirname(path));
}

export async function writePrivateFile(
  path: string,
  value: string | Uint8Array
): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  // Sync the directory entry too: an armed receipt must survive before submit.
  await syncDirectory(dirname(path));
}

export async function writePrivateJson(
  path: string,
  value: unknown
): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
