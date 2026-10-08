import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RUN_FORMAT, assertRunFormat } from './resultFormat.js';
import type { EvaluationSummary } from './evalFrameworkTypes.js';
import type { EvalCaseResult, TrialResult } from '../types/reporter.js';
import type { GraderScore } from '../types/index.js';
import type { EvalDataset } from './datasetTypes.js';
import { isInfrastructureFailure } from './infrastructureFailure.js';

/**
 * The run format, `mst.run/v1`: what a run leaves behind, one directory per
 * run.
 *
 * ```text
 * <eval dir>/latest.json
 * <eval dir>/runs/<run-id>/run.json
 * <eval dir>/runs/<run-id>/traces/<variant>/<case-id>/<trial>.json
 * <eval dir>/runs/<run-id>/scores/<grader>/<variant>/<case-id>/<trial>.json
 * <eval dir>/runs/<run-id>/results.json
 * <eval dir>/runs/<run-id>/summary.json
 * ```
 *
 * Every file starts with `format` and `kind`. Readers ignore fields they
 * don't know, so adding an optional field keeps the version; removing or
 * renaming one moves the format to `mst.run/v2`.
 */

/** A run's ID: its UTC start time, then 6 hex characters (`20261007T182504Z-7f3c2a`). */
export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{6}(\.g\d+)?$/;

/** A new run ID. IDs sort by start time; the hex suffix is the short form. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** The directory of an eval's runs. */
export function runsDirectory(evalDirectory: string): string {
  return path.join(evalDirectory, 'runs');
}

/** Longest path segment MST writes, in bytes: below every file system's limit. */
const MAX_SEGMENT_BYTES = 200;

/**
 * One path segment for a variant, case or grader name: URI-encoded, with
 * `*` and a leading or trailing `.` encoded too, and shortened with a hash
 * of the name when it would be too long.
 */
function segment(name: string): string {
  const encoded = encodeURIComponent(name)
    .replace(/\*/g, '%2A')
    .replace(/^\./, '%2E')
    .replace(/\.$/, '%2E');
  if (Buffer.byteLength(encoded) <= MAX_SEGMENT_BYTES) return encoded;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `${encoded.slice(0, MAX_SEGMENT_BYTES - 17).replace(/%[0-9A-F]?$/, '')}~${hash}`;
}

const Envelope = <K extends string>(kind: K) => ({
  format: z.literal(RUN_FORMAT),
  kind: z.literal(kind),
});

/** `run.json`: what ran, with what, and how far it got. */
const RunRecordSchema = z.looseObject({
  ...Envelope('run'),
  runId: z.string().regex(RUN_ID_PATTERN),
  evalName: z.string(),
  configId: z.string(),
  contentHash: z.string(),
  createdAt: z.string(),
  finishedAt: z.string(),
  mst: z.looseObject({ version: z.string() }),
  baseline: z.string().optional(),
  variants: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string().optional(),
      servers: z.array(z.looseObject({})).optional(),
      client: z.string().optional(),
      model: z.string().optional(),
      clientOptions: z.record(z.string(), z.unknown()).optional(),
      tools: z.record(z.string(), z.unknown()).optional(),
      inputTemplate: z.string().optional(),
      judges: z.array(z.string()).optional(),
    })
  ),
  datasets: z.array(
    z.looseObject({
      name: z.string(),
      caseCount: z.number().int().nonnegative(),
      contentHash: z.string(),
      /** A plugin's dataset: its source, `namespace/dataset/name`. */
      ref: z.string().optional(),
      /** The snapshot the source read. */
      snapshot: z.string().optional(),
      /** The source's live data, not a snapshot. */
      live: z.literal(true).optional(),
    })
  ),
  judges: z.array(z.unknown()).optional(),
  partial: z.boolean(),
  selection: z.looseObject({}).optional(),
  redactStoredResponses: z.boolean(),
  environment: z.looseObject({}),
  phases: z.looseObject({
    collect: z.enum(['complete', 'partial', 'skipped', 'failed']),
    grade: z.enum(['complete', 'partial', 'skipped', 'failed']),
  }),
});

/** `traces/<variant>/<case-id>/<trial>.json`: what the client did in one trial. */
const TrialRecordSchema = z.looseObject({
  ...Envelope('trial'),
  runId: z.string(),
  variant: z.string(),
  caseId: z.string(),
  datasetName: z.string(),
  trial: z.number().int().nonnegative(),
  durationMs: z.number(),
  infrastructureError: z.boolean(),
  error: z.string().optional(),
  trace: z.looseObject({}).optional(),
});

/** `scores/<grader>/<variant>/<case-id>/<trial>.json`: one grader's score for one trial. */
const ScoreRecordSchema = z.looseObject({
  ...Envelope('score'),
  runId: z.string(),
  grader: z.string(),
  variant: z.string(),
  caseId: z.string(),
  trial: z.number().int().nonnegative(),
  score: z.looseObject({ pass: z.boolean() }),
});

/** `scores/<pairwise judge>/<variant>/<case-id>.json`: one pairwise judge's preference for one case. */
const PreferenceRecordSchema = z.looseObject({
  ...Envelope('preference'),
  runId: z.string(),
  judge: z.string(),
  variant: z.string(),
  baseline: z.string(),
  caseId: z.string(),
  preference: z.looseObject({ judge: z.string() }),
});

/** `results.json`: every case result, traces and scores joined. */
const ResultsRecordSchema = z.looseObject({
  ...Envelope('results'),
  runId: z.string(),
  cases: z.array(z.looseObject({ id: z.string(), pass: z.boolean() })),
});

/** `summary.json`: the run summary, per variant, without the case list. */
const SummaryRecordSchema = z.looseObject({
  ...Envelope('summary'),
  runId: z.string(),
  configId: z.string(),
  contentHash: z.string(),
  timestamp: z.string(),
  configName: z.string(),
  variants: z.array(z.looseObject({ name: z.string() })),
  metrics: z.looseObject({}),
});

/** `latest.json`: the eval's newest complete, full run. */
const LatestRecordSchema = z.looseObject({
  ...Envelope('latest'),
  runId: z.string().regex(RUN_ID_PATTERN),
  createdAt: z.string(),
  path: z.string(),
});

/** The schemas `schema/run/v1/` is generated from, by file kind. */
export const RUN_SCHEMAS = {
  run: RunRecordSchema,
  trial: TrialRecordSchema,
  score: ScoreRecordSchema,
  preference: PreferenceRecordSchema,
  results: ResultsRecordSchema,
  summary: SummaryRecordSchema,
  latest: LatestRecordSchema,
} as const;

/** A dataset's content hash: the cases a run took from it, as they ran. */
export function datasetContentHash(dataset: EvalDataset): string {
  return createHash('sha256')
    .update(JSON.stringify(dataset.cases))
    .digest('hex');
}

/** Case IDs name trace and score paths, so a run can't have one twice. */
export function assertUniqueCaseIds(datasets: readonly EvalDataset[]): void {
  // Case-folded: macOS and Windows paths ignore case.
  const seen = new Map<string, string>();
  for (const dataset of datasets) {
    for (const evalCase of dataset.cases) {
      const other = seen.get(evalCase.id.toLowerCase());
      if (other !== undefined)
        throw new Error(
          other === dataset.name
            ? `Dataset "${dataset.name}" has case "${evalCase.id}" twice. Case IDs must be unique within a run.`
            : `Case "${evalCase.id}" is in datasets "${other}" and "${dataset.name}". Case IDs must be unique within a run.`
        );
      seen.set(evalCase.id.toLowerCase(), dataset.name);
    }
  }
}

/** Variant names name trace and score paths too, so they can't differ only in case. */
export function assertUniqueVariantNames(names: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const other = seen.get(name.toLowerCase());
    if (other !== undefined)
      throw new Error(
        `Variants "${other}" and "${name}" differ only in case. Variant names must differ in more than case.`
      );
    seen.set(name.toLowerCase(), name);
  }
}

/** The facts `run.json` records, beyond what the summary has. */
export interface RunFacts {
  evalName: string;
  createdAt: string;
  finishedAt: string;
  mstVersion: string;
  baseline?: string;
  variants: Array<{
    name: string;
    servers?: unknown[];
    client?: string;
    model?: string;
  }>;
  datasets: Array<{
    name: string;
    caseCount: number;
    contentHash: string;
    ref?: string;
    snapshot?: string;
    live?: true;
  }>;
  judges?: Array<{ type: string; level: string; optionsHash: string }>;
  redactStoredResponses: boolean;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A case result's trials: its trial results, or the case itself when it ran once. */
function trialsOf(result: EvalCaseResult): Array<TrialResult | EvalCaseResult> {
  return result.trialResults?.length ? result.trialResults : [result];
}

/** Whether a trial failed on infrastructure: graders didn't score it. */
export function isInfraTrial(trial: TrialResult | EvalCaseResult): boolean {
  return 'isInfrastructureError' in trial &&
    trial.isInfrastructureError !== undefined
    ? trial.isInfrastructureError
    : isInfrastructureFailure(trial as EvalCaseResult);
}

/** Each grader's score in a trial: one per judge when several judges ran. */
function graderScores(
  scores: Partial<Record<string, GraderScore>>
): Array<[string, GraderScore]> {
  return Object.entries(scores).flatMap(([grader, score]) => {
    if (!score) return [];
    if (grader === 'judge' && score.judgeResults?.length)
      return score.judgeResults.map(
        (result, index) =>
          [`judge.${result.judgeName ?? index}`, result] as [
            string,
            GraderScore,
          ]
      );
    return [
      [
        grader === 'judge' && score.judgeName
          ? `judge.${score.judgeName}`
          : grader,
        score,
      ] as [string, GraderScore],
    ];
  });
}

function trialRecord(
  runId: string,
  result: EvalCaseResult,
  trial: TrialResult | EvalCaseResult,
  index: number
): z.infer<typeof TrialRecordSchema> {
  const t = trial as TrialResult & Partial<EvalCaseResult>;
  return {
    format: RUN_FORMAT,
    kind: 'trial',
    runId,
    variant: result.variant ?? 'default',
    caseId: result.id,
    datasetName: result.datasetName,
    trial: index,
    durationMs: t.durationMs ?? 0,
    infrastructureError: isInfraTrial(trial),
    ...(t.error !== undefined ? { error: t.error } : {}),
    ...(t.trace
      ? { trace: t.trace as unknown as Record<string, unknown> }
      : {}),
    ...(t.clientUsage ? { clientUsage: t.clientUsage } : {}),
    ...(t.clientTelemetry ? { clientTelemetry: t.clientTelemetry } : {}),
    ...(t.clientMetadata ? { clientMetadata: t.clientMetadata } : {}),
    ...(t.clientDiagnostics ? { clientDiagnostics: t.clientDiagnostics } : {}),
    ...(t.traceEvidence ? { traceEvidence: t.traceEvidence } : {}),
    ...(t.skillLoads ? { skillLoads: t.skillLoads } : {}),
  };
}

/**
 * Write a run directory: `run.json`, one trace and one score per grader per
 * trial, `results.json` and `summary.json`. `summary` is the stored (redacted)
 * summary. Returns the files' paths, relative to `runDirectory`.
 */
export async function writeRun(
  runDirectory: string,
  runId: string,
  facts: RunFacts,
  summary: EvaluationSummary
): Promise<void> {
  const { results, ...rest } = summary;
  // The run's files that readers need come first, so a failure writing a
  // trace or score file can't leave a run without them.
  await writeJson(path.join(runDirectory, 'results.json'), {
    format: RUN_FORMAT,
    kind: 'results',
    runId,
    cases: results,
  });
  await writeJson(path.join(runDirectory, 'summary.json'), {
    ...rest,
    // Case results are in results.json.
    variants: rest.variants.map((variant) =>
      variant.result
        ? {
            ...variant,
            result: (({ caseResults: _cases, ...totals }) => totals)(
              variant.result
            ),
          }
        : variant
    ),
    format: RUN_FORMAT,
    kind: 'summary',
    runId,
  });
  await writeJson(path.join(runDirectory, 'run.json'), {
    format: RUN_FORMAT,
    kind: 'run',
    runId,
    evalName: facts.evalName,
    configId: summary.configId,
    contentHash: summary.contentHash,
    createdAt: facts.createdAt,
    finishedAt: facts.finishedAt,
    mst: { version: facts.mstVersion },
    ...(facts.baseline ? { baseline: facts.baseline } : {}),
    variants: facts.variants,
    datasets: facts.datasets,
    ...(facts.judges?.length ? { judges: facts.judges } : {}),
    partial: summary.partial ?? false,
    ...(summary.selection ? { selection: summary.selection } : {}),
    redactStoredResponses: facts.redactStoredResponses,
    environment: {
      node: process.version,
      platform: process.platform,
      ci: Boolean(process.env.CI),
    },
    phases: { collect: 'complete', grade: 'complete' },
  });
  for (const result of results) {
    const variant = segment(result.variant ?? 'default');
    const caseId = segment(result.id);
    for (const [index, trial] of trialsOf(result).entries()) {
      await writeJson(
        path.join(runDirectory, 'traces', variant, caseId, `${index}.json`),
        trialRecord(runId, result, trial, index)
      );
      // An infrastructure failure isn't a trial the graders scored.
      if (isInfraTrial(trial)) continue;
      const scores = (trial as Partial<EvalCaseResult>).scores ?? {};
      for (const [grader, score] of graderScores(scores)) {
        await writeJson(
          path.join(
            runDirectory,
            'scores',
            segment(grader),
            variant,
            caseId,
            `${index}.json`
          ),
          {
            format: RUN_FORMAT,
            kind: 'score',
            runId,
            grader,
            variant: result.variant ?? 'default',
            caseId: result.id,
            trial: index,
            score,
          }
        );
      }
    }
  }
  // Pairwise preferences: one per pairwise judge, variant and case.
  for (const variant of summary.variants) {
    const pairwise = variant.pairwise;
    if (!pairwise) continue;
    for (const caseResult of pairwise.cases) {
      for (const preference of caseResult.preferences) {
        await writeJson(
          path.join(
            runDirectory,
            'scores',
            segment(preference.judge),
            segment(variant.name),
            `${segment(caseResult.id)}.json`
          ),
          {
            format: RUN_FORMAT,
            kind: 'preference',
            runId,
            judge: preference.judge,
            variant: variant.name,
            baseline: pairwise.baseline,
            caseId: caseResult.id,
            preference,
          }
        );
      }
    }
  }
}

/**
 * Point the eval's `latest.json` at a run. Written last, and only for a full
 * run, so a crash or a partial run leaves it at the previous run.
 */
export async function writeLatest(
  evalDirectory: string,
  runId: string,
  createdAt: string
): Promise<void> {
  const file = path.join(evalDirectory, 'latest.json');
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeJson(temporary, {
    format: RUN_FORMAT,
    kind: 'latest',
    runId,
    createdAt,
    path: `runs/${runId}`,
  });
  await fs.rename(temporary, file);
}

/**
 * A run's summary with its case results put back from results.json: overall
 * and in each variant's result. summary.json keeps only the totals.
 */
export function joinCaseResults(
  summary: EvaluationSummary,
  cases: EvalCaseResult[]
): EvaluationSummary {
  return {
    ...summary,
    results: cases,
    variants: summary.variants.map((variant) =>
      variant.result
        ? {
            ...variant,
            result: {
              ...variant.result,
              caseResults: cases.filter(
                (result) => (result.variant ?? 'default') === variant.name
              ),
            },
          }
        : variant
    ),
  };
}

/** The type of run.json. */
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** A run directory, read back: run.json, and the summary with its case results. */
export interface StoredRun {
  directory: string;
  run: RunRecord;
  summary: EvaluationSummary;
}

/**
 * Read a run directory written in the mst.run/v1 format. Throws, with what
 * to do, when a file is missing or in another format.
 */
export async function readRunDirectory(directory: string): Promise<StoredRun> {
  const read = async (name: string): Promise<unknown> => {
    const file = path.join(directory, name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      throw new Error(
        `${file} is missing: ${directory} isn't a complete MST run.`
      );
    }
    const value: unknown = JSON.parse(text);
    assertRunFormat(value, file);
    return value;
  };
  const run = RunRecordSchema.parse(await read('run.json'));
  const summary = (await read('summary.json')) as EvaluationSummary;
  const results = (await read('results.json')) as { cases?: EvalCaseResult[] };
  return {
    directory,
    run,
    summary: joinCaseResults(summary, results.cases ?? []),
  };
}
