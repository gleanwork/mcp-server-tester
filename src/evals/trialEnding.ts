/**
 * How a client's attempt at a case ended (ADR 0010): a trial, graded as
 * usual, or an infrastructure failure, left out of pass rates. Collection
 * decides it, where the attempt ended; grading never changes it. Every
 * reader asks this module, and nothing here reads an error's words: a
 * producer that gets its failures as text (a provider SDK, a desktop app)
 * types them where it gets them.
 */
import type { ClientDiagnostics } from '../types/clientDiagnostics.js';
import type { EvalCaseResult, TrialResult } from '../types/reporter.js';
import type { InfrastructureBreak, TrialEnding } from '../types/trialEnding.js';
import type { ExternalClientFailureKind } from './externalClient/types.js';

/** Every value an infrastructure failure can name, for schemas. */
export const INFRASTRUCTURE_BREAKS = [
  'client-app',
  'workspace',
  'network',
  'provider',
  'collection',
  'deadline',
  'setup',
] as const satisfies readonly InfrastructureBreak[];

/** The attempt is a trial: its graders score it, and it counts. */
export const TRIAL_ENDING: TrialEnding = Object.freeze({ kind: 'trial' });

export function infrastructureEnding(
  broke: InfrastructureBreak,
  reason: string,
  retryable = true
): TrialEnding {
  return { kind: 'infrastructure', broke, retryable, reason };
}

/**
 * A client that ran out of context (ADR 0010). After the client acted, its
 * own turns and tool results filled the context: a trial, which counts
 * against it. Before it acted, the case's prompt didn't fit: a setup failure
 * a retry can't help. Each producer decides from its own provider's text
 * whether the context ran out, and whether the client had acted.
 */
export function contextOverflowEnding(
  reason: string,
  acted: boolean
): TrialEnding {
  return acted
    ? TRIAL_ENDING
    : infrastructureEnding(
        'setup',
        `The case's prompt didn't fit the model's context before the client acted: ${reason}`,
        false
      );
}

/**
 * What a trial result, a stored trial record or a client's result says about
 * how its attempt ended. Records from before endings carry only the old
 * fields; `endingOf` maps those.
 */
export interface EndingEvidence {
  ending?: TrialEnding;
  error?: string | null;
  /** A trial result's or a stored record's client diagnostics. */
  clientDiagnostics?: unknown;
  /** A client result's diagnostics (`ClientRunResult`). */
  diagnostics?: unknown;
  clientMetadata?: unknown;
  /** A stored trial record's classification before endings. */
  infrastructureError?: boolean;
  /** A trial result's classification before endings. */
  isInfrastructureError?: boolean;
  gradingError?: string;
}

/**
 * How an attempt ended. Its recorded ending when it has one. Otherwise, for
 * a record from before endings or a result its producer didn't type, the
 * ending its failure kinds say: an error alone is a trial that failed. A
 * stored record from before endings keeps the classification it was
 * recorded with (`infrastructureError`); when its failure kinds don't say
 * what broke, it is the client app, and a retry can help.
 */
export function endingOf(evidence: EndingEvidence): TrialEnding {
  if (evidence.ending) return evidence.ending;
  // Graders run only on an attempt that ended without an error, so a grading
  // error says the client's attempt ended fine: a trial, just not graded.
  if (evidence.gradingError !== undefined) return TRIAL_ENDING;
  const recorded =
    evidence.infrastructureError ?? evidence.isInfrastructureError;
  if (recorded === false) return TRIAL_ENDING;
  const error = evidence.error ?? undefined;
  const found =
    diagnosticEnding(
      failureKindOf(evidence.clientDiagnostics ?? evidence.diagnostics),
      error
    ) ?? externalEnding(failureKindOf(evidence.clientMetadata), error);
  if (found) return found;
  return recorded === true
    ? infrastructureEnding(
        'client-app',
        error ?? 'Recorded as an infrastructure failure.'
      )
    : TRIAL_ENDING;
}

/**
 * How an attempt ended when its client threw and MST caught the error. An
 * aborted wait is a deadline, and a Node network error (by its `code`, or
 * its cause's, as `fetch` reports one) is the network. Anything else is a
 * trial that failed with the error: a client that knows what broke returns
 * its ending instead of throwing.
 */
export function thrownEnding(error: unknown): TrialEnding {
  if (!(error instanceof Error)) return TRIAL_ENDING;
  if (error.name === 'AbortError')
    return infrastructureEnding('deadline', error.message || 'Aborted.');
  const code = networkCode(error) ?? networkCode(error.cause);
  return code
    ? infrastructureEnding('network', error.message || code)
    : TRIAL_ENDING;
}

/** Node's codes for a connection that failed or was refused. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function networkCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && NETWORK_CODES.has(code) ? code : undefined;
}

export function isInfrastructure(evidence: EndingEvidence): boolean {
  return endingOf(evidence).kind === 'infrastructure';
}

/**
 * Whether a trial counts toward pass rates: its attempt was a trial and its
 * graders scored it.
 */
export function isCounted(evidence: EndingEvidence): boolean {
  return (
    evidence.gradingError === undefined && endingOf(evidence).kind === 'trial'
  );
}

/**
 * What `mst run --resume` collects: a trial the run doesn't have, or an
 * infrastructure failure a retry can help. A trial the client ran is kept,
 * passed or failed: that is the trial's result.
 */
export function resumeCollects(evidence: EndingEvidence | undefined): boolean {
  if (evidence === undefined) return true;
  const ending = endingOf(evidence);
  return ending.kind === 'infrastructure' && ending.retryable;
}

/** Why a case is incomplete: neither passed nor failed (ADR 0010). */
export interface CaseIncompleteness {
  /** Its infrastructure failures: the trials it is short. */
  shortTrials: number;
  /** Of those, the ones a retry can't help: they need a fix to the eval, the case or the setup. */
  needsFix: number;
  /** Trials its graders couldn't score; `mst grade --resume` grades them. */
  ungradedTrials: number;
}

/** A case result's trials: its trial results, or the case itself when it ran once. */
function caseTrials(
  result: EvalCaseResult
): Array<TrialResult | EvalCaseResult> {
  return result.trialResults?.length ? result.trialResults : [result];
}

/**
 * Why a case is incomplete, or `undefined` when every trial it declares ran
 * and was graded. An incomplete case is left out of pass rates until it is
 * completed.
 */
export function caseIncompleteness(
  result: EvalCaseResult
): CaseIncompleteness | undefined {
  let shortTrials = 0;
  let needsFix = 0;
  let ungradedTrials = 0;
  for (const trial of caseTrials(result)) {
    const ending = endingOf(trial);
    if (ending.kind === 'infrastructure') {
      shortTrials++;
      if (!ending.retryable) needsFix++;
    } else if (trial.gradingError !== undefined) ungradedTrials++;
  }
  return shortTrials + ungradedTrials > 0
    ? { shortTrials, needsFix, ungradedTrials }
    : undefined;
}

export function isIncompleteCase(result: EvalCaseResult): boolean {
  return caseIncompleteness(result) !== undefined;
}

/** A case's results that count toward pass rates: complete ones. */
export function completeCases<T extends EvalCaseResult>(results: T[]): T[] {
  return results.filter((result) => !isIncompleteCase(result));
}

type DiagnosticFailureKind = NonNullable<ClientDiagnostics['failureKind']>;

/** What each client diagnostic kind says broke, and whether a retry can help. */
const DIAGNOSTIC_BREAKS: Record<
  DiagnosticFailureKind,
  [InfrastructureBreak, boolean]
> = {
  startup: ['client-app', true],
  timeout: ['deadline', true],
  process: ['client-app', true],
  output: ['client-app', true],
  'not-submitted': ['client-app', true],
  cleanup: ['client-app', true],
  missing: ['collection', true],
  artifacts: ['collection', true],
  // The desktop kept only part of the prompt: a retry gets the same part.
  input: ['setup', false],
};

/** What each external client failure kind (ChatGPT, macOS desktops) says broke. */
const EXTERNAL_BREAKS: Record<
  ExternalClientFailureKind,
  [InfrastructureBreak, boolean]
> = {
  app_unavailable: ['client-app', true],
  automation_permission_denied: ['setup', false],
  submission_failed: ['client-app', true],
  no_matching_session: ['client-app', true],
  ambiguous_matching_sessions: ['client-app', true],
  timeout: ['deadline', true],
  parse_failure: ['client-app', true],
  client_run_failed: ['client-app', true],
  cleanup_failed: ['client-app', true],
  unsupported_client: ['setup', false],
  unknown: ['client-app', true],
};

function failureKindOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const kind = (value as { failureKind?: unknown }).failureKind;
  return typeof kind === 'string' ? kind : undefined;
}

function diagnosticEnding(
  kind: string | undefined,
  error: string | undefined
): TrialEnding | undefined {
  if (kind === undefined) return undefined;
  const reason = error ?? `The client's attempt ended with "${kind}".`;
  const [broke, retryable] = DIAGNOSTIC_BREAKS[
    kind as DiagnosticFailureKind
  ] ?? ['client-app', true];
  return infrastructureEnding(broke, reason, retryable);
}

function externalEnding(
  kind: string | undefined,
  error: string | undefined
): TrialEnding | undefined {
  if (kind === undefined) return undefined;
  const [broke, retryable] = EXTERNAL_BREAKS[
    kind as ExternalClientFailureKind
  ] ?? ['client-app', true];
  return infrastructureEnding(
    broke,
    error ?? `The client's attempt ended with "${kind}".`,
    retryable
  );
}
