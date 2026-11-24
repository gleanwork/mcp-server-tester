import { describe, expect, it, vi } from 'vitest';
import {
  AgentDesktopError,
  type AgentDesktop,
  type AgentDesktopNode,
} from './agentDesktop.js';
import { agentDesktopUi } from './agentDesktopUi.js';
import { DesktopUiError } from './desktopUi.js';

type Fake = {
  [K in keyof AgentDesktop]: ReturnType<typeof vi.fn<AgentDesktop[K]>>;
};

const TREE: AgentDesktopNode = {
  role: 'window',
  name: 'An app',
  children: [
    {
      role: 'group',
      children: [
        { role: 'textfield', name: 'Prompt', ref_id: '@s1:e1' },
        {
          role: 'button',
          name: 'Send',
          ref_id: '@s1:e2',
          states: ['disabled'],
        },
        { role: 'statictext', value: 'Hidden note', states: ['hidden'] },
        {
          role: 'checkbox',
          name: 'Keep',
          ref_id: '@s1:e3',
          states: ['checked'],
        },
        { role: 'menuitem', name: 'Fast', value: '1', ref_id: '@s1:e4' },
        { role: 'menuitem', name: 'Open…', ref_id: '@s1:e5' },
        {
          role: 'link',
          name: 'Far away',
          ref_id: '@s1:e6',
          states: ['offscreen'],
        },
      ],
    },
  ],
};

function fake(tree: AgentDesktopNode = TREE): Fake {
  return {
    accessibility: vi.fn(async () => 'granted'),
    version: vi.fn(async () => '1.3.1'),
    apps: vi.fn(async () => []),
    windows: vi.fn(async () => []),
    snapshot: vi.fn(async () => ({ complete: true, tree })),
    value: vi.fn(async () => 'a value'),
    click: vi.fn(async () => {}),
    setValue: vi.fn(async () => {}),
    scrollTo: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    clipboardSet: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
  };
}
const host = {
  window: vi.fn(async () => ({ id: 'w-1', app: 'An app' })),
  open: vi.fn(async () => {}),
};

async function composer(ui: ReturnType<typeof agentDesktopUi>) {
  return (await ui.snapshot()).find((node) => node.role === 'entry')!;
}

describe('a snapshot through agent-desktop', () => {
  it('flattens the window in display order, with AT-SPI roles and states', async () => {
    const desktop = fake();
    const nodes = await agentDesktopUi(desktop, host).snapshot();

    expect(desktop.snapshot).toHaveBeenCalledExactlyOnceWith({
      id: 'w-1',
      app: 'An app',
    });
    expect(
      nodes.map(({ id, parentId, ...rest }) => ({
        ...rest,
        parent: parentId ? nodes.findIndex((n) => n.id === parentId) : -1,
      }))
    ).toEqual([
      {
        name: 'An app',
        role: 'frame',
        visible: true,
        showing: true,
        enabled: true,
        selected: false,
        parent: -1,
      },
      {
        name: '',
        role: 'section',
        visible: true,
        showing: true,
        enabled: true,
        selected: false,
        parent: 0,
      },
      {
        name: 'Prompt',
        role: 'entry',
        visible: true,
        showing: true,
        enabled: true,
        selected: false,
        parent: 1,
      },
      {
        name: 'Send',
        role: 'button',
        visible: true,
        showing: true,
        enabled: false,
        selected: false,
        parent: 1,
      },
      {
        name: 'Hidden note',
        role: 'static',
        visible: false,
        showing: false,
        enabled: true,
        selected: false,
        parent: 1,
      },
      {
        name: 'Keep',
        role: 'check box',
        visible: true,
        showing: true,
        enabled: true,
        selected: true,
        parent: 1,
      },
      {
        name: 'Fast',
        role: 'radio menu item',
        visible: true,
        showing: true,
        enabled: true,
        selected: false,
        parent: 1,
      },
      {
        name: 'Open…',
        role: 'menu item',
        visible: true,
        showing: true,
        enabled: true,
        selected: false,
        parent: 1,
      },
      {
        name: 'Far away',
        role: 'link',
        visible: true,
        showing: false,
        enabled: true,
        selected: false,
        parent: 1,
      },
    ]);
  });

  it('fails as an incomplete scan when agent-desktop ran out of time', async () => {
    const desktop = fake();
    desktop.snapshot.mockResolvedValue({ complete: false, tree: TREE });
    await expect(agentDesktopUi(desktop, host).snapshot()).rejects.toEqual(
      new DesktopUiError('accessibility_scan_timeout')
    );
  });

  it('names a node from an older snapshot nothing', async () => {
    const desktop = fake();
    const ui = agentDesktopUi(desktop, host);
    const old = await composer(ui);
    await ui.snapshot();
    await expect(ui.activate(old)).rejects.toEqual(
      new DesktopUiError('accessibility_unknown_node')
    );
    expect(desktop.click).not.toHaveBeenCalled();
  });
});

describe('reading text', () => {
  it("reads an actionable element's value, and a static node's name", async () => {
    const desktop = fake();
    const ui = agentDesktopUi(desktop, host);
    const nodes = await ui.snapshot();
    expect(await ui.readText(nodes.find((n) => n.name === 'Prompt')!)).toBe(
      'a value'
    );
    expect(
      await ui.readText(nodes.find((n) => n.name === 'Hidden note')!)
    ).toBe('Hidden note');
    expect(desktop.value).toHaveBeenCalledExactlyOnceWith('@s1:e1');
  });

  it("assembles an editor's paragraphs when its value is embedded-object markers", async () => {
    const desktop = fake({
      role: 'window',
      children: [
        {
          role: 'textfield',
          name: 'Prompt',
          ref_id: '@s1:e1',
          value: '\ufffc\ufffc',
          children: [
            {
              role: 'paragraph',
              children: [
                { role: 'statictext', name: 'one ' },
                { role: 'link', name: 'http://x' },
              ],
            },
            {
              role: 'paragraph',
              children: [{ role: 'statictext', name: 'two' }],
            },
          ],
        },
      ],
    });
    const ui = agentDesktopUi(desktop, host);
    expect(await ui.readText(await composer(ui))).toBe('one http://x\ntwo');
    expect(desktop.value).not.toHaveBeenCalled();
  });
});

describe('entering text', () => {
  it('sets the value by default, line breaks included', async () => {
    const desktop = fake();
    const ui = agentDesktopUi(desktop, host);
    await ui.enterText(await composer(ui), 'one\ntwo');
    expect(desktop.setValue).toHaveBeenCalledExactlyOnceWith(
      '@s1:e1',
      'one\ntwo'
    );
    expect(desktop.clipboardSet).not.toHaveBeenCalled();
    expect(desktop.press).not.toHaveBeenCalled();
  });

  it('pastes on a host whose editors ignore a set value: clipboard, focus, one paste key', async () => {
    const desktop = fake();
    const ui = agentDesktopUi(desktop, { ...host, textEntry: 'paste' });
    await ui.enterText(await composer(ui), 'one\ntwo\t✓');
    expect(desktop.clipboardSet).toHaveBeenCalledExactlyOnceWith('one\ntwo\t✓');
    expect(desktop.focus).toHaveBeenCalledExactlyOnceWith('@s1:e1');
    expect(desktop.press).toHaveBeenCalledExactlyOnceWith('ctrl+v');
    expect(desktop.setValue).not.toHaveBeenCalled();
    const order = [desktop.clipboardSet, desktop.focus, desktop.press].map(
      (call) => call.mock.invocationCallOrder[0]!
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('sends no key when the clipboard or the focus fails', async () => {
    const clipboard = fake();
    clipboard.clipboardSet.mockRejectedValue(
      new AgentDesktopError('ACTION_FAILED')
    );
    const ui = agentDesktopUi(clipboard, { ...host, textEntry: 'paste' });
    await expect(ui.enterText(await composer(ui), 'x')).rejects.toEqual(
      new DesktopUiError('clipboard_unavailable')
    );
    expect(clipboard.press).not.toHaveBeenCalled();

    const focus = fake();
    focus.focus.mockRejectedValue(new AgentDesktopError('ACTION_FAILED'));
    const ui2 = agentDesktopUi(focus, { ...host, textEntry: 'paste' });
    await expect(ui2.enterText(await composer(ui2), 'x')).rejects.toEqual(
      new DesktopUiError('composer_not_focused')
    );
    expect(focus.press).not.toHaveBeenCalled();
  });

  it('reports a failed paste key as uncertain, unless agent-desktop says it was not delivered', async () => {
    const desktop = fake();
    desktop.press.mockRejectedValueOnce(new AgentDesktopError('TIMEOUT'));
    const ui = agentDesktopUi(desktop, { ...host, textEntry: 'paste' });
    await expect(ui.enterText(await composer(ui), 'x')).rejects.toEqual(
      new DesktopUiError('action_acknowledgement_uncertain')
    );
    desktop.press.mockRejectedValueOnce(
      new AgentDesktopError('TIMEOUT', undefined, 'not_delivered')
    );
    await expect(ui.enterText(await composer(ui), 'x')).rejects.toEqual(
      new DesktopUiError('accessibility_scan_timeout')
    );
  });

  it.each([
    ['nothing', ''],
    ['a NUL', 'a\0b'],
    ['more than agent-desktop takes on stdin', 'a'.repeat(128 * 1024 + 1)],
  ])(
    'refuses %s before anything is sent, on either entry',
    async (_name, text) => {
      for (const textEntry of ['set-value', 'paste'] as const) {
        const desktop = fake();
        const ui = agentDesktopUi(desktop, { ...host, textEntry });
        await expect(ui.enterText(await composer(ui), text)).rejects.toEqual(
          new DesktopUiError('invalid_prompt')
        );
        expect(desktop.setValue).not.toHaveBeenCalled();
        expect(desktop.clipboardSet).not.toHaveBeenCalled();
      }
    }
  );

  it("accepts agent-desktop's own verification failure after a delivered set-value", async () => {
    const desktop = fake();
    desktop.setValue.mockRejectedValue(
      new AgentDesktopError(
        'ACTION_FAILED',
        'post_action_verification',
        'delivered'
      )
    );
    const ui = agentDesktopUi(desktop, host);
    await expect(
      ui.enterText(await composer(ui), 'x')
    ).resolves.toBeUndefined();
  });
});

describe('actions and links', () => {
  it('clicks, scrolls to and opens through the desktop and the host', async () => {
    const desktop = fake();
    const ui = agentDesktopUi(desktop, host);
    const entry = await composer(ui);
    await ui.activate(entry);
    await ui.reveal(entry);
    await ui.openLink('app://new', 'open_failed');
    expect(desktop.click).toHaveBeenCalledExactlyOnceWith('@s1:e1');
    expect(desktop.scrollTo).toHaveBeenCalledExactlyOnceWith('@s1:e1');
    expect(host.open).toHaveBeenCalledWith('app://new', 'open_failed');
  });

  it('maps a failed click to an uncertain action and a failed scroll to reveal_failed', async () => {
    const desktop = fake();
    desktop.click.mockRejectedValue(new AgentDesktopError('ACTION_FAILED'));
    desktop.scrollTo.mockRejectedValue(new AgentDesktopError('STALE_REF'));
    const ui = agentDesktopUi(desktop, host);
    const entry = await composer(ui);
    await expect(ui.activate(entry)).rejects.toEqual(
      new DesktopUiError('action_acknowledgement_uncertain')
    );
    await expect(ui.reveal(entry)).rejects.toEqual(
      new DesktopUiError('reveal_failed')
    );
  });

  it("closes the host's hold with the connection", async () => {
    const close = vi.fn();
    const ui = agentDesktopUi(fake(), { ...host, close });
    await ui.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('agent-desktop failure codes', () => {
  it.each([
    ['TIMEOUT', 'accessibility_scan_timeout'],
    ['APP_UNRESPONSIVE', 'accessibility_scan_timeout'],
    ['STALE_REF', 'accessibility_node_defunct'],
    ['ELEMENT_NOT_FOUND', 'accessibility_node_defunct'],
    ['WINDOW_NOT_FOUND', 'desktop_missing_or_ambiguous'],
    ['AMBIGUOUS_TARGET', 'desktop_missing_or_ambiguous'],
    ['NO_REPLY', 'accessibility_invalid_reply'],
    ['SOMETHING_NEW', 'accessibility_unavailable'],
  ])('reads %s as %s', async (code, expected) => {
    const desktop = fake();
    desktop.snapshot.mockRejectedValue(new AgentDesktopError(code));
    await expect(agentDesktopUi(desktop, host).snapshot()).rejects.toEqual(
      new DesktopUiError(expected)
    );
  });
});
