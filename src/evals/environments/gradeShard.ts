/**
 * The worker side of a grade shard (`mst grade-shard`, ADR 0005). It grades
 * the bundle's cases of a stored run with the code a local `mst grade` runs,
 * on the coordinator's loaded datasets, and records each trial's grading and
 * each case's pairwise preferences as it's produced, for the coordinator to
 * assemble the regrade from. It talks `mst.shard/v1` to the coordinator.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import packageJson from '../../../package.json' with { type: 'json' };
import { redactClientSecrets } from '../clientSecrets.js';
import { gradingErrorOf } from '../grading.js';
import { recordingGrading, type GradeRecord } from '../gradingSource.js';
import { gradeStoredRun } from '../runEval.js';
import { installPlugins } from '../../plugins/extensions.js';
import { loadWorkerPlugins, writeFileAtomically } from './collect.js';
import {
  SHARD_PROTOCOL,
  bundledRunDir,
  encodeMessage,
  gradeResultFile,
  parseCoordinatorMessage,
  readGradeShardBundle,
  type ShardTokens,
  type WorkerMessage,
} from './protocol.js';

export interface GradeShardOptions {
  bundleDir: string;
  resultsDir: string;
  /** The coordinator's lines (the worker's stdin). */
  input: AsyncIterable<string>;
  /** Writes one protocol line (the worker's stdout). */
  write: (line: string) => void;
  /**
   * `MST_IMAGE` (the image's digest), `MST_PLUGIN_DIR` (where plugin
   * packages are installed; default the working directory) and
   * `MST_HEARTBEAT_MS` (default 15000).
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Where the run's secrets go, for judges to read: this process's
   * environment, and nowhere else. Tests pass their own.
   */
  processEnv?: Record<string, string | undefined>;
}

/** Every string in `value` with the secrets replaced. */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactClientSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, redactDeep(v, secrets)])
    );
  return value;
}

/** Whether what grading produced holds no verdict for some grader or judge. */
function failedRecord(record: GradeRecord): boolean {
  return 'outcome' in record
    ? gradingErrorOf(record.outcome.scores) !== undefined
    : record.preferences.some((preference) => preference.error !== undefined);
}

/**
 * Grades the shard in `bundleDir` and returns the process's exit code. A
 * cancel (or the coordinator closing stdin) lets the grading under way
 * finish, grades no more, and still reports `done`.
 */
export async function gradeShard(options: GradeShardOptions): Promise<number> {
  const env = options.env ?? process.env;
  const processEnv = options.processEnv ?? process.env;
  const send = (message: WorkerMessage) =>
    options.write(encodeMessage(message));
  const bundle = await readGradeShardBundle(options.bundleDir);
  const heartbeatMs = Number(env.MST_HEARTBEAT_MS ?? 15_000);

  let cancelled = false;
  let resolveTokens: (tokens: ShardTokens) => void = () => {};
  const tokens = new Promise<ShardTokens>((resolve) => {
    resolveTokens = resolve;
  });
  const cancel = () => {
    cancelled = true;
    resolveTokens({ byServer: {} });
  };
  const reading = (async () => {
    for await (const line of options.input) {
      const message = parseCoordinatorMessage(line);
      if (message.type === 'cancel') cancel();
      else if (message.type === 'tokens') {
        const { type: _type, ...received } = message;
        resolveTokens(received);
      }
    }
    // The coordinator is gone: finish the grading under way, and stop.
    cancel();
  })();
  reading.catch(cancel);

  send({
    type: 'hello',
    protocol: SHARD_PROTOCOL,
    mst: packageJson.version,
    ...(env.MST_IMAGE ? { image: env.MST_IMAGE } : {}),
    client: { name: 'grade' },
  });
  const heartbeat = setInterval(
    () => send({ type: 'heartbeat', at: new Date().toISOString() }),
    heartbeatMs
  );
  heartbeat.unref();

  // Values the worker never lets out: the run's secrets.
  const secrets: string[] = [];
  let graded = 0;
  let failed = 0;
  let next = 0;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-grade-'));
  try {
    const plugins = await loadWorkerPlugins(
      bundle,
      options.bundleDir,
      env.MST_PLUGIN_DIR
    );
    installPlugins(plugins);
    // The run's secrets (judges' keys) arrive over stdin, and live only in
    // this process's environment, where judges read them.
    send({ type: 'need-tokens', servers: [], reason: 'start' });
    const received = await tokens;
    for (const [name, value] of Object.entries(received.env ?? {})) {
      processEnv[name] = value;
      if (value) secrets.push(value);
    }
    if (!cancelled) {
      // The eval config as the coordinator's file has it: its datasets come
      // loaded in the bundle, its plugins are loaded above.
      const configPath = path.join(workspace, 'eval.json');
      await fs.writeFile(configPath, JSON.stringify(bundle.evalConfig));
      const source = recordingGrading({
        stopped: () => cancelled,
        async record(record) {
          const relative = `${next++}.json`;
          const stored = redactDeep(record, secrets) as GradeRecord;
          await writeFileAtomically(
            path.join(options.resultsDir, relative),
            gradeResultFile(stored)
          );
          const status = failedRecord(stored) ? 'failed' : 'graded';
          if (status === 'failed') failed++;
          else graded++;
          send({ type: 'graded', key: stored.key, status, path: relative });
        },
      });
      await gradeStoredRun(
        {
          configPath,
          rootDir: workspace,
          run: bundledRunDir(options.bundleDir, bundle.runId),
          plugins,
          report: false,
        },
        { source, datasets: bundle.datasets }
      );
    }
  } finally {
    clearInterval(heartbeat);
    await fs.rm(workspace, { recursive: true, force: true });
  }
  send({ type: 'done', graded, failed, cancelled, cleanup: 'ok' });
  return 0;
}
