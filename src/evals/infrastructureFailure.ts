import type { EvalCaseResult } from '../types/reporter.js';
import type { ClientMetadata } from './externalClient/types.js';

/**
 * Message prefixes the eval runner counts as infrastructure failures. Cowork
 * reports a Claude binding failure as text, so the runner matches these exact
 * prefixes; the Claude session watcher (`claudeSessions.ts`) throws them.
 * Keep the wording here and nowhere else.
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

/**
 * Returns true when the error message appears to be caused by network or
 * infrastructure issues (connection resets, timeouts, rate limits, etc.)
 * rather than an assertion or logic failure.
 *
 * Accepts either an Error object or a plain string error message so it can
 * classify both thrown errors and errors surfaced via result.error.
 */
export function isInfrastructureError(err: unknown): boolean {
  let name: string | undefined;
  let msg: string;
  let code: string = '';

  if (err instanceof Error) {
    name = err.name;
    msg = err.message.toLowerCase();
    code = ((err as NodeJS.ErrnoException).code ?? '').toLowerCase();
  } else if (typeof err === 'string') {
    msg = err.toLowerCase();
  } else {
    return false;
  }

  return (
    name?.toLowerCase() === 'aborterror' ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('network') ||
    msg.includes('automation permission') ||
    msg.includes('automation/accessibility') ||
    // Cowork reports Claude binding failures as text; the wording is shared.
    msg.includes(CLAUDE_NO_MATCHING_SESSION_MESSAGE.toLowerCase()) ||
    msg.includes(CLAUDE_SESSION_TIMEOUT_MESSAGE.toLowerCase()) ||
    msg.includes(COWORK_WORKSPACE_UNAVAILABLE_MESSAGE.toLowerCase()) ||
    msg.includes('failed to submit prompt to claude') ||
    msg.includes('failed to submit prompt to desktop client') ||
    // Prompt/context overflow — LLM couldn't run, not a tool discoverability failure
    msg.includes('prompt is too long') ||
    msg.includes('context length exceeded') ||
    msg.includes('maximum context length') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('tokens > ') ||
    code.includes('econnreset') ||
    code.includes('etimedout') ||
    code.includes('econnrefused')
  );
}

function isExternalClientInfrastructureFailure(
  clientMetadata: ClientMetadata | undefined
): boolean {
  return clientMetadata?.failureKind !== undefined;
}

/**
 * Whether a run failed on infrastructure (a network failure, a client that
 * couldn't start) rather than on its assertions. Such runs are left out of
 * the pass rate and of per-trial metrics.
 */
export function isInfrastructureFailure(
  result: Pick<
    EvalCaseResult,
    'error' | 'clientDiagnostics' | 'clientMetadata' | 'gradingError'
  >
): boolean {
  return (
    // A grader that couldn't run says nothing about the client.
    result.gradingError !== undefined ||
    isExternalClientInfrastructureFailure(result.clientMetadata) ||
    (result.error != null &&
      (result.clientDiagnostics?.failureKind !== undefined ||
        isInfrastructureError(result.error)))
  );
}
