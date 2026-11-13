/** The managed Linux Cowork driver's policy over a fake native UI. No desktop. */
import { describe, expect, it } from 'vitest';
import {
  accessibilityText,
  runThirdPartyLinux,
  scanLinuxUi,
  type ThirdPartyPayload,
} from './linuxThirdPartyDriver.js';
import { LinuxUiError, type LinuxUi, type LinuxUiNode } from './linuxUi.js';

const DEEP_LINK_PROMPT_CHARS = 14_336;
const COMPOSER = 'Write your prompt to Claude';

interface Extra {
  name: string;
  role?: string;
  selected?: boolean;
  enabled?: boolean;
  showing?: boolean;
}

/** Claude Desktop's managed Cowork view, as the driver sees it. */
class FakeUi implements LinuxUi {
  starts = ['Start task'];
  /** The composer's mode switch. */
  radios = ['Cowork'];
  radioSelected = true;
  /** The sidebar's Cowork button: on screen in every view. */
  tabs = ['Cowork'];
  extra: Extra[] = [];
  /** The running task's Stop response, and how many scans it survives a click. */
  stops: string[] = [];
  stopLingers = 0;
  actions: string[] = [];
  links: string[] | undefined;
  prompt: string | null = null;
  fail = false;
  /** Below the window until revealed (a composer grown by a long prompt). */
  hidden = new Set<string>();
  /** The composer keeps its draft when an empty new-task link opens. */
  keepsDraft = false;
  /** Start task stays disabled whatever the composer holds. */
  startDisabled = false;
  scans = 0;
  snapshotError: (() => Error | undefined) | undefined;
  private onOpen: ((prompt: string) => void) | undefined;

  whenOpened(callback: (prompt: string) => void): void {
    this.onOpen = callback;
  }

  async snapshot(): Promise<readonly LinuxUiNode[]> {
    this.scans += 1;
    const error = this.snapshotError?.();
    if (error) throw error;
    if (this.actions.includes('Stop response') && this.stops.length) {
      if (this.stopLingers <= 0) this.stops = [];
      this.stopLingers -= 1;
    }
    const items: Required<Extra>[] = [
      ...this.starts.map((name) => ({
        name,
        role: 'button',
        selected: false,
        // The empty composer disables Start task.
        enabled: Boolean(this.prompt) && !this.startDisabled,
        showing: !this.hidden.has(name),
      })),
      ...this.radios.map((name) => ({
        name,
        role: 'radio button',
        selected: this.radioSelected,
        enabled: true,
        showing: true,
      })),
      ...[...this.tabs, ...this.stops].map((name) => ({
        name,
        role: 'button',
        selected: false,
        enabled: true,
        showing: true,
      })),
      ...this.extra.map((item) => ({
        role: 'button',
        selected: false,
        enabled: true,
        showing: true,
        ...item,
      })),
    ];
    return [
      {
        id: 'app',
        name: 'Claude',
        role: 'application',
        visible: true,
        showing: true,
        enabled: true,
        selected: false,
      },
      ...items.map((item, index) => ({
        id: String(index),
        parentId: 'app',
        visible: true,
        ...item,
      })),
    ];
  }

  async readText(node: LinuxUiNode): Promise<string> {
    return node.name === COMPOSER ? (this.prompt ?? '') : node.name;
  }

  async activate(node: LinuxUiNode): Promise<void> {
    this.actions.push(node.name);
    if (this.fail) throw new LinuxUiError('action_acknowledgement_uncertain');
  }

  async reveal(node: LinuxUiNode): Promise<void> {
    this.actions.push(`reveal ${node.name}`);
    this.hidden.delete(node.name);
  }

  async paste(_: LinuxUiNode, text: string): Promise<void> {
    this.actions.push('paste');
    this.prompt = text;
  }

  async openCowork(): Promise<void> {
    throw new Error('the managed driver never opens the hosted Cowork URL');
  }

  async openNewTask(prompt: string): Promise<void> {
    this.onOpen?.(prompt);
    this.links = [...(this.links ?? []), prompt];
    if (!(this.keepsDraft && this.prompt && !prompt)) this.prompt = prompt;
  }

  close(): void {}
}

function run(
  ui: FakeUi,
  operation: 'probe' | 'reset' | 'submit' | 'hitl' | 'answer',
  payload: ThirdPartyPayload = {},
  { timeout = 1000, actions = 4 } = {}
) {
  return runThirdPartyLinux(operation, payload, ui, {
    deadlineAt: Date.now() + timeout,
    maxActions: actions,
  });
}

function submit(
  ui: FakeUi,
  prompt: unknown,
  options?: { timeout?: number; actions?: number }
) {
  return run(ui, 'submit', { prompt }, options);
}

describe('probe and mode selection', () => {
  it('never lets a selected hosted Cowork radio allow prompt insertion', async () => {
    for (const prompt of ['query', 'x'.repeat(DEEP_LINK_PROMPT_CHARS + 1)]) {
      const ui = new FakeUi();
      ui.starts = [];
      expect((await run(ui, 'probe', {}, { timeout: 100 })).error).toBe(
        'cowork_not_ready'
      );
      expect((await submit(ui, prompt, { timeout: 30 })).error).toBe(
        'deadline_exceeded'
      );
      expect(ui.prompt).toBeNull();
      expect(ui.actions).toEqual([]);
      expect(ui.links).toBeUndefined();
    }
  });

  it('waits for Start task after a legacy mode selection, before the query link', async () => {
    for (const radio of [true, false]) {
      const ui = new FakeUi();
      ui.starts = [];
      ui.radioSelected = false;
      if (!radio) ui.radios = [];
      const activate = ui.activate.bind(ui);
      ui.activate = async (node) => {
        await activate(node);
        if (node.name === 'Cowork') {
          ui.radioSelected = true;
          ui.starts = ['Start task'];
        }
      };
      expect((await run(ui, 'probe')).status).toBe('ready');
      expect(ui.actions).toEqual([]);
      expect((await submit(ui, 'unchanged')).status).toBe('submitted');
      expect(ui.actions).toEqual(['Cowork', 'Start task']);
      expect(ui.links).toEqual(['unchanged']);
    }
  });

  it('keeps the account picker away from a managed model', async () => {
    const ui = new FakeUi();
    const receipt = await run(ui, 'submit', {
      prompt: 'query',
      targetModel: 'claude-opus-4-6',
    });
    expect(receipt.error).toBe('managed_model_requires_settings');
    expect(ui.prompt).toBeNull();
    expect(ui.actions).toEqual([]);
  });

  it('has no desktop effects when probing', async () => {
    const ui = new FakeUi();
    expect((await run(ui, 'probe')).status).toBe('ready');
    expect(ui.actions).toEqual([]);
    expect(ui.prompt).toBeNull();
  });

  it('accepts the empty composer without Cowork controls', async () => {
    // Desktop's November 2026 UI: no Cowork radio or sidebar button, only the
    // empty composer's Start task, disabled until text is inserted.
    const ui = new FakeUi();
    ui.radios = [];
    ui.tabs = [];
    expect((await run(ui, 'probe')).status).toBe('ready');
    expect(ui.actions).toEqual([]);
    ui.starts = [];
    expect((await run(ui, 'probe')).error).toBe('cowork_not_ready');
  });

  it('takes a Start task below the window as proof of Cowork mode', async () => {
    // Nothing is pressed: the sidebar's Cowork button could navigate away.
    const ui = new FakeUi();
    ui.prompt = 'a long draft';
    ui.hidden.add('Start task');
    ui.radios = [];
    ui.startDisabled = true;
    await submit(ui, 'x', { timeout: 200 });
    // No Cowork press and no empty link; a disabled Start task is never revealed.
    expect(ui.actions).toEqual([]);
    expect(ui.links).toEqual(['x']);
  });
});

describe('submit', () => {
  it('opens the exact Unicode multi-line prompt and submits once', async () => {
    const ui = new FakeUi();
    const prompt = '  Find 中文 & "quoted" text\nwith a new line  ';
    const receipt = await submit(ui, prompt);
    expect(ui.prompt).toBe(prompt);
    expect(ui.actions).toEqual(['Start task']);
    expect(receipt).toMatchObject({ status: 'submitted', action_count: 2 });
  });

  it('proves the mode by a disabled Start task before the prefill', async () => {
    const ui = new FakeUi();
    ui.radioSelected = false;
    expect((await submit(ui, 'unchanged')).status).toBe('submitted');
    expect(ui.prompt).toBe('unchanged');
    expect(ui.actions).toEqual(['Start task']);
  });

  it('never activates a disabled submit', async () => {
    const ui = new FakeUi();
    ui.startDisabled = true;
    expect((await submit(ui, 'unchanged', { timeout: 50 })).error).toBe(
      'deadline_exceeded'
    );
    expect(ui.actions).toEqual([]);
    expect(ui.prompt).toBe('unchanged');
  });

  it('leaves the previous task view without Cowork controls through one empty link', async () => {
    const ui = new FakeUi();
    ui.radios = [];
    ui.tabs = [];
    ui.starts = [];
    ui.whenOpened(() => {
      ui.starts = ['Start task'];
    });
    const receipt = await submit(ui, 'hello');
    expect(receipt.status).toBe('submitted');
    expect(ui.links).toEqual(['', 'hello']);
    expect(ui.actions).toEqual(['Start task']);
    expect(receipt.action_count).toBe(3);
  });

  it('opens the new-task link only once', async () => {
    const ui = new FakeUi();
    ui.radios = [];
    ui.tabs = [];
    ui.starts = [];
    expect((await submit(ui, 'hello', { timeout: 300 })).status).toBe('failed');
    expect(ui.links).toEqual(['']);
    expect(ui.actions).toEqual([]);
  });

  it('pastes a prompt too long for the link into an empty task', async () => {
    const prompt = 'x'.repeat(DEEP_LINK_PROMPT_CHARS);
    const linked = new FakeUi();
    linked.extra = [{ name: COMPOSER, role: 'entry' }];
    await submit(linked, prompt, { actions: 6 });
    expect([linked.links, linked.actions]).toEqual([[prompt], ['Start task']]);
    const pasted = new FakeUi();
    pasted.extra = [{ name: COMPOSER, role: 'entry' }];
    const receipt = await submit(pasted, `${prompt}y`, { actions: 6 });
    expect(pasted.links).toEqual(['']);
    expect(pasted.actions).toEqual(['paste', 'Start task']);
    expect([pasted.prompt, receipt.action_count]).toEqual([`${prompt}y`, 3]);
  });

  it('refuses to paste into a composer that holds a draft', async () => {
    const ui = new FakeUi();
    ui.extra = [{ name: COMPOSER, role: 'entry' }];
    ui.keepsDraft = true;
    ui.prompt = '';
    ui.readText = async () => 'an old draft';
    const receipt = await submit(ui, 'x'.repeat(DEEP_LINK_PROMPT_CHARS + 1), {
      actions: 6,
    });
    expect(receipt.error).toBe('composer_not_empty');
    expect(ui.actions).toEqual([]);
  });

  it('scrolls a long prompt\u2019s Start task into view once, then submits', async () => {
    const ui = new FakeUi();
    const open = ui.openNewTask.bind(ui);
    ui.openNewTask = async (prompt) => {
      await open(prompt);
      ui.hidden.add('Start task');
    };
    const receipt = await submit(
      ui,
      `is my email OK?\n\n${'line\n'.repeat(25)}`
    );
    expect(ui.actions).toEqual(['reveal Start task', 'Start task']);
    expect([receipt.status, receipt.action_count]).toEqual(['submitted', 3]);
    // One that stays below the window is revealed once, never pressed.
    const stuck = new FakeUi();
    stuck.openNewTask = async (prompt) => {
      stuck.prompt = prompt;
      stuck.hidden.add('Start task');
    };
    stuck.reveal = async (node) =>
      void stuck.actions.push(`reveal ${node.name}`);
    expect((await submit(stuck, 'long', { timeout: 200 })).error).toBe(
      'deadline_exceeded'
    );
    expect(stuck.actions).toEqual(['reveal Start task']);
  });

  it('never retries an uncertain submit', async () => {
    const ui = new FakeUi();
    ui.fail = true;
    expect((await submit(ui, 'unchanged')).error).toBe(
      'action_acknowledgement_uncertain'
    );
    expect(ui.actions).toEqual(['Start task']);
  });

  it('refuses to act on an ambiguous submit', async () => {
    const ui = new FakeUi();
    ui.starts.push('Start task');
    expect((await submit(ui, 'unchanged')).error).toBe(
      'submission_control_ambiguous'
    );
    expect(ui.actions).toEqual([]);
  });

  it('stops at the hard action budget', async () => {
    const ui = new FakeUi();
    expect((await submit(ui, 'unchanged', { actions: 1 })).error).toBe(
      'action_budget_exhausted'
    );
    expect(ui.actions).toEqual([]);
  });

  it('does not touch the desktop for an empty prompt', async () => {
    const ui = new FakeUi();
    expect((await submit(ui, ' \n')).error).toBe('invalid_prompt');
    expect(ui.prompt).toBeNull();
    expect(ui.actions).toEqual([]);
    expect(ui.scans).toBe(0);
  });

  it('takes no action past the hard deadline', async () => {
    const ui = new FakeUi();
    const receipt = await runThirdPartyLinux(
      'submit',
      { prompt: 'unchanged' },
      ui,
      {
        deadlineAt: Date.now() - 1,
        maxActions: 4,
      }
    );
    expect(receipt.error).toBe('deadline_exceeded');
    expect(ui.prompt).toBeNull();
  });

  it('rescans a transient read but never repeats an action', async () => {
    const ui = new FakeUi();
    let failures = 2;
    ui.snapshotError = () =>
      failures-- > 0
        ? new LinuxUiError('accessibility_node_defunct')
        : undefined;
    expect((await submit(ui, 'unchanged')).status).toBe('submitted');
    expect(ui.actions).toEqual(['Start task']);
    const broken = new FakeUi();
    broken.snapshotError = () => new LinuxUiError('accessibility_dbus_error');
    expect((await submit(broken, 'unchanged')).error).toBe(
      'accessibility_dbus_error'
    );
    expect(broken.scans).toBe(3);
  });
});

describe('reset', () => {
  it('opens one empty task and never sends', async () => {
    const ui = new FakeUi();
    expect((await run(ui, 'reset')).status).toBe('ready');
    expect(ui.prompt).toBe('');
    expect(ui.actions).toEqual([]);
    // A surface that never returns fails at the deadline without more actions.
    const gone = new FakeUi();
    gone.starts = [];
    gone.radios = [];
    expect((await run(gone, 'reset', {}, { timeout: 200 })).error).toBe(
      'deadline_exceeded'
    );
    expect([gone.prompt, gone.actions]).toEqual(['', []]);
  });

  it('stops a task that still runs before leaving it', async () => {
    const ui = new FakeUi();
    ui.stops = ['Stop response'];
    ui.stopLingers = 3;
    const receipt = await run(ui, 'reset');
    expect([receipt.status, receipt.stopped, receipt.action_count]).toEqual([
      'ready',
      true,
      2,
    ]);
    // Stopped, then the empty link: never a send.
    expect([ui.actions, ui.prompt]).toEqual([['Stop response'], '']);
    // A finished task has nothing to stop.
    expect(await run(new FakeUi(), 'reset')).not.toHaveProperty('stopped');
  });

  it('fails when the task does not stop, and never guesses a stop', async () => {
    const ui = new FakeUi();
    ui.stops = ['Stop response'];
    ui.stopLingers = 10_000;
    expect((await run(ui, 'reset', {}, { timeout: 300 })).error).toBe(
      'task_not_stopped'
    );
    // The old task is still running: the link isn't opened.
    expect(ui.prompt).toBeNull();
    const two = new FakeUi();
    two.stops = ['Stop response', 'Stop response'];
    expect((await run(two, 'reset')).error).toBe('stop_control_ambiguous');
    expect(two.actions).toEqual([]);
  });

  it('never takes the old task view for ready', async () => {
    // A failed case's view: no Start task, no mode switch, only the sidebar's
    // Cowork button, which the link leaves on screen.
    const old = new FakeUi();
    old.starts = [];
    old.radios = [];
    expect((await run(old, 'reset', {}, { timeout: 200 })).error).toBe(
      'deadline_exceeded'
    );
    expect(old.actions).toEqual([]);
    // Cowork selected but its composer not up yet: not ready either.
    const pending = new FakeUi();
    pending.starts = [];
    expect((await run(pending, 'reset', {}, { timeout: 200 })).error).toBe(
      'deadline_exceeded'
    );
    // Outside Cowork mode (its radio unselected), the next submit selects it.
    const outside = new FakeUi();
    outside.starts = [];
    outside.radioSelected = false;
    const receipt = await run(outside, 'reset');
    expect([receipt.status, receipt.action_count]).toEqual(['ready', 1]);
    expect(outside.actions).toEqual([]);
  });

  it('fails on a draft the empty link left', async () => {
    const ui = new FakeUi();
    ui.prompt = 'is my email OK?';
    ui.keepsDraft = true;
    ui.hidden.add('Start task');
    expect((await run(ui, 'reset', {}, { timeout: 200 })).error).toBe(
      'draft_not_cleared'
    );
    // One link, then read-only: never reveals, types or sends.
    expect(ui.actions).toEqual([]);
    // An empty composer below the window is ready.
    const empty = new FakeUi();
    empty.prompt = 'earlier';
    empty.hidden.add('Start task');
    expect((await run(empty, 'reset')).status).toBe('ready');
    expect(empty.actions).toEqual([]);
  });
});

describe('hitl', () => {
  function hitl(names: string[], approveWriteTools: boolean) {
    const ui = new FakeUi();
    ui.extra = names.map((name) => ({ name }));
    return { ui, receipt: run(ui, 'hitl', { approveWriteTools }) };
  }

  it('never submits or continues onboarding', async () => {
    const { ui, receipt } = hitl(['Continue', 'Get started'], true);
    expect((await receipt).action_count).toBe(0);
    expect(ui.actions).toEqual([]);
    expect(ui.prompt).toBeNull();
  });

  it('denies a folder request under either policy', async () => {
    for (const approve of [false, true]) {
      const { ui, receipt } = hitl(['Deny', 'Choose folder'], approve);
      expect(await receipt).toMatchObject({
        denied: 'folder_request',
        action_count: 1,
      });
      // Deny, never Choose folder.
      expect(ui.actions).toEqual(['Deny']);
    }
    // A Deny without its folder card is another prompt's: not this one.
    const other = hitl(['Deny'], true);
    expect(await other.receipt).not.toHaveProperty('denied');
    expect(other.ui.actions).toEqual([]);
    // Two Deny buttons: which is the folder's is unknown.
    const two = hitl(['Deny', 'Deny', 'Choose folder'], true);
    expect((await two.receipt).error).toBe('folder_request_ambiguous');
    expect(two.ui.actions).toEqual([]);
  });

  it('approves only under the explicit write policy', async () => {
    for (const names of [
      ['Allow once'],
      ...['Create', 'Update', 'Schedule', 'Run', 'Delete'].map((action) => [
        'Cancel',
        action,
      ]),
    ]) {
      const denied = hitl(names, false);
      expect((await denied.receipt).error).toBe(
        'approval_requires_explicit_write_policy'
      );
      expect(denied.ui.actions).toEqual([]);
      const approved = hitl(names, true);
      expect((await approved.receipt).status).toBe('hitl_checked');
      expect(approved.ui.actions).toEqual([names.at(-1)]);
    }
  });

  it('fails closed on ambiguous approvals and ignores a Create without its card', async () => {
    for (const names of [
      ['Cancel', 'Create', 'Run'],
      ['Allow', 'Allow'],
    ]) {
      const { ui, receipt } = hitl(names, true);
      expect((await receipt).error).toBe('approval_control_ambiguous');
      expect(ui.actions).toEqual([]);
    }
    const lone = hitl(['Create'], true);
    expect((await lone.receipt).action_count).toBe(0);
    expect(lone.ui.actions).toEqual([]);
  });

  it('reports an incomplete scan instead of acting', async () => {
    const ui = new FakeUi();
    ui.extra = [{ name: 'Allow once' }];
    ui.snapshotError = () => new LinuxUiError('accessibility_tree_budget');
    expect(await run(ui, 'hitl', { approveWriteTools: true })).toMatchObject({
      status: 'hitl_checked',
      scan: 'incomplete',
      action_count: 0,
    });
    expect(ui.actions).toEqual([]);
  });

  // A streaming reply adds and removes nodes while a poll walks the tree: a
  // child can vanish (a null reference) or move under another parent (seen
  // twice). One such read must not end the case's approval or answer polling.
  it('rescans a tree that changed under the read, for approvals and answers', async () => {
    for (const code of [
      'accessibility_invalid_reply',
      'accessibility_tree_invalid',
    ]) {
      const approval = new FakeUi();
      approval.extra = [{ name: 'Allow once' }];
      let once = true;
      approval.snapshotError = () =>
        once ? ((once = false), new LinuxUiError(code)) : undefined;
      expect(
        await run(approval, 'hitl', { approveWriteTools: true })
      ).toMatchObject({ status: 'hitl_checked', action_count: 1 });
      expect(approval.actions).toEqual(['Allow once']);
      expect(approval.scans).toBe(2);

      const asked = new FakeUi();
      asked.starts = [];
      asked.radios = [];
      asked.tabs = [];
      asked.extra = [{ name: 'Table', role: 'radio button' }];
      let first = true;
      asked.snapshotError = () =>
        first ? ((first = false), new LinuxUiError(code)) : undefined;
      expect(
        await run(
          asked,
          'answer',
          { questions: [{ labels: ['Table'] }] },
          { timeout: 2000, actions: 1 }
        )
      ).toMatchObject({ answered: 'option', action_count: 1 });
      expect(asked.actions).toEqual(['Table']);

      // A tree that never settles still fails closed, after the bounded rescans.
      const churning = new FakeUi();
      churning.extra = [{ name: 'Allow once' }];
      churning.snapshotError = () => new LinuxUiError(code);
      expect(
        (await run(churning, 'hitl', { approveWriteTools: true })).error
      ).toBe(code);
      expect(churning.scans).toBe(3);
      expect(churning.actions).toEqual([]);
    }
  });
});

describe('clarifying questions', () => {
  function question(...labels: string[]) {
    return { labels };
  }

  async function answer(questions: unknown, ...extra: Extra[]) {
    const ui = new FakeUi();
    ui.starts = [];
    ui.radios = [];
    ui.tabs = [];
    ui.extra = extra.map((item) => ({ role: 'radio button', ...item }));
    const receipt = await run(
      ui,
      'answer',
      { questions },
      { timeout: 2000, actions: 1 }
    );
    return { receipt, pressed: ui.actions };
  }

  it('picks the first option by its label, or its label and description', async () => {
    const table = { name: 'Table Rows and columns' };
    const chart = { name: 'Table with chart Adds a chart' };
    const first = await answer(
      [question('Table', 'Table with chart')],
      chart,
      table,
      {
        name: 'Skip',
        role: 'button',
      }
    );
    expect([
      first.receipt.answered,
      first.receipt.action_count,
      first.pressed,
    ]).toEqual(['option', 1, ['Table Rows and columns']]);
    // "Table with chart" first: its control, not the one "Table" also starts.
    expect(
      (await answer([question('Table with chart', 'Table')], table, chart))
        .pressed
    ).toEqual(['Table with chart Adds a chart']);
  });

  it('still matches with a shortcut number or a trailing number in the label', async () => {
    expect(
      (
        await answer(
          [question('Brief', 'Detailed')],
          { name: 'Brief 1' },
          { name: 'Detailed 2' }
        )
      ).pressed
    ).toEqual(['Brief 1']);
    expect(
      (
        await answer(
          [question('Q3 2025', 'Q4 2025')],
          { name: 'Q3 2025' },
          { name: 'Q4 2025' }
        )
      ).pressed
    ).toEqual(['Q3 2025']);
  });

  it('lets an exact label win even when it reads like a form control', async () => {
    expect(
      (
        await answer([question('Continue with defaults', 'Ask me later')], {
          name: 'Continue with defaults',
          role: 'button',
        })
      ).pressed
    ).toEqual(['Continue with defaults']);
  });

  it('answers the question its page marker names', async () => {
    const { receipt, pressed } = await answer(
      [question('A', 'B'), question('Weekly', 'Monthly'), question('X', 'Y')],
      { name: '2 of 3', role: 'static' },
      { name: 'A' },
      { name: 'Weekly' },
      { name: 'Monthly' }
    );
    expect([receipt.answered, pressed]).toEqual(['option', ['Weekly']]);
  });

  it('acts on nothing when the form disagrees with the question', async () => {
    const cases: [unknown, Extra[]][] = [
      // The marker counts other questions than were asked.
      [
        [question('A'), question('B')],
        [{ name: '1 of 3', role: 'static' }, { name: 'A' }],
      ],
      // Several questions and no marker: which one is on screen is unknown.
      [
        [question('A'), question('B')],
        [{ name: 'A' }, { name: 'B' }],
      ],
      // Two controls for the first option.
      [[question('A', 'B')], [{ name: 'A' }, { name: 'A', role: 'button' }]],
      // The form isn't on screen yet.
      [[question('A', 'B')], [{ name: 'Start task', role: 'button' }]],
    ];
    for (const [questions, nodes] of cases) {
      const { receipt, pressed } = await answer(questions, ...nodes);
      expect([receipt.question, receipt.action_count, pressed]).toEqual([
        'not_found',
        0,
        [],
      ]);
    }
  });

  it('submits a checked option with the page\u2019s one advance control', async () => {
    const option = { name: 'Email', role: 'check box', selected: true };
    const { receipt, pressed } = await answer(
      [question('Email', 'Slack')],
      option,
      { name: 'Slack', role: 'check box' },
      { name: 'Submit answers', role: 'button' }
    );
    expect([receipt.answered, pressed]).toEqual([
      'advance',
      ['Submit answers'],
    ]);
    // Two advance controls: no guess.
    const two = await answer(
      [question('Email', 'Slack')],
      option,
      { name: 'Next', role: 'button' },
      { name: 'Submit', role: 'button' }
    );
    expect([two.receipt.question, two.pressed]).toEqual(['not_found', []]);
  });

  it('refuses questions without usable labels', async () => {
    for (const questions of [
      null,
      [],
      [question()],
      [{ labels: [' '] }],
      ['A'],
    ])
      expect((await answer(questions, { name: 'A' })).receipt.error).toBe(
        'invalid_questions'
      );
  });

  it('acts on nothing when the scan cannot finish', async () => {
    const ui = new FakeUi();
    ui.extra = [{ name: 'A', role: 'radio button' }];
    const snapshot = ui.snapshot.bind(ui);
    // The scan outlasts the scan deadline (the last tenth of the call).
    ui.snapshot = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return snapshot();
    };
    const receipt = await runThirdPartyLinux(
      'answer',
      { questions: [question('A')] },
      ui,
      {
        deadlineAt: Date.now() + 50,
        maxActions: 1,
      }
    );
    expect([receipt.scan, receipt.action_count]).toEqual(['incomplete', 0]);
    expect(ui.actions).toEqual([]);
  });
});

describe('accessibility dump', () => {
  it('indents showing named nodes by depth and marks disabled ones', () => {
    const nodes: LinuxUiNode[] = [
      {
        id: 'a',
        name: 'Claude',
        role: 'application',
        visible: true,
        showing: true,
        enabled: true,
        selected: false,
      },
      {
        id: 'b',
        parentId: 'a',
        name: 'Start task',
        role: 'button',
        visible: true,
        showing: true,
        enabled: false,
        selected: false,
      },
      {
        id: 'c',
        parentId: 'b',
        name: 'line\none',
        role: 'label',
        visible: true,
        showing: true,
        enabled: true,
        selected: false,
      },
      {
        id: 'd',
        parentId: 'a',
        name: 'hidden',
        role: 'label',
        visible: true,
        showing: false,
        enabled: true,
        selected: false,
      },
    ];
    expect(accessibilityText(nodes)).toBe(
      'application: Claude\n  button: Start task [disabled]\n    label: line one\n'
    );
  });

  it('rescans the tree for diagnosis as the driver does, at most three times', async () => {
    const deadline = Date.now() + 5_000;
    const settles = new FakeUi();
    let once = true;
    settles.snapshotError = () =>
      once
        ? ((once = false), new LinuxUiError('accessibility_tree_invalid'))
        : undefined;
    expect(accessibilityText(await scanLinuxUi(settles, deadline))).toContain(
      'application: Claude'
    );
    expect(settles.scans).toBe(2);

    const churning = new FakeUi();
    churning.snapshotError = () =>
      new LinuxUiError('accessibility_node_defunct');
    await expect(scanLinuxUi(churning, deadline)).rejects.toThrow(
      'accessibility_node_defunct'
    );
    expect(churning.scans).toBe(3);

    const closed = new FakeUi();
    closed.snapshotError = () => new LinuxUiError('accessibility_bus_closed');
    await expect(scanLinuxUi(closed, deadline)).rejects.toThrow(
      'accessibility_bus_closed'
    );
    expect(closed.scans).toBe(1);
  });
});
