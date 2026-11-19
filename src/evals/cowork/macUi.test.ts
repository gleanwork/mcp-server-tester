import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentDesktopError,
  type AgentDesktop,
  type AgentDesktopNode,
  type AgentDesktopWindow,
} from '../agentDesktop.js';
import { runFirstPartyLinux } from './linuxFirstPartyDriver.js';
import { LinuxUiError, type LinuxUiNode } from './linuxUi.js';
import { connectMacUi } from './macUi.js';

let appPath: string;
beforeAll(async () => {
  appPath = await realpath(await mkdtemp(join(tmpdir(), 'mst-mac-ui-')));
});
afterAll(async () => {
  await rm(appPath, { recursive: true, force: true });
});

const CLAUDE_PID = 501;
const OTHER_PID = 777;

/**
 * Claude Desktop as agent-desktop reports it: the roles, names, states and
 * values of version 6.6395.1's new-task surface, read live.
 */
class FakeClaude implements AgentDesktop {
  draft = '';
  model = 'Opus 5.5';
  menu = false;
  surface: 'cowork' | 'chat' = 'cowork';
  startTaskOffscreen = false;
  complete = true;
  sent: string[] = [];
  calls: string[] = [];
  snapshots = 0;
  appWindows: AgentDesktopWindow[] = [
    { id: 'w-1', pid: CLAUDE_PID, accessible: true, visible: true },
  ];
  /** Thrown by the next action instead of running it. */
  failure?: AgentDesktopError;
  private refs = new Map<string, AgentDesktopNode>();

  private tree(): AgentDesktopNode {
    let index = 0;
    const ref = () => `@s${this.snapshots}:e${(index += 1)}`;
    const radio = (name: string, checked: boolean): AgentDesktopNode => ({
      role: 'radiobutton',
      name,
      value: checked ? '1' : '0',
      states: checked ? ['checked'] : null,
      ref_id: ref(),
    });
    const item = (name: string, value?: string): AgentDesktopNode => ({
      role: 'menuitem',
      name,
      ...(value === undefined ? {} : { value }),
      ref_id: ref(),
    });
    return {
      role: 'window',
      name: 'Claude',
      children: [
        {
          role: 'webarea',
          name: 'Claude',
          children: [
            {
              role: 'radiogroup',
              children: [radio('Claude', true), radio('Code', false)],
            },
            { role: 'heading', name: 'Navigation', value: '2' },
            { role: 'statictext', name: null, value: 'Recents' },
            {
              role: 'button',
              name: 'Forward',
              states: ['disabled'],
              ref_id: ref(),
            },
            { role: 'group', name: 'Notifications', states: ['offscreen'] },
            {
              role: 'group',
              children: [
                {
                  role: 'textfield',
                  name: 'Write your prompt to Claude',
                  value: this.draft || '\n',
                  states: ['focused'],
                  ref_id: ref(),
                },
                ...(this.surface === 'cowork'
                  ? [
                      {
                        role: 'radiogroup',
                        children: [radio('Chat', false), radio('Cowork', true)],
                      },
                    ]
                  : []),
                {
                  role: 'combobox',
                  name: `Model: ${this.model} Medium`,
                  states: ['readonly'],
                  ref_id: ref(),
                },
                ...(this.draft
                  ? [
                      {
                        role: 'button',
                        name: 'Start task',
                        states: this.startTaskOffscreen ? ['offscreen'] : [],
                        ref_id: ref(),
                      },
                    ]
                  : []),
              ],
            },
            ...(this.menu
              ? [
                  {
                    role: 'group',
                    children: [
                      item(
                        'Opus 5.5 For complex work and everyday tasks',
                        this.model === 'Opus 5.5' ? '1' : '0'
                      ),
                      item(
                        'Sonnet 5.5 Most efficient for simpler tasks',
                        this.model === 'Sonnet 5.5' ? '1' : '0'
                      ),
                      item('Effort Medium'),
                      item('More models'),
                    ],
                  },
                ]
              : []),
          ],
        },
      ],
    };
  }

  private target(ref: string): AgentDesktopNode {
    const node = this.refs.get(ref);
    if (!node)
      throw new AgentDesktopError('STALE_REF', undefined, 'not_delivered');
    return node;
  }

  private act(): void {
    const failure = this.failure;
    this.failure = undefined;
    if (failure) throw failure;
  }

  async accessibility() {
    return 'granted';
  }
  async windows() {
    this.calls.push('windows');
    return this.appWindows;
  }
  async snapshot(windowId: string) {
    this.calls.push(`snapshot ${windowId}`);
    this.snapshots += 1;
    const tree = this.tree();
    this.refs = new Map();
    const walk = (node: AgentDesktopNode) => {
      if (node.ref_id) this.refs.set(node.ref_id, node);
      node.children?.forEach(walk);
    };
    walk(tree);
    return { complete: this.complete, tree };
  }
  async value(ref: string) {
    this.calls.push(`value ${this.target(ref).name}`);
    return this.target(ref).role === 'textfield' ? this.draft || '\n' : null;
  }
  async click(ref: string) {
    const node = this.target(ref);
    this.calls.push(`click ${node.name}`);
    this.act();
    if (node.role === 'combobox') this.menu = !this.menu;
    else if (node.role === 'menuitem' && node.value !== undefined) {
      this.model = node.name!.split(' ').slice(0, 2).join(' ');
      this.menu = false;
    } else if (node.name === 'Start task') {
      this.sent.push(this.draft);
      this.draft = '';
    }
  }
  async setValue(ref: string, text: string) {
    this.calls.push(`setValue ${this.target(ref).name}`);
    this.act();
    this.draft = text;
  }
  async scrollTo(ref: string) {
    this.calls.push(`scrollTo ${this.target(ref).name}`);
    this.act();
    this.startTaskOffscreen = false;
  }
}

function connect(
  desktop: FakeClaude,
  options: {
    processes?: { pid: number; path: string }[];
    deadlineAt?: number;
    onOpen?: (args: readonly string[]) => void;
  } = {}
) {
  const opened: string[][] = [];
  return {
    opened,
    ui: connectMacUi({
      desktop,
      appPath,
      deadlineAt: options.deadlineAt ?? Date.now() + 60_000,
      processes: async () =>
        options.processes ?? [
          { pid: CLAUDE_PID, path: `${appPath}/Contents/MacOS/Claude` },
          {
            pid: OTHER_PID,
            path: '/Applications/Other.app/Contents/MacOS/Other',
          },
        ],
      open: async (args) => {
        opened.push([...args]);
        options.onOpen?.(args);
      },
      sleep: async () => undefined,
    }),
  };
}

function find(nodes: readonly LinuxUiNode[], role: string, name: string) {
  const found = nodes.filter(
    (node) => node.role === role && node.name === name
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe('the macOS UI seam', () => {
  it("gives the drivers Claude Desktop's tree in the names they match", async () => {
    const desktop = new FakeClaude();
    desktop.draft = 'a draft';
    desktop.menu = true;
    const ui = await connect(desktop).ui;
    const nodes = await ui.snapshot();
    expect(nodes.map((node) => `${node.role}: ${node.name}`)).toEqual([
      'frame: Claude',
      'document web: Claude',
      'radiogroup: ',
      'radio button: Claude',
      'radio button: Code',
      'heading: Navigation',
      'static: Recents',
      'button: Forward',
      'section: Notifications',
      'section: ',
      'entry: Write your prompt to Claude',
      'radiogroup: ',
      'radio button: Chat',
      'radio button: Cowork',
      'button: Model: Opus 5.5 Medium',
      'button: Start task',
      'section: ',
      'radio menu item: Opus 5.5 For complex work and everyday tasks',
      'radio menu item: Sonnet 5.5 Most efficient for simpler tasks',
      'menu item: Effort Medium',
      'menu item: More models',
    ]);
    expect(find(nodes, 'radio button', 'Cowork').selected).toBe(true);
    expect(find(nodes, 'radio button', 'Chat').selected).toBe(false);
    expect(find(nodes, 'button', 'Forward').enabled).toBe(false);
    expect(find(nodes, 'button', 'Start task')).toMatchObject({
      enabled: true,
      visible: true,
      showing: true,
    });
    expect(find(nodes, 'section', 'Notifications')).toMatchObject({
      visible: true,
      showing: false,
    });
    // Each node names its parent, so a driver can scope a question's options.
    const cowork = find(nodes, 'radio button', 'Cowork');
    const group = nodes.find((node) => node.id === cowork.parentId)!;
    expect(group.role).toBe('radiogroup');
    expect(nodes.find((node) => node.id === group.parentId)!.role).toBe(
      'section'
    );
    expect(nodes[0]!.parentId).toBeUndefined();
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
  });

  it('reads only the window of the session’s app bundle', async () => {
    const desktop = new FakeClaude();
    desktop.appWindows = [
      { id: 'w-other', pid: OTHER_PID, accessible: true, visible: true },
      { id: 'w-menu', pid: CLAUDE_PID, accessible: false, visible: false },
      { id: 'w-claude', pid: CLAUDE_PID, accessible: true, visible: true },
    ];
    const { ui, opened } = connect(desktop);
    await (await ui).snapshot();
    await (await ui).snapshot();
    // The window is resolved once for the connection.
    expect(desktop.calls).toEqual([
      'windows',
      'snapshot w-claude',
      'snapshot w-claude',
    ]);
    expect(opened).toEqual([]);
  });

  it('refuses two readable windows of the app', async () => {
    const desktop = new FakeClaude();
    desktop.appWindows = [
      { id: 'w-1', pid: CLAUDE_PID, accessible: true, visible: true },
      { id: 'w-2', pid: CLAUDE_PID, accessible: true, visible: true },
    ];
    await expect((await connect(desktop).ui).snapshot()).rejects.toMatchObject({
      code: 'desktop_missing_or_ambiguous',
    });
    expect(desktop.calls).toEqual(['windows']);
  });

  it('raises a running app that shows no readable window, once', async () => {
    const desktop = new FakeClaude();
    desktop.appWindows = [
      { id: 'w-1', pid: CLAUDE_PID, accessible: false, visible: false },
    ];
    const { ui, opened } = connect(desktop, {
      onOpen: () => {
        desktop.appWindows = [
          { id: 'w-1', pid: CLAUDE_PID, accessible: true, visible: true },
        ];
      },
    });
    expect(await (await ui).snapshot()).not.toHaveLength(0);
    expect(opened).toEqual([['-a', appPath]]);
  });

  it('fails when the raised app still shows no window', async () => {
    const desktop = new FakeClaude();
    desktop.appWindows = [];
    const { ui, opened } = connect(desktop, { deadlineAt: Date.now() + 50 });
    await expect((await ui).snapshot()).rejects.toMatchObject({
      code: 'desktop_missing_or_ambiguous',
    });
    expect(opened).toEqual([['-a', appPath]]);
  });

  it('never launches an app that is not running', async () => {
    const desktop = new FakeClaude();
    const { ui, opened } = connect(desktop, {
      processes: [
        {
          pid: CLAUDE_PID,
          path: '/Applications/Claude.app/Contents/MacOS/Claude',
        },
      ],
    });
    const seam = await ui;
    await expect(seam.snapshot()).rejects.toMatchObject({
      code: 'desktop_missing_or_ambiguous',
    });
    await expect(seam.openCowork()).rejects.toMatchObject({
      code: 'desktop_missing_or_ambiguous',
    });
    await expect(seam.openNewTask('x')).rejects.toMatchObject({
      code: 'desktop_missing_or_ambiguous',
    });
    expect(opened).toEqual([]);
    expect(desktop.calls).not.toContain('snapshot w-1');
  });

  it.each([
    'relative/Claude.app',
    '/Applications/Claude.app\n-x',
    '/no/such/Claude.app',
  ])('rejects the app path %j', async (path) => {
    await expect(
      connectMacUi({
        desktop: new FakeClaude(),
        appPath: path,
        deadlineAt: Date.now() + 1_000,
      })
    ).rejects.toMatchObject({ code: 'desktop_missing_or_ambiguous' });
  });

  it('fails a read that agent-desktop could not finish, as a scan that saw nothing', async () => {
    const desktop = new FakeClaude();
    desktop.complete = false;
    await expect((await connect(desktop).ui).snapshot()).rejects.toMatchObject({
      code: 'accessibility_scan_timeout',
    });
  });

  it('opens links in the session’s app only', async () => {
    const desktop = new FakeClaude();
    const { ui, opened } = connect(desktop);
    await (await ui).openCowork();
    await (await ui).openNewTask('a b&c=d? é\n"q"');
    expect(opened).toEqual([
      ['-a', appPath, 'claude://cowork/new'],
      [
        '-a',
        appPath,
        'claude://claude.ai/new?q=a%20b%26c%3Dd%3F%20%C3%A9%0A%22q%22',
      ],
    ]);
  });

  it('reports a link that could not be opened', async () => {
    const { ui } = connect(new FakeClaude(), {
      onOpen: (args) => {
        if (args.length === 3) throw new Error('open failed');
      },
    });
    await expect((await ui).openCowork()).rejects.toMatchObject({
      code: 'open_cowork_failed',
    });
  });

  it('acts only on a node of the latest snapshot', async () => {
    const desktop = new FakeClaude();
    const ui = await connect(desktop).ui;
    const older = find(await ui.snapshot(), 'button', 'Model: Opus 5.5 Medium');
    await ui.snapshot();
    await expect(ui.activate(older)).rejects.toMatchObject({
      code: 'accessibility_unknown_node',
    });
    await expect(ui.reveal(older)).rejects.toMatchObject({
      code: 'accessibility_unknown_node',
    });
    await expect(ui.paste(older, 'x')).rejects.toMatchObject({
      code: 'accessibility_unknown_node',
    });
    expect(
      desktop.calls.filter((call) => /^(click|setValue|scrollTo)/.test(call))
    ).toEqual([]);
    // Text no action can target reads as its name.
    const text = find(await ui.snapshot(), 'static', 'Recents');
    expect(await ui.readText(text)).toBe('Recents');
    await expect(ui.activate(text)).rejects.toMatchObject({
      code: 'accessibility_unknown_node',
    });
  });

  it('never calls an action that may have reached the app a clean failure', async () => {
    const desktop = new FakeClaude();
    const ui = await connect(desktop).ui;
    const model = () =>
      ui
        .snapshot()
        .then((nodes) => find(nodes, 'button', 'Model: Opus 5.5 Medium'));

    desktop.failure = new AgentDesktopError(
      'ACTION_FAILED',
      'post_action_verification',
      'delivered_unverified'
    );
    await expect(ui.activate(await model())).rejects.toMatchObject({
      code: 'action_acknowledgement_uncertain',
    });
    desktop.failure = new AgentDesktopError('TIMEOUT');
    await expect(ui.activate(await model())).rejects.toMatchObject({
      code: 'action_acknowledgement_uncertain',
    });
    desktop.failure = new AgentDesktopError('NO_REPLY');
    await expect(ui.activate(await model())).rejects.toMatchObject({
      code: 'action_acknowledgement_uncertain',
    });
    // Proven not delivered: the element was gone.
    desktop.failure = new AgentDesktopError(
      'STALE_REF',
      undefined,
      'not_delivered'
    );
    await expect(ui.activate(await model())).rejects.toMatchObject({
      code: 'accessibility_node_defunct',
    });
    desktop.failure = new AgentDesktopError(
      'PERM_DENIED',
      undefined,
      'not_delivered'
    );
    await expect(ui.activate(await model())).rejects.toMatchObject({
      code: 'accessibility_unavailable',
    });
    desktop.failure = new AgentDesktopError(
      'ACTION_FAILED',
      undefined,
      'not_delivered'
    );
    await expect(ui.reveal(await model())).rejects.toMatchObject({
      code: 'reveal_failed',
    });
  });

  it('sets the draft and leaves checking it to the driver', async () => {
    const desktop = new FakeClaude();
    const ui = await connect(desktop).ui;
    const entry = () =>
      ui
        .snapshot()
        .then((nodes) => find(nodes, 'entry', 'Write your prompt to Claude'));

    expect(await ui.readText(await entry())).toBe('\n');
    await ui.paste(await entry(), 'line one\nline "two" ✓');
    expect(desktop.draft).toBe('line one\nline "two" ✓');
    expect(await ui.readText(await entry())).toBe('line one\nline "two" ✓');

    // agent-desktop's own check can disagree with an editor that adds a line
    // break. The text was delivered; the driver reads it back.
    desktop.failure = new AgentDesktopError(
      'ACTION_FAILED',
      'post_action_verification',
      'delivered_unverified'
    );
    await expect(ui.paste(await entry(), 'again')).resolves.toBeUndefined();

    desktop.failure = new AgentDesktopError(
      'ACTION_FAILED',
      'post_action_verification',
      'not_delivered'
    );
    await expect(ui.paste(await entry(), 'x')).rejects.toMatchObject({
      code: 'accessibility_unavailable',
    });
    desktop.failure = new AgentDesktopError('TIMEOUT');
    await expect(ui.paste(await entry(), 'x')).rejects.toMatchObject({
      code: 'action_acknowledgement_uncertain',
    });
  });

  it.each([
    ['empty', ''],
    ['with a NUL byte', 'a\0b'],
    ['larger than agent-desktop accepts', 'x'.repeat(128 * 1024 + 1)],
  ])('refuses a prompt that is %s before any action', async (_name, text) => {
    const desktop = new FakeClaude();
    const ui = await connect(desktop).ui;
    const entry = find(
      await ui.snapshot(),
      'entry',
      'Write your prompt to Claude'
    );
    await expect(ui.paste(entry, text)).rejects.toMatchObject({
      code: 'invalid_prompt',
    });
    expect(desktop.calls.some((call) => call.startsWith('setValue'))).toBe(
      false
    );
  });

  it('forgets its refs when closed', async () => {
    const desktop = new FakeClaude();
    const ui = await connect(desktop).ui;
    const model = find(await ui.snapshot(), 'button', 'Model: Opus 5.5 Medium');
    await ui.close();
    await expect(ui.activate(model)).rejects.toBeInstanceOf(LinuxUiError);
  });
});

describe('the account-mode driver over the macOS UI seam', () => {
  const budget = () => ({ deadlineAt: Date.now() + 30_000, maxActions: 12 });

  it('probes a ready Cowork surface without acting', async () => {
    const desktop = new FakeClaude();
    const { ui, opened } = connect(desktop);
    expect(
      await runFirstPartyLinux('probe', {}, await ui, budget())
    ).toMatchObject({
      status: 'ready',
      action_count: 0,
    });
    expect(opened).toEqual([]);
    expect(
      desktop.calls.filter((call) => /^(click|setValue|scrollTo)/.test(call))
    ).toEqual([]);
  });

  it('is not ready on the Chat surface, which has no Cowork control', async () => {
    const desktop = new FakeClaude();
    desktop.surface = 'chat';
    expect(
      await runFirstPartyLinux('probe', {}, await connect(desktop).ui, budget())
    ).toMatchObject({
      status: 'failed',
      error: 'first_party_cowork_not_ready',
    });
  });

  it('opens a new task, selects the model, sets the prompt and presses Start task once', async () => {
    const desktop = new FakeClaude();
    desktop.surface = 'chat';
    const prompt = 'Find the planning doc.\nSummarize "Q3" in three bullets ✓';
    const { ui, opened } = connect(desktop, {
      onOpen: () => {
        desktop.surface = 'cowork';
      },
    });
    const receipt = await runFirstPartyLinux(
      'submit',
      { prompt, targetModel: 'claude-sonnet-5-5' },
      await ui,
      budget()
    );
    expect(receipt).toMatchObject({ status: 'submitted', action_count: 5 });
    expect(desktop.sent).toEqual([prompt]);
    expect(desktop.model).toBe('Sonnet 5.5');
    expect(opened).toEqual([['-a', appPath, 'claude://cowork/new']]);
    expect(
      desktop.calls.filter((call) => /^(click|setValue|scrollTo)/.test(call))
    ).toEqual([
      'click Model: Opus 5.5 Medium',
      'click Sonnet 5.5 Most efficient for simpler tasks',
      'setValue Write your prompt to Claude',
      'click Start task',
    ]);
  });

  it('scrolls an offscreen Start task into view, then presses it once', async () => {
    const desktop = new FakeClaude();
    desktop.startTaskOffscreen = true;
    const receipt = await runFirstPartyLinux(
      'submit',
      { prompt: 'a prompt' },
      await connect(desktop).ui,
      budget()
    );
    expect(receipt.status).toBe('submitted');
    expect(desktop.sent).toEqual(['a prompt']);
    expect(
      desktop.calls.filter((call) => /^(click|scrollTo)/.test(call))
    ).toEqual(['scrollTo Start task', 'click Start task']);
  });

  it('does not press Start task again when the press was uncertain', async () => {
    const desktop = new FakeClaude();
    const real = desktop.click.bind(desktop);
    desktop.click = async (ref) => {
      if (desktop.draft) desktop.failure = new AgentDesktopError('TIMEOUT');
      await real(ref);
    };
    const receipt = await runFirstPartyLinux(
      'submit',
      { prompt: 'a prompt' },
      await connect(desktop).ui,
      budget()
    );
    expect(receipt).toMatchObject({
      status: 'failed',
      error: 'action_acknowledgement_uncertain',
    });
    expect(
      desktop.calls.filter((call) => call === 'click Start task')
    ).toHaveLength(1);
    expect(desktop.sent).toEqual([]);
  });

  it('does not type over a draft that is already there', async () => {
    const desktop = new FakeClaude();
    desktop.draft = 'someone else’s draft';
    const receipt = await runFirstPartyLinux(
      'submit',
      { prompt: 'a prompt' },
      await connect(desktop).ui,
      { deadlineAt: Date.now() + 400, maxActions: 12 }
    );
    expect(receipt.status).toBe('failed');
    expect(desktop.draft).toBe('someone else’s draft');
    expect(desktop.sent).toEqual([]);
  });

  it('reports an unreadable window during HITL as a scan that saw nothing', async () => {
    const desktop = new FakeClaude();
    desktop.complete = false;
    expect(
      await runFirstPartyLinux(
        'hitl',
        { approveWrites: false },
        await connect(desktop).ui,
        budget()
      )
    ).toMatchObject({
      status: 'hitl_checked',
      action_count: 0,
      scan: 'incomplete',
    });
  });
});
