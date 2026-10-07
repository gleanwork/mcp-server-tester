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
  // case runs alone. A reset that fails stops the batch (see desktopBatch).
  async reset(options) {
    await runAnthropicComputerUseReset(options);
  },
  submit: runAnthropicComputerUseSubmission,
  handleHitl: runAnthropicComputerUseHitl,
};
