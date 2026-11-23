import { describe, expect, it } from 'vitest';
import {
  chosenDesktopAutomation,
  resolveDesktopAutomation,
} from './automation.js';

const linuxCowork = {
  name: 'cowork on Linux',
  default: 'atspi',
  supported: ['agent-desktop'],
} as const;

describe('chosenDesktopAutomation', () => {
  it('chooses nothing when the variable is unset or empty', () => {
    expect(chosenDesktopAutomation({})).toBeUndefined();
    expect(
      chosenDesktopAutomation({ MST_DESKTOP_AUTOMATION: '' })
    ).toBeUndefined();
  });

  it('reads a known automation', () => {
    expect(
      chosenDesktopAutomation({ MST_DESKTOP_AUTOMATION: 'agent-desktop' })
    ).toBe('agent-desktop');
  });

  it('fails on a value MST does not know, naming the ones it does', () => {
    expect(() =>
      chosenDesktopAutomation({ MST_DESKTOP_AUTOMATION: 'Agent-Desktop' })
    ).toThrow(
      'MST_DESKTOP_AUTOMATION="Agent-Desktop" names no desktop automation; MST knows atspi, computer-use, agent-desktop.'
    );
  });
});

describe('resolveDesktopAutomation', () => {
  it("runs the client's default when nothing is chosen", () => {
    expect(resolveDesktopAutomation({}, linuxCowork)).toBe('atspi');
  });

  it('runs a chosen automation the client supports', () => {
    expect(
      resolveDesktopAutomation(
        { MST_DESKTOP_AUTOMATION: 'agent-desktop' },
        linuxCowork
      )
    ).toBe('agent-desktop');
  });

  it("accepts choosing the client's own default", () => {
    expect(
      resolveDesktopAutomation({ MST_DESKTOP_AUTOMATION: 'atspi' }, linuxCowork)
    ).toBe('atspi');
  });

  it('fails on a choice the client cannot run on, before anything runs', () => {
    expect(() =>
      resolveDesktopAutomation(
        { MST_DESKTOP_AUTOMATION: 'computer-use' },
        linuxCowork
      )
    ).toThrow(
      'MST_DESKTOP_AUTOMATION=computer-use is not a way cowork on Linux can run; it runs on atspi or agent-desktop.'
    );
    expect(() =>
      resolveDesktopAutomation(
        { MST_DESKTOP_AUTOMATION: 'agent-desktop' },
        { name: 'chatgpt on Linux', default: 'atspi' }
      )
    ).toThrow('it runs on atspi.');
  });
});
