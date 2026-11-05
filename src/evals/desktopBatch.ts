/**
 * The batch rules every desktop client (Cowork, ChatGPT) follows, in one place:
 *
 * - one desktop per run, claimed with a cross-process lease file;
 * - for a client whose servers resolve only once its app is prepared, MST's
 *   readiness check runs after `prepare` and before the first case; when a
 *   server isn't ready, no case is sent;
 * - cases run one at a time, each self-contained: a case that leaves the app
 *   in an unknown state resets it before the next case, and if it can't be
 *   reset, the remaining cases are not submitted (never retried or resent);
 * - a failed case that leaves the app in an unknown state keeps a failure
 *   diagnosis (what the desktop showed, its logs) as its artifacts, taken
 *   before the reset changes it;
 * - after {@link MAX_CONSECUTIVE_FAILURES} failed cases in a row, the rest are
 *   not submitted: the desktop is no longer doing what the run expects;
 * - one native session per case (duplicate attribution fails the case);
 * - every error the batch surfaces is redacted against the batch's secrets;
 * - each case that ran is reported as it finishes, so the eval saves it even
 *   if the batch never ends;
 * - cleanup always runs; if it fails, the lease is kept for inspection and
 *   every result says so.
 *
 * A client supplies only how to prepare its desktop, run one case, reset,
 * diagnose, and clean up.
 */
import { mkdir, mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_ARTIFACTS } from './allArtifacts.js';
import type {
  ClientArtifacts,
  ClientBatchRequest,
  ClientContinuation,
  ClientRunContext,
  ClientRunResult,
  ClientSession,
  ClientSessionReadiness,
  ClientSessionResult,
  ClientSessionTrial,
} from './evalFrameworkTypes.js';
import {
  redactClientError,
  redactClientSecrets,
  redactedClientError,
  redactedClientRun,
} from './clientSecrets.js';
import { ClientUnavailableError } from './clientUnavailable.js';
import { stableJson } from '../skills/skillEntry.js';
import { checkServersReady, notReadyResult } from './readinessCheck.js';

/**
 * Failed cases in a row after which a batch stops submitting. A reset that
 * "succeeds" can still leave the desktop unusable (another app in front, a
 * dialog the driver can't see), and then every case fails the same way.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How long a failure diagnosis may take. A client bounds its own; this only
 * keeps a stuck one from holding the batch.
 */
const DIAGNOSE_TIMEOUT_MS = 30_000;

/** The desktop trial body uses the public session result unchanged. */
export type DesktopContinuation = ClientContinuation;
export type DesktopCaseOutcome = ClientSessionResult;

/** Native sessions already attributed to a case in this batch. */
interface NativeSessionLedger {
  /**
   * Claims a native session for the current case. Returns false when an
   * earlier case already claimed it, so the case must not be attributed.
   */
  claim(sessionId: string): boolean;
}

export interface DesktopClientAdapter<Session> {
  /** Client name in messages, e.g. 'Cowork'. */
  readonly name: string;
  /** The desktop lease file (one run per desktop, across processes). */
  readonly lease: { directory: string; file: string };
  /** Every error this batch surfaces is redacted against these values. */
  readonly secrets: readonly string[];
  /** How the client says it returned the app to a fresh state, for messages. */
  readonly resetVerb: 'reset' | 'restarted';
  /** Sets up the desktop (settings, app launch). */
  prepare(): Promise<Session>;
  /**
   * The servers MST checks before the first case, as the app will launch
   * them, for a client whose servers resolve only once `prepare` has run
   * (Cowork's stdio paths). The batch checks them right after `prepare`
   * (`checkServersReady`, with its retries); when one isn't ready, no case
   * is sent and each ends as a retryable setup failure. Such a client's
   * definition is marked with `checksServersAfterPrepare`, so the dispatch
   * doesn't also check them before the batch. A client whose servers need
   * no preparation (ChatGPT) leaves this out: the dispatch checks them
   * before the batch starts, before anything touches the desktop.
   */
  readiness?(session: Session): ClientSessionReadiness | undefined;
  runCase(
    session: Session,
    request: ClientSessionTrial,
    index: number,
    ledger: NativeSessionLedger
  ): Promise<DesktopCaseOutcome>;
  /**
   * Returns the app to a fresh task before `index`. Without it, a case that
   * needs a reset stops the batch.
   */
  reset?(session: Session, index: number): Promise<void>;
  /**
   * How long to wait before each retry of a failed reset; none by default.
   * A reset can fail transiently, e.g. an accessibility scan timing out on a
   * slow desktop (Cowork uses `RESET_RETRY_DELAYS_MS`); only when every
   * attempt fails does the batch stop submitting.
   */
  readonly resetRetryDelaysMs?: readonly number[];
  /**
   * After a failed case that leaves the app in an unknown state, before the
   * reset: writes a failure diagnosis into `dir`, an empty directory made for
   * the case (what the desktop shows, its own logs). Read-only: it never acts
   * on the app. Optional; when it fails, the case keeps only its error.
   */
  diagnose?(session: Session, dir: string): Promise<void>;
  /** Tears the desktop down. Receives nothing when `prepare` failed. */
  dispose(session: Session | undefined): Promise<void>;
  /** Telemetry added to every result, e.g. setup timings. */
  batchTelemetry?(session: Session | undefined): Record<string, unknown>;
}

async function claimLease(
  adapter: Pick<DesktopClientAdapter<unknown>, 'name' | 'lease'>
) {
  await mkdir(adapter.lease.directory, { recursive: true, mode: 0o700 });
  const path = join(adapter.lease.directory, adapter.lease.file);
  const handle = await open(path, 'wx', 0o600).catch(() => {
    // The desktop isn't this run's to use: the batch's cases can't run, but
    // an eval's other variants still can.
    throw new ClientUnavailableError(
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
    redactClientError(error, secrets, fallback) === error.message &&
    (error.stack === undefined ||
      redactClientSecrets(error.stack, secrets) === error.stack)
  )
    return error;
  return redactedClientError(error, secrets, fallback);
}

/** The existing bounded, best-effort diagnosis, exposed by the session. */
async function captureDiagnosis<Session>(
  adapter: DesktopClientAdapter<Session>,
  session: Session
): Promise<ClientArtifacts | undefined> {
  if (!adapter.diagnose) return undefined;
  let dir: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'mst-failure-'));
    await Promise.race([
      adapter.diagnose(session, dir),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('the failure diagnosis timed out')),
          DIAGNOSE_TIMEOUT_MS
        );
      }),
    ]);
    return { dir, include: ALL_ARTIFACTS, temporary: true };
  } catch {
    // Never fails the batch: the case keeps only its error.
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Keep the diagnosis beside a trial's own artifacts, when it has any. */
async function withDiagnosis(
  session: ClientSession,
  result: ClientRunResult
): Promise<ClientRunResult> {
  if (result.artifacts?.diagnosis) return result;
  const diagnosis = await session.diagnose?.();
  if (!diagnosis) return result;
  return {
    ...result,
    artifacts: result.artifacts
      ? { ...result.artifacts, diagnosis: diagnosis.dir }
      : diagnosis,
  };
}

/** Two reset retries, after 10 s then 20 s, for clients that opt in. */
export const RESET_RETRY_DELAYS_MS: readonly number[] = [10_000, 20_000];

/** `reset`, retried after each delay; throws the last attempt's error. */
async function withRetries(
  reset: () => Promise<void>,
  delays: readonly number[]
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await reset();
      return;
    } catch (error) {
      if (attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

function notSubmitted(message: string): ClientRunResult {
  return {
    finalText: '',
    events: [],
    error: message,
    // The client never ran the case: an infrastructure failure, not a grade.
    diagnostics: { failureKind: 'not-submitted' },
    telemetry: {
      caseExecution: { status: 'not-submitted', continuation: 'blocked' },
    },
  };
}

/**
 * Opens the same leased lifecycle used by the compatibility batch loop.
 * The concrete app state stays in this closure, never in a registry. Trial
 * scheduling, readiness and reset retries stay in MST's loop below.
 */
export async function openDesktopSession<Session>(
  adapter: DesktopClientAdapter<Session>
): Promise<ClientSession> {
  const secrets = [...adapter.secrets];
  const lease = await claimLease(adapter);
  let state: Session | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let index = 0;
  let continuation: ClientContinuation = 'continue';
  const attributed = new Set<string>();
  const ledger: NativeSessionLedger = {
    claim(sessionId) {
      if (attributed.has(sessionId)) return false;
      attributed.add(sessionId);
      return true;
    },
  };

  function assertOpen() {
    if (closed) throw new Error(`${adapter.name} session is closed.`);
  }

  async function dispose(): Promise<void> {
    let failed = false;
    try {
      await adapter.dispose(state);
    } catch (error) {
      failed = true;
      const reason = redactClientError(
        error,
        secrets,
        redactClientSecrets(String(error), secrets)
      );
      const message = `${adapter.name} batch cleanup failed; desktop lock retained for inspection: ${reason}`;
      console.warn(`[mst] ${message}`);
      throw new Error(message);
    } finally {
      await lease.release(failed);
    }
  }

  try {
    state = await adapter.prepare();
    const current = state;
    const readiness = adapter.readiness?.(current);
    return {
      readiness,
      get lifecycle() {
        return redactedClientRun(adapter.batchTelemetry?.(current), secrets);
      },
      async run(trial) {
        assertOpen();
        if (continuation === 'stop')
          throw new Error(`${adapter.name} session has stopped.`);
        if (continuation === 'reset')
          throw new Error(
            `${adapter.name} session requires reset before another trial.`
          );
        // TypeScript excludes these settings; reject them at runtime too,
        // rather than silently running a trial against different settings.
        if (
          Object.keys(trial).some(
            (key) => !['caseId', 'trial', 'input'].includes(key)
          ) ||
          Object.keys(trial.input).some((key) => key !== 'prompt')
        )
          throw new Error(
            `${adapter.name} session trials accept only identity and prompt; settings are fixed at open.`
          );
        if (!trial.input.prompt.trim())
          throw new Error(`${adapter.name} requires a non-empty input.`);
        try {
          const outcome = await adapter.runCase(
            current,
            trial,
            index++,
            ledger
          );
          continuation = outcome.continuation;
          return {
            ...outcome,
            result: redactedClientRun(outcome.result, secrets),
          };
        } catch (error) {
          continuation = 'stop';
          throw typeof error === 'string'
            ? redactClientSecrets(error, secrets)
            : surfaceable(
                error,
                secrets,
                `${adapter.name} batch execution failed.`
              );
        }
      },
      async reset() {
        assertOpen();
        if (continuation === 'stop')
          throw new Error(`${adapter.name} session has stopped.`);
        if (!adapter.reset)
          throw new Error(
            `this ${adapter.name} platform cannot reset between cases`
          );
        try {
          await adapter.reset(current, index);
          continuation = 'continue';
        } catch (error) {
          continuation = 'reset';
          throw surfaceable(
            error,
            secrets,
            adapter.resetVerb === 'restarted'
              ? 'restart failed'
              : 'reset failed'
          );
        }
      },
      ...(adapter.diagnose
        ? {
            async diagnose() {
              assertOpen();
              return captureDiagnosis(adapter, current);
            },
          }
        : {}),
      close() {
        closed = true;
        closing ??= dispose();
        return closing;
      },
    };
  } catch (error) {
    const safeError = surfaceable(
      error,
      secrets,
      typeof error === 'string'
        ? error
        : `${adapter.name} batch execution failed.`
    );
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [safeError, cleanupError],
        `${adapter.name} execution and batch cleanup failed.`
      );
    }
    throw safeError;
  }
}

/**
 * Runs a desktop batch under the rules above. `reportResult` (the batch
 * context's) receives a redacted copy of each case's result as it finishes.
 */
export async function runDesktopBatch<Session>(
  adapter: DesktopClientAdapter<Session>,
  requests: ClientBatchRequest[],
  reportResult?: ClientRunContext['reportResult'],
  /** The batch context's `acquire`: room for a case under the run's limits. */
  acquire?: ClientRunContext['acquire']
): Promise<ClientRunResult[]> {
  if (!requests.length) return [];
  const secrets = [...adapter.secrets];
  const redact = (error: unknown, fallback: string): string =>
    redactClientError(error, secrets, fallback);
  const session = await openDesktopSession(adapter);
  const results: ClientRunResult[] = [];
  let executionError: unknown;
  let executionFailed = false;
  let cleanupError: Error | undefined;
  try {
    let resetBeforeCase = false;
    let blocked: string | undefined;
    const target = session.readiness;
    const readiness = target?.servers.length
      ? await checkServersReady(target.servers, {
          ...(target.resolve ? { resolve: target.resolve } : {}),
          ...(target.env ? { env: target.env } : {}),
        })
      : undefined;
    // No case is sent: each ends as a setup failure a retry can help.
    if (readiness && !readiness.ready) {
      console.warn(
        `[mst] The ${adapter.name} batch didn't run: ${redactClientSecrets(readiness.reason, secrets)}`
      );
      results.push(...requests.map(() => notReadyResult(readiness)));
    }
    const toRun = readiness && !readiness.ready ? [] : requests;
    // `the Cowork app`, and `the Codex app`, not `the Codex app app`.
    const theApp = adapter.name.endsWith(' app')
      ? `the ${adapter.name}`
      : `the ${adapter.name} app`;
    let consecutiveFailures = 0;
    for (const [index, request] of toRun.entries()) {
      if (resetBeforeCase && !blocked) {
        resetBeforeCase = false;
        if (!adapter.reset)
          blocked = `Not submitted because ${theApp} could not be ${adapter.resetVerb} after an earlier failed case: this ${adapter.name} platform cannot reset between cases`;
        else
          try {
            await withRetries(
              () => session.reset(),
              adapter.resetRetryDelaysMs ?? []
            );
          } catch (error) {
            blocked = `Not submitted because ${theApp} could not be ${adapter.resetVerb} after an earlier failed case: ${redact(
              error,
              adapter.resetVerb === 'restarted'
                ? 'restart failed'
                : 'reset failed'
            )}`;
          }
      }
      if (blocked) {
        // Without an app in a known state, nothing can be sent safely.
        results.push(notSubmitted(blocked));
        continue;
      }
      await acquire?.(index);
      const outcome = await session.run({
        caseId: request.caseId,
        trial: request.trial,
        input: { prompt: request.input.prompt },
      });
      resetBeforeCase = outcome.continuation === 'reset';
      // Before the reset changes what the desktop shows.
      const result =
        resetBeforeCase && outcome.result.error
          ? await withDiagnosis(session, outcome.result)
          : outcome.result;
      results.push(result);
      // A copy: the batch adds to its results when it ends.
      await reportResult?.(index, redactedClientRun(result, secrets));
      if (outcome.continuation === 'stop')
        blocked = `Not submitted because the ${adapter.name} session stopped after an earlier case.`;
      consecutiveFailures = result.error ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        blocked = `Not submitted because the last ${MAX_CONSECUTIVE_FAILURES} ${adapter.name} cases failed in a row (latest: ${redactClientSecrets(result.error ?? '', secrets)}). Check the desktop before running again.`;
    }
  } catch (error) {
    if (results.length > 0) {
      // Cases already ran: keep their traces, and say why the rest didn't.
      const reason = redact(error, `${adapter.name} batch execution failed.`);
      // The case that threw may have been submitted: its outcome is unknown.
      if (results.length < requests.length) {
        const failed: ClientRunResult = {
          ...notSubmitted(`The ${adapter.name} case failed: ${reason}`),
          diagnostics: { failureKind: 'process' },
          telemetry: {
            caseExecution: { status: 'failed', continuation: 'blocked' },
          },
        };
        // The desktop is still up: keep what it showed.
        results.push(await withDiagnosis(session, failed));
      }
      while (results.length < requests.length)
        results.push(
          notSubmitted(
            `Not submitted because the ${adapter.name} batch stopped: ${reason}`
          )
        );
    } else {
      executionFailed = true;
      executionError = error;
    }
  } finally {
    try {
      await session.close();
    } catch (error) {
      const message = redact(error, `${adapter.name} batch cleanup failed.`);
      for (const result of results) {
        // The desktop's state is unknown, so no case counts; but this is the
        // desktop failing, not the client: an infrastructure failure.
        result.error = [result.error, message].filter(Boolean).join(' ');
        result.diagnostics = {
          ...result.diagnostics,
          failureKind: result.diagnostics?.failureKind ?? 'cleanup',
        };
        result.telemetry = {
          ...result.telemetry,
          batchFailure: { kind: 'cleanup_failed', error: message },
        };
      }
      cleanupError = new Error(message);
    } finally {
      const lifecycle = session.lifecycle;
      for (const [index, result] of results.entries()) {
        // Nothing the client reports leaves unredacted: the whole result,
        // with the batch's own telemetry, is what the batch returns.
        results[index] = redactedClientRun(
          {
            ...result,
            telemetry: {
              ...result.telemetry,
              ...(lifecycle ? { batchLifecycle: lifecycle } : {}),
              batchCase: {
                index,
                caseId: requests[index]!.caseId,
                count: requests.length,
              },
            },
          },
          secrets
        );
      }
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

/**
 * Throws unless every client config in a batch is the same. Key order doesn't
 * count, as it doesn't where the eval groups requests into batches.
 */
export function requireIdenticalClientSettings(
  client: string,
  configs: readonly unknown[]
): void {
  const first = stableJson(configs[0]);
  if (configs.some((config) => stableJson(config) !== first))
    throw new Error(
      `${client} batch requires identical client settings for all cases.`
    );
}
