/**
 * Shard containers: removal even when the run does not reach a shard's
 * `dispose`, so a stopped or crashed run leaves nothing holding a Docker
 * context's disk (a Cowork container unpacks a 10 GB VM).
 *
 * - Exiting, or SIGTERM / SIGHUP: every live container is removed
 *   synchronously before the process goes. (Ctrl-C stops the shards first,
 *   and their `dispose` removes them.)
 * - Killed outright (SIGKILL, a crash): each container is labeled with the
 *   machine and process that started it, and the next run on that machine
 *   removes containers whose process is gone.
 *
 * Kept containers (`dispose({ keep: true })`, for debugging) are renamed with
 * KEPT_SUFFIX and never swept.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';

export const RUN_LABEL = 'mst.run';
export const OWNER_HOST_LABEL = 'mst.owner.host';
export const OWNER_PID_LABEL = 'mst.owner.pid';
export const KEPT_SUFFIX = '-kept';
const SIGNALS = ['SIGTERM', 'SIGHUP'] as const;
/** How long the synchronous removal of one container may take at exit. */
const EXIT_REMOVE_TIMEOUT_MS = 30_000;

/** The Docker CLI. `MST_DOCKER` names another (for example `podman`). */
export function dockerCommand(): string {
  return process.env.MST_DOCKER || 'docker';
}

export function contextArgs(context: string | undefined): string[] {
  return context ? ['--context', context] : [];
}

/** `docker run` labels naming this process as the container's owner. */
export function ownerLabelArgs(
  owner: { host: string; pid: number } = {
    host: os.hostname(),
    pid: process.pid,
  }
): string[] {
  return [
    '--label',
    `${OWNER_HOST_LABEL}=${owner.host}`,
    '--label',
    `${OWNER_PID_LABEL}=${owner.pid}`,
  ];
}

const key = (context: string | undefined, name: string) =>
  `${context ?? ''}\u0000${name}`;
const live = new Map<string, { context: string | undefined; name: string }>();
let installed = false;

function removeLiveNow(): void {
  for (const { context, name } of live.values()) {
    try {
      spawnSync(
        dockerCommand(),
        [...contextArgs(context), 'rm', '--force', name],
        { stdio: 'ignore', timeout: EXIT_REMOVE_TIMEOUT_MS }
      );
    } catch {
      // Best effort: the process is going; the next run sweeps it.
    }
  }
  live.clear();
}

function onSignal(signal: NodeJS.Signals): void {
  removeLiveNow();
  uninstall();
  // Removing containers must not change how the process stops: with no other
  // handler, re-raise so the default action (exit by that signal) applies.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on('exit', removeLiveNow);
  for (const signal of SIGNALS) process.on(signal, onSignal);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  process.off('exit', removeLiveNow);
  for (const signal of SIGNALS) process.off(signal, onSignal);
}

/** A started container is this process's: removed if the run ends early. */
export function claimContainer(context: string | undefined, name: string) {
  live.set(key(context, name), { context, name });
  install();
}

/** The container was removed (or kept): stop guarding it. */
export function releaseContainer(context: string | undefined, name: string) {
  live.delete(key(context, name));
  if (live.size === 0) uninstall();
}

/** The containers this process guards, for tests. */
export function liveContainers(): string[] {
  return [...live.values()].map(({ name }) => name);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, as another user's process.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepResult {
  /** Containers removed: their owner process on this machine is gone. */
  removed: string[];
  /** MST containers without an owner (an older MST's): left, with a hint. */
  unowned: string[];
}

/**
 * Remove the MST shard containers on `context` whose owner process, on this
 * machine, is gone. Containers another machine started, kept containers and
 * this process's own are left alone.
 */
export async function sweepOrphanedContainers(
  context: string | undefined,
  docker: (
    args: readonly string[]
  ) => Promise<{ code: number; stdout: string }>,
  options: { host?: string; isRunning?: (pid: number) => boolean } = {}
): Promise<SweepResult> {
  const host = options.host ?? os.hostname();
  const isRunning = options.isRunning ?? running;
  const listed = await docker([
    'ps',
    '--all',
    '--filter',
    `label=${RUN_LABEL}`,
    '--format',
    `{{.Names}}\t{{.Label "${OWNER_HOST_LABEL}"}}\t{{.Label "${OWNER_PID_LABEL}"}}`,
  ]);
  const result: SweepResult = { removed: [], unowned: [] };
  if (listed.code !== 0) return result;
  for (const line of listed.stdout.split('\n')) {
    const [name, owner, pidText] = line.trim().split('\t');
    if (!name || name.endsWith(KEPT_SUFFIX) || live.has(key(context, name)))
      continue;
    if (!owner || !pidText) {
      result.unowned.push(name);
      continue;
    }
    const pid = Number(pidText);
    if (owner !== host || !Number.isInteger(pid) || pid <= 0) continue;
    if (isRunning(pid)) continue;
    const removed = await docker(['rm', '--force', name]);
    if (removed.code === 0) result.removed.push(name);
  }
  return result;
}
