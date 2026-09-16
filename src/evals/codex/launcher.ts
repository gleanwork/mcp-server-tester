import { createNativeCodexProcesses } from './nativeProcesses.js';
import {
  assertNoCodexProcesses,
  identifyCodexApplication,
} from './application.js';
import {
  leaseCodexProfile,
  prepareCodexProfile,
  type CodexProfile,
  type CodexProfileOwner,
} from './profile.js';

export interface CodexExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Retained ownership handle; deliberately has no process-signalling API. */
export interface CodexOwnedProcess {
  readonly pid: number;
  readonly exited: Promise<CodexExit>;
}

export interface CodexProcessIdentity {
  readonly pid: number;
  readonly executablePath: string;
  /** Opaque OS process-start value. Compare only for exact equality. */
  readonly startIdentity: string;
}

export interface CodexSpawnRequest {
  executablePath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdio: 'ignore';
  shell: false;
  detached: true;
}

/** OS boundary for offline launch-contract tests. */
export interface CodexProcessFacade {
  platform: NodeJS.Platform;
  readBundleInfo(
    bundlePath: string
  ): Promise<{ identifier: string; executable: string; version: string }>;
  /** Performs strict codesign verification and returns the signing identity. */
  verifyBundleSignature?(
    bundlePath: string
  ): Promise<{ teamIdentifier: string }>;
  listProcesses(): Promise<CodexProcessIdentity[]>;
  spawn(
    request: CodexSpawnRequest
  ): Promise<CodexOwnedProcess> | CodexOwnedProcess;
}

export type CodexLaunchStage =
  | 'application-identity'
  | 'process-preflight'
  | 'profile'
  | 'lease'
  | 'process-baseline'
  | 'spawn'
  | 'lease-running';

export interface CodexLaunchOptions {
  executablePath: string;
  profilePath: string;
  /** Opaque host authority required when host/config state is active. */
  profileOwner?: CodexProfileOwner;
  onStage?(this: void, stage: CodexLaunchStage): void;
  /** Bounded allowance to observe new bundle processes exit after the main exits. */
  ownedProcessCleanupTimeoutMs?: number;
}

export interface CodexSession {
  readonly profile: CodexProfile;
  readonly process: CodexOwnedProcess;
  readonly exited: Promise<CodexExit & { status: 'exited' | 'quarantined' }>;
  /** Marks the active lease unsafe. Rejects after finalization; never signals the app. */
  quarantine(): Promise<void>;
}

const DEFAULT_OWNED_PROCESS_CLEANUP_TIMEOUT_MS = 1000;
const OWNED_PROCESS_POLL_MS = 25;

function processKey(process: CodexProcessIdentity): string {
  return `${process.pid}\u0000${process.executablePath}\u0000${process.startIdentity}`;
}

function validateInventory(
  inventory: CodexProcessIdentity[]
): CodexProcessIdentity[] {
  for (const process of inventory) {
    if (
      !Number.isSafeInteger(process.pid) ||
      process.pid <= 0 ||
      !process.executablePath ||
      !process.startIdentity
    )
      throw new Error('Invalid process identity.');
  }
  return inventory;
}

function isBundleProcess(
  bundlePath: string,
  process: CodexProcessIdentity
): boolean {
  return process.executablePath.startsWith(`${bundlePath}/Contents/`);
}

function hasChangedObservedIdentity(
  observed: ReadonlyMap<string, CodexProcessIdentity>,
  process: CodexProcessIdentity
): boolean {
  for (const prior of observed.values()) {
    if (prior.pid === process.pid && processKey(prior) !== processKey(process))
      return true;
  }
  return false;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Opens the app only. No URL, prompt, sign-in automation, or readiness inference. */
export async function launchCodexApp(
  options: CodexLaunchOptions,
  processes: CodexProcessFacade = createNativeCodexProcesses()
): Promise<CodexSession> {
  const cleanupTimeoutMs =
    options.ownedProcessCleanupTimeoutMs ??
    DEFAULT_OWNED_PROCESS_CLEANUP_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs <= 0 ||
    cleanupTimeoutMs > 60_000
  )
    throw new TypeError(
      'A 1–60000ms owned process cleanup budget is required.'
    );
  options.onStage?.('application-identity');
  const application = await identifyCodexApplication(
    options.executablePath,
    processes
  );
  options.onStage?.('process-preflight');
  await assertNoCodexProcesses(application, processes);
  options.onStage?.('profile');
  const profile = await prepareCodexProfile(options.profilePath);
  options.onStage?.('lease');
  const lease = await leaseCodexProfile(
    profile,
    application.executablePath,
    options.profileOwner
  );
  let baseline: CodexProcessIdentity[];
  try {
    options.onStage?.('process-baseline');
    baseline = validateInventory(await processes.listProcesses());
    await assertNoCodexProcesses(application, processes);
  } catch (error) {
    await lease.release('not-launched');
    throw error;
  }
  const baselineKeys = new Set(baseline.map(processKey));
  const observedOwned = new Map<string, CodexProcessIdentity>();
  let inventoryUncertain = false;
  async function activeOwnedProcesses(): Promise<{
    active: CodexProcessIdentity[];
    changedIdentity: boolean;
  }> {
    const active = validateInventory(await processes.listProcesses()).filter(
      (process) =>
        isBundleProcess(application.bundlePath, process) &&
        !baselineKeys.has(processKey(process))
    );
    const changedIdentity = active.some((process) =>
      hasChangedObservedIdentity(observedOwned, process)
    );
    if (!changedIdentity)
      for (const process of active)
        observedOwned.set(processKey(process), process);
    return { active, changedIdentity };
  }
  async function observeOwnedProcessesExit(): Promise<boolean> {
    const deadline = Date.now() + cleanupTimeoutMs;
    for (;;) {
      const { active, changedIdentity } = await activeOwnedProcesses();
      if (changedIdentity) return false;
      if (active.length === 0) return true;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await delay(Math.min(OWNED_PROCESS_POLL_MS, remainingMs));
    }
  }
  const paths = profile.paths;
  let owned: CodexOwnedProcess;
  try {
    options.onStage?.('spawn');
    owned = await processes.spawn({
      executablePath: application.executablePath,
      args: [
        `--user-data-dir=${paths.electron}`,
        '--force-renderer-accessibility',
      ],
      cwd: paths.workspace,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
        HOME: paths.home,
        CFFIXED_USER_HOME: paths.home,
        CODEX_HOME: paths.codex,
        CODEX_ELECTRON_USER_DATA_PATH: paths.electron,
        CODEX_SPARKLE_ENABLED: 'false',
        XDG_CONFIG_HOME: paths.config,
        XDG_CACHE_HOME: paths.cache,
        XDG_DATA_HOME: paths.data,
        XDG_STATE_HOME: paths.state,
        XDG_RUNTIME_DIR: paths.runtime,
        TMPDIR: paths.temp,
        TMP: paths.temp,
        TEMP: paths.temp,
      },
      stdio: 'ignore',
      shell: false,
      detached: true,
    });
    options.onStage?.('lease-running');
    await lease.running(owned.pid);
  } catch {
    await lease.quarantine();
    throw new Error('Codex launch failed; profile quarantined.');
  }
  try {
    await activeOwnedProcesses();
  } catch {
    inventoryUncertain = true;
  }
  let quarantined = false;
  let terminal = false;
  let pending = Promise.resolve();
  function quarantine(): Promise<void> {
    if (terminal)
      return Promise.reject(new Error('Codex lifecycle already finalized.'));
    quarantined = true;
    pending = pending.then(() => lease.quarantine());
    return pending;
  }
  const exited = owned.exited
    .catch(() => {
      quarantined = true;
      return { code: null, signal: null };
    })
    .then(async (exit) => {
      if (
        !quarantined &&
        !inventoryUncertain &&
        exit.code === 0 &&
        exit.signal === null
      ) {
        try {
          if (!(await observeOwnedProcessesExit())) quarantined = true;
        } catch {
          quarantined = true;
        }
      }
      await pending;
      terminal = true;
      if (quarantined || exit.code !== 0 || exit.signal !== null) {
        await lease.quarantine();
        return { ...exit, status: 'quarantined' as const };
      }
      await lease.release();
      return { ...exit, status: 'exited' as const };
    });
  return { profile, process: owned, exited, quarantine };
}
