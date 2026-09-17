import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { getMacCoworkController } from './macController.js';
import { restoreMacCoworkSettings } from './macTransaction.js';

const Receipt = z
  .object({
    version: z.literal(1),
    nonce: z.string().uuid(),
    pid: z.number().int().positive(),
    profileDirectory: z.string(),
    stagingDirectory: z.string(),
    wasRunning: z.boolean(),
  })
  .strict();
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function privateFile(file: string): Promise<Buffer> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > 1024 * 1024
    )
      throw new Error('Recovery metadata is not a private owned regular file.');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export function assertStoppedOwner(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new Error(
      'Cannot confirm the previous MST process has stopped; recovery refused.'
    );
  }
  throw new Error(
    'The previous MST process is still running; recovery refused.'
  );
}
/** Explicit operator recovery only. Never expire/steal a lease during ordinary runs. */
export async function recoverMacCoworkSession(): Promise<void> {
  if (process.platform !== 'darwin')
    throw new Error('Cowork recovery requires macOS.');
  const profile = join(
    homedir(),
    'Library/Application Support/Claude-3p/configLibrary'
  );
  const lease = join(profile, '.mst-session-lock');
  const transaction = join(profile, '.mst-setup-lock');
  const gate = join(profile, '.mst-recovery-lock');
  const receiptPath = join(lease, 'session.json');
  if (!(await exists(lease))) {
    if (await exists(transaction))
      throw new Error(
        'Transaction exists without a session receipt; explicit transaction recovery is required.'
      );
    return;
  }
  const leaseInfo = await lstat(lease);
  if (
    !leaseInfo.isDirectory() ||
    leaseInfo.isSymbolicLink() ||
    leaseInfo.uid !== process.getuid?.() ||
    leaseInfo.mode & 0o077
  )
    throw new Error('Recovery lease is not a private owned directory.');
  const bytes = await privateFile(receiptPath);
  const receipt = Receipt.parse(JSON.parse(bytes.toString('utf8')));
  if (receipt.profileDirectory !== profile)
    throw new Error('Recovery profile mismatch.');
  assertStoppedOwner(receipt.pid);
  await mkdir(gate, { mode: 0o700 });
  const verifyLease = async () => {
    const current = await lstat(lease);
    if (
      current.dev !== leaseInfo.dev ||
      current.ino !== leaseInfo.ino ||
      !(await privateFile(receiptPath)).equals(bytes) ||
      (await readdir(lease)).join() !== 'session.json'
    )
      throw new Error('Recovery lease changed; refusing cleanup.');
    assertStoppedOwner(receipt.pid);
  };
  try {
    await verifyLease();
    const hasTransaction = await exists(transaction);
    if (hasTransaction) {
      const journal = JSON.parse(
        (await privateFile(join(transaction, 'journal.json'))).toString('utf8')
      ) as { directory?: string };
      if (journal.directory !== receipt.stagingDirectory)
        throw new Error('Recovery staging mismatch.');
    } else if (await exists(receipt.stagingDirectory))
      throw new Error(
        'Staging exists without its transaction; recovery refused.'
      );
    const controller = await getMacCoworkController();
    if ((await controller.state()).running) await controller.stop();
    if ((await controller.state()).running)
      throw new Error('Claude did not stop; recovery refused.');
    await verifyLease();
    if (hasTransaction) await restoreMacCoworkSettings(profile);
    if ((await exists(transaction)) || (await exists(receipt.stagingDirectory)))
      throw new Error('Recovery state remains; lease retained.');
    if (receipt.wasRunning) await controller.start();
    if ((await controller.state()).running !== receipt.wasRunning)
      throw new Error(
        'Could not restore prior Claude running state; lease retained.'
      );
    await verifyLease();
    await unlink(receiptPath);
    try {
      await rmdir(lease);
    } catch (error) {
      const remaining = await lstat(lease);
      if (
        remaining.dev === leaseInfo.dev &&
        remaining.ino === leaseInfo.ino &&
        remaining.isDirectory()
      ) {
        await writeFile(receiptPath, bytes, { mode: 0o600, flag: 'wx' });
      }
      throw error;
    }
  } finally {
    await rmdir(gate);
  }
}
