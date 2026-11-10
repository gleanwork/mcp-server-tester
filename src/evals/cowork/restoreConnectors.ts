import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError } from '../../utils/describeError.js';
import { claimDesktopLease } from '../desktopBatch.js';
import { restoreClaudeAiConnectors } from './claudeAi.js';
import { coworkDesktopLease } from './desktopLease.js';

export interface RestoreCoworkConnectorsOptions {
  recoverStaleLock?: boolean;
}

/**
 * Reclaim only a stopped local process's lease, while holding the separate
 * recovery guard. Normal evals do not take that guard: the caller must still
 * claim the main lease after this unlink, before reading or changing settings.
 */
async function removeStoppedOwnerLease(path: string): Promise<void> {
  const inspect = (reason: string) =>
    new Error(
      `Cannot recover Cowork desktop lock ${path}: ${reason}. Inspect the lock and its owner manually; no connector settings were changed.`
    );
  // A symlink, malformed record or an unreadable owner is not proof of death.
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: unknown) => {
    throw new Error(inspect('its owner could not be read safely').message, {
      cause: error,
    });
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 4096)
      throw inspect('its owner record is not a small regular file');
    let owner: unknown;
    try {
      owner = JSON.parse(await handle.readFile('utf8'));
    } catch (error) {
      throw new Error(inspect('its owner record is invalid').message, {
        cause: error,
      });
    }
    if (
      !owner ||
      typeof owner !== 'object' ||
      !('pid' in owner) ||
      typeof owner.pid !== 'number' ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.pid > 2_147_483_647 ||
      !('startedAt' in owner) ||
      typeof owner.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(owner.startedAt))
    )
      throw inspect('its owner PID or start time is unknown');
    let dead = false;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (!dead)
      throw inspect(`PID ${owner.pid} is live or its status is unknown`);
    const current = await lstat(path);
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs
    )
      throw inspect('the lock changed during inspection');
    await unlink(path);
  } finally {
    await handle.close();
  }
}

/** Restore an existing journal only; never prepare, launch or submit a task. */
export async function restoreCoworkConnectors(
  options: RestoreCoworkConnectorsOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (process.platform !== 'darwin')
    throw new Error('Cowork connector restoration runs on macOS only.');

  const target = { name: 'Cowork', lease: coworkDesktopLease('') };
  const path = join(target.lease.directory, target.lease.file);
  const recoveryTarget = {
    name: 'Cowork connector recovery',
    lease: { ...target.lease, file: `${target.lease.file}.recovery` },
  };
  const recoveryPath = join(
    recoveryTarget.lease.directory,
    recoveryTarget.lease.file
  );
  // Never recursively reclaim this guard, even with --recover-stale-lock.
  // A stopped/unknown recovery owner needs human inspection, not another
  // command racing it to remove the main lease.
  const guard = await claimDesktopLease(recoveryTarget).catch(
    (error: unknown) => {
      throw new Error(
        `Cowork connector recovery is guarded by ${recoveryPath}. Another recovery may be active. Inspect that guard and its owner manually before removing it; --recover-stale-lock does not reclaim recovery guards.`,
        { cause: error }
      );
    }
  );
  let desktop: Awaited<ReturnType<typeof claimDesktopLease>> | undefined;
  let restored = false;
  let succeeded = false;
  const errors: unknown[] = [];
  try {
    try {
      desktop = await claimDesktopLease(target);
    } catch (error) {
      if (!options.recoverStaleLock)
        throw new Error(
          `Cowork desktop is locked at ${path}. Stop its owner and inspect the lock; use --recover-stale-lock only for a provably stopped local owner.`,
          { cause: error }
        );
      await removeStoppedOwnerLease(path);
      // If a normal eval won this race, abort. Never inspect/unlink its new
      // lease and never enter account restoration without owning the desktop.
      desktop = await claimDesktopLease(target);
    }
    try {
      restored = await restoreClaudeAiConnectors(env);
      succeeded = true;
    } catch (error) {
      throw new Error(
        `Cowork connector restoration failed; the recovery journal and desktop lock ${path} are retained for inspection: ${describeError(error)}`,
        { cause: error }
      );
    }
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await desktop?.release(!succeeded);
    } catch (error) {
      errors.push(error);
    }
    try {
      await guard.release(false);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      `Cowork connector recovery or lock cleanup failed; inspect the recovery journal and desktop locks before retrying: ${errors.map(describeError).join('; ')}`
    );
  return restored;
}
