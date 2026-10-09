import type { CoworkPlatform } from './platform.js';
import { ensureCoworkPython } from './pythonRuntime.js';
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

/** Wiring only. Keep the live-tested setup and Computer Use behavior unchanged. */
export const macCoworkPlatform: CoworkPlatform = {
  dataDirectory: (options) =>
    options.dataDir ??
    join(
      homedir(),
      'Library',
      'Application Support',
      'Claude-3p',
      'local-agent-mode-sessions'
    ),
  async prepare(options) {
    await ensureCoworkPython(options.env);
    return prepareMacCoworkSession(options);
  },
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
