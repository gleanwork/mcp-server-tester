import type { CoworkDesktop } from './desktop.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  runAnthropicComputerUseSubmission,
  runAnthropicComputerUseHitl,
  runAnthropicComputerUseReset,
} from './anthropicComputerUse.js';
import { prepareMacCoworkSession } from '../coworkSetup/macSession.js';
import { recoverMacCoworkSession } from '../coworkSetup/recoverSession.js';
import { clientSecretValues, redactClientError } from '../clientSecrets.js';
import { CoworkDriverError } from './interaction.js';
import { macDriverAvailable, runMacDriver } from './macDriver.js';
import { handleSemanticHitl, semanticTelemetry } from './semanticHitl.js';

/** Wiring only. Keep the live-tested setup and Computer Use behavior unchanged. */
export const coworkMacos: CoworkDesktop = {
  dataDirectory: (options) =>
    options.dataDir ??
    join(
      homedir(),
      'Library',
      'Application Support',
      'Claude-3p',
      'local-agent-mode-sessions'
    ),
  prepare: prepareMacCoworkSession,
  recover: recoverMacCoworkSession,
  // After a failed case: stop the task and decline any prompt, so the next
  // case runs alone. The Computer Use planner tries first; if it can't (it
  // proposed something a reset may not do, or ran out of actions), quitting
  // and relaunching Claude stops whatever was running. A reset that fails
  // both ways stops the batch (see desktopBatch).
  async reset({ restartApp, ...options }) {
    try {
      await runAnthropicComputerUseReset(options);
    } catch (error) {
      if (!restartApp) throw error;
      const secrets = clientSecretValues(options.env ?? {}, []);
      const reason = redactClientError(error, secrets, 'reset failed');
      process.stderr.write(
        `[mst:cowork] Computer Use reset failed (${reason}); restarting Claude Desktop instead\n`
      );
      try {
        await restartApp();
      } catch (restartError) {
        // Say why both failed: the batch stops on this message.
        throw new Error(
          `Computer Use reset failed (${reason}), and restarting Claude Desktop failed too: ${redactClientError(restartError, secrets, 'restart failed')}`
        );
      }
    }
  },
  submit: runAnthropicComputerUseSubmission,
  handleHitl: runAnthropicComputerUseHitl,
};

/**
 * Account mode has one driver on macOS. Fails, before any desktop action,
 * on a machine where agent-desktop is not installed.
 */
export function requireMacDriver(): void {
  if (!macDriverAvailable())
    throw new Error(
      "First-party Cowork on macOS drives Claude Desktop through agent-desktop, which isn't installed here. MST installs it as an optional dependency: install MST without `--omit=optional`, or run `npm install agent-desktop`."
    );
}

/**
 * Account mode (Cowork signed in to claude.ai). MST reads and presses Claude
 * Desktop's own controls through its accessibility tree, with agent-desktop,
 * under the same policy as account mode on Linux: no planner, no screenshots.
 * Computer Use never drives account mode.
 */
export const coworkMacosFirstParty: CoworkDesktop = {
  // The session's setup and recovery. Every desktop operation is replaced.
  ...coworkMacos,
  async reset({ restartApp, ...options }) {
    try {
      await runMacDriver('reset', {}, { ...options, maxActions: 2 });
    } catch (error) {
      if (!restartApp) throw error;
      const secrets = clientSecretValues(options.env ?? {}, []);
      const reason = redactClientError(error, secrets, 'reset failed');
      process.stderr.write(
        `[mst:cowork] reset failed (${reason}); restarting Claude Desktop instead\n`
      );
      try {
        await restartApp();
      } catch (restartError) {
        throw new Error(
          `Reset failed (${reason}), and restarting Claude Desktop failed too: ${redactClientError(restartError, secrets, 'restart failed')}`
        );
      }
    }
  },
  async submit(query, options) {
    const started = Date.now();
    const receipt = await runMacDriver(
      'submit',
      {
        prompt: query,
        ...(options.targetModel ? { targetModel: options.targetModel } : {}),
      },
      options
    );
    return {
      status: 'submitted',
      action_count: receipt.action_count,
      telemetry: semanticTelemetry(started, receipt.action_count, 'complete'),
    };
  },
  async handleHitl(options) {
    // This is the user's own Claude Desktop, with their other tasks in it.
    // Each pass names its task, and the driver presses nothing elsewhere.
    const { prompt } = options;
    if (prompt === undefined)
      throw new CoworkDriverError(
        'macOS HITL needs the prompt that started its task; no action attempted.'
      );
    const pass = async (
      mode: 'hitl' | 'answer',
      payload: { approveWriteTools?: boolean; questions?: unknown },
      maxActions: number
    ) => {
      const receipt = await runMacDriver(
        mode,
        mode === 'hitl'
          ? { approveWrites: payload.approveWriteTools === true, prompt }
          : (payload as { questions: { labels: string[] }[] }),
        { ...options, maxActions }
      );
      return {
        action_count: receipt.action_count,
        ...(receipt.scan === 'incomplete' ? { scanIncomplete: true } : {}),
        ...(receipt.denied === 'folder_request'
          ? { deniedFolderRequest: true }
          : {}),
        ...(receipt.answered ? { answered: true } : {}),
      };
    };
    // Bound to a native session: watch it until it completes.
    if (options.isComplete) return handleSemanticHitl(options, pass, 'macOS');
    // A later look at a task waiting on a tool: one pass.
    const started = Date.now();
    const result = await pass(
      'hitl',
      { approveWriteTools: options.approveWriteTools === true },
      options.maxActions ?? 12
    );
    return {
      status: 'hitl_checked',
      action_count: result.action_count,
      telemetry: semanticTelemetry(started, result.action_count, 'complete', {
        incompleteScans: result.scanIncomplete ? 1 : 0,
        folderRequestsDenied: result.deniedFolderRequest ? 1 : 0,
      }),
    };
  },
};
