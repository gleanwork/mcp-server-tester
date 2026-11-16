/**
 * The run format's schemas that need no file system: how a run-format file
 * is parsed, a case result's shape, and the files outside a run directory
 * that carry `mst.run/v1` (a `saveBaseline` file and an `EvalResultStore`
 * artifact). `runFormat.ts` builds the run directory's files from them. They
 * are a module of their own so the eval runner and its result stores reach
 * them without the run directory's reader and writer.
 */
import { z } from 'zod';
import {
  RUN_FORMAT,
  assertCurrentComparisonResults,
  assertCurrentRunResult,
  assertCurrentSummaryResults,
  assertRunFormat,
} from './resultFormat.js';
import { INFRASTRUCTURE_BREAKS } from './trialEnding.js';
import { TranscriptSchema } from './transcriptFormat.js';

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
export function parseRunFile<T extends z.ZodType>(
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

/** The fields that name a run-format file's format and kind. */
export function Envelope<K extends string>(kind: K) {
  return { format: z.literal(RUN_FORMAT), kind: z.literal(kind) };
}

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
export const WriteRecordSchema = z.looseObject({
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

/** How a trial's attempt ended (ADR 0010): a trial, or an infrastructure failure. */
export const TrialEndingSchema = z.discriminatedUnion('kind', [
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
export const CaseResultSchema = z.looseObject({
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

/** A `saveBaseline` file: an eval runner's result, in the run format. */
export const BaselineRecordSchema = z.looseObject({
  ...Envelope('baseline'),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  incomplete: z.number().optional(),
  caseResults: z.array(CaseResultSchema),
});

/** The kinds of artifact an `EvalResultStore` keeps. */
export const STORED_ARTIFACT_KINDS = [
  'eval-runner-result',
  'eval-run-summary',
  'eval-run-comparison',
] as const;

/**
 * An `EvalResultStore` artifact. Its `kind` names what `data` is: an eval
 * runner's result, a run summary or a comparison of two runs.
 */
export const StoredArtifactSchema = z.looseObject({
  format: z.literal(RUN_FORMAT),
  kind: z.enum(STORED_ARTIFACT_KINDS),
  id: z.string(),
  createdAt: z.string(),
  metadata: z.looseObject({}),
  data: z.unknown(),
});

/** The 2.0 prerelease note on baselines saved without a format. */
const FORMATLESS_BASELINES =
  'docs/migrations/2.0-prereleases.md#baseline-files-have-a-format';

/**
 * Parse a `saveBaseline` file. A file with no format, which every MST
 * before 2.0.0-rc.1 saved, fails with its older field names when it has
 * them, and otherwise says to save it again.
 */
export function parseBaselineFile(value: unknown, file: string): unknown {
  const what = `Baseline ${file}`;
  if (
    typeof value === 'object' &&
    value !== null &&
    !('format' in value) &&
    !('kind' in value)
  ) {
    assertCurrentRunResult(value, what);
    throw new Error(
      `${what} has no format: MST saved baselines without one before 2.0.0-rc.1. Save it again with saveBaseline (see ${FORMATLESS_BASELINES}).`
    );
  }
  assertRunFormat(value, what);
  // Older field names say what to do, before the schema says what's wrong.
  assertCurrentRunResult(value, what);
  const parsed = parseRunFile(BaselineRecordSchema, value, file, 'a baseline');
  const { format: _format, kind: _kind, ...result } = parsed;
  return result;
}

/**
 * Parse an `EvalResultStore` artifact that `what` names, read where the
 * store keeps artifacts of `kind`. Another kind, an older format, or case
 * results with older field names fail, saying what to do.
 */
export function parseStoredArtifact(
  value: unknown,
  what: string,
  kind: (typeof STORED_ARTIFACT_KINDS)[number]
): z.infer<typeof StoredArtifactSchema> {
  assertRunFormat(value, what);
  const artifact = parseRunFile(
    StoredArtifactSchema,
    value,
    what,
    'a stored result artifact'
  );
  if (artifact.kind !== kind)
    throw new Error(`${what} is an ${artifact.kind}, not an ${kind}.`);
  if (kind === 'eval-runner-result')
    assertCurrentRunResult(artifact.data, what);
  else if (kind === 'eval-run-summary')
    assertCurrentSummaryResults(artifact.data, what);
  else assertCurrentComparisonResults(artifact.data, what);
  return artifact;
}
