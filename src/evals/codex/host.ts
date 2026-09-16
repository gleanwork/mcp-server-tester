import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  ApprovalAutomationError,
  createAutomatedApprovalDriver,
  type ApprovalReceipt,
} from '../approvalAutomation.js';
import type { HostDefinition, HostRunResult } from '../evalFrameworkTypes.js';
import {
  CODEX_GUARDIAN_APPROVAL_POLICY,
  createCodexGuardianApprovalAdapter,
} from './approval.js';
import {
  getCodexElectronFailureDiagnostic,
  launchCodexElectron,
  type CodexElectronErrorName,
  type CodexElectronFailureReason,
  type CodexElectronLaunch,
  type CodexElectronOptions,
  type CodexElectronSession,
  type CodexElectronStage,
} from './electron.js';
import {
  createCodexElectronControl,
  type CodexElectronSubmitReceipt,
  type CodexFreshWorkspaceDiagnostic,
} from './electronControl.js';
import {
  installCodexFixtureConfig,
  renderCodexFixtureBlocks,
  type CodexFixtureInstallation,
} from './fixtureConfig.js';
import {
  baselineCodexNativeState,
  collectCodexNativeEvidence,
  CODEX_DESKTOP_BUILD,
  type CodexNativeBaseline,
  type CodexNativeCollection,
} from './nativeEvidence.js';
import {
  assertCodexProfileOwner,
  createCodexProfileOwner,
  lockCodexProfileOperation,
  prepareCodexProfile,
  profileStateExists,
  saveCodexProfileOwner,
  type CodexProfile,
  type CodexProfileOwner,
} from './profile.js';

export interface CodexHostSubmitReceipt extends CodexElectronSubmitReceipt {
  readonly version: 1;
  readonly profileId: string;
}

export interface CodexHostDependencies {
  /** Test seam only. Production uses the one Playwright Electron launch handle. */
  launchElectron?: (options: CodexElectronOptions) => CodexElectronLaunch;
  /** Test seams only. Production uses the pinned native SQLite adapter. */
  baselineNativeState?: typeof baselineCodexNativeState;
  collectNativeEvidence?: typeof collectCodexNativeEvidence;
  status?: (message: string) => void;
}

export const CodexFirstHostSchema = z
  .object({
    type: z.literal('codex-desktop-first'),
    attemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
    executablePath: z.string().refine(isAbsolute),
    profilePath: z.string().refine(isAbsolute),
    outputDir: z.string().refine(isAbsolute),
    appVersion: z.literal(CODEX_DESKTOP_BUILD).default(CODEX_DESKTOP_BUILD),
    timeoutMs: z.number().int().positive().max(180_000).default(60_000),
    cleanupTimeoutMs: z.number().int().positive().max(60_000).default(30_000),
  })
  .strict();

export type CodexFirstHostConfig = z.output<typeof CodexFirstHostSchema>;

class DeadlineExpired extends Error {}

const CODEX_HOST_STAGES = [
  'preflight',
  'owned profile preflight',
  'attempt reservation',
  'output reservation',
  'fixture config installation',
  'launch checkpoint',
  'owned Electron launch',
  'owned Electron readiness',
  'native baseline',
  'baseline artifact',
  'owned window observation',
  'owned window artifact',
  'workspace checkpoint',
  'fresh workspace',
  'approval mode observation',
  'approval mode write-ahead',
  'approval mode dispatch',
  'approval mode verification',
  'approval mode receipt',
  'approval mode artifact',
  'exact prompt entry',
  'at-most-once submit',
  'submit checkpoint',
  'native evidence',
  'native evidence wait',
  'native evidence artifact',
] as const;

type CodexHostStage = (typeof CODEX_HOST_STAGES)[number];
type CodexHostFailureStage =
  | CodexHostStage
  | `${CodexHostStage}/${CodexElectronStage}`;

interface CodexHostFailureDiagnostic {
  readonly version: 1;
  readonly stage: CodexHostFailureStage;
  readonly errorName: CodexElectronErrorName;
  readonly reason: CodexElectronFailureReason;
  readonly freshWorkspace?: CodexFreshWorkspaceDiagnostic;
}

// A promise alone does not keep Node alive. An uncertain native lifetime must
// retain the fixture-config backup and all Playwright ownership handles.
const retainedLifetimes = new Set<{
  resources: () => unknown;
  keepAlive: ReturnType<typeof setInterval>;
}>();

interface CodexBrowserGlobal {
  location: { href: string };
  document: { querySelectorAll(selector: string): ArrayLike<unknown> };
}

/** Pure startup probe. Fresh-workspace and empty-composer checks stay in control. */
function codexWindowReady() {
  const browser = globalThis as unknown as CodexBrowserGlobal;
  return {
    readyRoute: browser.location.href === 'app://-/index.html',
    appContents:
      browser.document.querySelectorAll('[data-codex-composer-root]').length >
      0,
  };
}

/** One canonical run seam. Scoring and evaluator oracles never enter this host. */
export function createCodexDesktopHost(
  dependencies: CodexHostDependencies = {}
): HostDefinition {
  return {
    name: 'codex-desktop-first',
    schema: CodexFirstHostSchema,
    // Native SQLite evidence is structured only after strict correlation and ledger reconciliation.
    evidence: 'structured',
    async run(input, rawConfig, context) {
      const started = Date.now();
      const parsed = CodexFirstHostSchema.safeParse(rawConfig);
      if (!parsed.success)
        return emptyResult(
          'Invalid first-host configuration; no app was launched.'
        );
      const config = parsed.data;
      const executionDeadline = started + config.timeoutMs;
      let stage: CodexHostStage = 'preflight';
      let profile: CodexProfile | undefined;
      let profileOwner: CodexProfileOwner | undefined;
      let installation: CodexFixtureInstallation | undefined;
      let releaseAttempt: (() => Promise<void>) | undefined;
      let checkpoint:
        | ((state: string, receipt?: CodexHostSubmitReceipt) => Promise<void>)
        | undefined;
      let outputDir: string | undefined;
      let launch: CodexElectronLaunch | undefined;
      let session: CodexElectronSession | undefined;
      let baseline: CodexNativeBaseline | undefined;
      let lastCollection: CodexNativeCollection | undefined;
      let receipt: CodexHostSubmitReceipt | undefined;
      let receiptStarted = false;
      let submitAcknowledged = false;
      let submitUncertain = false;
      let evidencePersisted = false;
      let executionSettled = false;
      let cleanupPending: Promise<unknown> | undefined;
      let shutdownPending: Promise<unknown> | undefined;
      let cleanExit = false;
      let configRestored = false;
      let quarantined = false;
      let finalized = false;
      let failureDiagnostic: CodexHostFailureDiagnostic | undefined;
      let freshWorkspaceDiagnostic: CodexFreshWorkspaceDiagnostic | undefined;
      const correlationMarker = randomUUID();
      const fullPrompt = `${input.scenario}\n\n[Desktop evaluation correlation: ${correlationMarker}]`;
      const fullPromptSha256 = createHash('sha256')
        .update(fullPrompt)
        .digest('hex');
      let result = emptyResult('No qualified native desktop evidence.');

      function checkExecution(): void {
        if (Date.now() >= executionDeadline) throw new DeadlineExpired();
      }

      async function step<T>(
        name: CodexHostStage,
        action: () => Promise<T>
      ): Promise<T> {
        checkExecution();
        stage = name;
        const value = await action();
        checkExecution();
        return value;
      }

      async function execute(): Promise<void> {
        if (
          !input.scenario ||
          !input.scenario.trim() ||
          Buffer.byteLength(input.scenario, 'utf8') > 64 * 1024 ||
          Object.keys(input.env ?? {}).length > 0 ||
          Object.keys(context.env ?? {}).length > 0
        )
          throw new Error('Explicit nonsecret scenario/server inputs only.');
        renderCodexFixtureBlocks(input.servers);
        profile = await step('owned profile preflight', () =>
          prepareCodexProfile(config.profilePath)
        );
        await step('attempt reservation', async () => {
          const reservation = await reserveAttempt(profile!, config.attemptId);
          profileOwner = reservation.owner;
          releaseAttempt = () => reservation.release();
          let savedReceipt: CodexHostSubmitReceipt | undefined;
          let writes = Promise.resolve();
          checkpoint = (state, nextReceipt) => {
            savedReceipt = nextReceipt ?? savedReceipt;
            const record = {
              version: 1,
              attemptId: config.attemptId,
              profileId: profile!.id,
              outputDir: config.outputDir,
              correlationMarker,
              fullPromptSha256,
              state,
              outcome: evidencePersisted ? 'completed' : 'failed',
              receipt: savedReceipt,
            };
            writes = writes.then(() =>
              saveCheckpoint(reservation.directory, record)
            );
            return writes;
          };
          await checkpoint('reserved');
        });
        await step('output reservation', async () => {
          await mkdir(config.outputDir, { mode: 0o700 });
          outputDir = await realpath(config.outputDir);
          if (outputDir !== config.outputDir)
            throw new Error('Output directory must be canonical.');
          await assertPrivateDirectory(outputDir);
          await saveArtifact(outputDir, 'request.json', {
            attemptId: config.attemptId,
            profileId: profile!.id,
            correlationMarker,
            scenario: input.scenario,
            fullPrompt,
            fullPromptSha256,
            servers: input.servers,
          });
        });
        installation = await step('fixture config installation', () =>
          installCodexFixtureConfig(profile!, input.servers, profileOwner)
        );
        await step('launch checkpoint', () => checkpoint!('launching'));
        await step('owned Electron launch', async () => {
          const launchElectron =
            dependencies.launchElectron ?? launchCodexElectron;
          launch = launchElectron({
            executablePath: config.executablePath,
            profilePath: profile!.root,
            profileOwner,
            executionDeadline,
            cleanupTimeoutMs: config.cleanupTimeoutMs,
            windowReady: codexWindowReady,
          });
        });
        session = await step('owned Electron readiness', () => launch!.ready);
        if (
          session.profile.id !== profile.id ||
          session.profile.root !== profile.root
        )
          throw new Error('Electron session profile mismatch.');

        // This inventory must precede the fresh-workspace deep link.
        baseline = await step('native baseline', () =>
          (dependencies.baselineNativeState ?? baselineCodexNativeState)(
            profile!,
            session!.workspacePath,
            config.appVersion
          )
        );
        await step('baseline artifact', () =>
          saveArtifact(outputDir!, 'baseline.json', baseline)
        );

        const control = createCodexElectronControl({
          session,
          attemptId: config.attemptId,
          onFreshWorkspaceObservation(diagnostic) {
            freshWorkspaceDiagnostic = diagnostic;
          },
          async beforeSubmit(controllerReceipt) {
            receiptStarted = true;
            checkExecution();
            const proof = session!.windowProof;
            const candidate: CodexHostSubmitReceipt = {
              version: 1,
              profileId: profile!.id,
              ...controllerReceipt,
            };
            if (
              receipt ||
              candidate.attemptId !== config.attemptId ||
              candidate.pid !== session!.process.pid ||
              candidate.pid !== proof.pid ||
              candidate.browserWindowId !== proof.browserWindowId ||
              candidate.webContentsId !== proof.webContentsId ||
              candidate.workspace !== session!.workspacePath ||
              candidate.fullPromptSha256 !== fullPromptSha256 ||
              candidate.inputMode !== 'playwright-fill' ||
              candidate.readback !== 'exact'
            )
              throw new Error('Unverified or repeated submit receipt.');
            await checkpoint!('submit-armed', candidate);
            await saveArtifact(outputDir!, 'submit-receipt.json', candidate);
            checkExecution();
            receipt = candidate;
          },
        });
        const observation = await step('owned window observation', () =>
          control.observe()
        );
        if (
          observation.pid !== session.process.pid ||
          observation.browserWindowId !== session.windowProof.browserWindowId ||
          observation.webContentsId !== session.windowProof.webContentsId
        )
          throw new Error('Unverified owned window observation.');
        await step('owned window artifact', () =>
          saveArtifact(outputDir!, 'owned-window.json', {
            profileId: profile!.id,
            pid: observation.pid,
            browserWindowId: observation.browserWindowId,
            webContentsId: observation.webContentsId,
          })
        );
        await step('workspace checkpoint', () =>
          checkpoint!('opening-fresh-workspace')
        );
        await step('fresh workspace', () =>
          control.openFreshWorkspace(session!.workspacePath)
        );

        const approvalAdapter = createCodexGuardianApprovalAdapter({
          session,
          onStage(approvalStage) {
            checkExecution();
            stage =
              approvalStage === 'observation'
                ? 'approval mode observation'
                : approvalStage === 'dispatch'
                  ? 'approval mode dispatch'
                  : 'approval mode verification';
          },
        });
        const approvalReceiptStates = new Set<ApprovalReceipt['state']>();
        const approvalDriver = createAutomatedApprovalDriver({
          policy: CODEX_GUARDIAN_APPROVAL_POLICY,
          adapter: approvalAdapter,
          journal: {
            async append(approvalReceipt) {
              checkExecution();
              if (
                approvalReceipt.host !== 'codex' ||
                approvalReceipt.isolationKey !==
                  `${profile!.id}:${config.attemptId}` ||
                approvalReceipt.policyId !==
                  CODEX_GUARDIAN_APPROVAL_POLICY.id ||
                approvalReceiptStates.has(approvalReceipt.state)
              )
                throw new Error('Invalid or repeated approval mode receipt.');
              stage =
                approvalReceipt.state === 'armed'
                  ? 'approval mode write-ahead'
                  : 'approval mode receipt';
              await saveArtifact(
                outputDir!,
                `approval-mode-${approvalReceipt.state}.json`,
                approvalReceipt
              );
              await checkpoint!(`approval-mode-${approvalReceipt.state}`);
              approvalReceiptStates.add(approvalReceipt.state);
              checkExecution();
            },
          },
        });
        const approvalResult = await step('approval mode observation', () =>
          approvalDriver.drive({
            host: 'codex',
            isolationKey: `${profile!.id}:${config.attemptId}`,
            deadline: executionDeadline,
            targetApprovals: 1,
            isComplete: () => approvalAdapter.isConfigured(),
          })
        );
        const approvalSource = approvalAdapter.configurationSource();
        if (
          !approvalAdapter.isConfigured() ||
          (approvalResult.approvals === 0 && approvalSource !== 'observed') ||
          (approvalResult.approvals === 1 && approvalSource !== 'verified') ||
          (approvalResult.approvals !== 0 && approvalResult.approvals !== 1)
        )
          throw new Error('Codex approval mode was not positively configured.');
        await step('approval mode artifact', () =>
          saveArtifact(outputDir!, 'approval-mode.json', {
            version: 1,
            action: {
              kind: 'host_permission_mode',
              attributes: {
                surface: 'codex',
                mode: 'guardian-approvals',
                scope: 'current_task',
              },
            },
            status:
              approvalSource === 'observed'
                ? 'already-configured'
                : 'configured',
            approvals: approvalResult.approvals,
          })
        );
        await step('exact prompt entry', () =>
          control.replacePrompt(fullPrompt)
        );
        const acknowledgement = await step('at-most-once submit', () =>
          control.submitOnce()
        );
        if (!receipt)
          throw new Error('Control bypassed the durable submit receipt.');
        submitUncertain = acknowledgement.status === 'uncertain';
        submitAcknowledged = acknowledgement.status === 'acknowledged';
        await step('submit checkpoint', () =>
          checkpoint!(
            submitUncertain ? 'submit-uncertain' : 'submit-acknowledged'
          )
        );

        const request = {
          profileId: profile.id,
          appVersion: config.appVersion,
          workspace: session.workspacePath,
          promptSha256: fullPromptSha256,
          servers: input.servers.map((server) => server.label!),
        };
        for (;;) {
          lastCollection = await step('native evidence', () =>
            (dependencies.collectNativeEvidence ?? collectCodexNativeEvidence)(
              profile!,
              baseline!,
              request
            )
          );
          if (lastCollection.evidence.terminal || submitUncertain) break;
          await step('native evidence wait', () =>
            delay(Math.min(250, Math.max(1, executionDeadline - Date.now())))
          );
        }
        if (submitUncertain)
          throw new Error('Submit acknowledgement is uncertain.');
        if (
          lastCollection.evidence.qualification !== 'qualified' ||
          !lastCollection.evidence.terminal
        )
          throw new Error('Native evidence is incomplete.');
        result = lastCollection.evidence.trace;
        await step('native evidence artifact', async () => {
          await saveArtifact(
            outputDir!,
            'native-evidence.json',
            lastCollection!.evidence
          );
          await saveArtifact(
            outputDir!,
            'native-database.json',
            lastCollection!.database
          );
        });
        evidencePersisted = true;
      }

      const execution = execute().finally(() => {
        executionSettled = true;
      });
      try {
        await beforeDeadline(execution, executionDeadline);
      } catch (error) {
        // A durable receipt authorizes the only click. Any later failure is an
        // unknown or incomplete submitted run, even if the app later exits.
        submitUncertain ||= receiptStarted && receipt !== undefined;
        quarantined ||=
          error instanceof ApprovalAutomationError && error.quarantine;
        failureDiagnostic = {
          ...safeFailureDiagnostic(stage, error),
          ...(freshWorkspaceDiagnostic
            ? { freshWorkspace: freshWorkspaceDiagnostic }
            : {}),
        };
        result = emptyResult(
          `Codex first-host failed during ${failureDiagnostic.stage}; error=${failureDiagnostic.errorName}; reason=${failureDiagnostic.reason}; no retry was attempted.`
        );
      }

      const cleanupDeadline = Date.now() + config.cleanupTimeoutMs;
      const resourceDeadline =
        cleanupDeadline -
        Math.min(1000, Math.ceil(config.cleanupTimeoutMs / 3));
      async function clean<T>(action: () => Promise<T>): Promise<T> {
        if (Date.now() >= resourceDeadline) throw new DeadlineExpired();
        cleanupPending = action();
        return beforeDeadline(cleanupPending as Promise<T>, resourceDeadline);
      }

      let cleanupSafe = false;
      try {
        // Drain the Playwright/native boundary before the host continuation.
        if (launch) await clean(() => launch!.settled());
        await clean(() => execution.catch(() => {}));
        if (!executionSettled) throw new DeadlineExpired();
        const submittedIncomplete =
          receipt !== undefined && (!submitAcknowledged || !evidencePersisted);
        const retainedUnknownConfig =
          profile !== undefined &&
          installation === undefined &&
          (await clean(() => exists(join(profile!.root, '.fixture-config'))));
        quarantined ||=
          submitUncertain || submittedIncomplete || retainedUnknownConfig;
        if (quarantined && session) await clean(() => session!.quarantine());
        if (launch) {
          await clean(() => launch!.settled());
          shutdownPending = launch.quit();
          const shutdown = await clean(
            () => shutdownPending as Promise<Awaited<typeof shutdownPending>>
          );
          if (
            !shutdown ||
            typeof shutdown !== 'object' ||
            !('status' in shutdown) ||
            shutdown.status !== 'exited'
          )
            quarantined = true;
          else cleanExit = true;
          await clean(() => launch!.settled());
        }
        if (!quarantined && installation) {
          await clean(() => installation!.restore());
          configRestored = true;
        }
        if (
          !quarantined &&
          profile &&
          ((await clean(() => exists(join(profile!.root, '.lease')))) ||
            (await clean(() => exists(join(profile!.root, '.fixture-config')))))
        )
          quarantined = true;
        const qualifiedEvidence =
          evidencePersisted && lastCollection?.evidence.trace !== undefined;
        if (
          !quarantined &&
          qualifiedEvidence &&
          cleanExit &&
          configRestored &&
          session
        ) {
          try {
            await clean(() => removeOwnedWorkspace(session!));
          } catch {
            quarantined = true;
          }
        }
        cleanupSafe = !quarantined;
      } catch {
        quarantined = true;
        if (session)
          await beforeDeadline(session.quarantine(), cleanupDeadline).catch(
            () => {}
          );
        if (launch) {
          // Keep settlement live without cancelling it. quit() also waits for it
          // and will return quarantined if the cleanup allowance is exhausted.
          cleanupPending = launch.settled();
          void cleanupPending.catch(() => {});
          if (!shutdownPending) shutdownPending = launch.quit();
          await beforeDeadline(shutdownPending, cleanupDeadline).catch(
            () => {}
          );
        }
      }

      function quarantineResult(): void {
        result = {
          ...result,
          error: `${result.error ?? 'Unqualified native evidence.'} Quarantined lifecycle/config retained for manual review; do not retry this profile.`,
        };
      }
      if (quarantined) quarantineResult();

      async function finalize(action: () => Promise<void>): Promise<void> {
        if (Date.now() >= cleanupDeadline) throw new DeadlineExpired();
        await beforeDeadline(action(), cleanupDeadline);
      }
      try {
        if (checkpoint)
          await finalize(() =>
            checkpoint!(quarantined ? 'quarantined' : 'closed', receipt)
          );
        if (outputDir) {
          if (failureDiagnostic)
            await finalize(() =>
              saveArtifact(outputDir!, 'failure.json', failureDiagnostic)
            );
          if (
            lastCollection &&
            !(await exists(join(outputDir, 'native-evidence.json')))
          )
            await finalize(async () => {
              await saveArtifact(
                outputDir!,
                'native-evidence.json',
                lastCollection!.evidence
              );
              await saveArtifact(
                outputDir!,
                'native-database.json',
                lastCollection!.database
              );
            });
          await finalize(() =>
            saveArtifact(outputDir!, 'host-result.json', result)
          );
        }
        if (cleanupSafe && releaseAttempt) await finalize(releaseAttempt);
        finalized = true;
      } catch {
        if (!quarantined) {
          quarantined = true;
          quarantineResult();
        }
      }

      if (
        quarantined &&
        (releaseAttempt ||
          launch ||
          installation ||
          !executionSettled ||
          !finalized)
      ) {
        retainedLifetimes.add({
          resources: () => ({
            session,
            launch,
            installation,
            execution,
            cleanupPending,
            shutdownPending,
            input,
          }),
          keepAlive: setInterval(() => {
            /* Retain native owner and opaque fixture-config backup. */
          }, 60_000),
        });
        reportStatus(
          dependencies,
          'Quarantined: native ownership and fixture configuration are retained for manual review. Quit the owned app normally; do not force-exit or retry this profile.'
        );
      }
      return result;
    },
  };
}

function safeFailureDiagnostic(
  hostStage: CodexHostStage,
  error: unknown
): CodexHostFailureDiagnostic {
  const safeHostStage = CODEX_HOST_STAGES.some(
    (allowed) => allowed === hostStage
  )
    ? hostStage
    : 'preflight';
  const electron = getCodexElectronFailureDiagnostic(error);
  if (electron)
    return {
      version: 1,
      stage: `${safeHostStage}/${electron.stage}`,
      errorName: electron.errorName,
      reason: electron.reason,
    };
  return {
    version: 1,
    stage: safeHostStage,
    errorName: 'Error',
    reason: error instanceof DeadlineExpired ? 'deadline' : 'other',
  };
}

function emptyResult(error: string): HostRunResult {
  return { finalText: '', events: [], error };
}

function reportStatus(
  dependencies: CodexHostDependencies,
  message: string
): void {
  try {
    dependencies.status?.(message);
  } catch {
    /* Status cannot disrupt ownership. */
  }
}

/** Caller deadline only: no AbortSignal, cancellation, close, signal, or kill. */
async function beforeDeadline<T>(
  pending: Promise<T>,
  deadline: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DeadlineExpired()),
          Math.max(0, deadline - Date.now())
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keep every receipt. Only a safely closed attempt removes its active guard. */
async function reserveAttempt(profile: CodexProfile, attemptId: string) {
  const operation = await lockCodexProfileOperation(profile);
  const active = join(profile.root, '.host-active');
  const owner = createCodexProfileOwner(profile);
  let activeCreated = false;
  try {
    for (const name of ['.host-active', '.lease', '.fixture-config']) {
      if (await profileStateExists(join(profile.root, name)))
        throw new Error('Active, quarantined, or unknown profile state.');
    }
    await mkdir(active, { mode: 0o700 });
    activeCreated = true;
    await syncDirectory(profile.root);
    await saveCodexProfileOwner(active, profile, owner);
    const legacy = join(profile.root, '.first-host-attempt');
    if (await exists(legacy)) {
      const record = await readCheckpoint(legacy);
      if (
        record.version !== 1 ||
        record.profileId !== profile.id ||
        record.state !== 'closed' ||
        typeof record.workspacePath !== 'string' ||
        !isAbsolute(record.workspacePath) ||
        typeof record.promptSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.promptSha256)
      )
        throw new Error('Unknown or quarantined legacy attempt.');
      if (attemptId === 'legacy-first-host-attempt')
        throw new Error('Legacy attempt cannot be replayed.');
    }
    const history = join(profile.root, '.host-attempts');
    if (!(await exists(history))) await mkdir(history, { mode: 0o700 });
    await assertPrivateDirectory(history);
    const attempts = await readdir(history);
    if (attempts.length > 10_000)
      throw new Error('Attempt history exceeds bound.');
    for (const id of attempts) {
      if (id === attemptId) throw new Error('Attempt ID was already reserved.');
      const record = await readCheckpoint(join(history, id));
      if (
        record.version !== 1 ||
        record.profileId !== profile.id ||
        record.attemptId !== id ||
        record.state !== 'closed'
      )
        throw new Error('Unknown or quarantined prior attempt.');
    }
    const directory = join(history, attemptId);
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(history);
    return {
      directory,
      owner,
      async release() {
        const releaseOperation = await lockCodexProfileOperation(profile);
        try {
          await assertCodexProfileOwner(active, profile, owner);
          await rm(join(active, 'owner.json'));
          await rmdir(active);
          await syncDirectory(profile.root);
        } finally {
          await releaseOperation.release();
        }
      },
    };
  } catch (error) {
    if (activeCreated) {
      await rm(join(active, 'owner.json'), { force: true });
      await rmdir(active);
      await syncDirectory(profile.root);
    }
    throw error;
  } finally {
    await operation.release();
  }
}

async function readCheckpoint(
  directory: string
): Promise<Record<string, unknown>> {
  await assertPrivateDirectory(directory);
  const file = await open(
    join(directory, 'checkpoint.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 8192
    )
      throw new Error('Unsafe attempt checkpoint.');
    return JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
  } finally {
    await file.close();
  }
}

async function removeOwnedWorkspace(
  session: CodexElectronSession
): Promise<void> {
  const ownership = session.workspaceOwnership;
  const workspace = session.workspacePath;
  const temporaryRoot = await realpath(tmpdir());
  if (
    ownership?.kind !== 'codex-electron-workspace' ||
    ownership.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(ownership.id) ||
    ownership.path !== workspace ||
    ownership.markerPath !== join(workspace, '.owner.json') ||
    ownership.uid !== process.getuid?.() ||
    !isAbsolute(workspace) ||
    dirname(workspace) !== temporaryRoot ||
    !basename(workspace).startsWith('codex-electron-workspace-') ||
    (await realpath(workspace)) !== workspace
  )
    throw new Error('Unsafe owned workspace evidence.');
  await assertPrivateDirectory(workspace);
  const marker = await open(
    ownership.markerPath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const info = await marker.stat();
    if (
      !info.isFile() ||
      info.uid !== ownership.uid ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 8192
    )
      throw new Error('Unsafe workspace ownership marker.');
    const record: unknown = JSON.parse(await marker.readFile('utf8'));
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      (record as Record<string, unknown>).kind !== ownership.kind ||
      (record as Record<string, unknown>).version !== ownership.version ||
      (record as Record<string, unknown>).id !== ownership.id ||
      (record as Record<string, unknown>).path !== ownership.path ||
      (record as Record<string, unknown>).uid !== ownership.uid
    )
      throw new Error('Invalid workspace ownership marker.');
  } finally {
    await marker.close();
  }
  await rm(workspace, { recursive: true });
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(directory)) !== directory
  )
    throw new Error('Unsafe attempt directory.');
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

async function saveArtifact(
  directory: string,
  name: string,
  value: unknown
): Promise<void> {
  const file = await open(join(directory, name), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
}

async function saveCheckpoint(
  directory: string,
  value: unknown
): Promise<void> {
  const name = `.checkpoint-${randomUUID()}.json`;
  await saveArtifact(directory, name, value);
  await rename(join(directory, name), join(directory, 'checkpoint.json'));
  await syncDirectory(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
