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

  it('builds a submit script that prefers direct accessibility actions over global keystrokes', () => {
    const script = buildMacosDesktopSubmitScript('hello marker', {
      appName: 'Example',
      createNewConversation: false,
      settleDelayMs: 500,
    });

    expect(script).toContain('set value of textAreaElement to "hello marker"');
    expect(script).toContain('perform action "AXPress" of submitButtonElement');
    expect(script).toContain('keystroke "v" using command down');
    expect(script).toContain('key code 36');
  });
});
