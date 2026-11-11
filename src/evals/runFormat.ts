import { readJsonFile, writeJsonFile } from '../utils/jsonFile.js';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  PRERELEASE_SCORE_KEYS,
  RENAMED_SCORES_ANCHOR,
  RUN_FORMAT,
  assertCurrentRunResult,
  assertRunFormat,
  renamedScoreKeys,
} from './resultFormat.js';
import type { EvaluationSummary } from './evalFrameworkTypes.js';
import type { BuiltinModelUse } from '../llm/modelDefaults.js';
import type { EvalCaseResult, TrialResult } from '../types/reporter.js';
import type { GraderScore } from '../types/index.js';
import type { EvalDataset } from './datasetTypes.js';
import {
  INFRASTRUCTURE_BREAKS,
  endingOf,
  isInfrastructure,
} from './trialEnding.js';
import type { RecordedRunner } from './runners/builtinRunners.js';
import type { ShardRecord } from './runners/shardedCollect.js';
import type { ListedServerTools } from './toolSurface.js';
import { storedClientName, storedClientSetup } from './clientNames.js';
import { TranscriptSchema } from './transcriptFormat.js';

/**
 * The run format, `mst.run/v1`: what a run leaves behind, one directory per
 * run.
 *
 * ```text
 * <eval dir>/latest.json
 * <eval dir>/calibrations/<judge>/<judge identity>.json
 * <eval dir>/runs/<run-id>/run.json
 * <eval dir>/runs/<run-id>/transcripts/<variant>/<case-id>/<trial>.json
 * <eval dir>/runs/<run-id>/scores/<grader>/<variant>/<case-id>/<trial>.json
 * <eval dir>/runs/<run-id>/labels/<question>/<variant>/<case-id>/<trial>.json
 * <eval dir>/runs/<run-id>/results.json
 * <eval dir>/runs/<run-id>/summary.json
 * ```
 *
 * Every file starts with `format` and `kind`. Readers keep fields they don't
 * know, at every depth, so adding an optional field keeps the version;
 * removing or renaming one moves the format to `mst.run/v2`.
 *
 * A field whose values the format names (a write mode, an ending, a transcript
 * event's kind, a label) is closed: a value this MST doesn't know fails the
 * read, with a message to upgrade MST (`parseRunFile`). MST's code handles
 * each value it names, in grading, resuming, metrics and reports, and
 * guessing what a new one means could change a count or a grade. Adding such
 * a value keeps the version, and an older MST can't read a run that uses it.
 * A known field of the wrong type is a malformed file and fails the read.
 * Every client's events are checked against the stored shape where they
 * enter MST (`transcriptFormat.ts`), so MST doesn't write a run it can't read.
 * A regrade keeps a trial's transcript and write record as recorded, fields
 * it doesn't know included, and writes the trial record's own fields anew.
 *
 * A trial's transcript is written when the trial finishes (`writeTrial`), so a
 * run that is killed keeps every trial that finished. The other files are
 * written when the run is saved (`writeRun`), which rewrites the transcripts.
 */

/** A run's directory of trial transcripts (`transcripts/<variant>/<case-id>/<trial>.json`). */
const TRANSCRIPTS_DIR = 'transcripts';

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

/**
 * A Zod error's issues with each union replaced by its closest branch, the
 * one with the fewest issues, and every path made absolute. Without this a
 * union says only "Invalid input", and a branch the file was never meant to
 * be (a pairwise calibration's `judgeKind` against the pointwise branch)
 * looks like an unknown value.
 */
function closestIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = []
): z.core.$ZodIssue[] {
  return issues.flatMap((issue) => {
    const at = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length) {
      const closest = issue.errors.reduce((best, branch) =>
        branch.length < best.length ? branch : best
      );
      return closestIssues(closest, at);
    }
    return [{ ...issue, path: at }];
  });
}

/** `writeRecord.writes[0].mode`, as Zod prints a path. */
function issuePath(path: readonly PropertyKey[]): string {
  return (
    path
      .map((key, i) =>
        typeof key === 'number' ? `[${key}]` : `${i ? '.' : ''}${String(key)}`
      )
      .join('') || '(root)'
  );
}

/** The value at a Zod issue's path in what was parsed. */
function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<PropertyKey, unknown>)[key];
  }
  return at;
}

/**
 * Where a file has a value in a closed field this MST doesn't know: an enum
 * or literal value, or a discriminator no branch has. A field that is
 * missing is a malformed file, not a newer one.
 */
function unknownValues(
  value: unknown,
  issues: readonly z.core.$ZodIssue[]
): string[] {
  return issues.flatMap((issue) =>
    (issue.code === 'invalid_value' ||
      (issue.code === 'invalid_union' && 'discriminator' in issue)) &&
    valueAt(value, issue.path) !== undefined
      ? [issuePath(issue.path)]
      : []
  );
}

/**
 * Parse one run-format file with its schema. Throws with the file's name, and
 * says to upgrade MST when the file has a value in a closed field that this
 * MST doesn't know: a newer MST may have written it.
 */
function parseRunFile<T extends z.ZodType>(
  schema: T,
  value: unknown,
  file: string,
  what: string
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = closestIssues(parsed.error.issues);
  const unknown = [...new Set(unknownValues(value, issues))];
  const hint = unknown.length
    ? ` It has a value this MST doesn't know at ${unknown.join(', ')}: a newer MST may have written it. Upgrade MST to read it.`
    : '';
  throw new Error(
    `${file} isn't ${what}: ${z.prettifyError(new z.ZodError(issues))}${hint}`
  );
}

const Envelope = <K extends string>(kind: K) => ({
  format: z.literal(RUN_FORMAT),
  kind: z.literal(kind),
});

/** How a server handles a write (ADR 0014). */
export const WriteModeSchema = z.enum([
  'planned',
  'simulated',
  'server-planned',
  'live',
  'unguarded',
  'read-only',
]);

/** A trial's write record (ADR 0014): what its dry-run proxies recorded. */
const WriteRecordSchema = z.looseObject({
  writes: z.array(
    z.looseObject({
      server: z.string(),
      tool: z.string(),
      arguments: z.unknown(),
      /** What the client was told. Not in a run that redacts responses. */
      reply: z.unknown().optional(),
      mode: z.enum(['planned', 'simulated', 'server-planned']),
      target: z.string().optional(),
      eventId: z.string().optional(),
    })
  ),
  unreported: z.number().int().nonnegative(),
  unrecorded: z.array(
    z.looseObject({
      server: z.string(),
      tool: z.string(),
      eventId: z.string().optional(),
    })
  ),
  unclassified: z.array(
    z.looseObject({
      server: z.string(),
      tool: z.string(),
      arguments: z.unknown(),
      target: z.string().optional(),
      reason: z.enum(['dispatch', 'unmarked']),
    })
  ),
  attribution: z.enum(['exclusive', 'matched']),
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
      /** Each server's write mode, by label (ADR 0014). */
      writeModes: z.record(z.string(), WriteModeSchema).optional(),
      /**
       * The tools the variant's servers served before its tool metadata,
       * listed once before any client started. Only when the run was asked
       * to record them (a tool optimization's runs).
       */
      servedTools: z
        .array(
          z.looseObject({
            server: z.string().optional(),
            tools: z.array(z.looseObject({ name: z.string() })),
          })
        )
        .optional(),
    })
  ),
  /**
   * The tool optimization the run was made for: its baseline, its grouping
   * run, or a round of candidates. Such a run never becomes the latest.
   */
  optimization: z
    .looseObject({
      id: z.string(),
      role: z.enum(['baseline', 'grouping', 'round']),
      round: z.number().int().nonnegative().optional(),
    })
    .optional(),
  datasets: z.array(
    z.looseObject({
      name: z.string(),
      caseCount: z.number().int().nonnegative(),
      contentHash: z.string(),
      /** A plugin's dataset: its source, `namespace/dataset/name`. */
      type: z.string().optional(),
      /** For a source with snapshots: a snapshot, or its live data. */
      source: z.enum(['snapshot', 'live']).optional(),
      /** The snapshot the source read. */
      snapshot: z.string().optional(),
    })
  ),
  judges: z
    .array(
      z.looseObject({
        type: z.string(),
        level: z.string(),
        optionsHash: z.string(),
        identity: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        /** The judge's version, or its plugin's (ADR 0009). */
        version: z.string().optional(),
        /** The judge has no version MST can see change (ADR 0009). */
        unversioned: z.literal(true).optional(),
      })
    )
    .optional(),
  /**
   * MST's built-in models the run used because nothing set one: no option,
   * eval config or mst.config.json (ADR 0015). Each names the `models`
   * entry that would set it, the model, and what used it (`api client`,
   * `judge rubric`). A regrade records its own judges' and its source run's
   * clients'. Absent: the run set every model, or it is from before run.json
   * recorded them.
   */
  builtinModels: z
    .array(
      z.looseObject({
        /** Where to set it: `models.judge.anthropic`. */
        setting: z.string(),
        model: z.string(),
        usedBy: z.array(z.string()),
      })
    )
    .optional(),
  /**
   * The plugins that collected the run's transcripts, by namespace, with
   * their package versions and a hash of their settings: either can change
   * what the plugin's clients, judges and datasets do. A regrade records its
   * source run's. Empty: the run loaded none. Absent: a run from before
   * run.json recorded them, or one the Playwright reporter wrote.
   */
  plugins: z
    .array(
      z.looseObject({
        namespace: z.string(),
        name: z.string(),
        version: z.string().optional(),
        /** A hash of the plugin's settings section, when it has one. */
        settings: z.string().optional(),
      })
    )
    .optional(),
  /**
   * Which key hashed the run's client options (`hmac:…`): a fingerprint of
   * it, which says nothing about the key. Two runs' hashes are comparable
   * only under the same one. Absent: a run from before MST kept a key for
   * the eval.
   */
  optionKey: z.string().optional(),
  partial: z.boolean(),
  selection: z.looseObject({}).optional(),
  redactStoredResponses: z.boolean(),
  /**
   * The run's dry-run proxies answered writes with a success reply
   * (`simulateWrites`). Absent: with a planned-write result.
   */
  simulateWrites: z.literal(true).optional(),
  /** A regrade's run: the run whose transcripts it graded (`mst grade`). */
  gradedFrom: z.string().regex(RUN_ID_PATTERN).optional(),
  /**
   * `mst grade --resume`: the regrade whose verdicts this one kept, and how
   * many trials and pairwise comparisons it kept and graded.
   */
  resumedGrading: z
    .looseObject({
      from: z.string().regex(RUN_ID_PATTERN),
      reusedTrials: z.number().int().nonnegative(),
      gradedTrials: z.number().int().nonnegative(),
      reusedComparisons: z.number().int().nonnegative(),
      gradedComparisons: z.number().int().nonnegative(),
    })
    .optional(),
  /** Where the trials were collected, and the machine `mst run` ran on. */
  runner: z.looseObject({
    /** `local`, or a plugin runner (`<namespace>/runner/<name>`). */
    name: z.string().optional(),
    shards: z.number().int().positive().optional(),
    /** `--runner-option keep`, when not `never`. */
    keep: z.enum(['failed', 'always']).optional(),
    /** The runner's own options, when it was given any. */
    options: z.looseObject({}).optional(),
    node: z.string().optional(),
    platform: z.string().optional(),
    ci: z.boolean().optional(),
    /**
     * Each shard's machine, for the shards that had work: what its worker
     * ran (MST, the machine's image, its OS) and how it ended. `node` and
     * `platform` above are `mst run`'s.
     */
    machines: z
      .array(
        z.looseObject({
          shard: z.number().int().positive(),
          mst: z.string().optional(),
          image: z.string().optional(),
          /**
           * The OS the worker ran on (`process.platform`), which decides
           * how a desktop client ran. Runs before it don't record it.
           */
          platform: z.string().optional(),
          client: z.string().optional(),
          ok: z.boolean(),
          collected: z.number().int().nonnegative(),
          reason: z.string().optional(),
        })
      )
      .optional(),
  }),
  /**
   * Where the run was graded, when not where `mst run` or `mst grade` ran:
   * `mst grade --runner` (ADR 0005). Its machines are the grade shards'.
   */
  grading: z
    .looseObject({
      runner: z.looseObject({
        name: z.string(),
        shards: z.number().int().positive(),
        keep: z.enum(['failed', 'always']).optional(),
        options: z.looseObject({}).optional(),
        machines: z
          .array(
            z.looseObject({
              shard: z.number().int().positive(),
              mst: z.string().optional(),
              image: z.string().optional(),
              ok: z.boolean(),
              graded: z.number().int().nonnegative(),
              failed: z.number().int().nonnegative(),
              reason: z.string().optional(),
            })
          )
          .optional(),
      }),
    })
    .optional(),
  phases: z.looseObject({
    collect: z.enum(['complete', 'partial', 'skipped', 'failed']),
    grade: z.enum(['complete', 'partial', 'skipped', 'failed']),
  }),
});

/** A grade shard's machine, as `run.json`'s `grading.runner` records it. */
export interface GradeShardRecord {
  /** 1-based. */
  shard: number;
  mst?: string;
  image?: string;
  ok: boolean;
  /** Trials and cases whose grading came back. */
  graded: number;
  /** Those the worker couldn't grade. */
  failed: number;
  reason?: string;
}

/**
 * A case's directories in a run, relative to it: its transcripts and its
 * trials' client artifacts, for one variant.
 */
export function caseRunPaths(variant: string, caseId: string): string[] {
  return [
    path.join(TRANSCRIPTS_DIR, segment(variant), segment(caseId)),
    path.join('artifacts', segment(variant), segment(caseId)),
  ];
}

/** A trial's copy of its client artifacts, relative to the run directory. */
export function trialArtifactsPath(
  variant: string,
  caseId: string,
  trial: number
): string {
  return path.join(
    'artifacts',
    segment(variant),
    segment(caseId),
    String(trial)
  );
}

/** How a trial's attempt ended (ADR 0010): a trial, or an infrastructure failure. */
const TrialEndingSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('trial') }),
  z.looseObject({
    kind: z.literal('infrastructure'),
    /** What broke around the client. */
    broke: z.enum(INFRASTRUCTURE_BREAKS),
    /** Whether collecting the attempt again can end differently: `mst run --resume` collects it. */
    retryable: z.boolean(),
    reason: z.string(),
  }),
]);

/** `transcripts/<variant>/<case-id>/<trial>.json`: what the client did in one trial. */
const TrialRecordSchema = z.looseObject({
  ...Envelope('trial'),
  runId: z.string(),
  variant: z.string(),
  caseId: z.string(),
  datasetName: z.string(),
  trial: z.number().int().nonnegative(),
  durationMs: z.number(),
  /**
   * How the attempt ended (ADR 0010). Runs stored before endings have none:
   * `infrastructureError` and the failure kinds say.
   */
  ending: TrialEndingSchema.optional(),
  /** Whether `ending` is an infrastructure failure. */
  infrastructureError: z.boolean(),
  error: z.string().optional(),
  /** A grader couldn't score the trial (`<grader>: <error>`); the client ran. */
  gradingError: z.string().optional(),
  /** The trial's transcript: what the client did. */
  transcript: TranscriptSchema.optional(),
  /**
   * The writes its servers' dry-run proxies recorded (ADR 0014), when any
   * server's writes go through one.
   */
  writeRecord: WriteRecordSchema.optional(),
  /** The trial's client artifacts, copied into the run: a path relative to it. */
  artifacts: z.string().optional(),
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

/** What a person answered to a judge's question: pass or fail for a trial. */
export const POINTWISE_LABELS = ['pass', 'fail'] as const;
/** What a person answered to a pairwise judge's question for a case. */
export const PAIRWISE_LABELS = ['baseline', 'candidate', 'tie'] as const;
/**
 * Which labels measure a judge (`test`) and which a person may read while
 * changing it (`dev`).
 */
export const LABEL_SPLITS = ['dev', 'test'] as const;

const LabelFields = {
  ...Envelope('label'),
  /** The judge's name in results: its rubric for a `rubric` judge, else its reference. */
  judge: z.string().min(1),
  /** One criterion of a judge that checks several. */
  criterion: z.string().min(1).optional(),
  variant: z.string(),
  caseId: z.string(),
  split: z.enum(LABEL_SPLITS),
  /** Who gave the label. */
  labeler: z.string().min(1),
  labeledAt: z.string(),
  note: z.string().optional(),
};

/**
 * `labels/<question>/<variant>/<case-id>/<trial>.json`: a person's pass or
 * fail for one trial, or `labels/<question>/<variant>/<case-id>/vs/<baseline>.json`:
 * their preference between the variant and `baseline` for one case.
 * `<question>` is the judge's name, with `#<criterion>` for one criterion.
 */
const LabelRecordSchema = z.union([
  z.looseObject({
    ...LabelFields,
    trial: z.number().int().nonnegative(),
    baseline: z.never().optional(),
    label: z.enum(POINTWISE_LABELS),
  }),
  z.looseObject({
    ...LabelFields,
    baseline: z.string(),
    trial: z.never().optional(),
    label: z.enum(PAIRWISE_LABELS),
  }),
]);

/** A label as a run stores it. */
export type LabelRecord = z.infer<typeof LabelRecordSchema>;

/** A label's question: the judge's name, with `#<criterion>` for one criterion. */
export function labelQuestion(
  label: Pick<LabelRecord, 'judge' | 'criterion'>
): string {
  return label.criterion === undefined
    ? label.judge
    : `${label.judge}#${label.criterion}`;
}

/** A label's file, relative to the run directory. */
export function labelRecordPath(
  label: Pick<LabelRecord, 'judge' | 'criterion' | 'variant' | 'caseId'> &
    ({ trial: number } | { baseline: string })
): string {
  const base = path.join(
    'labels',
    segment(labelQuestion(label)),
    segment(label.variant),
    segment(label.caseId)
  );
  if ('trial' in label) {
    if (!Number.isInteger(label.trial) || label.trial < 0)
      throw new Error(`A label's trial must be 0 or more, not ${label.trial}.`);
    return path.join(base, `${label.trial}.json`);
  }
  // A preference names its baseline: a candidate compared with two
  // baselines (in two runs, say) has a label for each.
  return path.join(base, 'vs', `${segment(label.baseline)}.json`);
}

/** Parses a label file's contents; throws with the file's name when it isn't one. */
export function parseLabelRecord(value: unknown, file: string): LabelRecord {
  assertRunFormat(value, file);
  return parseRunFile(LabelRecordSchema, value, file, 'a label');
}

const RateSchema = z.looseObject({
  k: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
  value: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
});

const CalibrationFields = {
  ...Envelope('calibration'),
  /** The judge's name in results, as its labels name it. */
  judge: z.string().min(1),
  judgeIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  /** MST can't see the judge's version change, so it can't tell when this goes stale. */
  unversioned: z.literal(true).optional(),
  judgeModels: z.array(z.string()),
  createdAt: z.string(),
  /** The runs whose labels it used. */
  runs: z.array(z.string()),
  split: z.enum(['test', 'dev', 'all']),
  labels: z.number().int().nonnegative(),
  unknown: RateSchema,
};

/**
 * `calibrations/<judge>/<judge identity>.json`, in the eval's directory:
 * what `mst judges check` measured for one judge identity against people's
 * labels. It applies only to that identity.
 */
const CalibrationRecordSchema = z.discriminatedUnion('judgeKind', [
  z.looseObject({
    ...CalibrationFields,
    judgeKind: z.literal('pointwise'),
    humanPass: z.number().int().nonnegative(),
    humanFail: z.number().int().nonnegative(),
    counts: z.looseObject({
      truePositive: z.number().int().nonnegative(),
      falseNegative: z.number().int().nonnegative(),
      trueNegative: z.number().int().nonnegative(),
      falsePositive: z.number().int().nonnegative(),
    }),
    tpr: RateSchema,
    tnr: RateSchema,
    kappa: z.number().nullable(),
    gate: z.looseObject({
      minPassLabels: z.number(),
      minFailLabels: z.number(),
      minRate: z.number(),
      maxUnknownRate: z.number(),
    }),
    usable: z.boolean(),
    reasons: z.array(z.string()),
  }),
  z.looseObject({
    ...CalibrationFields,
    judgeKind: z.literal('pairwise'),
    agreement: RateSchema,
    judgeTies: RateSchema,
    humanTies: RateSchema,
  }),
]);

/** A judge identity's calibration, as an eval keeps it. */
export type CalibrationRecord = z.infer<typeof CalibrationRecordSchema>;

/** A calibration's file, relative to the eval's directory. */
export function calibrationRecordPath(
  record: Pick<CalibrationRecord, 'judge' | 'judgeIdentity'>
): string {
  if (!/^[0-9a-f]{64}$/.test(record.judgeIdentity))
    throw new Error(
      `"${record.judgeIdentity}" isn't a judge identity (64 hex characters).`
    );
  return path.join(
    'calibrations',
    segment(record.judge),
    `${record.judgeIdentity}.json`
  );
}

/** Parses a calibration file's contents; throws with the file's name when it isn't one. */
export function parseCalibrationRecord(
  value: unknown,
  file: string
): CalibrationRecord {
  assertRunFormat(value, file);
  return parseRunFile(CalibrationRecordSchema, value, file, 'a calibration');
}

/** One grader's score in a case or trial result, by its grader's name. */
const ScoresSchema = z.record(
  z.string(),
  z.looseObject({
    pass: z.boolean(),
    score: z.number().optional(),
    reasoning: z.string().optional(),
  })
);

/** One trial of a case that ran several. */
const TrialResultSchema = z.looseObject({
  pass: z.boolean(),
  durationMs: z.number(),
  scores: ScoresSchema.optional(),
  error: z.string().optional(),
  gradingError: z.string().optional(),
  ending: TrialEndingSchema.optional(),
  transcript: TranscriptSchema.optional(),
  writeRecord: WriteRecordSchema.optional(),
});

/** A case's result: its trials, scores and transcript joined. */
const CaseResultSchema = z.looseObject({
  id: z.string(),
  datasetName: z.string(),
  variant: z.string().optional(),
  pass: z.boolean(),
  durationMs: z.number(),
  ending: TrialEndingSchema.optional(),
  scores: ScoresSchema,
  error: z.string().optional(),
  gradingError: z.string().optional(),
  passRate: z.number().optional(),
  trialResults: z.array(TrialResultSchema).optional(),
  transcript: TranscriptSchema.optional(),
  writeRecord: WriteRecordSchema.optional(),
  tags: z.array(z.string()).optional(),
});

/** `results.json`: every case result, transcripts and scores joined. */
const ResultsRecordSchema = z.looseObject({
  ...Envelope('results'),
  runId: z.string(),
  cases: z.array(CaseResultSchema),
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

/**
 * A stored run's `manifest.json`, which its upload writes last: each file's
 * size and SHA-256 (`runStore.ts`). It has its own `format: 1`, which
 * predates `mst.run/v1`; `kind` names its schema, and manifests from before
 * rc.1 have none.
 */
const RunManifestSchema = z.looseObject({
  format: z.literal(1),
  kind: z.literal('manifest').optional(),
  runId: z.string(),
  files: z.array(
    z.looseObject({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
  ),
});

/** A stored run's `manifest.json`. */
export type RunManifest = z.infer<typeof RunManifestSchema>;

/**
 * Parse a stored run's `manifest.json`. Throws with the file's name, and
 * says to upgrade MST for a format it doesn't know.
 */
export function parseRunManifest(value: unknown, file: string): RunManifest {
  return parseRunFile(RunManifestSchema, value, file, "a run's manifest");
}

/** The schemas `schema/run/v1/` is generated from, by file kind. */
export const RUN_SCHEMAS = {
  run: RunRecordSchema,
  trial: TrialRecordSchema,
  score: ScoreRecordSchema,
  preference: PreferenceRecordSchema,
  label: LabelRecordSchema,
  calibration: CalibrationRecordSchema,
  results: ResultsRecordSchema,
  summary: SummaryRecordSchema,
  latest: LatestRecordSchema,
  manifest: RunManifestSchema,
} as const;

/** A dataset's content hash: the cases a run took from it, as they ran. */
export function datasetContentHash(dataset: EvalDataset): string {
  return createHash('sha256')
    .update(JSON.stringify(dataset.cases))
    .digest('hex');
}

/** Case IDs name transcript and score paths, so a run can't have one twice. */
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

/** Variant names name transcript and score paths too, so they can't differ only in case. */
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

/**
 * An eval config judge as `run.json` records it: by name and level, with a
 * hash of its options (which can hold settings that shouldn't be stored),
 * and its identity: a hash of the judge, its version and its parsed options,
 * which every score it gives also records (ADR 0009). `identity` is absent
 * for runs from before MST recorded it, and when the judge's plugin wasn't
 * loaded.
 */
export interface JudgeRecord {
  type: string;
  level: string;
  optionsHash: string;
  identity?: string;
  /**
   * The version a person reads beside the identity: the one the judge
   * declares or, for a plugin judge that declares none, its plugin's package
   * version. Absent for an unversioned judge, a built-in that declares none
   * (MST's version stands for it), and runs from before MST recorded it.
   */
  version?: string;
  /** The judge has no version MST can see change (ADR 0009). */
  unversioned?: true;
}

/** A plugin a run loaded. */
export interface PluginRecord {
  namespace: string;
  name: string;
  /** Its package version, when it has one. */
  version?: string;
  /** A hash of its settings section, when it has one. */
  settings?: string;
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
    servedTools?: ListedServerTools[];
  }>;
  /** The tool optimization the run was made for. */
  optimization?: RunOptimization;
  datasets: Array<{
    name: string;
    caseCount: number;
    contentHash: string;
    type?: string;
    source?: 'snapshot' | 'live';
    snapshot?: string;
  }>;
  judges?: JudgeRecord[];
  /** MST's built-in models the run used because nothing set one (ADR 0015). */
  builtinModels?: BuiltinModelUse[];
  /** The plugins that collected the run, with their versions and settings. */
  plugins?: PluginRecord[];
  /** Which key hashed the run's client options. */
  optionKey?: string;
  redactStoredResponses: boolean;
  /** The run's dry-run proxies answered writes with a success reply. */
  simulateWrites?: true;
  /** Where the trials were collected (`--runner`). Default: `local`. */
  runner?: RecordedRunner;
  /** What each shard ran on, in a runner with machines. */
  machines?: ShardRecord[];
  /** Where the run was graded, with `mst grade --runner` (ADR 0005). */
  grading?: { runner: RecordedRunner; machines: GradeShardRecord[] };
  /**
   * How far the run got. Default: both complete. A run saved while variants
   * remain is `partial`; one that stopped on an error is `collect: failed`.
   */
  phases?: RunPhases;
  /** The run a regrade graded the transcripts of. */
  gradedFrom?: string;
  /** `mst grade --resume`: the grading it kept the verdicts of, and how many. */
  resumedGrading?: ResumedGradingRecord;
}

/** `run.json`'s `resumedGrading`. */
interface ResumedGradingRecord {
  /** The run whose grading was resumed. */
  from: string;
  reusedTrials: number;
  gradedTrials: number;
  reusedComparisons: number;
  gradedComparisons: number;
}

/** `run.json`'s `optimization`: which tool optimization a run was made for, and as what. */
export type RunOptimization = NonNullable<
  z.infer<typeof RunRecordSchema>['optimization']
>;

/** `run.json`'s `phases`: how far collecting transcripts and grading them got. */
type RunPhases = Pick<
  z.infer<typeof RunRecordSchema>['phases'],
  'collect' | 'grade'
>;

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeJsonFile(file, value);
}

/**
 * Writes a JSON file in one step: a kill mid-write leaves the old file or none.
 * `writeJsonFile` already replaces atomically, and keeps the file's mode.
 */
async function replaceJson(file: string, value: unknown): Promise<void> {
  await writeJsonFile(file, value);
}

/** A case result's trials: its trial results, or the case itself when it ran once. */
function trialsOf(result: EvalCaseResult): Array<TrialResult | EvalCaseResult> {
  return result.trialResults?.length ? result.trialResults : [result];
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
  index: number,
  artifacts: string | undefined
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
    ending: endingOf(t),
    infrastructureError: isInfrastructure(t),
    ...(t.error !== undefined ? { error: t.error } : {}),
    // The client ran; a grader couldn't score it. A regrade can finish it.
    ...(t.gradingError !== undefined ? { gradingError: t.gradingError } : {}),
    // The stored shapes keep unknown fields (an index signature), which
    // MST's interfaces don't declare.
    ...(t.transcript
      ? {
          transcript: t.transcript as unknown as z.infer<
            typeof TranscriptSchema
          >,
        }
      : {}),
    ...(t.writeRecord
      ? {
          writeRecord: t.writeRecord as unknown as z.infer<
            typeof WriteRecordSchema
          >,
        }
      : {}),
    ...(t.clientUsage ? { clientUsage: t.clientUsage } : {}),
    ...(t.clientTelemetry ? { clientTelemetry: t.clientTelemetry } : {}),
    ...(t.clientMetadata ? { clientMetadata: t.clientMetadata } : {}),
    ...(t.clientDiagnostics ? { clientDiagnostics: t.clientDiagnostics } : {}),
    ...(t.transcriptEvidence
      ? { transcriptEvidence: t.transcriptEvidence }
      : {}),
    ...(t.skillLoads ? { skillLoads: t.skillLoads } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

/** `transcripts/<variant>/<case-id>/<trial>.json`, for one trial of a case result. */
async function writeTrialRecord(
  runDirectory: string,
  runId: string,
  result: EvalCaseResult,
  trial: TrialResult | EvalCaseResult,
  index: number
): Promise<void> {
  // The trial's client artifacts, when the run kept a copy of them.
  const artifacts = trialArtifactsPath(
    result.variant ?? 'default',
    result.id,
    index
  );
  const copied = await fs
    .stat(path.join(runDirectory, artifacts))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  await replaceJson(
    path.join(
      runDirectory,
      TRANSCRIPTS_DIR,
      segment(result.variant ?? 'default'),
      segment(result.id),
      `${index}.json`
    ),
    trialRecord(runId, result, trial, index, copied ? artifacts : undefined)
  );
}

/**
 * Write one trial's transcript as soon as the trial finishes. `result` is the
 * trial's own result, as it is stored (redacted when the run redacts), with
 * its `variant`; `trial` is its number from 0. `writeRun` writes the same
 * record again when the run is saved.
 */
export async function writeTrial(
  runDirectory: string,
  runId: string,
  result: EvalCaseResult,
  trial: number
): Promise<void> {
  await writeTrialRecord(runDirectory, runId, result, result, trial);
}

/**
 * Write a run directory: `run.json`, one transcript and one score per grader per
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
  // transcript or score file can't leave a run without them.
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
    ...(facts.builtinModels?.length
      ? { builtinModels: facts.builtinModels }
      : {}),
    ...(facts.plugins ? { plugins: facts.plugins } : {}),
    ...(facts.optionKey ? { optionKey: facts.optionKey } : {}),
    partial: summary.partial ?? false,
    ...(summary.selection ? { selection: summary.selection } : {}),
    redactStoredResponses: facts.redactStoredResponses,
    ...(facts.simulateWrites ? { simulateWrites: true } : {}),
    ...(facts.gradedFrom ? { gradedFrom: facts.gradedFrom } : {}),
    ...(facts.optimization ? { optimization: facts.optimization } : {}),
    ...(facts.resumedGrading ? { resumedGrading: facts.resumedGrading } : {}),
    runner: {
      name: facts.runner?.name ?? 'local',
      shards: facts.runner?.shards ?? 1,
      ...(facts.runner && facts.runner.keep !== 'never'
        ? { keep: facts.runner.keep }
        : {}),
      ...(facts.runner && Object.keys(facts.runner.options).length
        ? { options: facts.runner.options }
        : {}),
      node: process.version,
      platform: process.platform,
      ci: Boolean(process.env.CI),
      ...(facts.machines?.length ? { machines: facts.machines } : {}),
    },
    ...(facts.grading
      ? {
          grading: {
            runner: {
              name: facts.grading.runner.name,
              shards: facts.grading.runner.shards,
              ...(facts.grading.runner.keep !== 'never'
                ? { keep: facts.grading.runner.keep }
                : {}),
              ...(Object.keys(facts.grading.runner.options).length
                ? { options: facts.grading.runner.options }
                : {}),
              ...(facts.grading.machines.length
                ? { machines: facts.grading.machines }
                : {}),
            },
          },
        }
      : {}),
    phases: facts.phases ?? { collect: 'complete', grade: 'complete' },
  });
  for (const result of results) {
    const variant = segment(result.variant ?? 'default');
    const caseId = segment(result.id);
    for (const [index, trial] of trialsOf(result).entries()) {
      await writeTrialRecord(runDirectory, runId, result, trial, index);
      // An infrastructure failure isn't a trial the graders scored. A trial
      // a grader failed on keeps the others' scores, and its error.
      if (isInfrastructure(trial)) continue;
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

/** The run `latest.json` points at, if it exists and reads as one. */
export async function readLatestRunId(
  evalDirectory: string
): Promise<string | undefined> {
  try {
    const value = await readJsonFile(path.join(evalDirectory, 'latest.json'));
    return LatestRecordSchema.parse(value).runId;
  } catch {
    return undefined;
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
  await replaceJson(
    path.join(evalDirectory, 'latest.json'),
    latestRecord(runId, createdAt)
  );
}

/** The `latest.json` that points at a run, locally or in a result store. */
export function latestRecord(runId: string, createdAt: string) {
  return {
    format: RUN_FORMAT,
    kind: 'latest' as const,
    runId,
    createdAt,
    path: `runs/${runId}`,
  };
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
 * Refuse a run a 2.0 release candidate stored, before ADR 0013 renamed its
 * fields and its `traces/` directory, rather than fail on a missing field.
 */
async function assertCurrentRunLayout(
  record: unknown,
  directory: string
): Promise<void> {
  const fields =
    record && typeof record === 'object'
      ? (record as Record<string, unknown>)
      : {};
  const renamed: string[] = [];
  if ('environment' in fields && !('runner' in fields))
    renamed.push('environment to runner');
  const isDirectory = async (name: string): Promise<boolean> =>
    fs
      .stat(path.join(directory, name))
      .then((stat) => stat.isDirectory())
      .catch(() => false);
  if ((await isDirectory('traces')) && !(await isDirectory(TRANSCRIPTS_DIR)))
    renamed.push('traces to transcripts');
  if (renamed.length > 0)
    throw new Error(
      `${directory} was stored by an MST 2.0 release candidate, before ADR 0013 renamed ${renamed.join(' and ')}. This MST can't read it: run the eval again.`
    );
  for (const grader of Object.keys(PRERELEASE_SCORE_KEYS))
    if (await isDirectory(path.join('scores', grader)))
      throw new Error(
        `${directory} was stored by an MST 2.0 prerelease, before its score keys took their assertions' names (${renamedScoreKeys()}; see ${RENAMED_SCORES_ANCHOR}). This MST can't read it: run the eval again.`
      );
}

/**
 * Read a run directory written in the mst.run/v1 format. Throws, with what
 * to do, when a file is missing or in another format.
 */
export async function readRunDirectory(directory: string): Promise<StoredRun> {
  const read = async (name: string): Promise<unknown> => {
    const file = path.join(directory, name);
    let value: unknown;
    try {
      value = await readJsonFile(file);
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      throw new Error(
        `${file} is missing: ${directory} isn't a complete MST run.`
      );
    }
    assertRunFormat(value, file);
    return value;
  };
  const record = await read('run.json');
  await assertCurrentRunLayout(record, directory);
  const run = parseRunRecord(record, path.join(directory, 'run.json'));
  const results = await read('results.json');
  // Old score keys in the results, too: a run stopped before its scores
  // has `results.json` but no `scores/`.
  assertCurrentRunResult(
    { caseResults: (results as { cases?: EvalCaseResult[] }).cases },
    path.join(directory, 'results.json')
  );
  const { cases } = parseResultsRecord(
    results,
    path.join(directory, 'results.json')
  );
  const summary = parseSummaryRecord(
    await read('summary.json'),
    path.join(directory, 'summary.json')
  );
  return {
    directory,
    run: runWithCurrentClients(run),
    summary: summaryWithCurrentClients(joinCaseResults(summary, cases), run),
  };
}

/**
 * Parse a stored `run.json` (after `assertRunFormat`). Throws with the file's
 * name, and says to upgrade MST for a value it doesn't know.
 */
export function parseRunRecord(value: unknown, file: string): RunRecord {
  return parseRunFile(RunRecordSchema, value, file, "a run's run.json");
}

/**
 * Parse a stored `results.json` (after `assertRunFormat`): its case results,
 * as written. Checking a large file doesn't keep a second copy of it.
 */
export function parseResultsRecord(
  value: unknown,
  file: string
): { cases: EvalCaseResult[] } {
  parseRunFile(ResultsRecordSchema, value, file, "a run's results.json");
  return { cases: (value as { cases: EvalCaseResult[] }).cases };
}

/**
 * A stored `results.json`'s case results, for a reader that has only that
 * file (the previous-run comparison): its format checked, then its cases.
 */
export function storedCaseResults(
  value: unknown,
  file: string
): EvalCaseResult[] {
  assertRunFormat(value, file);
  return parseResultsRecord(value, file).cases;
}

/** Parse a stored `summary.json` (after `assertRunFormat`), as written. */
export function parseSummaryRecord(
  value: unknown,
  file: string
): EvaluationSummary {
  parseRunFile(SummaryRecordSchema, value, file, "a run's summary.json");
  return value as EvaluationSummary;
}

/**
 * The client each of a stored run's `chatgpt` variants is now, by variant
 * name, for those whose options made it another client
 * (`storedClientSetup`: the Codex surface is `codex-app`). Results and
 * shards record the client's name without its options; this says what
 * their `chatgpt` meant.
 */
function renamedChatgptVariants(
  run: Pick<RunRecord, 'variants'> | undefined
): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const variant of run?.variants ?? []) {
    if (
      variant.client === undefined ||
      storedClientName(variant.client) !== 'chatgpt'
    )
      continue;
    const current = storedClientSetup(variant).client!;
    if (current !== 'chatgpt') renamed.set(variant.name, current);
  }
  return renamed;
}

/**
 * A stored run.json with each client it records as MST names it now
 * (`storedClientSetup`): its variants', with their options, and its shards'
 * machines'. A machine records only a client's name, so a machine's
 * `chatgpt` is `codex-app` only when every `chatgpt` variant was the Codex
 * surface. The file keeps the names it was written with.
 */
export function runWithCurrentClients(run: RunRecord): RunRecord {
  const renamed = renamedChatgptVariants(run);
  const chatgptVariants = run.variants.filter(
    (variant) =>
      variant.client !== undefined &&
      storedClientName(variant.client) === 'chatgpt'
  ).length;
  const machineChatgpt = new Set(renamed.values());
  const chatgptIs =
    renamed.size === chatgptVariants && machineChatgpt.size === 1
      ? [...machineChatgpt][0]!
      : 'chatgpt';
  const machines = run.runner.machines;
  return {
    ...run,
    variants: run.variants.map((variant) => storedClientSetup(variant)),
    runner: {
      ...run.runner,
      ...(machines
        ? {
            machines: machines.map((machine) => {
              if (machine.client === undefined) return machine;
              const client = storedClientName(machine.client);
              return {
                ...machine,
                client: client === 'chatgpt' ? chatgptIs : client,
              };
            }),
          }
        : {}),
    },
  };
}

/**
 * A stored summary with the client each case ran on (`request.client`) as
 * MST names it now (`storedClientName`), in its results and its variants'.
 * A result records the client's name, not its options: with `run`, the
 * stored run.json, a `chatgpt` result in a variant that was the Codex
 * surface reads as `codex-app` (`storedClientSetup`).
 */
export function summaryWithCurrentClients(
  summary: EvaluationSummary,
  run?: Pick<RunRecord, 'variants'>
): EvaluationSummary {
  const renamed = renamedChatgptVariants(run);
  return {
    ...summary,
    ...(Array.isArray(summary.results)
      ? { results: casesWithCurrentClients(summary.results, renamed) }
      : {}),
    variants: summary.variants.map((variant) =>
      Array.isArray(variant.result?.caseResults)
        ? {
            ...variant,
            result: {
              ...variant.result,
              caseResults: casesWithCurrentClients(
                variant.result.caseResults,
                renamed,
                variant.name
              ),
            },
          }
        : variant
    ),
  };
}

function casesWithCurrentClients(
  cases: readonly EvalCaseResult[],
  renamed: ReadonlyMap<string, string>,
  variant?: string
): EvalCaseResult[] {
  return cases.map((result) => {
    if (result.request?.client === undefined) return result;
    const client = storedClientName(result.request.client);
    const current =
      client === 'chatgpt'
        ? (renamed.get(variant ?? result.variant ?? 'default') ?? client)
        : client;
    return {
      ...result,
      request: { ...result.request, client: current },
    };
  });
}

/** A trial's stored record: `transcripts/<variant>/<case-id>/<trial>.json`. */
export type TrialRecord = z.infer<typeof TrialRecordSchema>;

/**
 * Every trial a run stored, read from its `transcripts/` directory, in trial
 * order within each variant and case.
 */
export async function readRunTrials(directory: string): Promise<TrialRecord[]> {
  const root = path.join(directory, TRANSCRIPTS_DIR);
  const files = (
    await fs.readdir(root, { recursive: true }).catch(() => {
      throw new Error(
        `${root} is missing: ${directory} stored no transcripts.`
      );
    })
  )
    .filter((file) => file.endsWith('.json'))
    .sort();
  const trials = await Promise.all(
    files.map(async (file) => {
      const full = path.join(root, file);
      const value = await readJsonFile(full);
      assertRunFormat(value, full);
      return parseRunFile(TrialRecordSchema, value, full, 'a trial');
    })
  );
  return trials.sort(
    (a, b) =>
      a.variant.localeCompare(b.variant) ||
      a.caseId.localeCompare(b.caseId) ||
      a.trial - b.trial
  );
}

/** A run ID without its regrade suffix: `…-7f3c2a.g2` is `…-7f3c2a`. */
function collectedRunId(runId: string): string {
  return runId.replace(/\.g\d+$/, '');
}

/**
 * The ID of a new regrade of `runId`: the run's collected ID with the next
 * free `.g<n>` among the eval's runs. The first regrade is `.g2`; the run
 * graded when it was collected is the first grading.
 */
export async function nextRegradeId(
  runs: string,
  runId: string
): Promise<string> {
  const collected = collectedRunId(runId);
  const taken = (await fs.readdir(runs).catch(() => [] as string[]))
    .map((name) =>
      name.startsWith(`${collected}.g`)
        ? Number(name.slice(collected.length + 2))
        : NaN
    )
    .filter((n) => Number.isInteger(n));
  return `${collected}.g${Math.max(1, ...taken) + 1}`;
}

/**
 * A run's directory from what the user typed: a run directory (relative to
 * `baseDir`), a full run ID, or its short form (the 6 hex characters, with
 * any `.g<n>`) among the eval's runs.
 */
export async function findRunDirectory(
  runs: string,
  run: string,
  baseDir: string
): Promise<string> {
  const asPath = path.resolve(baseDir, run);
  if (
    await fs
      .stat(path.join(asPath, 'run.json'))
      .then(() => true)
      .catch(() => false)
  )
    return asPath;
  const names = await fs.readdir(runs).catch(() => [] as string[]);
  const matches = RUN_ID_PATTERN.test(run)
    ? names.filter((name) => name === run)
    : names.filter(
        (name) => RUN_ID_PATTERN.test(name) && name.endsWith(`-${run}`)
      );
  if (matches.length === 1) return path.join(runs, matches[0]!);
  if (matches.length > 1)
    throw new Error(
      `"${run}" matches ${matches.length} runs in ${runs}: ${matches.join(', ')}. Give the full run ID.`
    );
  throw new Error(
    `No run "${run}" in ${runs}. Give a run ID from there or a run directory.`
  );
}
