import type { CoworkPlatform } from './platform.js';
import { ensureCoworkPython } from './pythonRuntime.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  runAnthropicComputerUseSubmission,
  runAnthropicComputerUseHitl,
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
  submit: runAnthropicComputerUseSubmission,
  handleHitl: runAnthropicComputerUseHitl,
};
