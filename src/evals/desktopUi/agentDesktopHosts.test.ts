import { describe, expect, it, vi } from 'vitest';
import type * as ChildProcess from 'node:child_process';
import { AgentDesktopError, type AgentDesktop } from './agentDesktop.js';
import { connectAgentDesktopUi } from './agentDesktopConnect.js';
import { connectAgentDesktopLinuxUi } from './agentDesktopLinux.js';
import { connectAgentDesktopMacUi } from './agentDesktopMac.js';
import { DesktopUiError } from './desktopUi.js';

const external = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFile: external.execFile,
}));

const TREE = {
  role: 'window',
  name: 'App',
  children: [{ role: 'textfield', name: 'Prompt', ref_id: '@s1:e1' }],
};
function fake(overrides: Partial<AgentDesktop> = {}): AgentDesktop {
  return {
    accessibility: vi.fn(async () => 'granted'),
    version: vi.fn(async () => '1.3.1'),
    apps: vi.fn(async () => [
      { name: 'Claude', pid: 1 },
      { name: 'Finder', pid: 2 },
    ]),
    windows: vi.fn(async (app?: string) =>
      app === undefined || app === 'Claude'
        ? [
            {
              id: 'w-1',
              pid: 1,
              accessible: true,
              visible: true,
              app_name: 'Claude',
            },
            {
              id: 'w-2',
              pid: 2,
              accessible: true,
              visible: true,
              app_name: 'Finder',
            },
          ].filter((w) => app === undefined || w.app_name === app)
        : []
    ),
    snapshot: vi.fn(async () => ({ complete: true, tree: TREE })),
    value: vi.fn(async () => ''),
    click: vi.fn(async () => {}),
    setValue: vi.fn(async () => {}),
    scrollTo: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    clipboardSet: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    ...overrides,
  };
}
const env = { DISPLAY: ':1', HOME: '/home/u' };
const isClaude = (name: string) => name.toLowerCase() === 'claude';

function opener(exitError: Error | null = null) {
  external.execFile.mockReset();
  external.execFile.mockImplementation(
    (_file, _args, _options, callback: (error: Error | null) => void) => {
      callback(exitError);
      return {};
    }
  );
}

describe('agent-desktop on Linux', () => {
  it('reads the one accessible window of the app, by its name on the bus, and pastes text', async () => {
    const desktop = fake();
    const ui = await connectAgentDesktopLinuxUi(env, Date.now() + 10_000, {
      application: isClaude,
      desktop,
    });
    const nodes = await ui.snapshot();
    expect(desktop.windows).toHaveBeenCalledExactlyOnceWith();
    expect(desktop.snapshot).toHaveBeenCalledExactlyOnceWith({
      id: 'w-1',
      app: 'Claude',
    });
    await ui.enterText(nodes.find((n) => n.role === 'entry')!, 'hi');
    expect(desktop.press).toHaveBeenCalledWith('ctrl+v');
    expect(desktop.setValue).not.toHaveBeenCalled();
    // The window is found once for the connection.
    await ui.snapshot();
    expect(desktop.windows).toHaveBeenCalledOnce();
  });

  it('fails when the app has no window or more than one', async () => {
    for (const windows of [
      [],
      [
        {
          id: 'a',
          pid: 1,
          accessible: true,
          visible: true,
          app_name: 'Claude',
        },
        {
          id: 'b',
          pid: 1,
          accessible: true,
          visible: true,
          app_name: 'claude',
        },
      ],
    ]) {
      const ui = await connectAgentDesktopLinuxUi(env, Date.now() + 10_000, {
        application: isClaude,
        desktop: fake({ windows: vi.fn(async () => windows) }),
      });
      await expect(ui.snapshot()).rejects.toEqual(
        new DesktopUiError('desktop_missing_or_ambiguous')
      );
    }
  });

  it('opens a link with the URL opener, and fails with the caller’s code', async () => {
    opener();
    const ui = await connectAgentDesktopLinuxUi(env, Date.now() + 10_000, {
      application: isClaude,
      desktop: fake(),
      urlOpener: '/opt/open-in-app',
    });
    await ui.openLink('app://x', 'open_failed');
    expect(external.execFile.mock.calls[0]!.slice(0, 2)).toEqual([
      '/opt/open-in-app',
      ['app://x'],
    ]);
    opener(new Error('exit 1'));
    await expect(ui.openLink('app://x', 'open_failed')).rejects.toEqual(
      new DesktopUiError('open_failed')
    );
  });

  it('refuses a relative URL opener before running it', async () => {
    opener();
    const ui = await connectAgentDesktopLinuxUi(env, Date.now() + 10_000, {
      application: isClaude,
      desktop: fake(),
      urlOpener: 'bin/open',
    });
    await expect(ui.openLink('app://x', 'open_failed')).rejects.toEqual(
      new DesktopUiError('invalid_url_opener')
    );
    expect(external.execFile).not.toHaveBeenCalled();
  });
});

describe('agent-desktop on macOS', () => {
  it('finds the app among the running applications, lists only its windows, and sets text as a value', async () => {
    const desktop = fake();
    const ui = await connectAgentDesktopMacUi(env, Date.now() + 10_000, {
      application: isClaude,
      desktop,
    });
    const nodes = await ui.snapshot();
    expect(desktop.apps).toHaveBeenCalledOnce();
    expect(desktop.windows).toHaveBeenCalledExactlyOnceWith('Claude');
    expect(desktop.snapshot).toHaveBeenCalledExactlyOnceWith({
      id: 'w-1',
      app: 'Claude',
    });
    await ui.enterText(nodes.find((n) => n.role === 'entry')!, 'hi\nthere');
    expect(desktop.setValue).toHaveBeenCalledExactlyOnceWith(
      '@s1:e1',
      'hi\nthere'
    );
    expect(desktop.press).not.toHaveBeenCalled();
  });

  it('fails when the app is not running', async () => {
    const ui = await connectAgentDesktopMacUi(env, Date.now() + 10_000, {
      application: isClaude,
      desktop: fake({ apps: vi.fn(async () => [{ name: 'Finder', pid: 2 }]) }),
    });
    await expect(ui.snapshot()).rejects.toEqual(
      new DesktopUiError('desktop_missing_or_ambiguous')
    );
  });

  it("maps agent-desktop's failure to list windows", async () => {
    const ui = await connectAgentDesktopMacUi(env, Date.now() + 10_000, {
      application: isClaude,
      desktop: fake({
        windows: vi.fn(async () => {
          throw new AgentDesktopError('TIMEOUT');
        }),
      }),
    });
    await expect(ui.snapshot()).rejects.toEqual(
      new DesktopUiError('accessibility_scan_timeout')
    );
  });

  it('opens a link with /usr/bin/open', async () => {
    opener();
    const ui = await connectAgentDesktopMacUi(env, Date.now() + 10_000, {
      application: isClaude,
      desktop: fake(),
    });
    await ui.openLink('claude://x', 'open_failed');
    expect(external.execFile.mock.calls[0]!.slice(0, 2)).toEqual([
      '/usr/bin/open',
      ['claude://x'],
    ]);
    opener(new Error('exit 1'));
    await expect(ui.openLink('claude://x', 'open_failed')).rejects.toEqual(
      new DesktopUiError('open_failed')
    );
  });
});

describe('agent-desktop for the OS that runs MST', () => {
  it('fails on an OS MST has no desktop setup for, before running anything', async () => {
    await expect(
      connectAgentDesktopUi(
        env,
        Date.now() + 10_000,
        { application: isClaude },
        'win32'
      )
    ).rejects.toEqual(new DesktopUiError('desktop_os_unsupported'));
  });

  it('fails when agent-desktop is not installed', async () => {
    // tests/vitest.setup.ts hides the installed package from every unit test.
    for (const platform of ['linux', 'darwin'] as const)
      await expect(
        connectAgentDesktopUi(
          env,
          Date.now() + 10_000,
          { application: isClaude },
          platform
        )
      ).rejects.toEqual(new DesktopUiError('agent_desktop_not_installed'));
  });
});
