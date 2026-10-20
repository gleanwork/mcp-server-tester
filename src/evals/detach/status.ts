/**
 * Detached runs (ADR 0007): the plan a coordinator machine runs, and the
 * status it keeps in the result store, where `mst runs` reads it.
 *
 * ```text
 * <eval name>/detached/<id>/status.json   rewritten at least once a minute
 * <eval name>/detached/<id>/log.txt       the coordinator's output
 * <eval name>/detached/<id>/cancel        written by `mst runs cancel`
 * ```
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { RunStore } from '../runStore.js';

/** A coordinator heartbeat older than this means the coordinator is gone. */
const LOST_AFTER_MS = 5 * 60 * 1000;

/** How a detached run's coordinator runs it: written to `detach.json`. */
export const DetachPlanSchema = z.object({
  format: z.literal(1),
  id: z.string(),
  evalName: z.string(),
  /** `mst run` or `mst grade`. */
  command: z.enum(['run', 'grade']),
  /** The eval config's file name in the bundle. */
  config: z.string(),
  /** `mst grade`'s run, or the run `mst run --resume` completes. */
  run: z.string().optional(),
  /** `mst run --resume`: complete `run` instead of starting a run. */
  resume: z.boolean().optional(),
  /** The environment, its `--env-option`s, and the grade's, if they differ. */
  env: z.string(),
  envOptions: z.array(z.string()),
  gradeEnvOptions: z.array(z.string()).optional(),
  /** `--results`, when given; else the eval config's store. */
  results: z.string().optional(),
  /** `--store`: a credential store the coordinator machine reaches. */
  store: z.string().optional(),
  /** `mst run`'s selection and report flags, passed through. */
  runArgs: z.array(z.string()),
  /** Collect without grading on the coordinator (`--no-grade` or `--grade-env`). */
  noGrade: z.boolean(),
  /** After collecting, grade in the environment (`--grade-env`). */
  gradeEnv: z.boolean(),
  /** How many times a partial run is resumed before grading. */
  resumes: z.number().int().nonnegative(),
  /** Whether the coordinator gets a secrets file over its channel. */
  secrets: z.boolean(),
  /** What the coordinator runs on its machine at the end. */
  finish: z.array(z.string()).optional(),
  createdAt: z.string(),
});
export type DetachPlan = z.infer<typeof DetachPlanSchema>;

const DETACH_STATES = [
  'starting',
  'running',
  'done',
  'failed',
  'cancelled',
] as const;

const DetachStatusSchema = z.object({
  format: z.literal(1),
  id: z.string(),
  evalName: z.string(),
  command: z.enum(['run', 'grade']),
  state: z.enum(DETACH_STATES),
  /** What the coordinator is doing: collecting, resuming or grading. */
  phase: z.enum(['collect', 'resume', 'grade']).optional(),
  machine: z.string(),
  env: z.string(),
  createdAt: z.string(),
  /** The coordinator's last heartbeat. */
  updatedAt: z.string(),
  endedAt: z.string().optional(),
  /** The run it collected, and the regrade of it, once known. */
  runId: z.string().optional(),
  gradedRunId: z.string().optional(),
  /** Trials collected and results graded so far. */
  collected: z.number().int().nonnegative(),
  graded: z.number().int().nonnegative(),
  /** Trials the run was still missing when it ended. */
  missing: z.boolean().optional(),
  /** Why it failed. */
  error: z.string().optional(),
  /** The coordinator's last lines of output. */
  lines: z.array(z.string()),
});
export type DetachStatus = z.infer<typeof DetachStatusSchema>;

/** A detached run's id: `d` and a UTC timestamp, then 6 hex characters. */
export function newDetachId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `d${stamp}-${randomBytes(3).toString('hex')}`;
}

const DETACH_ID = /^d\d{8}T\d{6}Z-[0-9a-f]{6}$/;

function prefix(evalName: string): string {
  return `${evalName}/detached/`;
}

export function detachKeys(evalName: string, id: string) {
  if (!DETACH_ID.test(id)) throw new Error(`"${id}" isn't a detached run id.`);
  const base = `${prefix(evalName)}${id}/`;
  return {
    status: `${base}status.json`,
    log: `${base}log.txt`,
    cancel: `${base}cancel`,
  };
}

export async function writeStatus(
  store: RunStore,
  status: DetachStatus
): Promise<void> {
  await store.put(
    detachKeys(status.evalName, status.id).status,
    `${JSON.stringify(status, null, 2)}\n`
  );
}

export async function readStatus(
  store: RunStore,
  evalName: string,
  id: string
): Promise<DetachStatus | undefined> {
  const bytes = await store.get(detachKeys(evalName, id).status);
  if (!bytes) return undefined;
  return DetachStatusSchema.parse(
    JSON.parse(Buffer.from(bytes).toString('utf8'))
  );
}

/** Every detached run of the eval in the store, newest first. */
export async function listDetachIds(
  store: RunStore,
  evalName: string
): Promise<string[]> {
  const keys = await store.list(prefix(evalName), { shallow: true });
  return keys
    .map((key) => key.slice(prefix(evalName).length).replace(/\/$/, ''))
    .filter((id) => DETACH_ID.test(id))
    .sort()
    .reverse();
}

/** The detached run `ref` names: its id, or an end of it (`3fa9c1`). */
export async function findDetachId(
  store: RunStore,
  evalName: string,
  ref: string
): Promise<string> {
  if (DETACH_ID.test(ref)) return ref;
  const ids = (await listDetachIds(store, evalName)).filter((id) =>
    id.endsWith(ref)
  );
  if (ids.length === 1) return ids[0]!;
  throw new Error(
    ids.length === 0
      ? `No detached run of ${evalName} matches "${ref}" in ${store.location}.`
      : `"${ref}" matches ${ids.length} detached runs: ${ids.join(', ')}.`
  );
}

/**
 * The state to show: a running coordinator whose heartbeat stopped is
 * `lost`. Its machine may be gone; `mst run --resume <run> --detach`
 * finishes its run.
 */
export function shownState(
  status: DetachStatus,
  now = Date.now()
): DetachStatus['state'] | 'lost' {
  const live = status.state === 'starting' || status.state === 'running';
  return live && now - Date.parse(status.updatedAt) > LOST_AFTER_MS
    ? 'lost'
    : status.state;
}
