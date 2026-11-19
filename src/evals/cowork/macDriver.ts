/**
 * One bounded operation of the account-backed Cowork driver on macOS: connect
 * to the session's Claude Desktop, run the driver's policy, and turn its
 * receipt into a result or a typed failure. No operation is retried.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDesktop, agentDesktopBinary } from '../agentDesktop.js';
import { CoworkDriverError, type CoworkDriverOptions } from './interaction.js';
import { runFirstPartyLinux } from './linuxFirstPartyDriver.js';
import type {
  LinuxDriverOperation,
  LinuxDriverPayload,
  LinuxDriverReceipt,
  LinuxUi,
} from './linuxUi.js';
import { connectMacUi } from './macUi.js';
import { semanticTelemetry } from './semanticHitl.js';

/** The most one UI submission may take, within the case deadline. */
const SUBMIT_TIMEOUT_MS = 10 * 60_000;

const EXPECTED: Record<LinuxDriverOperation, LinuxDriverReceipt['status']> = {
  probe: 'ready',
  reset: 'ready',
  submit: 'submitted',
  hitl: 'hitl_checked',
  answer: 'hitl_checked',
  diagnose: 'diagnosed',
};

export interface MacDriverRuntime {
  /** Whether this machine can run the driver: agent-desktop is installed. */
  available(): boolean;
  /** The UI seam over the session's app. The caller closes it. */
  connect(options: {
    appPath: string;
    deadlineAt: number;
    env: NodeJS.ProcessEnv;
  }): Promise<LinuxUi>;
}

const agentDesktopRuntime: MacDriverRuntime = {
  available: () => agentDesktopBinary() !== undefined,
  async connect({ appPath, deadlineAt, env }) {
    const binary = agentDesktopBinary();
    if (!binary) throw new Error('agent-desktop is not installed.');
    // A private state directory: refs and snapshots of this operation only,
    // and nothing left in the user's ~/.agent-desktop.
    const home = await mkdtemp(join(tmpdir(), 'mst-agent-desktop-'));
    try {
      const ui = await connectMacUi({
        desktop: agentDesktop({
          binary,
          deadlineAt,
          env: { ...env, AGENT_DESKTOP_HOME: home },
        }),
        appPath,
        deadlineAt,
      });
      return {
        ...ui,
        async close() {
          try {
            await ui.close();
          } finally {
            await rm(home, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await rm(home, { recursive: true, force: true });
      throw error;
    }
  },
};
let runtime = agentDesktopRuntime;

/** Replaces agent-desktop, for tests. Returns a function that restores it. */
export function setMacDriverRuntime(next: MacDriverRuntime): () => void {
  runtime = next;
  return () => {
    runtime = agentDesktopRuntime;
  };
}

/** Whether macOS drives Claude Desktop through its accessibility tree here. */
export function macDriverAvailable(): boolean {
  return runtime.available();
}

export async function runMacDriver(
  operation: LinuxDriverOperation,
  payload: LinuxDriverPayload,
  options: CoworkDriverOptions
): Promise<LinuxDriverReceipt> {
  const started = Date.now();
  const remaining = options.deadlineAt - started;
  if (remaining <= 0)
    throw new CoworkDriverError(
      'macOS desktop deadline exceeded; no action attempted.'
    );
  if (!options.appPath)
    throw new CoworkDriverError(
      "macOS desktop driving needs the session's Claude Desktop bundle; no action attempted."
    );
  const maxActions = options.maxActions ?? 24;
  const deadlineAt =
    started +
    Math.min(
      remaining,
      operation === 'submit'
        ? SUBMIT_TIMEOUT_MS
        : operation === 'diagnose'
          ? 20_000
          : 15_000
    );
  let receipt: LinuxDriverReceipt | undefined;
  let ui: LinuxUi | undefined;
  try {
    ui = await runtime.connect({
      appPath: options.appPath,
      deadlineAt,
      env: { ...process.env, ...options.env },
    });
    receipt = await runFirstPartyLinux(operation, payload, ui, {
      deadlineAt,
      maxActions,
    });
  } catch {
    // Connecting acts on nothing, and the driver reports its own failures:
    // a missing receipt here means no driver action ran.
    receipt = undefined;
  } finally {
    await Promise.resolve(ui?.close()).catch(() => undefined);
  }
  if (
    receipt?.status !== EXPECTED[operation] ||
    receipt.action_count > maxActions
  )
    throw new CoworkDriverError(
      `macOS desktop ${operation} failed or its receipt was uncertain (${receipt?.error ?? 'desktop_missing_or_unreadable'}); no retry attempted.`,
      semanticTelemetry(started, receipt?.action_count ?? 0, 'partial')
    );
  return receipt;
}
