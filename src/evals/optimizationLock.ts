/**
 * One process at a time steps a stored tool optimization: a `lock` file in
 * its directory, created only when absent, names the process that holds it.
 * Without it, two processes that each read optimization.json, ran a round and
 * wrote it back would lose one of the rounds (or run one twice).
 *
 * Only two things remove the lock: its holder, when it finishes, and a
 * process taking over a dead holder's lock. A takeover holds a second file,
 * `lock.takeover`, also created only when absent, and removes the lock only
 * if it still names the dead holder it read. So two processes that both find
 * the same dead holder can't both take over, and neither removes a lock that
 * another process just created.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface LockHolder {
  pid: number;
  host: string;
  since: string;
  /** What the holder is doing, for the message another process prints. */
  step: string;
  /** Tells this holder from another in the same process. Older locks have none. */
  token?: string;
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

function sameHolder(a: LockHolder, b: LockHolder): boolean {
  return (
    a.pid === b.pid &&
    a.host === b.host &&
    a.since === b.since &&
    a.token === b.token
  );
}

/** Creates `file` naming `holder`, or returns false when it exists. */
async function create(file: string, holder: LockHolder): Promise<boolean> {
  try {
    await fs.writeFile(file, `${JSON.stringify(holder)}\n`, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false
  );
}

/**
 * Removes the lock `dead` left, holding `lock.takeover` while it checks the
 * lock still names `dead`. False when another process is taking it over or
 * already did.
 */
async function clearDeadHolder(
  file: string,
  dead: LockHolder,
  holder: LockHolder
): Promise<boolean> {
  const guard = `${file}.takeover`;
  if (!(await create(guard, holder))) return false;
  try {
    const current = await readHolder(file);
    if (current === undefined || !sameHolder(current, dead)) return false;
    await fs.rm(file, { force: true });
    return true;
  } finally {
    await fs.rm(guard, { force: true });
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
    token: randomUUID(),
  };
  await acquire(file, id, holder);
  try {
    return await fn();
  } finally {
    // Only this holder's lock: never one another process took over since.
    const current = await readHolder(file);
    if (current !== undefined && sameHolder(current, holder))
      await fs.rm(file, { force: true });
  }
}

async function acquire(
  file: string,
  id: string,
  holder: LockHolder
): Promise<void> {
  // A few tries: the lock can be released, or a dead holder's cleared,
  // between this process's create and its read.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await create(file, holder)) return;
    const current = await readHolder(file);
    if (current === undefined) {
      if (await exists(file)) break;
      continue;
    }
    const dead = current.host === holder.host && !isRunning(current.pid);
    if (!dead) throw inUse(id, file, current);
    if (await clearDeadHolder(file, current, holder)) continue;
    // Another process is taking it over, or took it over: see who holds it now.
    const now = await readHolder(file);
    if (now !== undefined && !sameHolder(now, current))
      throw inUse(id, file, now);
    if (now === undefined && !(await exists(file))) continue;
    throw new Error(
      `Optimization ${id} is in use: process ${current.pid}, which held it, is gone, and another process is taking it over. Try again. If no process is stepping it, delete ${file} and ${file}.takeover.`
    );
  }
  const current = await readHolder(file);
  throw current
    ? inUse(id, file, current)
    : new Error(
        `Optimization ${id} is in use (${file} exists). If no process is stepping it, delete that file.`
      );
}

function inUse(id: string, file: string, holder: LockHolder): Error {
  return new Error(
    `Optimization ${id} is in use: process ${holder.pid} on ${holder.host} started to ${holder.step} at ${holder.since}. Wait for it to finish. If that process is gone, delete ${file}.`
  );
}
