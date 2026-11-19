/**
 * Unit tests never drive the desktop of the machine that runs them.
 * agent-desktop installs with MST, so `tests/vitest.setup.ts` hides it: a
 * test that forgot to replace the macOS driver finds no agent-desktop, and
 * fails before it reads or presses anything in the developer's Claude Desktop.
 */
import { describe, expect, it } from 'vitest';
import { agentDesktopBinary } from '../src/evals/agentDesktop.js';
import {
  macDriverAvailable,
  runMacDriver,
} from '../src/evals/cowork/macDriver.js';
import { requireMacDriver } from '../src/evals/cowork/macos.js';

describe('agent-desktop in unit tests', () => {
  it('is not found, wherever it is installed', () => {
    expect(agentDesktopBinary()).toBeUndefined();
    expect(macDriverAvailable()).toBe(false);
    expect(() => requireMacDriver()).toThrow("isn't installed here");
  });

  it('is not run by a driver operation nobody replaced', async () => {
    await expect(
      runMacDriver(
        'probe',
        {},
        { deadlineAt: Date.now() + 5_000, appPath: '/Applications/Claude.app' }
      )
    ).rejects.toThrow('desktop_missing_or_unreadable');
  });
});
