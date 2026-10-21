/**
 * The coordinator machine's side of a detached run (ADR 0007): `mst
 * coordinate --bundle <dir>` takes the run's secrets over stdin, starts the
 * coordinator as a process of its own session, so it outlives the channel,
 * and returns. The coordinator then runs the same commands a user would
 * type: `mst run`, `mst run --resume` while the run is partial, and
 * `mst grade --env`, keeping its status in the result store.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { evalResultStore } from '../runEval.js';
import type { RunStore } from '../runStore.js';
import {
  DetachPlanSchema,
  detachKeys,
  writeStatus,
  type DetachPlan,
  type DetachStatus,
} from './status.js';

/** The bundle's plan file, and its datasets as loaded where the run started. */
export const PLAN_FILE = 'detach.json';
export const DATASETS_FILE = 'datasets.json';

const HEARTBEAT_MS = 30_000;
const LOG_UPLOAD_MS = 60_000;
const STATUS_LINES = 20;

async function readPlan(bundleDir: string): Promise<DetachPlan> {
  return DetachPlanSchema.parse(
    JSON.parse(await fs.readFile(path.join(bundleDir, PLAN_FILE), 'utf8'))
  );
}

/** Where things are on the coordinator machine, from the bundle's place. */
export function coordinatorPaths(bundleDir: string, plan: DetachPlan) {
  const bundle = path.resolve(bundleDir);
  return {
    bundle,
    // `<workDir>/detached/<id>`: plugins resolve from the work directory.
    workDir: path.resolve(bundle, '..', '..'),
    config: path.join(bundle, plan.config),
    datasets: path.join(bundle, DATASETS_FILE),
    outputDir: path.join(bundle, 'results'),
    log: path.join(bundle, 'coordinator.log'),
  };
}

/** Each command's flags for the run's environment and stores. */
function sharedArgs(
  plan: DetachPlan,
  paths: ReturnType<typeof coordinatorPaths>,
  secretsFile: string | undefined
): string[] {
  return [
    '--config',
    paths.config,
    '--output-dir',
    paths.outputDir,
    '--root-dir',
    paths.workDir,
    // Loaded where the run started: this machine has no dataset credentials.
    '--loaded-datasets',
    paths.datasets,
    ...(secretsFile ? ['--secrets-file', secretsFile] : []),
    ...(plan.results ? ['--results', plan.results] : []),
    '--env',
    plan.env,
  ];
}

function envOptionArgs(options: readonly string[]): string[] {
  return options.flatMap((option) => ['--env-option', option]);
}

/** The commands a plan runs, as MST arguments. */
export function planCommands(
  plan: DetachPlan,
  paths: ReturnType<typeof coordinatorPaths>,
  secretsFile: string | undefined
) {
  const shared = sharedArgs(plan, paths, secretsFile);
  const store = plan.store ? ['--store', plan.store] : [];
  return {
    run: [
      'run',
      ...shared,
      ...envOptionArgs(plan.envOptions),
      ...store,
      ...plan.runArgs,
      ...(plan.noGrade ? ['--no-grade'] : []),
    ],
    resume: (runDir: string) => [
      'run',
      '--resume',
      runDir,
      ...shared,
      ...envOptionArgs(plan.envOptions),
      ...store,
    ],
    grade: (run: string) => [
      'grade',
      run,
      ...shared,
      ...envOptionArgs(plan.gradeEnvOptions ?? plan.envOptions),
      // `mst grade --detach`'s own flags (`--no-report`, `--resume`).
      ...(plan.command === 'grade' ? plan.runArgs : []),
    ],
  };
}

/** What a command printed that the coordinator acts on. */
export function readLine(line: string): {
  collected?: true;
  graded?: true;
  output?: string;
  partial?: true;
} {
  if (/^\[mst\] shard \d+\/\d+: .* collected$/.test(line))
    return { collected: true };
  if (/^\[mst\] grade shard \d+\/\d+: .* graded$/.test(line))
    return { graded: true };
  if (/trials? (?:is|are) missing: the run is partial/.test(line))
    return { partial: true };
  const output = /^Output: (.+)$/.exec(line);
  if (output) return { output: output[1]!.trim() };
  return {};
}

/** A running MST command, as the coordinator sees it. */
export interface CoordinatorChild {
  lines: AsyncIterable<string>;
  exit: Promise<number>;
  /** Asks it to stop as Ctrl-C does: it ends its shards and keeps its traces. */
  interrupt(): void;
}

export interface CoordinatorDeps {
  store: RunStore;
  /** Runs `mst <args>`. */
  mst(args: string[]): CoordinatorChild;
  /** Appends a line to the coordinator's log. */
  log(line: string): void;
  /** The log so far, for the store. */
  readLog(): Promise<string>;
  /** Runs the plan's `finish` command. */
  finish(argv: readonly string[]): Promise<void>;
  machine: string;
  heartbeatMs?: number;
  logUploadMs?: number;
  now?: () => Date;
}

/**
 * Runs a plan to its end and returns its final status. Never throws: a
 * failure is the status's `failed` state.
 */
export async function runPlan(
  plan: DetachPlan,
  paths: ReturnType<typeof coordinatorPaths>,
  secretsFile: string | undefined,
  deps: CoordinatorDeps
): Promise<DetachStatus> {
  const now = deps.now ?? (() => new Date());
  const keys = detachKeys(plan.evalName, plan.id);
  const commands = planCommands(plan, paths, secretsFile);
  const status: DetachStatus = {
    format: 1,
    id: plan.id,
    evalName: plan.evalName,
    command: plan.command,
    state: 'running',
    machine: deps.machine,
    env: plan.env,
    createdAt: plan.createdAt,
    updatedAt: now().toISOString(),
    collected: 0,
    graded: 0,
    lines: [],
  };
  const save = async () => {
    status.updatedAt = now().toISOString();
    await writeStatus(deps.store, status).catch((error: unknown) =>
      deps.log(`[mst coordinate] couldn't write the status: ${String(error)}`)
    );
  };
  const uploadLog = async () => {
    await deps.store
      .put(keys.log, await deps.readLog())
      .catch((error: unknown) =>
        deps.log(`[mst coordinate] couldn't upload the log: ${String(error)}`)
      );
  };
  let current: CoordinatorChild | undefined;
  let cancelled = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      if (!cancelled && (await deps.store.get(keys.cancel).catch(() => null))) {
        cancelled = true;
        deps.log('[mst coordinate] cancel requested: stopping the run');
        current?.interrupt();
      }
      await save();
    })();
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  const logs = setInterval(
    () => void uploadLog(),
    deps.logUploadMs ?? LOG_UPLOAD_MS
  );

  /** Runs one command; its output, and whether it said the run is partial. */
  const step = async (
    phase: NonNullable<DetachStatus['phase']>,
    args: string[]
  ) => {
    status.phase = phase;
    await save();
    deps.log(`[mst coordinate] mst ${args.join(' ')}`);
    current = deps.mst(args);
    let output: string | undefined;
    let partial = false;
    for await (const line of current.lines) {
      deps.log(line);
      status.lines = [...status.lines, line].slice(-STATUS_LINES);
      const read = readLine(line);
      if (read.collected) status.collected += 1;
      if (read.graded) status.graded += 1;
      if (read.partial) partial = true;
      if (read.output) output = read.output;
    }
    const code = await current.exit;
    current = undefined;
    // `mst run` exits 1 when a case failed; only a run with no output failed.
    if (!output)
      throw new Error(
        cancelled
          ? 'cancelled'
          : `mst ${args[0]} ended (exit ${code}) without writing a run`
      );
    return { output, partial };
  };

  try {
    if (plan.command === 'grade') {
      const graded = await step('grade', commands.grade(plan.run ?? ''));
      status.gradedRunId = path.basename(graded.output);
    } else {
      const first = plan.resume
        ? await step('resume', commands.resume(plan.run ?? ''))
        : await step('collect', commands.run);
      const runDir = first.output;
      let { partial } = first;
      status.runId = path.basename(runDir);
      for (let attempt = 0; partial && attempt < plan.resumes; attempt++) {
        if (cancelled) break;
        ({ partial } = await step('resume', commands.resume(runDir)));
      }
      status.missing = partial;
      if (plan.gradeEnv && !cancelled) {
        const graded = await step('grade', commands.grade(status.runId));
        status.gradedRunId = path.basename(graded.output);
      }
    }
    status.state = cancelled ? 'cancelled' : 'done';
  } catch (error) {
    status.state = cancelled ? 'cancelled' : 'failed';
    if (!cancelled)
      status.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearInterval(heartbeat);
    clearInterval(logs);
  }
  status.phase = undefined;
  status.endedAt = now().toISOString();
  deps.log(`[mst coordinate] ${status.state}`);
  await save();
  await uploadLog();
  if (plan.finish?.length)
    await deps
      .finish(plan.finish)
      .catch((error: unknown) =>
        deps.log(`[mst coordinate] finish failed: ${String(error)}`)
      );
  return status;
}

/** The lines a stream writes, as they come. */
async function* textLines(
  stream: NodeJS.ReadableStream
): AsyncIterable<string> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) yield line;
}

/** Merges two line streams. */
async function* merge(
  a: AsyncIterable<string>,
  b: AsyncIterable<string>
): AsyncIterable<string> {
  const queue: string[] = [];
  let open = 2;
  let wake: (() => void) | undefined;
  const pump = async (source: AsyncIterable<string>) => {
    for await (const line of source) {
      queue.push(line);
      wake?.();
    }
    open -= 1;
    wake?.();
  };
  void pump(a);
  void pump(b);
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (open === 0) return;
    await new Promise<void>((resolve) => (wake = resolve));
    wake = undefined;
  }
}

/**
 * `mst coordinate --bundle <dir>`: reads `{"secrets": {...}}` from stdin,
 * keeps the secrets in a private file in memory-backed storage, starts the
 * coordinator in its own session, prints `{"type":"started"}` and exits.
 */
export async function startCoordinator(options: {
  bundleDir: string;
  input: AsyncIterable<string>;
  write: (line: string) => void;
}): Promise<void> {
  const plan = await readPlan(options.bundleDir);
  const paths = coordinatorPaths(options.bundleDir, plan);
  let secretsFile: string | undefined;
  for await (const line of options.input) {
    const message = JSON.parse(line) as { secrets?: Record<string, string> };
    if (plan.secrets && message.secrets) {
      // /dev/shm is RAM: the secrets never reach a disk.
      const base = existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
      const dir = await fs.mkdtemp(path.join(base, 'mst-detach-'));
      await fs.chmod(dir, 0o700);
      secretsFile = path.join(dir, 'secrets.json');
      await fs.writeFile(secretsFile, JSON.stringify(message.secrets), {
        mode: 0o600,
      });
    }
    break;
  }
  const log = await fs.open(paths.log, 'a', 0o600);
  const child = spawnProcess(
    process.execPath,
    [
      process.argv[1]!,
      'coordinate',
      '--bundle',
      paths.bundle,
      '--daemon',
      ...(secretsFile ? ['--secrets', secretsFile] : []),
    ],
    {
      cwd: paths.workDir,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    }
  );
  child.unref();
  await log.close();
  options.write(`${JSON.stringify({ type: 'started', pid: child.pid })}\n`);
}

/** The coordinator itself (`mst coordinate --daemon`), started by `startCoordinator`. */
export async function runCoordinatorDaemon(options: {
  bundleDir: string;
  secretsFile?: string;
}): Promise<number> {
  const plan = await readPlan(options.bundleDir);
  const paths = coordinatorPaths(options.bundleDir, plan);
  const secrets: Record<string, string> = options.secretsFile
    ? (JSON.parse(await fs.readFile(options.secretsFile, 'utf8')) as Record<
        string,
        string
      >)
    : {};
  const { store } = await evalResultStore({
    configPath: paths.config,
    rootDir: paths.workDir,
    ...(plan.results ? { results: plan.results } : {}),
  });
  if (!store) throw new Error('A detached run needs a result store.');
  const log = (line: string) => process.stdout.write(`${line}\n`);
  let interrupted: (() => void) | undefined;
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const)
    process.on(signal, () => interrupted?.());
  const status = await runPlan(plan, paths, options.secretsFile, {
    store,
    machine: os.hostname(),
    log,
    readLog: () => fs.readFile(paths.log, 'utf8').catch(() => ''),
    mst(args) {
      const child = spawnProcess(
        process.execPath,
        [process.argv[1]!, ...args],
        {
          cwd: paths.workDir,
          // The secrets file's values, as a laptop's environment would hold them.
          env: { ...process.env, ...secrets },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      interrupted = () => child.kill('SIGINT');
      return {
        lines: merge(textLines(child.stdout), textLines(child.stderr)),
        exit: new Promise((resolve) =>
          child.on('close', (code) => resolve(code ?? 1))
        ),
        interrupt: () => child.kill('SIGINT'),
      };
    },
    finish: (argv) =>
      new Promise((resolve, reject) => {
        const child = spawnProcess(argv[0]!, argv.slice(1), {
          stdio: 'inherit',
        });
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`exit ${code}`))
        );
      }),
  });
  if (options.secretsFile)
    await fs
      .rm(path.dirname(options.secretsFile), { recursive: true, force: true })
      .catch(() => {});
  return status.state === 'done' ? 0 : 1;
}
