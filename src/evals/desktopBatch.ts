/**
 * The batch rules every desktop host (Cowork, ChatGPT) follows, in one place:
 *
 * - one desktop per run, claimed with a cross-process lease file;
 * - cases run one at a time, each self-contained: a case that leaves the app
 *   in an unknown state resets it before the next case, and if it can't be
 *   reset, the remaining cases are not submitted (never retried or resent);
 * - one native session per case (duplicate attribution fails the case);
 * - every error the batch surfaces is redacted against the batch's secrets;
 * - cleanup always runs; if it fails, the lease is kept for inspection and
 *   every result says so.
 *
 * A host supplies only how to prepare its desktop, run one case, reset, and
 * clean up.
 */
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostBatchRequest, HostRunResult } from './evalFrameworkTypes.js';
import {
  redactHostError,
  redactHostSecrets,
  redactedHostError,
} from './hostSecrets.js';

/** How a case left the app. */
export type DesktopContinuation =
  /** The app is in a known state; the next case can run as is. */
  | 'allowed'
  /** The app state is unknown; reset it before the next case. */
  | 'reset';

export interface DesktopCaseOutcome {
  result: HostRunResult;
  continuation: DesktopContinuation;
}

/** Native sessions already attributed to a case in this batch. */
export interface NativeSessionLedger {
  /**
   * Claims a native session for the current case. Returns false when an
   * earlier case already claimed it, so the case must not be attributed.
   */
  claim(sessionId: string): boolean;
}

export interface DesktopHostAdapter<Session> {
  /** Host name in messages, e.g. 'Cowork'. */
  readonly name: string;
  /** The desktop lease file (one run per desktop, across processes). */
  readonly lease: { directory: string; file: string };
  /** Every error this batch surfaces is redacted against these values. */
  readonly secrets: readonly string[];
  /** How the host says it returned the app to a fresh state, for messages. */
  readonly resetVerb: 'reset' | 'restarted';
  /** Sets up the desktop (settings, app launch). */
  prepare(): Promise<Session>;
  /**
   * The MCP readiness gate (`checkMcpServers` with the shared
   * `isMcpServerReady` rule) for servers that only become resolvable after
   * `prepare`. Runs before the first case; a failure
   * stops the batch with nothing submitted, and the session is still disposed.
   * Hosts that can check readiness before touching the desktop (ChatGPT, before
   * it stops the user's app) run the same gate inside `prepare` instead.
   */
  ready?(session: Session): Promise<void>;
  runCase(
    session: Session,
    request: HostBatchRequest,
    index: number,
    ledger: NativeSessionLedger
  ): Promise<DesktopCaseOutcome>;
  /**
   * Returns the app to a fresh task before `index`. Without it, a case that
   * needs a reset stops the batch.
   */
  reset?(session: Session, index: number): Promise<void>;
  /** Tears the desktop down. Receives nothing when `prepare` failed. */
  dispose(session: Session | undefined): Promise<void>;
  /** Telemetry added to every result, e.g. setup timings. */
  batchTelemetry?(session: Session | undefined): Record<string, unknown>;
}

async function claimLease(
  adapter: Pick<DesktopHostAdapter<unknown>, 'name' | 'lease'>
) {
  await mkdir(adapter.lease.directory, { recursive: true, mode: 0o700 });
  const path = join(adapter.lease.directory, adapter.lease.file);
  const handle = await open(path, 'wx', 0o600).catch(() => {
    throw new Error(
      `${adapter.name} desktop is locked by another run or an interrupted run (${path}). Use one worker; inspect stale locks before removing them.`
    );
  });
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
  } catch (error) {
    // Don't leave a lease that looks stale behind.
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return {
    /** Releases the lease; `keep` leaves the file for inspection. */
    async release(keep: boolean) {
      await handle.close();
      if (!keep) await unlink(path);
    },
  };
}

/**
 * The error to surface: the original (keeping its class and fields, e.g. a
 * readiness error's servers) when it holds no secret, otherwise a redacted
 * copy.
 */
function surfaceable(
  error: unknown,
  secrets: readonly string[],
  fallback: string
): unknown {
  if (
    error instanceof Error &&
    redactHostError(error, secrets, fallback) === error.message &&
    (error.stack === undefined ||
      redactHostSecrets(error.stack, secrets) === error.stack)
  )
    return error;
  return redactedHostError(error, secrets, fallback);
}

function notSubmitted(message: string): HostRunResult {
  return {
    finalText: '',
    events: [],
    error: message,
    telemetry: {
      caseExecution: { status: 'not-submitted', continuation: 'blocked' },
    },
  };
}

/** Runs a desktop batch under the rules above. */
export async function runDesktopBatch<Session>(
  adapter: DesktopHostAdapter<Session>,
  requests: HostBatchRequest[]
): Promise<HostRunResult[]> {
  if (!requests.length) return [];
  const secrets = [...adapter.secrets];
  const redact = (error: unknown, fallback: string): string =>
    redactHostError(error, secrets, fallback);
  const lease = await claimLease(adapter);

  const results: HostRunResult[] = [];
  const attributed = new Set<string>();
  const ledger: NativeSessionLedger = {
    claim(sessionId) {
      if (attributed.has(sessionId)) return false;
      attributed.add(sessionId);
      return true;
    },
  };
  let session: Session | undefined;
  let executionError: unknown;
  let executionFailed = false;
  let cleanupError: Error | undefined;
  try {
    session = await adapter.prepare();
    await adapter.ready?.(session);
    let resetBeforeCase = false;
    let blocked: string | undefined;
    for (const [index, request] of requests.entries()) {
      if (resetBeforeCase && !blocked) {
        resetBeforeCase = false;
        if (!adapter.reset)
          blocked = `this ${adapter.name} platform cannot reset between cases`;
        else
          try {
            await adapter.reset(session, index);
          } catch (error) {
            blocked = redact(
              error,
              adapter.resetVerb === 'restarted'
                ? 'restart failed'
                : 'reset failed'
            );
          }
      }
      if (blocked) {
        // Without an app in a known state, nothing can be sent safely.
        results.push(
          notSubmitted(
            `Not submitted because the ${adapter.name} app could not be ${adapter.resetVerb} after an earlier failed case: ${blocked}`
          )
        );
        continue;
      }
      const outcome = await adapter.runCase(session, request, index, ledger);
      results.push(outcome.result);
      resetBeforeCase = outcome.continuation === 'reset';
    }
  } catch (error) {
    executionFailed = true;
    executionError = error;
  } finally {
    let cleanupFailed = false;
    try {
      await adapter.dispose(session);
    } catch (error) {
      cleanupFailed = true;
      const message = `${adapter.name} batch cleanup failed; desktop lock retained for inspection: ${redact(error, redactHostSecrets(String(error), secrets))}`;
      for (const result of results) {
        result.error = [result.error, message].filter(Boolean).join(' ');
        result.telemetry = {
          ...result.telemetry,
          batchFailure: { kind: 'cleanup_failed', error: message },
        };
      }
      cleanupError = new Error(message);
    } finally {
      const lifecycle = adapter.batchTelemetry?.(session);
      for (const [index, result] of results.entries()) {
        // Nothing the host reports leaves unredacted.
        if (result.error)
          result.error = redactHostSecrets(result.error, secrets);
        result.telemetry = {
          ...result.telemetry,
          ...(lifecycle ? { batchLifecycle: lifecycle } : {}),
          batchCase: {
            index,
            caseId: requests[index]!.caseId,
            count: requests.length,
          },
        };
      }
      await lease.release(cleanupFailed);
    }
  }
  if (executionFailed) {
    const safeExecutionError = surfaceable(
      executionError,
      secrets,
      typeof executionError === 'string'
        ? executionError
        : `${adapter.name} batch execution failed.`
    );
    if (cleanupError)
      throw new AggregateError(
        [safeExecutionError, cleanupError],
        `${adapter.name} execution and batch cleanup failed.`
      );
    throw safeExecutionError;
  }
  if (cleanupError && !results.length) throw cleanupError;
  return results;
}

/** Throws unless every host config in a batch is the same. */
export function requireIdenticalHostSettings(
  host: string,
  configs: readonly unknown[]
): void {
  const first = JSON.stringify(configs[0]);
  if (configs.some((config) => JSON.stringify(config) !== first))
    throw new Error(
      `${host} batch requires identical host settings for all cases.`
    );
}
