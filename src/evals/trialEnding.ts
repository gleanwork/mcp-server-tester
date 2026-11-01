/**
 * How a client's attempt at a case ended (ADR 0010): a trial, graded as
 * usual, or an infrastructure failure, left out of pass rates. Collection
 * decides it, where the attempt ended; grading never changes it. Every
 * reader asks this module and never parses errors itself.
 */
import type { ClientDiagnostics } from '../types/clientDiagnostics.js';
import type { EvalCaseResult, TrialResult } from '../types/reporter.js';
import type { InfrastructureBreak, TrialEnding } from '../types/trialEnding.js';
import type { ExternalClientFailureKind } from './externalClient/types.js';

/**
 * Message prefixes Cowork reports a Claude binding failure with, as text. The
 * Claude session watcher (`claudeSessions.ts`) throws them. Keep the wording
 * here and nowhere else.
 */
export const CLAUDE_SESSION_TIMEOUT_MESSAGE =
  'Timed out waiting for Claude session';
export const CLAUDE_NO_MATCHING_SESSION_MESSAGE = 'No matching Claude session';
/**
 * A Cowork trial whose sandbox (Cowork's VM) didn't start: the task ran
 * without its shell, so the answer says nothing about the servers under test.
 */
export const COWORK_WORKSPACE_UNAVAILABLE_MESSAGE =
  "Cowork's workspace was unavailable";

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
 * a record from before endings or an attempt still being attached, the
 * ending its failure kinds and error say. A run stored before endings keeps
 * the classification it was recorded with.
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
    ) ??
    externalEnding(failureKindOf(evidence.clientMetadata), error) ??
    (error !== undefined ? textEnding(error) : undefined);
  if (found) return found;
  return recorded === true
    ? infrastructureEnding(
        'client-app',
        error ?? 'Recorded as an infrastructure failure.'
      )
    : TRIAL_ENDING;
}

/**
 * How an attempt ended when its client threw and MST caught the error: an
 * infrastructure failure when the error names what broke (an aborted wait,
 * a refused connection), else a trial that failed with the error.
 */
export function thrownEnding(error: unknown): TrialEnding {
  if (error instanceof Error) {
    if (error.name.toLowerCase() === 'aborterror')
      return infrastructureEnding('deadline', error.message || 'Aborted.');
    const code = String(
      (error as NodeJS.ErrnoException).code ?? ''
    ).toLowerCase();
    if (NETWORK_CODES.some((network) => code.includes(network)))
      return infrastructureEnding('network', error.message || code);
    return textEnding(error.message) ?? TRIAL_ENDING;
  }
  return typeof error === 'string'
    ? (textEnding(error) ?? TRIAL_ENDING)
    : TRIAL_ENDING;
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
  if (
    kind === 'startup' &&
    error?.startsWith(COWORK_WORKSPACE_UNAVAILABLE_MESSAGE)
  )
    return infrastructureEnding('workspace', reason);
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

const NETWORK_CODES = ['econnreset', 'etimedout', 'econnrefused'];

/**
 * Error text that names what broke, for clients that report failures only
 * as text. In the order they are tried.
 */
const TEXT_BREAKS: Array<{
  phrases: string[];
  broke: InfrastructureBreak;
  retryable: boolean;
}> = [
  {
    phrases: ['automation permission', 'automation/accessibility'],
    broke: 'setup',
    retryable: false,
  },
  {
    // The model couldn't run: a retry sends the same prompt.
    phrases: [
      'prompt is too long',
      'context length exceeded',
      'maximum context length',
      'context_length_exceeded',
      'tokens > ',
    ],
    broke: 'setup',
    retryable: false,
  },
  {
    phrases: [COWORK_WORKSPACE_UNAVAILABLE_MESSAGE.toLowerCase()],
    broke: 'workspace',
    retryable: true,
  },
  {
    phrases: [
      CLAUDE_NO_MATCHING_SESSION_MESSAGE.toLowerCase(),
      CLAUDE_SESSION_TIMEOUT_MESSAGE.toLowerCase(),
      'failed to submit prompt to claude',
      'failed to submit prompt to desktop client',
    ],
    broke: 'client-app',
    retryable: true,
  },
  {
    phrases: ['rate limit', '429', '503'],
    broke: 'provider',
    retryable: true,
  },
  {
    phrases: [...NETWORK_CODES, 'network'],
    broke: 'network',
    retryable: true,
  },
];

function textEnding(message: string): TrialEnding | undefined {
  const text = message.toLowerCase();
  const match = TEXT_BREAKS.find(({ phrases }) =>
    phrases.some((phrase) => text.includes(phrase))
  );
  return match
    ? infrastructureEnding(match.broke, message, match.retryable)
    : undefined;
}
