import { describe, expect, it } from 'vitest';
import {
  buildMacosDesktopSubmitScript,
  MACOS_DESKTOP_CAPABILITIES,
} from './macosDesktop.js';

describe('macOS desktop built-in capabilities', () => {
  it('declares reusable platform, accessibility submit, and AX wake capabilities', () => {
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
      {
        id: 'builtin:desktop.macos.wakeAccessibility',
        capabilities: ['control'],
      },
    ]);
  });

  it('builds a submit script that focuses the composer via coordinate click then pastes and submits', () => {
    const script = buildMacosDesktopSubmitScript('hello marker', {
      appName: 'Example',
      createNewConversation: false,
      settleDelayMs: 500,
    });

    expect(script).toContain('tell application "Example" to activate');
    expect(script).toContain('click at {centerX as integer, composerY as integer}');
    expect(script).toContain('keystroke "v" using command down');
    expect(script).toContain('key code 36');
  });

  it('emits Cmd+N when createNewConversation is enabled', () => {
    const script = buildMacosDesktopSubmitScript('hello marker', {
      appName: 'Example',
      createNewConversation: true,
      settleDelayMs: 500,
    });

    expect(script).toContain('keystroke "n" using command down');
  });
});
