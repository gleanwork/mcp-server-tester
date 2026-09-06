import { describe, expect, it } from 'vitest';
import {
  buildMacosAccessibilityDescriptionsScript,
  buildMacosAccessibilityTextScript,
  buildMacosAppLaunchArgs,
  buildMacosDesktopReadyScript,
  buildMacosDesktopSubmitScript,
  classifyMacosDesktopFailure,
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
        id: 'builtin:desktop.macos.appLifecycle',
        capabilities: ['control'],
      },
      {
        id: 'builtin:desktop.macos.accessibilitySubmit',
        capabilities: ['control', 'input'],
      },
    ]);
  });

  it('builds detached LaunchServices arguments with an isolated environment', () => {
    expect(
      buildMacosAppLaunchArgs('Example', {
        CLAUDE_CONFIG_DIR: '/tmp/eval profile',
      })
    ).toEqual([
      '--fresh',
      '--env',
      'CLAUDE_CONFIG_DIR=/tmp/eval profile',
      '-a',
      'Example',
    ]);
  });

  it('builds a lightweight flattened description scan for readiness checks', () => {
    const script = buildMacosAccessibilityDescriptionsScript('Example');

    expect(script).toContain('entire contents of front window');
    expect(script).toContain('description of theElement');
    expect(script).not.toContain('on collectText');
  });

  it('collects accessibility descriptions and titles as well as text values', () => {
    const script = buildMacosAccessibilityTextScript('Example');

    expect(script).toContain('description of theElement');
    expect(script).toContain('title of theElement');
    expect(script).toContain('value of theElement');
  });

  it('builds a readiness script that waits for an app process and window', () => {
    const script = buildMacosDesktopReadyScript('Example', 10_000);

    expect(script).toContain('tell application "Example" to activate');
    expect(script).toContain('repeat 50 times');
    expect(script).toContain('exists process "Example"');
    expect(script).toContain('exists window 1');
    expect(script).toContain(
      'Example did not expose a ready window within 10000ms'
    );
  });

  it('builds a submit script that uses keyboard-only input (no coordinate clicks)', () => {
    const script = buildMacosDesktopSubmitScript('hello marker', {
      appName: 'Example',
      createNewConversation: false,
      settleDelayMs: 500,
    });

    expect(script).toContain('tell application "Example" to activate');
    expect(script).toContain('keystroke "v" using command down');
    expect(script).toContain('delay 1.5');
    expect(script).toContain('key code 36');
    // Coordinate-based clicks were removed in favor of relying on Chromium's
    // DOM autofocus when a new conversation opens via Cmd+N.
    expect(script).not.toContain('click at {');
  });

  it('focuses and verifies a semantically named prompt area before submission', () => {
    const script = buildMacosDesktopSubmitScript('hello marker', {
      appName: 'Example',
      createNewConversation: false,
      settleDelayMs: 500,
      promptElementDescription: 'Write your prompt',
    });

    expect(script).toContain('perform action "AXPress"');
    expect(script).toContain('keystroke "a" using command down');
    expect(script).toContain('key code 51');
    expect(script).toContain('Write your prompt');
    expect(script).toContain('Pasted prompt was not found');
    expect(script).toContain('set previousClipboard to the clipboard');
    expect(script).toContain('set the clipboard to previousClipboard');
  });

  it('emits Cmd+N when createNewConversation is enabled', () => {
    const script = buildMacosDesktopSubmitScript('hello marker', {
      appName: 'Example',
      createNewConversation: true,
      settleDelayMs: 500,
    });

    expect(script).toContain('keystroke "n" using command down');
  });

  it('classifies explicit permission errors without treating diagnostic accessibility text as denial', () => {
    expect(
      classifyMacosDesktopFailure(
        'osascript is not allowed assistive access (-1743)'
      )
    ).toBe('automation_permission_denied');
    expect(
      classifyMacosDesktopFailure(
        'Timed out. Last observed accessibility text: standard window'
      )
    ).toBe('submission_failed');
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
