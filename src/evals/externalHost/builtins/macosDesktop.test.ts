import { describe, expect, it } from 'vitest';
import {
  buildMacosDesktopSubmitScript,
  MACOS_DESKTOP_CAPABILITIES,
} from './macosDesktop.js';

describe('macOS desktop built-in capabilities', () => {
  it('declares reusable platform and accessibility submit capabilities', () => {
    expect(
      MACOS_DESKTOP_CAPABILITIES.map((capability) => ({
        id: capability.id,
        capabilities: capability.capabilities,
      }))
    ).toEqual([
      {
        id: 'builtin:platform.macos',
        capabilities: ['control'],
      },
      {
        id: 'builtin:desktop.macos.accessibilitySubmit',
        capabilities: ['control', 'input'],
      },
    ]);
  });

  it('builds a submit script that uses keyboard-only input (no coordinate clicks)', () => {
    const script = buildMacosDesktopSubmitScript('hello marker', {
      appName: 'Example',
      createNewConversation: false,
      settleDelayMs: 500,
    });

    expect(script).toContain('tell application "Example" to activate');
    expect(script).toContain('keystroke "v" using command down');
    expect(script).toContain('key code 36');
    // Coordinate-based clicks were removed in favor of relying on Chromium's
    // DOM autofocus when a new conversation opens via Cmd+N.
    expect(script).not.toContain('click at {');
  });

  it('emits Cmd+N when createNewConversation is enabled', () => {
    const script = buildMacosDesktopSubmitScript('hello marker', {
      appName: 'Example',
      createNewConversation: true,
      settleDelayMs: 500,
    });

    expect(script).toContain('keystroke "n" using command down');
  });

  it('verifies the target app is foregrounded before sending keystrokes and errors fast otherwise', () => {
    const script = buildMacosDesktopSubmitScript('hello marker', {
      appName: 'Example',
      createNewConversation: false,
      settleDelayMs: 500,
    });

    // The retry loop polls `frontmost` and re-asserts `set frontmost to true`
    // up to 10 times so transient focus-prevention can be retried before we
    // give up.
    expect(script).toContain('repeat 10 times');
    expect(script).toContain('if frontmost then');
    expect(script).toContain('set frontmost to true');

    // If the loop exits without activation succeeding, the script must error
    // fast with a message identifying the foreground problem rather than
    // letting downstream keystrokes route to the wrong app and surface as a
    // 90-second eval timeout.
    expect(script).toContain('if not activated then');
    expect(script).toContain(
      'could not be brought to the foreground (focus is held by another app)'
    );
  });
});
