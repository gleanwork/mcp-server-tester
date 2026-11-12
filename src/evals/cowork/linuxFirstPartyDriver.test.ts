import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFirstPartyLinux } from './linuxFirstPartyDriver.js';
import { LinuxUiError, type LinuxUi, type LinuxUiNode } from './linuxUi.js';

function node(
  id: string,
  name: string,
  role = 'button',
  extra: Partial<LinuxUiNode> = {}
): LinuxUiNode {
  return {
    id,
    name,
    role,
    visible: true,
    showing: true,
    enabled: true,
    selected: false,
    ...extra,
  };
}

/** A stateful native UI seam, not a mock of the workflow's private predicates. */
class AccountUi implements LinuxUi {
  cowork = node('cowork', 'Cowork', 'radio button', { selected: true });
  chat = node('chat', 'Chat', 'radio button');
  entry = node('entry', 'Write your prompt to Claude', 'entry');
  model = node('model', 'Model: Opus 5.5 Medium');
  options = [
    node(
      'sonnet',
      'Sonnet 5.5 Most efficient for simpler tasks',
      'radio menu item'
    ),
    node(
      'opus',
      'Opus 5.5 For complex work and everyday tasks',
      'radio menu item'
    ),
  ];
  start = node('start', 'Start task');
  menu = false;
  prompt = '';
  actions: string[] = [];
  extra: LinuxUiNode[] = [];
  scans = 0;
  keepDraft = false;
  uncertain?: string;
  rendered?: (text: string) => string;
  afterPaste?: () => void;
  onSnapshot?: () => void;

  async snapshot(): Promise<readonly LinuxUiNode[]> {
    this.scans += 1;
    this.onSnapshot?.();
    return [
      this.cowork,
      this.chat,
      this.entry,
      this.model,
      ...this.extra,
      ...(this.menu ? this.options : []),
      ...(this.prompt ? [this.start] : []),
    ].map((n) => ({ ...n }));
  }
  async readText(): Promise<string> {
    return this.rendered ? this.rendered(this.prompt) : this.prompt;
  }
  async openCowork(): Promise<void> {
    this.actions.push('open cowork');
    if (!this.keepDraft) this.prompt = '';
  }
  async activate(target: LinuxUiNode): Promise<void> {
    this.actions.push(target.name);
    if (target.name === this.uncertain)
      throw new LinuxUiError('action_acknowledgement_uncertain');
    if (target.id === this.model.id) this.menu = true;
    if (this.options.some((option) => option.id === target.id)) {
      this.model.name = `Model: ${target.name.split(' ').slice(0, 2).join(' ')} Medium`;
      this.menu = false;
    }
  }
  async reveal(): Promise<void> {
    this.actions.push('reveal');
    this.start.showing = true;
  }
  async paste(_entry: LinuxUiNode, text: string): Promise<void> {
    this.actions.push('paste');
    this.prompt = text;
    this.afterPaste?.();
  }
  close(): void {
    /* The caller owns the transport. */
  }
}

async function run(
  operation: Parameters<typeof runFirstPartyLinux>[0],
  ui: LinuxUi,
  payload: Parameters<typeof runFirstPartyLinux>[1] = {},
  timeout = 60_000,
  maxActions = 8
) {
  const result = runFirstPartyLinux(operation, payload, ui, {
    deadlineAt: Date.now() + timeout,
    maxActions,
  });
  await vi.runAllTimersAsync();
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

async function submit(ui: AccountUi, prompt = 'query', maxActions = 8) {
  const result = runFirstPartyLinux(
    'submit',
    { prompt, targetModel: 'claude-sonnet-5-5' },
    ui,
    { deadlineAt: Date.now() + 60_000, maxActions }
  );
  await vi.runAllTimersAsync();
  return result;
}

describe('first-party Linux workflow', () => {
  it('opens an empty Cowork task, selects the exact decorated model, pastes unchanged and submits once', async () => {
    const ui = new AccountUi();
    const prompt = '  Find 中文 & "quoted" text\nunchanged  ';
    const receipt = await submit(ui, prompt);
    expect(receipt).toEqual({
      status: 'submitted',
      action_count: 5,
      duration_ms: 0,
    });
    expect(ui.actions).toEqual([
      'open cowork',
      'Model: Opus 5.5 Medium',
      'Sonnet 5.5 Most efficient for simpler tasks',
      'paste',
      'Start task',
    ]);
    expect(ui.prompt).toBe(prompt);
  });

  it('probes the empty hosted surface without Start task or any native action', async () => {
    const ui = new AccountUi();
    expect(await run('probe', ui)).toEqual({
      status: 'ready',
      action_count: 0,
      duration_ms: 0,
    });
    expect(ui.scans).toBe(1);
    expect(ui.actions).toEqual([]);
  });

  it.each([
    'Model: Sonnet 5.5',
    'Model: Sonnet 5.5 Low',
    'Model: Sonnet 5.5 Medium',
    'Model: Sonnet 5.5 High',
    'Model: Sonnet 5.5 Max',
  ])(
    'accepts exact selected header %s without reopening the picker',
    async (header) => {
      const ui = new AccountUi();
      ui.model.name = header;
      expect(await submit(ui, 'query', 3)).toMatchObject({
        status: 'submitted',
        action_count: 3,
      });
      expect(ui.actions).toEqual(['open cowork', 'paste', 'Start task']);
    }
  );

  it.each([
    'chat',
    'both modes',
    'neither mode',
    'sidebar',
    'missing chat',
    'duplicate composer',
    'missing model',
    'bare model',
    'corrupt header',
    'duplicate model',
    'draft',
    'running',
  ])('probe rejects %s without acting', async (kind) => {
    const ui = new AccountUi();
    if (kind === 'chat') {
      ui.cowork.selected = false;
      ui.chat.selected = true;
    }
    if (kind === 'both modes') ui.chat.selected = true;
    if (kind === 'neither mode') ui.cowork.selected = false;
    if (kind === 'sidebar') ui.cowork.role = 'button';
    if (kind === 'missing chat') ui.chat.visible = false;
    if (kind === 'duplicate composer')
      ui.extra.push(node('extra', ui.entry.name, 'entry'));
    if (kind === 'missing model') ui.model.visible = false;
    if (kind === 'bare model') ui.model.name = 'Opus 5.5';
    if (kind === 'corrupt header')
      ui.model.name = 'Model: Opus 5.5 Medium unknown';
    if (kind === 'duplicate model') ui.extra.push(node('extra', ui.model.name));
    if (kind === 'draft') ui.prompt = 'existing draft';
    if (kind === 'running') ui.extra.push(node('stop', 'Stop response'));
    expect(await run('probe', ui)).toMatchObject({
      status: 'failed',
      action_count: 0,
    });
    expect(ui.actions).toEqual([]);
  });

  it.each(['chat', 'draft'])(
    'never pastes into %s after navigation fails to clear it',
    async (kind) => {
      const ui = new AccountUi();
      if (kind === 'chat') {
        ui.cowork.selected = false;
        ui.chat.selected = true;
      } else {
        ui.prompt = 'existing draft';
        ui.keepDraft = true;
      }
      expect(await submit(ui)).toMatchObject({
        status: 'failed',
        action_count: 1,
        duration_ms: 10_000,
      });
      expect(ui.actions).toEqual(['open cowork']);
    }
  );

  it('waits read-only for asynchronous Cowork navigation', async () => {
    const ui = new AccountUi();
    ui.cowork.selected = false;
    ui.chat.selected = true;
    setTimeout(() => {
      ui.cowork.selected = true;
      ui.chat.selected = false;
    }, 250);
    expect(await submit(ui)).toMatchObject({
      status: 'submitted',
      action_count: 5,
      duration_ms: 300,
    });
    expect(
      ui.actions.filter((action) => action === 'open cowork')
    ).toHaveLength(1);
  });

  it.each([
    '',
    ' ',
    'Sonnet or Opus',
    'claude-sonnet',
    'claude-sonnet-5-5-20261001',
    'claude-sonnet-latest',
    'claude-sonnet-5-5\n',
  ])('rejects target %j before navigation', async (targetModel) => {
    const ui = new AccountUi();
    expect(
      await run('submit', ui, { prompt: 'query', targetModel })
    ).toMatchObject({
      status: 'failed',
      error: 'invalid_target_model',
      action_count: 0,
    });
    expect(ui.actions).toEqual([]);
  });

  it.each([undefined, '', ' \n '])(
    'rejects empty prompt %j before navigation',
    async (prompt) => {
      const ui = new AccountUi();
      expect(await run('submit', ui, { prompt })).toMatchObject({
        status: 'failed',
        error: 'invalid_prompt',
        action_count: 0,
      });
      expect(ui.scans).toBe(0);
    }
  );

  it.each([
    ['Sonnet 5.50'],
    ['Sonnet 5.5.1'],
    ['Sonnet 5.5x'],
    ['Sonnet 5.5 A', 'Sonnet 5.5 B'],
    ['Opus 5.5 Sonnet 5.5 is recommended'],
    ['???'],
  ])(
    'never selects the wrong or ambiguous model from %j',
    async (...names: string[]) => {
      const ui = new AccountUi();
      ui.options = names.map((name, i) =>
        node(`option-${i}`, name, 'radio menu item')
      );
      expect(await submit(ui)).toMatchObject({
        status: 'failed',
        error: 'model_unavailable_or_ambiguous',
        action_count: 2,
      });
      expect(ui.actions).toEqual(['open cowork', 'Model: Opus 5.5 Medium']);
    }
  );

  it('caps a dropdown that never appears instead of consuming the full call deadline', async () => {
    const ui = new AccountUi();
    ui.options = [];
    expect(await submit(ui)).toMatchObject({
      status: 'failed',
      error: 'model_unavailable_or_ambiguous',
      action_count: 2,
      duration_ms: 10_000,
    });
    expect(ui.actions).toEqual(['open cowork', 'Model: Opus 5.5 Medium']);
  });

  it.each(['wrong header', 'picker remains open'])(
    'does not paste when model selection has %s',
    async (kind) => {
      const ui = new AccountUi();
      ui.onSnapshot = () => {
        if (ui.actions.includes(ui.options[0]!.name)) {
          if (kind === 'wrong header') ui.model.name = 'Model: Opus 5.5 Medium';
          else ui.menu = true;
        }
      };
      expect(await submit(ui)).toMatchObject({
        status: 'failed',
        error: 'model_selection_not_confirmed',
        action_count: 3,
        duration_ms: 10_000,
      });
      expect(ui.actions).not.toContain('paste');
    }
  );

  it.each(['model', 'mode'])(
    'rejects a changed %s after paste before submitting',
    async (kind) => {
      const ui = new AccountUi();
      ui.afterPaste = () => {
        if (kind === 'model') ui.model.name = 'Model: Opus 5.5 Medium';
        else {
          ui.cowork.selected = false;
          ui.chat.selected = true;
        }
      };
      expect(await submit(ui)).toMatchObject({
        status: 'failed',
        action_count: 4,
      });
      expect(ui.actions).not.toContain('Start task');
    }
  );

  it('checks the model even when no target was supplied', async () => {
    const ui = new AccountUi();
    ui.afterPaste = () => {
      ui.model.name = 'Model: Sonnet 5.5';
    };
    expect(await run('submit', ui, { prompt: 'query' })).toMatchObject({
      error: 'model_changed_before_submit',
      action_count: 2,
    });
    expect(ui.actions).not.toContain('Start task');
  });

  it('tolerates a long rendered prompt that omits its beginning and normalizes whitespace', async () => {
    const ui = new AccountUi();
    ui.rendered = (text) => text.slice(-500).replace(/\s+/g, '\n');
    const prompt =
      'long paragraph '.repeat(1000) +
      'unique tail 中文 https://example.com/a/b\n\n/Writing Style';
    expect(await submit(ui, prompt)).toMatchObject({ status: 'submitted' });
    expect(ui.prompt).toBe(prompt);
  });

  it('waits for asynchronous rendered text without pasting again', async () => {
    const ui = new AccountUi();
    ui.rendered = (text) => (Date.now() < 350 ? '' : text);
    expect(await submit(ui)).toMatchObject({
      status: 'submitted',
      action_count: 5,
      duration_ms: 400,
    });
    expect(ui.actions.filter((action) => action === 'paste')).toHaveLength(1);
  });

  it('caps a paste whose rendered tail never arrives', async () => {
    const ui = new AccountUi();
    ui.rendered = (text) => (text ? 'wrong text' : '');
    expect(await submit(ui)).toMatchObject({
      status: 'failed',
      error: 'prompt_not_pasted',
      action_count: 4,
      duration_ms: 30_000,
    });
    expect(ui.actions).not.toContain('Start task');
  });

  it('rechecks the rendered prompt immediately before submitting', async () => {
    const ui = new AccountUi();
    let pastedScans = 0;
    ui.onSnapshot = () => {
      if (ui.actions.includes('paste') && ++pastedScans === 2)
        ui.prompt += ' unexpected';
    };
    expect(await submit(ui)).toMatchObject({
      status: 'failed',
      error: 'prompt_changed_before_submit',
      action_count: 4,
    });
    expect(ui.actions).not.toContain('Start task');
  });

  it('reveals a hidden Start task once, then submits once', async () => {
    const ui = new AccountUi();
    ui.start.showing = false;
    expect(await submit(ui)).toMatchObject({
      status: 'submitted',
      action_count: 6,
      duration_ms: 100,
    });
    expect(ui.actions.slice(-2)).toEqual(['reveal', 'Start task']);
  });

  it('never retries reveal when Start task stays hidden', async () => {
    const ui = new AccountUi();
    ui.onSnapshot = () => {
      ui.start.showing = false;
    };
    expect(await submit(ui)).toMatchObject({
      status: 'failed',
      error: 'submission_control_missing',
      action_count: 5,
      duration_ms: 10_000,
    });
    expect(ui.actions.filter((action) => action === 'reveal')).toHaveLength(1);
    expect(ui.actions).not.toContain('Start task');
  });

  it.each(['disabled', 'invisible'])(
    'never activates a %s Start task',
    async (kind) => {
      const ui = new AccountUi();
      if (kind === 'disabled') ui.start.enabled = false;
      else ui.start.visible = false;
      expect(await submit(ui)).toMatchObject({
        status: 'failed',
        error: 'submission_control_missing',
        action_count: 4,
      });
      expect(ui.actions).not.toContain('Start task');
    }
  );

  it.each([true, false])(
    'refuses duplicate Start task even when the duplicate showing state is %s',
    async (showing) => {
      const ui = new AccountUi();
      ui.extra.push(
        node('duplicate-start', 'Start task', 'button', { showing })
      );
      expect(await submit(ui)).toMatchObject({
        status: 'failed',
        error: 'submission_control_ambiguous',
        action_count: 4,
      });
      expect(ui.actions).not.toContain('Start task');
    }
  );

  it.each([
    'Model: Opus 5.5 Medium',
    'Sonnet 5.5 Most efficient for simpler tasks',
    'Start task',
  ])('never retries uncertain activation of %s', async (uncertain) => {
    const ui = new AccountUi();
    ui.uncertain = uncertain;
    const receipt = await submit(ui);
    expect(receipt).toMatchObject({
      status: 'failed',
      error: 'action_acknowledgement_uncertain',
      action_count: ui.actions.length,
    });
    expect(ui.actions.filter((action) => action === uncertain)).toHaveLength(1);
    expect(ui.actions.at(-1)).toBe(uncertain);
  });

  it.each([1, 2, 3, 4])(
    'enforces the action budget %i before the next native action',
    async (maxActions) => {
      const ui = new AccountUi();
      expect(await submit(ui, 'query', maxActions)).toMatchObject({
        status: 'failed',
        error: 'action_budget_exhausted',
        action_count: maxActions,
      });
      expect(ui.actions).toHaveLength(maxActions);
      expect(ui.actions).not.toContain('Start task');
    }
  );

  it.each([0, -1, 65, 1.5, NaN])(
    'rejects invalid maxActions %s before any UI call',
    async (maxActions) => {
      const ui = new AccountUi();
      expect(
        await run('submit', ui, { prompt: 'query' }, 1000, maxActions)
      ).toMatchObject({
        status: 'failed',
        error: 'invalid_budget',
        action_count: 0,
      });
      expect(ui.scans).toBe(0);
    }
  );

  it('enforces the call deadline before any native action', async () => {
    const ui = new AccountUi();
    expect(await run('submit', ui, { prompt: 'query' }, 0)).toEqual({
      status: 'failed',
      error: 'deadline_exceeded',
      action_count: 0,
      duration_ms: 0,
    });
    expect(ui.actions).toEqual([]);
  });

  it('limits readiness polling to a shorter call deadline', async () => {
    const ui = new AccountUi();
    ui.chat.selected = true;
    expect(await run('submit', ui, { prompt: 'query' }, 250)).toEqual({
      status: 'failed',
      error: 'deadline_exceeded',
      action_count: 1,
      duration_ms: 250,
    });
    expect(ui.actions).toEqual(['open cowork']);
    expect(ui.scans).toBe(3);
  });

  it('bounds a hung snapshot by the read-only stage, not just a long call deadline', async () => {
    class StalledUi extends AccountUi {
      override async snapshot(): Promise<readonly LinuxUiNode[]> {
        return new Promise(() => {});
      }
    }
    const ui = new StalledUi();
    expect(await submit(ui)).toEqual({
      status: 'failed',
      error: 'first_party_cowork_not_ready',
      action_count: 1,
      duration_ms: 10_000,
    });
    expect(ui.actions).toEqual(['open cowork']);
  });

  it('bounds a hung native submission and still counts the one uncertain attempt', async () => {
    class StalledUi extends AccountUi {
      override async activate(target: LinuxUiNode): Promise<void> {
        await super.activate(target);
        if (target.name === 'Start task') await new Promise(() => {});
      }
    }
    const ui = new StalledUi();
    expect(await run('submit', ui, { prompt: 'query' }, 250)).toEqual({
      status: 'failed',
      error: 'deadline_exceeded',
      action_count: 3,
      duration_ms: 250,
    });
    expect(ui.actions).toEqual(['open cowork', 'paste', 'Start task']);
  });

  it('resets by opening one empty task without submitting', async () => {
    const ui = new AccountUi();
    ui.prompt = 'earlier draft';
    expect(await run('reset', ui)).toMatchObject({
      status: 'ready',
      action_count: 1,
    });
    expect(ui.actions).toEqual(['open cowork']);
  });

  it.each(['Stop response', 'Stop task'])(
    'never resets away from a running task with %s',
    async (stop) => {
      const ui = new AccountUi();
      ui.extra.push(node('stop', stop));
      expect(await run('reset', ui)).toMatchObject({
        status: 'failed',
        error: 'first_party_task_running',
        action_count: 0,
      });
      expect(ui.actions).toEqual([]);
    }
  );
});

describe('account approval policy', () => {
  it.each([undefined, false])(
    'never approves writes under policy %s',
    async (approveWrites) => {
      const ui = new AccountUi();
      ui.extra = [node('once', 'Allow once'), node('always', 'Always allow')];
      expect(await run('hitl', ui, { approveWrites })).toMatchObject({
        status: 'failed',
        error: 'approval_requires_explicit_write_policy',
        action_count: 0,
      });
      expect(ui.actions).toEqual([]);
      expect(ui.scans).toBe(1);
    }
  );

  it('allows only the one-time action with an explicit write policy', async () => {
    const ui = new AccountUi();
    ui.extra = [node('once', 'Allow once'), node('always', 'Always allow')];
    expect(await run('hitl', ui, { approveWrites: true })).toMatchObject({
      status: 'hitl_checked',
      action_count: 1,
    });
    expect(ui.actions).toEqual(['Allow once']);
    expect(ui.scans).toBe(1);
  });

  it.each([
    'Allow',
    'Always allow',
    'Allow always',
    'Full access',
    'Allow full access',
  ])('never grants persistent permission through %s', async (name) => {
    const ui = new AccountUi();
    ui.extra = [node('approval', name)];
    expect(await run('hitl', ui, { approveWrites: true })).toMatchObject({
      status: 'failed',
      error: 'account_approval_scope_unsupported',
      action_count: 0,
    });
    expect(ui.actions).toEqual([]);
  });

  it.each(['Create', 'Update', 'Schedule', 'Run', 'Delete'])(
    'refuses unclassified account write card %s even when writes are enabled',
    async (name) => {
      const ui = new AccountUi();
      ui.extra = [node('write', name), node('cancel', 'Cancel')];
      expect(await run('hitl', ui, { approveWrites: true })).toMatchObject({
        status: 'failed',
        error: 'account_approval_scope_unsupported',
        action_count: 0,
      });
      expect(ui.actions).toEqual([]);
    }
  );

  it('fails closed on duplicate one-time controls', async () => {
    const ui = new AccountUi();
    ui.extra = [node('a', 'Allow once'), node('b', 'Allow once')];
    expect(await run('hitl', ui, { approveWrites: true })).toMatchObject({
      status: 'failed',
      error: 'approval_control_ambiguous',
      action_count: 0,
    });
    expect(ui.actions).toEqual([]);
  });

  it.each([false, true])(
    'denies a folder request under write policy %s',
    async (approveWrites) => {
      const ui = new AccountUi();
      ui.extra = [node('folder', 'Choose folder'), node('deny', 'Deny')];
      expect(await run('hitl', ui, { approveWrites })).toMatchObject({
        status: 'hitl_checked',
        denied: 'folder_request',
        action_count: 1,
      });
      expect(ui.actions).toEqual(['Deny']);
    }
  );

  it.each(['duplicate deny', 'duplicate folder', 'missing deny'])(
    'fails closed for folder request with %s',
    async (kind) => {
      const ui = new AccountUi();
      ui.extra = [node('folder', 'Choose folder')];
      if (kind !== 'missing deny') ui.extra.push(node('deny', 'Deny'));
      if (kind === 'duplicate deny') ui.extra.push(node('deny2', 'Deny'));
      if (kind === 'duplicate folder')
        ui.extra.push(node('folder2', 'Choose folder'));
      expect(await run('hitl', ui, { approveWrites: true })).toMatchObject({
        status: 'failed',
        error: 'folder_request_ambiguous',
        action_count: 0,
      });
      expect(ui.actions).toEqual([]);
    }
  );

  it('does not continue onboarding, select a folder or activate unrelated page buttons', async () => {
    const ui = new AccountUi();
    ui.extra = ['Deny', 'Continue', 'Get started', 'Create'].map((name) =>
      node(name, name)
    );
    expect(await run('hitl', ui, { approveWrites: true })).toMatchObject({
      status: 'hitl_checked',
      action_count: 0,
    });
    expect(ui.actions).toEqual([]);
  });
});

function questionUi(selected = false): AccountUi {
  const ui = new AccountUi();
  ui.extra = [
    node('app', 'Claude', 'application'),
    node('question', 'Choose a format', 'section', { parentId: 'app' }),
    node('table', 'Table Rows and columns', 'radio button', {
      parentId: 'question',
      selected,
    }),
    node('chart', 'Table with chart Adds a chart', 'radio button', {
      parentId: 'question',
    }),
    node('advance', 'Submit answers', 'button', { parentId: 'question' }),
    node('other', 'Next', 'button', { parentId: 'app' }),
  ];
  return ui;
}
const formatQuestion = [{ labels: ['Table', 'Table with chart'] }];

describe('account question safety', () => {
  it('matches the first option description without stealing a longer option label', async () => {
    const ui = questionUi();
    expect(
      await run('answer', ui, { questions: formatQuestion })
    ).toMatchObject({
      status: 'hitl_checked',
      answered: 'option',
      action_count: 1,
    });
    expect(ui.actions).toEqual(['Table Rows and columns']);
    expect(ui.scans).toBe(1);
  });

  it('picks a longer label when it is the first option', async () => {
    const ui = questionUi();
    expect(
      await run('answer', ui, {
        questions: [{ labels: ['Table with chart', 'Table'] }],
      })
    ).toMatchObject({ answered: 'option' });
    expect(ui.actions).toEqual(['Table with chart Adds a chart']);
  });

  it('advances only within the selected option question, not an unrelated Next button', async () => {
    const ui = questionUi(true);
    expect(
      await run('answer', ui, { questions: formatQuestion })
    ).toMatchObject({ answered: 'advance', action_count: 1 });
    expect(ui.actions).toEqual(['Submit answers']);
    expect(ui.scans).toBe(1);
  });

  it.each([
    'missing sibling',
    'missing parent',
    'cycle',
    'outside advance',
    'duplicate advance',
  ])('does not act on question metadata with %s', async (kind) => {
    const ui = questionUi(true);
    if (kind === 'missing sibling')
      ui.extra = ui.extra.filter((item) => item.id !== 'chart');
    if (kind === 'missing parent')
      ui.extra = ui.extra.filter((item) => item.id !== 'question');
    if (kind === 'cycle') {
      ui.extra.find((item) => item.id === 'table')!.parentId = 'cycle';
      ui.extra.push(node('cycle', '', 'section', { parentId: 'cycle' }));
    }
    if (kind === 'outside advance')
      ui.extra = ui.extra.filter((item) => item.id !== 'advance');
    if (kind === 'duplicate advance')
      ui.extra.push(
        node('advance2', 'Next', 'button', { parentId: 'question' })
      );
    expect(
      await run('answer', ui, { questions: formatQuestion })
    ).toMatchObject({ status: 'hitl_checked', action_count: 0 });
    expect(ui.actions).toEqual([]);
  });

  it('does not choose a lone exact button outside a question when parent metadata exists', async () => {
    const ui = questionUi();
    ui.extra = ui.extra.filter((item) => !['table', 'chart'].includes(item.id));
    ui.extra.push(node('stray', 'Table', 'button', { parentId: 'app' }));
    expect(
      await run('answer', ui, { questions: formatQuestion })
    ).toMatchObject({ action_count: 0 });
    expect(ui.actions).toEqual([]);
  });

  it('finds an advance sibling of a nested option group within the question', async () => {
    const ui = questionUi(true);
    ui.extra.push(node('group', '', 'panel', { parentId: 'question' }));
    for (const option of ui.extra.filter((item) =>
      ['table', 'chart'].includes(item.id)
    ))
      option.parentId = 'group';
    expect(
      await run('answer', ui, { questions: formatQuestion })
    ).toMatchObject({ answered: 'advance', action_count: 1 });
    expect(ui.actions).toEqual(['Submit answers']);
  });

  it.each([
    'Allow',
    'Always allow',
    'Allow always',
    'Full access',
    'Allow full access',
    'Allow once',
    'Create',
    'Update',
    'Schedule',
    'Run',
    'Delete',
    'Start task',
    'Send message',
    'Always allow for this account',
    'Connect',
    'Approve',
    'Accept',
    'Deny',
    'Cancel',
    'Stop task',
  ])(
    'does not turn question label %s into an approval or submission',
    async (name) => {
      const ui = new AccountUi();
      ui.extra = [node('unsafe', name)];
      expect(
        await run('answer', ui, {
          approveWrites: true,
          questions: [{ labels: [name] }],
        })
      ).toMatchObject({
        status: 'failed',
        error: 'account_question_action_conflict',
        action_count: 0,
      });
      expect(ui.actions).toEqual([]);
    }
  );

  it('blocks an unrelated approval card before answering an otherwise safe question', async () => {
    const ui = questionUi();
    ui.extra.push(node('approval', 'Allow once'));
    expect(
      await run('answer', ui, { questions: formatQuestion })
    ).toMatchObject({
      error: 'account_question_action_conflict',
      action_count: 0,
    });
    expect(ui.actions).toEqual([]);
  });

  it('does not bypass the policy through a radio option', async () => {
    const ui = new AccountUi();
    ui.extra = [node('approval', 'Always allow', 'radio button')];
    expect(
      await run('answer', ui, { questions: [{ labels: ['Always allow'] }] })
    ).toMatchObject({
      error: 'account_question_action_conflict',
      action_count: 0,
    });
    expect(ui.actions).toEqual([]);
  });

  it.each(['Brief 1', 'Q3 2025', 'Version 1'])(
    'matches shortcut or literal numeric label %s',
    async (name) => {
      const ui = new AccountUi();
      ui.extra = [node('option', name, 'radio button')];
      const first = name === 'Brief 1' ? 'Brief' : name;
      expect(
        await run('answer', ui, { questions: [{ labels: [first, 'Other'] }] })
      ).toMatchObject({ answered: 'option', action_count: 1 });
      expect(ui.actions).toEqual([name]);
    }
  );

  it('retains exact non-approval option labels that resemble form controls', async () => {
    const ui = new AccountUi();
    ui.extra = [node('option', 'Continue with defaults')];
    expect(
      await run('answer', ui, {
        questions: [{ labels: ['Continue with defaults', 'Ask me later'] }],
      })
    ).toMatchObject({ answered: 'option' });
    expect(ui.actions).toEqual(['Continue with defaults']);
  });

  it('uses the displayed page number for multi-question forms', async () => {
    const ui = new AccountUi();
    ui.extra = [
      node('page', '2 of 3', 'static'),
      node('a', 'A', 'radio button'),
      node('weekly', 'Weekly', 'radio button'),
      node('monthly', 'Monthly', 'radio button'),
    ];
    expect(
      await run('answer', ui, {
        questions: [
          { labels: ['A', 'B'] },
          { labels: ['Weekly', 'Monthly'] },
          { labels: ['X', 'Y'] },
        ],
      })
    ).toMatchObject({ answered: 'option', action_count: 1 });
    expect(ui.actions).toEqual(['Weekly']);
  });

  it.each([
    'none',
    'wrong total',
    'out of range',
    'conflicting markers',
    'duplicate option',
  ])('acts on nothing with %s in a multi-question form', async (kind) => {
    const ui = new AccountUi();
    ui.extra = [node('a', 'A', 'radio button'), node('b', 'B', 'radio button')];
    if (kind === 'wrong total') ui.extra.push(node('page', '1 of 3', 'static'));
    if (kind === 'out of range')
      ui.extra.push(node('page', '3 of 2', 'static'));
    if (kind === 'conflicting markers')
      ui.extra.push(
        node('page1', '1 of 2', 'static'),
        node('page2', '2 of 2', 'static')
      );
    if (kind === 'duplicate option')
      ui.extra.push(
        node('page', '1 of 2', 'static'),
        node('dup', 'A', 'button')
      );
    expect(
      await run('answer', ui, {
        questions: [{ labels: ['A'] }, { labels: ['B'] }],
      })
    ).toMatchObject({ status: 'hitl_checked', action_count: 0 });
    expect(ui.actions).toEqual([]);
  });

  it.each([undefined, [], [{ labels: [] }], [{ labels: [' '] }]])(
    'rejects malformed questions %j',
    async (questions) => {
      const ui = new AccountUi();
      expect(await run('answer', ui, { questions })).toMatchObject({
        status: 'failed',
        error: 'invalid_questions',
        action_count: 0,
      });
      expect(ui.scans).toBe(0);
    }
  );
});

describe('safe receipts and bounded diagnosis', () => {
  it.each(['accessibility_tree_budget', 'accessibility_scan_timeout'])(
    'treats %s as an incomplete HITL scan with no action',
    async (code) => {
      class IncompleteUi extends AccountUi {
        override async snapshot(): Promise<readonly LinuxUiNode[]> {
          throw new LinuxUiError(code);
        }
      }
      for (const operation of ['hitl', 'answer'] as const) {
        const ui = new IncompleteUi();
        expect(
          await run(operation, ui, { questions: [{ labels: ['Yes'] }] })
        ).toEqual({
          status: 'hitl_checked',
          scan: 'incomplete',
          action_count: 0,
          duration_ms: 0,
        });
        expect(ui.actions).toEqual([]);
      }
      expect(await run('probe', new IncompleteUi())).toMatchObject({
        status: 'failed',
        error: code,
      });
    }
  );

  it.each([
    [new Error('secret prompt and credentials'), 'desktop_driver_failed'],
    [new LinuxUiError('SECRET_TOKEN=private'), 'desktop_driver_failed'],
    [new LinuxUiError('unknown_transport_code'), 'desktop_driver_failed'],
    [
      new LinuxUiError('desktop_missing_or_ambiguous'),
      'desktop_missing_or_ambiguous',
    ],
    [
      new LinuxUiError('accessibility_bus_disconnected'),
      'accessibility_bus_disconnected',
    ],
  ])(
    'sanitizes transport errors into an allowlisted receipt: %s',
    async (error, expected) => {
      class FailedUi extends AccountUi {
        override async snapshot(): Promise<readonly LinuxUiNode[]> {
          throw error;
        }
      }
      const receipt = await run('probe', new FailedUi());
      expect(receipt).toEqual({
        status: 'failed',
        error: expected,
        action_count: 0,
        duration_ms: 0,
      });
      expect(JSON.stringify(receipt)).not.toContain('secret');
    }
  );

  it('records elapsed duration and the failed paste attempt without leaking its error', async () => {
    class FailedUi extends AccountUi {
      override async paste(): Promise<void> {
        this.actions.push('paste');
        await new Promise<void>((resolve) => setTimeout(resolve, 125));
        throw new Error('clipboard contains secret prompt');
      }
    }
    const ui = new FailedUi();
    expect(await run('submit', ui, { prompt: 'query' })).toEqual({
      status: 'failed',
      error: 'desktop_driver_failed',
      action_count: 2,
      duration_ms: 125,
    });
    expect(ui.actions).toEqual(['open cowork', 'paste']);
  });

  it('does not downgrade an incomplete scan error from an attempted action to successful HITL', async () => {
    class FailedUi extends AccountUi {
      override async activate(): Promise<void> {
        throw new LinuxUiError('accessibility_scan_timeout');
      }
    }
    const ui = new FailedUi();
    ui.extra = [node('once', 'Allow once')];
    expect(await run('hitl', ui, { approveWrites: true })).toMatchObject({
      status: 'failed',
      error: 'accessibility_scan_timeout',
      action_count: 1,
    });
  });

  it('writes only a bounded accessibility dump, without a native action or screenshot', async () => {
    vi.useRealTimers();
    const directory = await mkdtemp(join(tmpdir(), 'mst-1p-diagnose-'));
    try {
      const ui = new AccountUi();
      ui.extra = Array.from({ length: 5100 }, (_, i) =>
        node(`extra-${i}`, 'x'.repeat(500), 'label')
      );
      const receipt = await runFirstPartyLinux(
        'diagnose',
        { dir: directory },
        ui,
        { deadlineAt: Date.now() + 5000, maxActions: 1 }
      );
      expect(receipt).toMatchObject({ status: 'diagnosed', action_count: 0 });
      expect(await readdir(directory)).toEqual(['accessibility.txt']);
      const dump = await readFile(join(directory, 'accessibility.txt'), 'utf8');
      expect(dump.split('\n')).toHaveLength(5001);
      expect(dump.length).toBeLessThan(1_500_000);
      expect(dump).not.toContain('x'.repeat(201));
      expect(ui.actions).toEqual([]);
      expect(ui.scans).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not follow an accessibility dump symlink', async () => {
    vi.useRealTimers();
    const directory = await mkdtemp(join(tmpdir(), 'mst-1p-diagnose-'));
    try {
      const target = join(directory, 'keep.txt');
      await writeFile(target, 'unchanged');
      await symlink(target, join(directory, 'accessibility.txt'));
      const receipt = await runFirstPartyLinux(
        'diagnose',
        { dir: directory },
        new AccountUi(),
        { deadlineAt: Date.now() + 5000, maxActions: 1 }
      );
      expect(receipt.status).toBe('failed');
      expect(await readFile(target, 'utf8')).toBe('unchanged');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([undefined, 'relative'])(
    'rejects invalid diagnostic directory %s',
    async (dir) => {
      const ui = new AccountUi();
      expect(await run('diagnose', ui, { dir })).toMatchObject({
        status: 'failed',
        error: 'invalid_directory',
        action_count: 0,
      });
      expect(ui.scans).toBe(0);
    }
  );
});
