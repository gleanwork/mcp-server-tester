import { describe, expect, it, vi } from 'vitest';
import type { DesktopUi, DesktopUiNode } from '../desktopUi/desktopUi.js';
import { coworkUi, isClaude, LinuxUiError } from './linuxUi.js';

const node: DesktopUiNode = {
  id: 'entry',
  name: 'Write your prompt to Claude',
  role: 'entry',
  visible: true,
  showing: true,
  enabled: true,
  selected: false,
};

function transport(): DesktopUi {
  return {
    snapshot: vi.fn(async () => [node]),
    readText: vi.fn(async () => 'draft'),
    activate: vi.fn(async () => {}),
    reveal: vi.fn(async () => {}),
    enterText: vi.fn(async () => {}),
    openLink: vi.fn(async () => {}),
    close: vi.fn(),
  };
}

describe('coworkUi', () => {
  it('passes reads and actions to the transport unchanged', async () => {
    const desktop = transport();
    const ui = coworkUi(desktop);

    expect(await ui.snapshot()).toEqual([node]);
    expect(await ui.readText(node)).toBe('draft');
    await ui.activate(node);
    await ui.reveal(node);
    await ui.paste(node, 'a prompt');
    await ui.close();

    expect(desktop.activate).toHaveBeenCalledExactlyOnceWith(node);
    expect(desktop.reveal).toHaveBeenCalledExactlyOnceWith(node);
    expect(desktop.enterText).toHaveBeenCalledExactlyOnceWith(node, 'a prompt');
    expect(desktop.close).toHaveBeenCalledOnce();
    expect(desktop.openLink).not.toHaveBeenCalled();
  });

  it("opens Cowork with Claude's link", async () => {
    const desktop = transport();
    await coworkUi(desktop).openCowork();
    expect(desktop.openLink).toHaveBeenCalledExactlyOnceWith(
      'claude://cowork/new',
      'open_cowork_failed'
    );
  });

  it('opens the managed new-task route with no query parameter', async () => {
    const desktop = transport();
    await coworkUi(desktop).openBlankManagedTask();
    expect(desktop.openLink).toHaveBeenCalledExactlyOnceWith(
      'claude://claude.ai/new',
      'open_task_failed'
    );
  });

  it('opens a new task with the prompt percent-encoded as its draft', async () => {
    const desktop = transport();
    await coworkUi(desktop).openNewTask('a b&c=d/é\n');
    expect(desktop.openLink).toHaveBeenCalledExactlyOnceWith(
      'claude://claude.ai/new?q=a%20b%26c%3Dd%2F%C3%A9%0A',
      'open_task_failed'
    );
  });

  it('opens a blank task for an empty prompt', async () => {
    const desktop = transport();
    await coworkUi(desktop).openNewTask('');
    expect(desktop.openLink).toHaveBeenCalledExactlyOnceWith(
      'claude://claude.ai/new?q=',
      'open_task_failed'
    );
  });

  it('refuses a prompt no link can carry, before the transport is asked', async () => {
    const desktop = transport();
    await expect(coworkUi(desktop).openNewTask('\ud800')).rejects.toEqual(
      new LinuxUiError('invalid_prompt')
    );
    expect(desktop.openLink).not.toHaveBeenCalled();
  });

  it("reports the transport's failure as it is", async () => {
    const desktop = transport();
    vi.mocked(desktop.openLink).mockRejectedValue(
      new LinuxUiError('open_task_failed')
    );
    await expect(coworkUi(desktop).openNewTask('x')).rejects.toMatchObject({
      code: 'open_task_failed',
    });
  });
});

describe('isClaude', () => {
  it.each(['Claude', 'claude', 'CLAUDE-DESKTOP', 'claude-desktop'])(
    'accepts the exact name %s',
    (name) => {
      expect(isClaude(name)).toBe(true);
    }
  );

  it.each(['Claude Helper', 'claude-desktop-3p', 'ChatGPT', ''])(
    'rejects %j',
    (name) => {
      expect(isClaude(name)).toBe(false);
    }
  );
});
