import type { EvalCaseResult } from '../types/reporter.js';
import type { ClientMetadata } from './externalHost/types.js';
import {
  CLAUDE_NO_MATCHING_SESSION_MESSAGE,
  CLAUDE_SESSION_TIMEOUT_MESSAGE,
} from './externalHost/builtins/claudeSessions.js';

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
    msg.includes('failed to submit prompt to claude') ||
    msg.includes('failed to submit prompt to desktop host') ||
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

function isExternalHostInfrastructureFailure(
  clientMetadata: ClientMetadata | undefined
): boolean {
  return clientMetadata?.failureKind !== undefined;
}

/**
 * Whether a run failed on infrastructure (a network failure, a host that
 * couldn't start) rather than on its assertions. Such runs are left out of
 * the pass rate and of per-trial metrics.
 */
export function isInfrastructureFailure(
  result: Pick<EvalCaseResult, 'error' | 'clientDiagnostics' | 'clientMetadata'>
): boolean {
  return (
    isExternalHostInfrastructureFailure(result.clientMetadata) ||
    (result.error != null &&
      (result.clientDiagnostics?.failureKind !== undefined ||
        isInfrastructureError(result.error)))
  );
}
