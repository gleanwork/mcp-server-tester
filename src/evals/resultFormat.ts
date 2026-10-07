/**
 * The stored result format. Version 2 is the 2.0 result vocabulary (ADR
 * 0002): results name the client, not a host. Results written by an earlier
 * MST fail with what to do instead of losing fields silently.
 */
export const RESULT_SCHEMA_VERSION = 2;

/** 1.x result field names and what 2.0 calls them. */
const RENAMED_RESULT_FIELDS: Record<string, string> = {
  mcpHostTrace: 'toolCallTrace',
  hostUsage: 'clientUsage',
  hostTelemetry: 'clientTelemetry',
  hostDiagnostics: 'clientDiagnostics',
  hostEvidence: 'traceEvidence',
  externalHost: 'clientMetadata',
};

const MIGRATION =
  'docs/migrations/migration-2.0.md#result-fields-name-the-client';

export function olderResultsError(
  what: string,
  schemaVersion?: unknown
): Error {
  if (
    typeof schemaVersion === 'number' &&
    schemaVersion > RESULT_SCHEMA_VERSION
  )
    return new Error(
      `${what} was written by a newer MST (result schemaVersion ${schemaVersion}). Upgrade MST to read it.`
    );
  const renames = Object.entries(RENAMED_RESULT_FIELDS)
    .map(([from, to]) => `${from} → ${to}`)
    .join(', ');
  return new Error(
    `${what} was written by an earlier MST. 2.0 renamed result fields (${renames}, and more; see ${MIGRATION}). Rerun to write it again.`
  );
}

function isRenamed(key: string): boolean {
  return Object.hasOwn(RENAMED_RESULT_FIELDS, key);
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
    Array.isArray(result.iterationResults) &&
    result.iterationResults.some(
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
}
