import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopUiError } from '../desktopUi/desktopUi.js';

const transports = vi.hoisted(() => ({
  atspi: vi.fn(),
  agentDesktop: vi.fn(),
}));
vi.mock('../desktopUi/atspi.js', () => ({
  connectAtspiDesktopUi: transports.atspi,
}));
vi.mock('../desktopUi/agentDesktopLinux.js', () => ({
  connectAgentDesktopLinuxUi: transports.agentDesktop,
}));

const { connectLinuxUi } = await import('./linuxConnect.js');
const { linuxCoworkAutomation } = await import('./linuxAutomation.js');

const env = {
  DISPLAY: ':99',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/bus',
  MST_COWORK_URL_OPENER: '/usr/local/bin/open-in-claude',
};
const ui = {
  snapshot: vi.fn(),
  readText: vi.fn(),
  activate: vi.fn(),
  reveal: vi.fn(),
  enterText: vi.fn(),
  openLink: vi.fn(),
  close: vi.fn(),
};

describe('which transport Cowork on Linux connects through', () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs MST's AT-SPI client unless the environment chooses otherwise", async () => {
    transports.atspi.mockResolvedValue(ui);
    await connectLinuxUi(env, Date.now() + 10_000);
    expect(linuxCoworkAutomation(env)).toBe('atspi');
    expect(transports.atspi).toHaveBeenCalledOnce();
    expect(transports.agentDesktop).not.toHaveBeenCalled();
    const [, , options] = transports.atspi.mock.calls[0]!;
    expect(options.urlOpener).toBe('/usr/local/bin/open-in-claude');
    expect(options.application('Claude')).toBe(true);
    expect(options.application('Code')).toBe(false);
  });

  it('runs agent-desktop when MST_DESKTOP_AUTOMATION chooses it, with the same app and opener', async () => {
    transports.agentDesktop.mockResolvedValue(ui);
    const chosen = { ...env, MST_DESKTOP_AUTOMATION: 'agent-desktop' };
    const connected = await connectLinuxUi(chosen, Date.now() + 10_000);
    expect(linuxCoworkAutomation(chosen)).toBe('agent-desktop');
    expect(transports.agentDesktop).toHaveBeenCalledOnce();
    const [, , options] = transports.agentDesktop.mock.calls[0]!;
    expect(options.urlOpener).toBe('/usr/local/bin/open-in-claude');
    expect(options.application('claude-desktop')).toBe(true);
    // Cowork's links are the same over either transport.
    await connected.openCowork();
    expect(ui.openLink).toHaveBeenCalledWith(
      'claude://cowork/new',
      'open_cowork_failed'
    );
  });

  it('fails before connecting on an automation Cowork on Linux cannot run on', async () => {
    const chosen = { ...env, MST_DESKTOP_AUTOMATION: 'computer-use' };
    await expect(connectLinuxUi(chosen, Date.now() + 10_000)).rejects.toThrow(
      'MST_DESKTOP_AUTOMATION=computer-use is not a way cowork on Linux can run'
    );
    expect(transports.atspi).not.toHaveBeenCalled();
    expect(transports.agentDesktop).not.toHaveBeenCalled();
  });

  it('keeps a transport failure as the interface error', async () => {
    transports.agentDesktop.mockRejectedValue(
      new DesktopUiError('agent_desktop_not_installed')
    );
    await expect(
      connectLinuxUi(
        { ...env, MST_DESKTOP_AUTOMATION: 'agent-desktop' },
        Date.now() + 10_000
      )
    ).rejects.toThrow('agent_desktop_not_installed');
  });
});
