import type { CoworkPlatform } from './platform.js';
import { ensureCoworkPython } from './pythonRuntime.js';
import { CLAUDE_COWORK_DESKTOP_MACOS_DRIVER } from '../externalHost/driverIdentity.js';
import { getClaudeDataDir } from '../externalHost/builtins/anthropicClaude.js';
import {
  runAnthropicComputerUseSubmission,
  runAnthropicComputerUseHitl,
} from '../externalHost/builtins/anthropicComputerUse.js';
import { prepareMacCoworkSession } from '../coworkSetup/macSession.js';
import { recoverMacCoworkSession } from '../coworkSetup/recoverSession.js';

/** Wiring only. Keep the live-tested setup and Computer Use behavior unchanged. */
export const macCoworkPlatform: CoworkPlatform = {
  dataDirectory: (options) =>
    getClaudeDataDir({ driver: CLAUDE_COWORK_DESKTOP_MACOS_DRIVER, options }),
  async prepare(options) {
    await ensureCoworkPython(options.env);
    return prepareMacCoworkSession(options);
  },
  recover: recoverMacCoworkSession,
  submit: runAnthropicComputerUseSubmission,
  handleHitl: runAnthropicComputerUseHitl,
};
