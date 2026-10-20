import { evalResultStore } from '../../../evals/runEval.js';
import type { RunStore } from '../../../evals/runStore.js';
import {
  detachKeys,
  findDetachId,
  listDetachIds,
  readStatus,
  shownState,
  type DetachStatus,
} from '../../../evals/detach/status.js';

export interface RunsOptions {
  config: string;
  rootDir?: string;
  results?: string;
}

async function open(
  options: RunsOptions
): Promise<{ evalName: string; store: RunStore }> {
  const { evalName, store } = await evalResultStore({
    configPath: options.config,
    ...(options.rootDir ? { rootDir: options.rootDir } : {}),
    ...(options.results ? { results: options.results } : {}),
  });
  if (!store)
    throw new Error(
      `${options.config} keeps its runs in no result store: give --results, as the run was given.`
    );
  return { evalName, store };
}

function age(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m ago`;
}

function describe(status: DetachStatus): string {
  const state = shownState(status);
  return [
    `${status.id}  ${state}${status.phase ? ` (${status.phase})` : ''}`,
    `  ${status.command} on ${status.env}, coordinator ${status.machine}; started ${age(status.createdAt)}, last heard ${age(status.updatedAt)}`,
    `  ${status.collected} collected, ${status.graded} graded` +
      (status.runId ? `; run ${status.runId}` : '') +
      (status.gradedRunId ? `, graded as ${status.gradedRunId}` : '') +
      (status.missing ? '; still missing trials' : ''),
    ...(status.error ? [`  error: ${status.error}`] : []),
    ...(state === 'lost'
      ? [
          '  Its coordinator stopped reporting. Finish its run with mst run --resume <run> --detach.',
        ]
      : []),
  ].join('\n');
}

/** `mst runs list`: the eval's detached runs, newest first. */
export async function listRuns(options: RunsOptions): Promise<void> {
  const { evalName, store } = await open(options);
  const ids = await listDetachIds(store, evalName);
  if (ids.length === 0) {
    console.log(`No detached runs of ${evalName} in ${store.location}.`);
    return;
  }
  for (const id of ids) {
    const status = await readStatus(store, evalName, id);
    console.log(status ? describe(status) : `${id}  (no status)`);
  }
}

/** `mst runs status <id>`: one detached run. */
export async function runStatus(
  id: string,
  options: RunsOptions
): Promise<void> {
  const { evalName, store } = await open(options);
  const status = await readStatus(
    store,
    evalName,
    await findDetachId(store, evalName, id)
  );
  if (!status) throw new Error(`Detached run ${id} has no status yet.`);
  console.log(describe(status));
  if (status.lines.length) console.log(`\n${status.lines.join('\n')}`);
}

/** `mst runs watch <id>`: follow a detached run until it ends. */
export async function watchRun(
  id: string,
  options: RunsOptions & { interval?: string }
): Promise<void> {
  const { evalName, store } = await open(options);
  const full = await findDetachId(store, evalName, id);
  const interval = Number(options.interval ?? 30) * 1000;
  let printed = '';
  for (;;) {
    const status = await readStatus(store, evalName, full);
    if (status) {
      const text = describe(status);
      if (text !== printed) {
        console.log(`\n${new Date().toLocaleTimeString()}\n${text}`);
        if (status.lines.length) console.log(status.lines.slice(-5).join('\n'));
        printed = text;
      }
      const state = shownState(status);
      if (state !== 'starting' && state !== 'running') {
        if (state !== 'done') process.exitCode = 1;
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** `mst runs logs <id>`: the coordinator's output so far. */
export async function runLogs(id: string, options: RunsOptions): Promise<void> {
  const { evalName, store } = await open(options);
  const bytes = await store.get(
    detachKeys(evalName, await findDetachId(store, evalName, id)).log
  );
  if (!bytes) throw new Error(`Detached run ${id} has uploaded no log yet.`);
  process.stdout.write(Buffer.from(bytes).toString('utf8'));
}

/** `mst runs cancel <id>`: ask a detached run's coordinator to stop. */
export async function cancelRun(
  id: string,
  options: RunsOptions
): Promise<void> {
  const { evalName, store } = await open(options);
  const full = await findDetachId(store, evalName, id);
  await store.put(detachKeys(evalName, full).cancel, new Date().toISOString());
  console.log(
    `Asked ${full} to stop. Its coordinator checks within a minute, lets the trials under way finish, deletes its machines and keeps what it collected.`
  );
}
