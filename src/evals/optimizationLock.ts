/**
 * One process at a time steps a stored tool optimization: a `lock` file in
 * its directory, created only when absent, names the process that holds it.
 * Without it, two processes that each read optimization.json, ran a round and
 * wrote it back would lose one of the rounds (or run one twice).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface LockHolder {
  pid: number;
  host: string;
  since: string;
  /** What the holder is doing, for the message another process prints. */
  step: string;
}

function isLockHolder(value: unknown): value is LockHolder {
  const holder = value as Partial<LockHolder> | null;
  return (
    typeof holder?.pid === 'number' &&
    typeof holder.host === 'string' &&
    typeof holder.since === 'string'
  );
}

/** Whether a process on this machine is still running. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readHolder(file: string): Promise<LockHolder | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return isLockHolder(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `fn` holding the optimization's lock. A lock left by a process on
 * this machine that no longer runs is taken over; any other lock fails with
 * who holds it and how to clear it.
 */
export async function withOptimizationLock<T>(
  directory: string,
  id: string,
  step: string,
  fn: () => Promise<T>
): Promise<T> {
  const file = path.join(directory, 'lock');
  const holder: LockHolder = {
    pid: process.pid,
    host: os.hostname(),
    since: new Date().toISOString(),
    step,
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.writeFile(file, `${JSON.stringify(holder)}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await readHolder(file);
      const stale =
        current !== undefined &&
        current.host === holder.host &&
        !isRunning(current.pid);
      if (stale && attempt === 0) {
        await fs.rm(file, { force: true });
        continue;
      }
      throw new Error(
        current
          ? `Optimization ${id} is in use: process ${current.pid} on ${current.host} started to ${current.step} at ${current.since}. Wait for it to finish. If that process is gone, delete ${file}.`
          : `Optimization ${id} is in use (${file} exists). If no process is stepping it, delete that file.`
      );
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(file, { force: true });
  }
}
