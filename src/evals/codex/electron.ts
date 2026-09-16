import {
  _electron,
  type ElectronApplication,
  type JSHandle,
  type Page,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  launchCodexApp,
  type CodexExit,
  type CodexOwnedProcess,
  type CodexProcessFacade,
  type CodexSession,
  type CodexLaunchStage,
} from './launcher.js';
import { createNativeCodexProcesses } from './nativeProcesses.js';
import type { CodexProfileOwner } from './profile.js';

export interface CodexElectronOptions {
  executablePath: string;
  /** Persistent, dedicated profile. No auth or config import is performed. */
  profilePath: string;
  /** Opaque host authority required when host/config state is active. */
  profileOwner?: CodexProfileOwner;
  onLaunchStage?(this: void, stage: CodexLaunchStage): void;
  /** One absolute deadline for launch and all renderer work. */
  executionDeadline: number;
  /** Separate allowance, starting at quit(), never at launch. */
  cleanupTimeoutMs: number;
  /** Required, pure DOM probe. Verify the pinned app's ready route AND app contents.
   * Runs in each renderer without captured variables. Return booleans, never DOM text.
   * This is app readiness, not proof of a fresh workspace or an empty composer.
   */
  windowReady: () => CodexElectronWindowReadiness;
}

export interface CodexElectronWindowReadiness {
  readyRoute: boolean;
  appContents: boolean;
}

export interface CodexElectronWindowProof extends CodexElectronWindowReadiness {
  pid: number;
  browserWindowId: number;
  webContentsId: number;
  owned: boolean;
  destroyed: boolean;
  webContentsDestroyed: boolean;
  visible: boolean;
  focused: boolean;
}

// Public Electron facade; do not depend on the app's bundled Electron types or internals.
interface ElectronBrowserWindow {
  id: number;
  webContents: { id: number; isDestroyed(): boolean; getURL(): string };
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  show(): void;
  focus(): void;
}

interface ElectronWindowModule {
  BrowserWindow: {
    fromId(id: number): ElectronBrowserWindow | undefined;
    getAllWindows(): ElectronBrowserWindow[];
  };
}

type NativeWindowProof = Omit<
  CodexElectronWindowProof,
  keyof CodexElectronWindowReadiness
>;

export interface CodexElectronDependencies {
  processes?: CodexProcessFacade;
  electron?: Pick<typeof _electron, 'launch'>;
}

// Electron is supplied by the selected app, not an installed Electron package.
interface ElectronMainApp {
  getPath(name: 'userData' | 'home'): string;
  quit(): void;
}

export interface CodexElectronNativePaths {
  pid: number;
  executablePath: string;
  userData: string;
  home: string;
  envHome: string | undefined;
  codexHome: string | undefined;
  workspacePath: string;
}

export interface CodexElectronWorkspaceOwnership {
  readonly kind: 'codex-electron-workspace';
  readonly version: 1;
  readonly id: string;
  readonly path: string;
  readonly markerPath: string;
  readonly uid: number;
}

export interface CodexElectronSession extends CodexSession {
  readonly application: ElectronApplication;
  /** The actual Playwright-owned process, not a PID reconstruction. Never signal it. */
  readonly child: ChildProcess;
  readonly window: Page;
  /** Last verified snapshot, refreshed before each action. Not a live OS-state claim. */
  readonly windowProof: Readonly<CodexElectronWindowProof>;
  readonly native: CodexElectronNativePaths;
  /** New per launch. The caller must still open and verify a fresh UI session. */
  readonly workspacePath: string;
  /** Durable ownership proof. Only the host may verify and remove this workspace. */
  readonly workspaceOwnership: Readonly<CodexElectronWorkspaceOwnership>;
  /** Pure DOM reads only. Retries only destroyed startup/navigation contexts. */
  readDOM<T>(reader: () => T | Promise<T>): Promise<T>;
  /** One dispatch, never a retry. Caller owns semantic selectors and submit receipts. */
  runOnce<T>(
    action: (window: Page, remainingMs: number) => Promise<T>
  ): Promise<T>;
}

export interface CodexElectronShutdown {
  status: 'exited' | 'quarantined' | 'not-launched';
  exit?: CodexExit;
}

export interface CodexElectronLaunch {
  readonly ready: Promise<CodexElectronSession>;
  /** Also retained if the deadline expires before Playwright returns its app. */
  readonly child: ChildProcess | undefined;
  /** Waits for pending launch, renderer, and handshake work; does not cancel it. */
  settled(): Promise<void>;
  /** At most one cooperative quit; never app.close(), cancellation, or signals. */
  quit(): Promise<CodexElectronShutdown>;
}

class ElectronDeadlineExpired extends Error {
  constructor() {
    super('Codex Electron execution or cleanup deadline exceeded');
    this.name = 'ElectronDeadlineExpired';
  }
}

const CODEX_ELECTRON_STAGES = [
  'launch',
  'native-paths',
  'window-selection',
  'window-ownership',
  'window-readiness',
  'window-visibility',
  'renderer-navigation',
  'renderer-read',
  'renderer-action',
] as const;
const CODEX_ELECTRON_ERROR_NAMES = [
  'Error',
  'TypeError',
  'RangeError',
  'TimeoutError',
  'TargetClosedError',
  'ElectronDeadlineExpired',
] as const;
const CODEX_ELECTRON_FAILURE_REASONS = [
  'navigation',
  'timeout',
  'deadline',
  'visibility',
  'ownership',
  'other',
] as const;

export type CodexElectronStage = (typeof CODEX_ELECTRON_STAGES)[number];
export type CodexElectronErrorName =
  (typeof CODEX_ELECTRON_ERROR_NAMES)[number];
export type CodexElectronFailureReason =
  (typeof CODEX_ELECTRON_FAILURE_REASONS)[number];

export interface CodexElectronFailureDiagnostic {
  readonly stage: CodexElectronStage;
  readonly errorName: CodexElectronErrorName;
  readonly reason: CodexElectronFailureReason;
}

/** Bounded diagnostics only. Never retain the original error, message, cause, or payload. */
export class CodexElectronFailure extends Error {
  readonly errorName: CodexElectronErrorName;
  readonly reason: CodexElectronFailureReason;

  constructor(
    message: string,
    readonly stage: CodexElectronStage,
    error?: unknown
  ) {
    const name =
      typeof error === 'object' && error !== null && 'name' in error
        ? error.name
        : undefined;
    const errorName = CODEX_ELECTRON_ERROR_NAMES.some(
      (allowed) => allowed === name
    )
      ? (name as CodexElectronErrorName)
      : 'Error';
    const reason =
      error instanceof ElectronDeadlineExpired
        ? 'deadline'
        : isNavigationError(error)
          ? 'navigation'
          : errorName === 'TimeoutError'
            ? 'timeout'
            : stage === 'window-visibility'
              ? 'visibility'
              : stage === 'window-ownership'
                ? 'ownership'
                : 'other';
    super(`${message} [stage=${stage}; error=${errorName}; reason=${reason}]`);
    this.name = 'CodexElectronFailure';
    this.errorName = errorName;
    this.reason = reason;
  }
}

export function getCodexElectronFailureDiagnostic(
  error: unknown
): Readonly<CodexElectronFailureDiagnostic> | null {
  if (
    !(error instanceof CodexElectronFailure) ||
    !CODEX_ELECTRON_STAGES.some((allowed) => allowed === error.stage) ||
    !CODEX_ELECTRON_ERROR_NAMES.some(
      (allowed) => allowed === error.errorName
    ) ||
    !CODEX_ELECTRON_FAILURE_REASONS.some((allowed) => allowed === error.reason)
  )
    return null;
  return Object.freeze({
    stage: error.stage,
    errorName: error.errorName,
    reason: error.reason,
  });
}

function isNavigationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Execution context was destroyed|Cannot find context with specified id/.test(
      error.message
    )
  );
}

function isTransientPageMappingError(error: unknown): boolean {
  return (
    isNavigationError(error) ||
    (error instanceof Error &&
      /(?:^|: )Page is not an Electron window$/.test(error.message))
  );
}

/**
 * Keep this handle until quit completes. Always call quit(), including after a
 * rejected ready. A quarantined result requires manual review, never a retry.
 * Use runOnce for renderer actions so quit cannot overlap a pending mutation.
 * No sign-in automation, auth-store reads, or native evidence inference occurs.
 */
export function launchCodexElectron(
  options: CodexElectronOptions,
  dependencies: CodexElectronDependencies = {}
): CodexElectronLaunch {
  if (
    !Number.isSafeInteger(options.executionDeadline) ||
    !Number.isSafeInteger(options.cleanupTimeoutMs) ||
    options.cleanupTimeoutMs <= 0 ||
    options.cleanupTimeoutMs > 60_000
  )
    throw new TypeError(
      'An absolute execution deadline and a 1–60000ms cleanup budget are required'
    );
  if (typeof options.windowReady !== 'function')
    throw new TypeError(
      'A pure DOM windowReady route and app-content probe is required'
    );
  const processes = dependencies.processes ?? createNativeCodexProcesses();
  const electron = dependencies.electron ?? _electron;
  let application: ElectronApplication | undefined;
  let child: ChildProcess | undefined;
  let childExit: Promise<CodexExit> | undefined;
  let closed: Promise<void> | undefined;
  let nativeLaunch: Promise<CodexOwnedProcess> | undefined;
  let workspacePath: string;
  let workspaceOwnership: Readonly<CodexElectronWorkspaceOwnership>;
  let executablePathForLaunch: string;
  let session: CodexSession | undefined;
  let window: Page;
  let windowProof: Readonly<CodexElectronWindowProof>;
  let stage: CodexElectronStage = 'launch';
  let active: Promise<unknown> | undefined;
  let handshake: Promise<unknown> | undefined;
  let quarantineWork: Promise<void> | undefined;
  let unsafe = false;
  let closing = false;
  let quitAcknowledged = false;
  let shutdown: Promise<CodexElectronShutdown> | undefined;

  function retain(app: ElectronApplication): CodexOwnedProcess {
    application = app;
    child = app.process();
    closed = new Promise<void>((resolve) => app.once('close', resolve));
    childExit = new Promise<CodexExit>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
      child!.once('error', () => resolve({ code: null, signal: null }));
      if (child!.exitCode !== null || child!.signalCode !== null)
        resolve({ code: child!.exitCode, signal: child!.signalCode });
    });
    const exited = childExit.then(async (exit) => {
      if (exit.code !== 0 || exit.signal !== null) return exit;
      if (!quitAcknowledged) throw new Error('Unsolicited Electron exit.');
      await closed;
      return exit;
    });
    // A late acquired child may have no launcher awaiting it. Retain, never signal.
    void exited.catch(() => {});
    if (child.pid === undefined) throw new Error('No owned Electron child.');
    return { pid: child.pid, exited };
  }

  async function start(): Promise<CodexElectronSession> {
    remaining();
    session = await launchCodexApp(
      {
        ...options,
        onStage: options.onLaunchStage,
        ownedProcessCleanupTimeoutMs: options.cleanupTimeoutMs,
      },
      {
        ...processes,
        async spawn(request) {
          requireOpen();
          executablePathForLaunch = request.executablePath;
          const workspace = await createOwnedWorkspace();
          workspacePath = workspace.path;
          workspaceOwnership = workspace;
          requireOpen();
          nativeLaunch = electron
            .launch({
              executablePath: request.executablePath,
              args: request.args,
              cwd: workspacePath,
              env: request.env,
              // Playwright's own launch timeout kills the app. Caller deadlines must not.
              timeout: 0,
            })
            .then(retain);
          return beforeDeadline(nativeLaunch, options.executionDeadline);
        },
      }
    );
    void session.exited
      .then((exit) => {
        if (exit.status === 'quarantined') unsafe = true;
      })
      .catch(() => {
        unsafe = true;
      });
    if (unsafe) await quarantine();
    requireOpen();
    let native: CodexElectronNativePaths;
    stage = 'native-paths';
    try {
      native = await application!.evaluate(
        ({ app }: { app: ElectronMainApp }) => ({
          pid: process.pid,
          executablePath: process.execPath,
          userData: app.getPath('userData'),
          home: app.getPath('home'),
          envHome: process.env.HOME,
          codexHome: process.env.CODEX_HOME,
          workspacePath: process.cwd(),
        })
      );
    } catch {
      throw new Error('Codex native path confirmation failed');
    }
    remaining();
    if (
      native.pid !== child!.pid ||
      native.executablePath !== executablePathForLaunch! ||
      native.userData !== session.profile.paths.electron ||
      native.home !== session.profile.paths.home ||
      native.envHome !== session.profile.paths.home ||
      native.codexHome !== session.profile.paths.codex ||
      native.workspacePath !== workspacePath!
    )
      throw new Error('Codex native path confirmation failed');
    requireOpen();
    for (;;) {
      stage = 'window-selection';
      const matches: { page: Page; proof: NativeWindowProof }[] = [];
      for (const candidate of application!.windows()) {
        checkWork();
        const proof = await inspectWindow(candidate, false);
        if (!proof) continue;
        const content = await readPage(
          candidate,
          options.windowReady,
          'window-readiness'
        );
        if (content?.readyRoute === true && content.appContents === true)
          matches.push({ page: candidate, proof });
      }
      stage = 'window-selection';
      if (matches.length > 1)
        throw new CodexElectronFailure(
          'Codex ready owned window is ambiguous',
          stage
        );
      const selected = matches[0];
      if (selected) {
        window = selected.page;
        windowProof = await foreground(selected.proof);
        break;
      }
      await delay(Math.min(100, remaining()));
      checkWork();
    }
    return {
      ...session,
      application: application!,
      child: child!,
      window,
      get windowProof() {
        return windowProof;
      },
      native,
      workspacePath: workspacePath!,
      workspaceOwnership: workspaceOwnership!,
      readDOM,
      runOnce,
      quarantine,
    };
  }

  function remaining(): number {
    const budget = options.executionDeadline - Date.now();
    if (budget <= 0) throw new ElectronDeadlineExpired();
    return budget;
  }
  function checkWork(): void {
    if (unsafe) throw new Error('Codex Electron lifecycle is quarantined');
    if (closing) throw new Error('Codex Electron shutdown already requested');
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error('Owned Codex Electron process exited');
    remaining();
  }
  async function inspectWindow(
    target: Page,
    activate: boolean,
    expected?: NativeWindowProof
  ): Promise<NativeWindowProof | null> {
    stage = 'window-ownership';
    checkWork();
    if (target.isClosed() || !application!.windows().includes(target))
      return null;
    try {
      let mapped: JSHandle<ElectronBrowserWindow> | undefined;
      let pageURL: string | undefined;
      try {
        mapped = (await application!.browserWindow(
          target
        )) as JSHandle<ElectronBrowserWindow>;
      } catch (error) {
        if (
          !activate &&
          expected === undefined &&
          isTransientPageMappingError(error)
        ) {
          checkWork();
          if (application!.process() !== child)
            throw new CodexElectronFailure(
              'Codex owned child identity confirmation failed',
              'window-ownership'
            );
          return null;
        }
        // The pinned Owl runtime cannot resolve Playwright's DevTools target.
        // Qualify only this failure with public exact-URL uniqueness, never a
        // first-window fallback or a reconstructed native identity.
        if (
          !(error instanceof Error) ||
          !error.message.includes(
            "Cannot read properties of null (reading 'getOwnerBrowserWindow')"
          )
        )
          throw error;
        checkWork();
        pageURL = target.url();
        const equivalentPages = application!
          .windows()
          .filter((page) => !page.isClosed() && page.url() === pageURL);
        // Stricter than ready-page uniqueness: even an unready equivalent Page
        // makes URL-only mapping unsafe. DOM readiness is verified separately.
        if (equivalentPages.length > 1)
          throw new CodexElectronFailure(
            'Codex exact-URL page mapping is ambiguous',
            'window-ownership'
          );
        if (!pageURL || equivalentPages[0] !== target) return null;
      }
      try {
        checkWork();
        stage = activate ? 'window-visibility' : 'window-ownership';
        const proof = await application!.evaluate(
          (
            { BrowserWindow }: ElectronWindowModule,
            { window: mappedWindow, pageURL, pid, activate, expected }
          ) => {
            let window = mappedWindow;
            if (!window) {
              const matches = BrowserWindow.getAllWindows().filter(
                (candidate) =>
                  !candidate.isDestroyed() &&
                  !candidate.webContents.isDestroyed() &&
                  candidate.webContents.getURL() === pageURL
              );
              if (matches.length > 1) return 'ambiguous' as const;
              window = matches[0] ?? null;
            }
            if (
              !window ||
              process.pid !== pid ||
              window.isDestroyed() ||
              BrowserWindow.fromId(window.id) !== window ||
              !Number.isSafeInteger(window.id) ||
              window.id <= 0 ||
              !Number.isSafeInteger(window.webContents.id) ||
              window.webContents.id <= 0
            )
              return null;
            if (window.webContents.isDestroyed()) return null;
            if (
              expected &&
              (window.id !== expected.browserWindowId ||
                window.webContents.id !== expected.webContentsId)
            )
              return null;
            if (activate) {
              window.show();
              window.focus();
            }
            return {
              pid: process.pid,
              browserWindowId: window.id,
              webContentsId: window.webContents.id,
              owned: BrowserWindow.fromId(window.id) === window,
              destroyed: window.isDestroyed(),
              webContentsDestroyed: window.webContents.isDestroyed(),
              visible: window.isVisible(),
              focused: window.isFocused(),
            };
          },
          {
            window: mapped ?? null,
            pageURL,
            pid: child!.pid,
            activate,
            expected,
          }
        );
        if (proof === 'ambiguous')
          throw new CodexElectronFailure(
            'Codex exact-URL native window mapping is ambiguous',
            'window-ownership'
          );
        if (pageURL !== undefined && target.url() !== pageURL) return null;
        return proof;
      } finally {
        await mapped?.dispose();
      }
    } catch (error) {
      throw failure('Codex owned window confirmation failed', error);
    }
  }
  function requireOwnedProof(
    proof: NativeWindowProof | null
  ): asserts proof is NativeWindowProof {
    checkWork();
    if (
      !proof ||
      proof.pid !== child!.pid ||
      !proof.owned ||
      proof.destroyed ||
      proof.webContentsDestroyed ||
      !Number.isSafeInteger(proof.browserWindowId) ||
      proof.browserWindowId <= 0 ||
      !Number.isSafeInteger(proof.webContentsId) ||
      proof.webContentsId <= 0
    )
      throw new CodexElectronFailure(
        'Codex owned window identity confirmation failed',
        'window-ownership'
      );
  }
  async function foreground(
    expected: NativeWindowProof
  ): Promise<Readonly<CodexElectronWindowProof>> {
    let proof = await inspectWindow(window, true, expected);
    for (;;) {
      requireOwnedProof(proof);
      if (proof.visible && proof.focused) {
        // Activation can navigate. Do not publish the pre-activation DOM proof.
        await requireReadyContent();
        proof = await inspectWindow(window, false, expected);
        requireOwnedProof(proof);
        if (proof.visible && proof.focused)
          return Object.freeze({
            ...proof,
            readyRoute: true,
            appContents: true,
          });
      }
      stage = 'window-visibility';
      // Native activation can settle asynchronously. Observe only; never replay show/focus.
      await delay(Math.min(100, remaining()));
      proof = await inspectWindow(window, false, expected);
    }
  }
  async function quarantine(): Promise<void> {
    unsafe = true;
    if (session) quarantineWork ??= session.quarantine().catch(() => {});
    await quarantineWork;
  }
  function requireOpen(): void {
    if (unsafe) throw new Error('Codex Electron lifecycle is quarantined');
    if (closing) throw new Error('Codex Electron shutdown already requested');
    if (active) throw new Error('A Codex Electron operation is still pending');
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error('Owned Codex Electron process exited');
    remaining();
  }
  async function operation<T>(
    work: () => Promise<T>,
    mutation: boolean
  ): Promise<T> {
    requireOpen();
    let completed = false;
    const pending = Promise.resolve()
      .then(work)
      .then((value) => {
        remaining();
        return value;
      })
      .finally(() => {
        completed = true;
        active = undefined;
      });
    active = pending;
    try {
      return await beforeDeadline(pending, options.executionDeadline);
    } catch (error) {
      const reported = failure(
        mutation
          ? 'Codex renderer action failed'
          : 'Codex renderer read failed',
        error
      );
      if (mutation || !completed) await quarantine();
      throw reported;
    }
  }
  function failure(message: string, error: unknown): CodexElectronFailure {
    return error instanceof CodexElectronFailure
      ? error
      : new CodexElectronFailure(message, stage, error);
  }
  async function readPage<T>(
    target: Page,
    reader: () => T | Promise<T>,
    readStage: CodexElectronStage = 'renderer-read'
  ): Promise<T> {
    for (;;) {
      checkWork();
      try {
        stage = 'renderer-navigation';
        await target.waitForLoadState('domcontentloaded', {
          timeout: remaining(),
        });
        checkWork();
        stage = readStage;
        const value = await target.evaluate(reader);
        checkWork();
        return value;
      } catch (error) {
        if (!isNavigationError(error))
          throw failure('Codex renderer read failed', error);
        // Only this read-only boundary retries. Never wrap a submit in readDOM.
        stage = 'renderer-navigation';
        await delay(Math.min(100, remaining()));
      }
    }
  }
  async function readDOM<T>(reader: () => T | Promise<T>): Promise<T> {
    return operation(() => readPage(window, reader), false);
  }
  async function requireReadyContent(): Promise<void> {
    const content = await readPage(
      window,
      options.windowReady,
      'window-readiness'
    );
    if (content?.readyRoute !== true || content.appContents !== true)
      throw new CodexElectronFailure(
        'Codex owned window readiness confirmation failed',
        'window-readiness'
      );
  }
  async function runOnce<T>(
    action: (window: Page, remainingMs: number) => Promise<T>
  ): Promise<T> {
    return operation(async () => {
      await requireReadyContent();
      windowProof = await foreground(windowProof);
      checkWork();
      stage = 'renderer-action';
      return action(window, remaining());
    }, true);
  }

  const launchWork = start().catch(async (error: unknown) => {
    await quarantine();
    throw error;
  });
  const ready = beforeDeadline(launchWork, options.executionDeadline).catch(
    async (error: unknown) => {
      const reported =
        error instanceof ElectronDeadlineExpired
          ? failure('Codex Electron readiness failed', error)
          : error;
      await quarantine();
      throw reported;
    }
  );
  // quit() also supports callers that never consumed ready, without an unhandled rejection.
  void ready.catch(() => {});
  async function settled(): Promise<void> {
    await launchWork.catch(() => {});
    await nativeLaunch?.catch(() => {});
    await active?.catch(() => {});
    await handshake?.catch(() => {});
    await quarantineWork;
  }
  async function quit(): Promise<CodexElectronShutdown> {
    const cleanupDeadline = Date.now() + options.cleanupTimeoutMs;
    // Reserve time to persist quarantine rather than spending everything on exit.
    const resourceDeadline =
      cleanupDeadline - Math.min(1000, Math.ceil(options.cleanupTimeoutMs / 3));
    async function clean<T>(action: () => Promise<T>): Promise<T> {
      if (Date.now() >= resourceDeadline) throw new ElectronDeadlineExpired();
      return beforeDeadline(action(), resourceDeadline);
    }
    try {
      await clean(settled);
      if (!application)
        return { status: unsafe ? 'quarantined' : 'not-launched' };
      if (child!.exitCode === null && child!.signalCode === null) {
        await clean(async () => {
          handshake = application!.evaluate(
            ({ app }: { app: ElectronMainApp }) => {
              // Acknowledge over Node CDP before closing inspector, then quit normally.
              setTimeout(() => {
                process.getBuiltinModule('inspector').close();
                app.quit();
              }, 100);
            }
          );
          await handshake;
          quitAcknowledged = true;
        });
      }
      if (!session) {
        await clean(() => childExit!);
        await clean(() => closed!);
        return { status: 'quarantined' };
      }
      const exit = await clean(() => session!.exited);
      return {
        status: exit.status,
        exit: { code: exit.code, signal: exit.signal },
      };
    } catch {
      await beforeDeadline(quarantine(), cleanupDeadline).catch(() => {});
      return { status: 'quarantined' };
    }
  }
  return {
    ready,
    get child() {
      return child;
    },
    settled,
    quit() {
      closing = true;
      shutdown ??= quit();
      return shutdown;
    },
  };
}

async function createOwnedWorkspace(): Promise<
  Readonly<CodexElectronWorkspaceOwnership>
> {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0)
    throw new Error('A numeric workspace owner is required.');
  const temporaryRoot = await realpath(tmpdir());
  const path = await realpath(
    await mkdtemp(join(temporaryRoot, 'codex-electron-workspace-'))
  );
  await chmod(path, 0o700);
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700)
    throw new Error('Codex workspace must be private and owned.');
  const id = randomUUID();
  const markerPath = join(path, '.owner.json');
  const marker = await open(
    markerPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await marker.writeFile(
      JSON.stringify({
        kind: 'codex-electron-workspace',
        version: 1,
        id,
        path,
        uid,
      })
    );
    await marker.sync();
  } finally {
    await marker.close();
  }
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return Object.freeze({
    kind: 'codex-electron-workspace',
    version: 1,
    id,
    path,
    markerPath,
    uid,
  });
}

/** Deadline observation only: no AbortSignal, cancellation, app.close, or kill. */
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
          () => reject(new ElectronDeadlineExpired()),
          Math.max(0, deadline - Date.now())
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
