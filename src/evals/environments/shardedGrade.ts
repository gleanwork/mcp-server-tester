/**
 * Grading a stored run in an environment (`mst grade --env`, ADR 0005):
 * split its cases into shards as collecting does, give each shard's worker
 * the coordinator's loaded datasets and the run's files for its cases, and
 * gather what each worker's grading produced, for the coordinator to
 * assemble the regrade from.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import packageJson from '../../../package.json' with { type: 'json' };
import type { EvalDataset } from '../datasetTypes.js';
import type { ShardOutcome } from '../evalFrameworkTypes.js';
import {
  gatheredGrading,
  gradeKeyString,
  type GradeKey,
  type GradeRecord,
} from '../gradingSource.js';
import { caseRunPaths, type GradeShardRecord } from '../runFormat.js';
import type { GradedElsewhere, PreparedGrading } from '../runEval.js';
import type { ResolvedEnvironment } from './builtinEnvironments.js';
import {
  bundledRunDir,
  readGradeResult,
  writeGradeShardBundle,
  type GradeShardBundle,
} from './protocol.js';
import { shardOf } from './shardedCollect.js';

export interface GradeInEnvironmentOptions {
  environment: ResolvedEnvironment;
  prepared: PreparedGrading;
  /** A private local directory for bundles and copied results. */
  workDir: string;
  signal: AbortSignal;
  log?: (line: string) => void;
}

/** The run files the shard's worker needs, beside its bundle. */
async function stageRun(
  prepared: PreparedGrading,
  caseIds: ReadonlySet<string>,
  target: string
): Promise<void> {
  const source = prepared.replay.directory;
  await fs.mkdir(target, { recursive: true });
  for (const file of ['run.json', 'summary.json'])
    await fs.copyFile(path.join(source, file), path.join(target, file));
  // The shard's cases' results only: a run's results.json holds every case.
  const results = JSON.parse(
    await fs.readFile(path.join(source, 'results.json'), 'utf8')
  ) as { cases?: Array<{ id?: string }> };
  await fs.writeFile(
    path.join(target, 'results.json'),
    `${JSON.stringify({
      ...results,
      cases: (results.cases ?? []).filter(
        (result) => result.id !== undefined && caseIds.has(result.id)
      ),
    })}\n`
  );
  for (const variant of prepared.replay.trials.keys())
    for (const caseId of caseIds)
      for (const relative of caseRunPaths(variant, caseId)) {
        const from = path.join(source, relative);
        const exists = await fs
          .stat(from)
          .then(() => true)
          .catch(() => false);
        // Links are copied as links: grading refuses them, as it does locally.
        if (exists)
          await fs.cp(from, path.join(target, relative), {
            recursive: true,
            verbatimSymlinks: true,
          });
      }
}

/** The eval config a worker loads: the plugins arrive apart, and it stores nothing. */
function workerConfig(
  file: PreparedGrading['configFile']
): GradeShardBundle['evalConfig'] {
  const { plugins: _plugins, results: _results, ...rest } = file;
  return rest as GradeShardBundle['evalConfig'];
}

/** `<index>.json` files under `dir`. */
async function resultFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => /^\d+\.json$/.test(name));
}

/** Grades the stored run's cases in the environment, `shards` at a time. */
export async function gradeInEnvironment(
  options: GradeInEnvironmentOptions
): Promise<GradedElsewhere> {
  const { environment, prepared } = options;
  const count = environment.shards;
  const log = options.log ?? (() => {});
  const runId = prepared.replay.run.runId;
  // The run's cases that the datasets still have, by shard.
  const datasetCases = new Set(
    prepared.datasets.flatMap((dataset) => dataset.cases.map((c) => c.id))
  );
  const stored = new Set(
    [...prepared.replay.trials.values()].flatMap((cases) => [...cases.keys()])
  );
  const shards = Array.from({ length: count }, (_, index) => ({
    index,
    cases: new Set(
      [...stored].filter(
        (id) => datasetCases.has(id) && shardOf(id, count) === index
      )
    ),
  })).filter((shard) => shard.cases.size > 0);

  const opened = await environment.definition.open(environment.options, {
    runId: prepared.replay.runId,
    shards: count,
    keep: environment.keep,
  });
  const records = new Map<string, GradeRecord>();
  const outcomes = new Map<number, ShardOutcome>();
  const hellos = new Map<number, { mst: string; image?: string }>();
  try {
    if (!(opened.work ?? ['collect']).includes('grade'))
      throw new Error(
        `The environment ${environment.name} can't run grade shards: it runs ${(opened.work ?? ['collect']).join(', ')}.`
      );
    await Promise.all(
      shards.map(async ({ index, cases }) => {
        const root = path.join(options.workDir, `shard-${index}`);
        const bundleDir = path.join(root, 'bundle');
        const resultsDir = path.join(root, 'results');
        await writeGradeShardBundle(bundleDir, {
          runId,
          shard: { index, count },
          mst: packageJson.version,
          plugins: prepared.plugins,
          ...(prepared.pluginPackages.length
            ? { pluginPackages: prepared.pluginPackages }
            : {}),
          evalConfig: workerConfig(prepared.configFile),
          datasets: prepared.datasets.map(
            (dataset): EvalDataset => ({
              ...dataset,
              cases: dataset.cases.filter((c) => cases.has(c.id)),
            })
          ),
        });
        await stageRun(prepared, cases, bundledRunDir(bundleDir, runId));
        // Results are read as they arrive, one at a time, once each.
        let reading = Promise.resolve();
        const seen = new Set<string>();
        const read = (relative: string) =>
          (reading = reading
            .catch(() => {})
            .then(async () => {
              if (seen.has(relative)) return;
              // A copy can race the worker's next write: a file that isn't
              // here yet is read again after the shard's final copy.
              const record = await readGradeResult(
                path.join(resultsDir, relative)
              );
              seen.add(relative);
              records.set(gradeKeyString(record.key), record);
            }));
        const outcome = await opened.runShard(
          {
            runId: prepared.replay.runId,
            index,
            count,
            work: 'grade',
            bundleDir,
            resultsDir,
          },
          {
            progress(event) {
              if (event.type === 'hello') {
                hellos.set(index, {
                  mst: event.mst,
                  ...(event.image ? { image: event.image } : {}),
                });
                log(
                  `grade shard ${index + 1}/${count}: ${cases.size} cases on MST ${event.mst}${event.image ? ` (${event.image})` : ''}`
                );
              } else if (event.type === 'graded') {
                const { key } = event;
                log(
                  `grade shard ${index + 1}/${count}: ${key.kind === 'trial' ? `${key.variant} ${key.caseId} #${key.trial + 1}` : `${key.candidate} vs baseline ${key.caseId}`} ${event.status}`
                );
                read(event.path).catch(() => {});
              }
            },
            // Grading starts no client: no connector tokens, only the run's
            // secrets, for its judges.
            async requestTokens() {
              return { byServer: {}, env: prepared.secrets };
            },
          },
          options.signal
        );
        await reading.catch(() => {});
        for (const relative of await resultFiles(resultsDir))
          await read(relative).catch(() => {});
        await reading.catch(() => {});
        outcomes.set(index, outcome);
        log(
          `grade shard ${index + 1}/${count}: ${outcome.ok ? `done${outcome.note ? `, but ${outcome.note}` : ''}` : `stopped: ${outcome.reason}`}`
        );
      })
    );
  } finally {
    await opened.close();
  }

  const missing = (key: GradeKey): string => {
    const shard = shardOf(key.caseId, count);
    const reason = outcomes.get(shard)?.reason;
    return `Missing: grade shard ${shard + 1} ended before this ${key.kind === 'trial' ? "trial's grading" : 'comparison'} came back${reason ? ` (${reason})` : ''}.`;
  };
  const machines: GradeShardRecord[] = shards.map(({ index }) => {
    const outcome = outcomes.get(index);
    const hello = hellos.get(index);
    return {
      shard: index + 1,
      ...(hello ? { mst: hello.mst } : {}),
      ...(hello?.image ? { image: hello.image } : {}),
      ok: outcome?.ok ?? false,
      graded: outcome?.graded ?? 0,
      failed: outcome?.failed ?? 0,
      ...(outcome && !outcome.ok && outcome.reason
        ? { reason: outcome.reason }
        : {}),
    };
  });
  const { definition: _definition, ...recorded } = environment;
  return {
    source: gatheredGrading(records, missing),
    environment: recorded,
    machines,
  };
}
