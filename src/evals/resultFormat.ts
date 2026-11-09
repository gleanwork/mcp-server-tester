/**
 * The run format: every file a run writes, and every stored summary,
 * carries `format: 'mst.run/v1'`. It uses the 2.0 result vocabulary (ADR
 * 0002): results name the client, not a host, and record trials and scores.
 * Results written by an earlier MST fail with what to do instead of losing
 * fields silently.
 */
export const RUN_FORMAT = 'mst.run/v1' as const;

/** Whether `value` is a stored file or artifact in this run format. */
function isRunFormat(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === RUN_FORMAT
  );
}

/** Throws, saying what to do, unless `value` is in this run format. */
export function assertRunFormat(value: unknown, what: string): void {
  if (!isRunFormat(value))
    throw olderResultsError(
      what,
      (value as { format?: unknown } | null | undefined)?.format
    );
}

/**
 * 1.x result field names and what 2.0 calls them, as keys of a case or
 * trial result. 2.0's own `hostTelemetry` (CONTEXT.md, host telemetry) is
 * only ever in a trial's `transcript`, so it never matches.
 */
const RENAMED_RESULT_FIELDS: Record<string, string> = {
  mcpHostTrace: 'toolCallTranscript',
  hostUsage: 'clientUsage',
  hostTelemetry: 'clientTelemetry',
  hostDiagnostics: 'clientDiagnostics',
  hostEvidence: 'transcriptEvidence',
  externalHost: 'clientMetadata',
  expectations: 'scores',
  iterationResults: 'trialResults',
  assertionPassRate: 'passRate',
  assertionPassRateCI: 'passRateCI',
};

const MIGRATION =
  'docs/migrations/migration-2.0.md#result-fields-use-the-eval-vocabulary';

/** `format` is the run format the file says it has, when it says one. */
export function olderResultsError(what: string, format?: unknown): Error {
  const version =
    typeof format === 'string' ? /^mst\.run\/v(\d+)$/.exec(format) : null;
  if (version && Number(version[1]) > 1)
    return new Error(
      `${what} was written by a newer MST (${String(format)}). Upgrade MST to read it.`
    );
  const renames = Object.entries(RENAMED_RESULT_FIELDS)
    .map(([from, to]) => `${from} → ${to}`)
    .join(', ');
  return new Error(
    `${what} was written by an earlier MST. 2.0 renamed result fields (${renames}, and more; see ${MIGRATION}) and writes runs in the ${RUN_FORMAT} format (see docs/migrations/migration-2.0.md#runs-are-directories-in-the-mstrunv1-format). Rerun to write it again.`
  );
}

function isRenamed(key: string): boolean {
  return Object.hasOwn(RENAMED_RESULT_FIELDS, key);
}

/** Result fields a 2.0 release candidate wrote, and what ADR 0013 renamed them. */
const PRERELEASE_RESULT_FIELDS: Record<string, string> = {
  trace: 'transcript',
  toolCallTrace: 'toolCallTranscript',
  traceEvidence: 'transcriptEvidence',
};

function isPrereleaseField(key: string): boolean {
  return Object.hasOwn(PRERELEASE_RESULT_FIELDS, key);
}

function hasPrereleaseFields(result: Record<string, unknown>): boolean {
  if (Object.keys(result).some(isPrereleaseField)) return true;
  return (
    Array.isArray(result.trialResults) &&
    result.trialResults.some(
      (trial) => isObject(trial) && Object.keys(trial).some(isPrereleaseField)
    )
  );
}

/**
 * Score keys a 2.0 release candidate wrote, and the assertion keys that
 * name them now. Shared with the run layout check (`scores/<grader>/`).
 */
export const PRERELEASE_SCORE_KEYS: Readonly<Record<string, string>> = {
  textContains: 'containsText',
  regex: 'matchesPattern',
};

export const RENAMED_SCORES_ANCHOR =
  'docs/migrations/2.0-prereleases.md#score-keys-are-assertion-keys';

function hasPrereleaseScores(result: Record<string, unknown>): boolean {
  const renamed = (scores: unknown) =>
    isObject(scores) &&
    Object.keys(scores).some((key) =>
      Object.hasOwn(PRERELEASE_SCORE_KEYS, key)
    );
  if (renamed(result.scores)) return true;
  return (
    Array.isArray(result.trialResults) &&
    result.trialResults.some(
      (trial) => isObject(trial) && renamed(trial.scores)
    )
  );
}

/** `textContains → containsText, regex → matchesPattern`. */
export function renamedScoreKeys(): string {
  return Object.entries(PRERELEASE_SCORE_KEYS)
    .map(([from, to]) => `${from} → ${to}`)
    .join(', ');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOlderFields(result: Record<string, unknown>): boolean {
  if (result.toolName === 'mcp_host') return true;
  if (Object.keys(result).some(isRenamed)) return true;
  const request = result.request;
  if (isObject(request) && ('scenario' in request || 'expect' in request))
    return true;
  return (
    Array.isArray(result.trialResults) &&
    result.trialResults.some(
      (trial) => isObject(trial) && Object.keys(trial).some(isRenamed)
    )
  );
}

/**
 * Throws when a saved run result (a baseline file has no schema version)
 * uses 1.x result field names.
 */
export function assertCurrentRunResult(value: unknown, what: string): void {
  const cases = isObject(value) ? value.caseResults : undefined;
  if (
    Array.isArray(cases) &&
    cases.some((result) => isObject(result) && hasOlderFields(result))
  )
    throw olderResultsError(what);
  if (
    Array.isArray(cases) &&
    cases.some((result) => isObject(result) && hasPrereleaseFields(result))
  ) {
    const renames = Object.entries(PRERELEASE_RESULT_FIELDS)
      .map(([from, to]) => `${from} → ${to}`)
      .join(', ');
    throw new Error(
      `${what} was written by an MST 2.0 release candidate, before ADR 0013 renamed its result fields (${renames}; see docs/migrations/2.0-prereleases.md#traces-are-transcripts). Rerun to write it again.`
    );
  }
  if (
    Array.isArray(cases) &&
    cases.some((result) => isObject(result) && hasPrereleaseScores(result))
  )
    throw new Error(
      `${what} was written by an MST 2.0 prerelease, before its score keys took their assertions' names (${renamedScoreKeys()}; see ${RENAMED_SCORES_ANCHOR}). Rerun to write it again.`
    );
}
