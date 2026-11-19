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
 * Whether a macOS batch needs the Computer Use planner, and so an Anthropic
 * credential. Account mode doesn't when agent-desktop is installed.
 */
export function coworkMacosUsesPlanner(firstParty: boolean): boolean {
  return !firstParty || !macDriverAvailable();
}

/**
 * Account mode (Cowork signed in to claude.ai). With agent-desktop installed,
 * MST reads and presses Claude Desktop's own controls through its
 * accessibility tree, under the same policy as account mode on Linux: no
 * planner, no screenshots. Without it, Computer Use drives the app as before.
 * The choice is made once per operation and never changes after an action.
 */
export const coworkMacosFirstParty: CoworkDesktop = {
  ...coworkMacos,
  async reset({ restartApp, ...options }) {
    if (!macDriverAvailable())
      return coworkMacos.reset!({ restartApp, ...options });
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
    if (!macDriverAvailable()) return coworkMacos.submit(query, options);
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
    if (!macDriverAvailable()) return coworkMacos.handleHitl(options);
    const pass = async (
      mode: 'hitl' | 'answer',
      payload: { approveWriteTools?: boolean; questions?: unknown },
      maxActions: number
    ) => {
      const receipt = await runMacDriver(
        mode,
        mode === 'hitl'
          ? { approveWrites: payload.approveWriteTools === true }
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
