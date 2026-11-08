/**
 * How much of a Docker context a shard's container may use, and how many
 * containers fit on it at once. A context reports its memory and CPUs
 * (`docker info`); for a Colima VM or Docker Desktop that is the VM's size,
 * not the machine's. The run's shard count never changes with them: it
 * decides which shard a case is on, and run.json records it for `--resume`.
 * Capacity only decides how many shards run at a time.
 */
import type { ShardWork } from '../evalFrameworkTypes.js';

/** What a context has, as `docker info` reports it. */
export interface ContextCapacity {
  /** Bytes. */
  memory: number;
  cpus: number;
}

/** What one container may use: Docker's `--memory` and `--cpus`. */
export interface ContainerLimits {
  /** Bytes. Unset: no limit. */
  memory?: number;
  cpus?: number;
}

const GIB = 1024 ** 3;

/** Left for the Docker daemon and the context's own system. */
const CONTEXT_RESERVE = GIB;

/**
 * A grade container's memory when `memory` isn't set. A grade shard runs
 * judges, and an agentic judge's agent (Claude Code, Codex) is the most it
 * holds.
 */
export const DEFAULT_GRADE_MEMORY = 2 * GIB;

const MEMORY_UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: GIB,
};

/**
 * Bytes in Docker's memory syntax (`512m`, `8g`, `1.5g`, a plain number of
 * bytes), or undefined for anything else.
 */
export function parseMemory(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg]?)$/i.exec(text.trim());
  if (!match) return undefined;
  const bytes = Math.floor(
    Number(match[1]) * MEMORY_UNITS[match[2]!.toLowerCase()]!
  );
  return bytes > 0 ? bytes : undefined;
}

/** Bytes as `--memory` takes them, in whole MiB. */
export function memoryArg(bytes: number): string {
  return `${Math.max(1, Math.floor(bytes / 1024 ** 2))}m`;
}

/** Bytes for a person: `11.6 GiB`, `512 MiB`. */
export function formatMemory(bytes: number): string {
  return bytes >= GIB
    ? `${Number((bytes / GIB).toFixed(1))} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/** `docker info`'s `{{.MemTotal}} {{.NCPU}}`, or undefined if unreadable. */
export function parseDockerInfo(stdout: string): ContextCapacity | undefined {
  const [memory, cpus] = stdout.trim().split(/\s+/).map(Number);
  if (!memory || !cpus || !Number.isFinite(memory) || !Number.isFinite(cpus))
    return undefined;
  return { memory, cpus };
}

/** How shards of one kind use a context: each container's limits, and how many run at once. */
export interface ContextPlan {
  limits: ContainerLimits;
  slots: number;
  /** The plan in a line, for the run's log. */
  note: string;
}

/** What a context can give its containers: all but the reserve, and at least half. */
function spare(capacity: ContextCapacity): number {
  return Math.max(capacity.memory - CONTEXT_RESERVE, capacity.memory / 2);
}

/**
 * How shards of `work` use a context. A collect container is alone on its
 * context (Cowork's VM listens on a host-wide vsock port), so by default it
 * may use all the context can spare. Grade containers share the context: as
 * many run at once as their memory, and their CPUs when `cpus` is set, fit.
 * A context that can't hold one still runs one. `cpus` above the context's
 * CPU count is capped at it: Docker refuses to start a container that asks
 * for more CPUs than its context has.
 */
export function planContext(
  work: ShardWork,
  capacity: ContextCapacity | undefined,
  requested: ContainerLimits
): ContextPlan {
  const usable = capacity ? spare(capacity) : undefined;
  const memory =
    requested.memory ?? (work === 'grade' ? DEFAULT_GRADE_MEMORY : usable);
  const cpus =
    requested.cpus !== undefined && capacity
      ? Math.min(requested.cpus, capacity.cpus)
      : requested.cpus;
  const limits: ContainerLimits = {
    ...(memory !== undefined ? { memory } : {}),
    ...(cpus !== undefined ? { cpus } : {}),
  };
  const fit = capacity
    ? Math.min(
        memory !== undefined ? Math.floor(usable! / memory) : Infinity,
        limits.cpus !== undefined
          ? Math.floor(capacity.cpus / limits.cpus)
          : Infinity
      )
    : undefined;
  const slots = work === 'collect' ? 1 : Math.max(1, fit ?? 1);
  const each = [
    memory !== undefined ? formatMemory(memory) : 'no memory limit',
    ...(limits.cpus !== undefined ? [`${limits.cpus} CPUs`] : []),
  ].join(' and ');
  const has = capacity
    ? `${formatMemory(capacity.memory)} and ${capacity.cpus} CPUs`
    : "an unknown size (docker info didn't say)";
  const kind = work === 'collect' ? 'Cowork' : 'grade';
  const short = [
    ...(memory !== undefined && usable !== undefined && memory > usable
      ? [`more memory than it can spare (${formatMemory(usable)})`]
      : []),
    ...(requested.cpus !== undefined && cpus! < requested.cpus
      ? [`${requested.cpus} CPUs asked for, more than it has`]
      : []),
  ];
  return {
    limits,
    slots,
    note: `has ${has}: ${slots} ${kind} container${slots === 1 ? '' : 's'} at a time, ${each} each${
      short.length > 0 ? `; ${short.join('; ')}` : ''
    }`,
  };
}
