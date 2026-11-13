/** Offline native draft contracts for the Linux ChatGPT driver. No live app, credentials, or queries. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LINUX_CHATGPT_ERROR_CODES } from './linuxContract.js';
import {
  ChatgptDriver,
  DRAFT_POLLS,
  DriverFailure,
  IDLE_POLLS,
  INPUT_LIMIT,
  SETUP_SETTLE_POLLS,
  composer,
  errorCode,
  matchesPrompt,
  type ChatgptLinuxDesktop,
  type ChatgptNode,
  type DraftState,
} from './linuxDriver.js';
import { AtspiError } from '../linuxAtspiBus.js';

const WORK = 'ChatGPT Work';
const CODEX = 'Codex';
const SWITCH_CODEX = 'Switch mode, current mode: Codex';
const WORK_ITEM = 'ChatGPT Work Create, learn, and explore';
const PROMPT = '  π 😀e\u0301\n\nExact.  \n';
const RECEIPT_KEYS = ['action_count', 'duration_ms', 'status', 'surface'];
const UNREADABLE = [
  'composerRootCount',
  'observedSurface',
  'sendControlCount',
  'textReadable',
];

type FakeNode = ChatgptNode & { text?: unknown };

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readableState(text: string, surface = 'chatgpt-work'): DraftState {
  const points = [...text];
  return {
    observedSurface: surface as DraftState['observedSurface'],
    composerRootCount: 1,
    sendControlCount: 1,
    textReadable: true,
    textLength: points.length,
    textSha256: sha(text),
    embeddedObjectCount: points.filter((c) => c === '\ufffc').length,
    newlineCount: points.filter((c) => c === '\n').length,
  };
}

function node(
  name: string,
  role = 'button',
  values: Partial<FakeNode> = {}
): FakeNode {
  return {
    name,
    role,
    showing: true,
    visible: true,
    enabled: true,
    sensitive: true,
    editableState: false,
    editableInterface: false,
    textInterface: false,
    editable: false,
    selected: false,
    ancestors: [0],
    ...values,
  };
}

function editor(
  name = 'extra',
  role = 'text',
  values: Partial<FakeNode> = {}
): FakeNode {
  return node(name, role, { editable: true, ...values });
}

function ready(surface = WORK, text: unknown = ''): FakeNode[] {
  return [
    node(`Switch mode, current mode: ${surface}`),
    node('Send', 'button', { enabled: Boolean(text) }),
    node('composer', 'text', {
      editable: true,
      editableState: true,
      textInterface: true,
      text,
    }),
  ];
}

type Action = [string, ...unknown[]];

class FakeDesktop implements ChatgptLinuxDesktop<FakeNode> {
  actions: Action[] = [];
  stall: string | undefined;
  openSurface: string | undefined;
  preserveDraft = true;
  uncertainSend = false;
  staleChecked = false;
  announcement = false;
  snapshots = 0;

  constructor(public nodes: FakeNode[] = ready()) {}

  requireHelpers(): void {}

  async snapshot(): Promise<FakeNode[]> {
    this.snapshots += 1;
    return this.nodes;
  }

  async text(control: FakeNode): Promise<string> {
    return (control.text === undefined ? '' : control.text) as string;
  }

  surface(): string {
    return this.nodes[0]!.name.endsWith(CODEX) ? CODEX : WORK;
  }

  async openPrompt(prompt: string): Promise<void> {
    this.actions.push(['open', prompt]);
    if (this.stall !== 'open')
      this.nodes = ready(this.openSurface ?? this.surface(), prompt);
  }

  async selectProfession(_: readonly FakeNode[], choice: FakeNode) {
    this.actions.push(['Engineering']);
    if (!this.staleChecked) choice.selected = true;
  }

  async activate(control: FakeNode, allowed: readonly string[]) {
    const name = control.name;
    this.actions.push([name, allowed]);
    if (name === this.stall) return;
    if (name === 'Continue')
      this.nodes = [
        node('Skip'),
        node('Leave a note on my Desktop'),
        node('Turn this spreadsheet into a chart'),
      ];
    else if (name === 'Skip')
      this.nodes = [node('Go to ChatGPT'), node('Keep setting up')];
    else if (name === 'Go to ChatGPT')
      // Modal: while it is open, the mode switch is not in the tree.
      this.nodes = this.announcement
        ? [node('Continue with current model'), node('Try the new model now')]
        : ready(CODEX);
    else if (name === 'Continue with current model') this.nodes = ready(CODEX);
    else if (name.startsWith('Switch mode'))
      this.nodes = [
        ...this.nodes,
        node(WORK_ITEM, 'menu item'),
        node('Codex Build, debug, and ship', 'menu item'),
      ];
    else if (name.startsWith(WORK_ITEM) || name.startsWith('Codex Build')) {
      const text = this.preserveDraft
        ? await this.text(composer(this.nodes))
        : '';
      this.nodes = ready(name.startsWith(CODEX) ? CODEX : WORK, text);
    } else if (name === 'Send' && this.uncertainSend)
      throw new DriverFailure('action_acknowledgement_uncertain');
  }

  names(): string[] {
    return this.actions.map((action) => action[0]);
  }

  /** Runs `after(prompt)` after each hand-off. */
  hookOpen(after: (prompt: string) => void): void {
    const original = this.openPrompt.bind(this);
    this.openPrompt = async (prompt) => {
      await original(prompt);
      after(prompt);
    };
  }
}

/** Time advances only when the driver sleeps; `onSleep` sees the 1-based sleep count. */
function fakeClock(onSleep?: (count: number) => void) {
  const clock = {
    time: 0,
    sleeps: 0,
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.sleeps += 1;
      clock.time += ms;
      onSleep?.(clock.sleeps);
    },
  };
  return clock;
}

function driverFor(
  desktop: ChatgptLinuxDesktop<FakeNode>,
  {
    actions = 24,
    clock = fakeClock(),
    timeout = 600_000,
    setupSettlePolls,
  }: {
    actions?: number;
    clock?: ReturnType<typeof fakeClock>;
    timeout?: number;
    setupSettlePolls?: number;
  } = {}
) {
  return new ChatgptDriver(desktop, timeout, actions, {
    clock,
    ...(setupSettlePolls === undefined ? {} : { setupSettlePolls }),
  });
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DriverFailure) return error.message;
    throw error;
  }
  throw new Error('expected a DriverFailure');
}

describe('draft state (failure receipts)', () => {
  async function failedState(desktop: FakeDesktop, read?: FakeDesktop['text']) {
    const driver = driverFor(desktop);
    await driver.snapshot();
    if (read) desktop.text = read;
    return { driver, state: (await driver.receipt('failed')).draftState };
  }

  it('has exact measurements and no private values', async () => {
    for (const text of [
      '',
      '\ufffc',
      '\ufffc\ufffc\n\r\nπ😀',
      'private prompt',
    ]) {
      const desktop = new FakeDesktop(ready(WORK, text));
      Object.assign(desktop.nodes[2]!, {
        name: 'private UI name',
        role: 'entry',
      });
      // Chromium's entry plus a nested editable paragraph is one root.
      desktop.nodes.push(
        editor('private paragraph', 'paragraph', {
          ancestors: [0, 2],
          text: 'must not read',
        })
      );
      const driver = driverFor(desktop);
      driver.phase = 'composer';
      driver.step = 'draft-surface';
      await driver.snapshot();
      const reads: [FakeNode, number | undefined][] = [];
      desktop.snapshot = () => {
        throw new Error('no fresh snapshot');
      };
      const original = desktop.text.bind(desktop);
      desktop.text = async (control, limit?: number) => {
        reads.push([control, limit]);
        return original(control);
      };
      const receipt = await driver.receipt('failed');
      expect(receipt.draftState).toEqual(readableState(text));
      expect([receipt.phase, receipt.step]).toEqual([
        'composer',
        'draft-surface',
      ]);
      expect(JSON.stringify(receipt)).not.toContain('private');
      expect(reads).toEqual([[desktop.nodes[2], INPUT_LIMIT]]);
      expect(desktop.actions).toEqual([]);
    }
  });

  it('is unreadable for unsafe editors and failed or oversized reads', async () => {
    const never = async (): Promise<string> => {
      throw new Error('must not read');
    };
    for (const editors of [
      [],
      [editor('a', 'entry'), editor('b', 'paragraph')],
      [editor('a', 'entry', { visible: false })],
      [editor('a', 'entry', { showing: false })],
      [editor('a', 'entry', { enabled: false })],
      [editor('a', 'entry', { sensitive: false })],
    ]) {
      const { state } = await failedState(
        new FakeDesktop([...ready().slice(0, 2), ...editors]),
        never
      );
      expect(Object.keys(state!).sort()).toEqual(UNREADABLE);
      expect(state!.textReadable).toBe(false);
    }
    for (const text of [
      null,
      1,
      'a'.repeat(INPUT_LIMIT + 1),
      '😀'.repeat(INPUT_LIMIT / 4 + 1),
      'bad\ud800',
    ]) {
      const { state } = await failedState(new FakeDesktop(ready(WORK, text)));
      expect(Object.keys(state!).sort()).toEqual(UNREADABLE);
    }
    const { driver, state } = await failedState(new FakeDesktop(), async () => {
      throw new Error('private UI');
    });
    expect(Object.keys(state!).sort()).toEqual(UNREADABLE);
    expect(JSON.stringify(await driver.receipt('failed'))).not.toContain(
      'private'
    );
  });

  it('appears only on failed receipts after a snapshot', async () => {
    const desktop = new FakeDesktop();
    const driver = driverFor(desktop);
    expect(await driver.receipt('failed')).not.toHaveProperty('draftState');
    await driver.snapshot();
    desktop.text = async () => {
      throw new Error('no diagnostic read on success');
    };
    for (const status of ['ready', 'submitted'] as const)
      expect(await driver.receipt(status, 'chatgpt-work')).not.toHaveProperty(
        'draftState'
      );
  });

  it('names the observed surface only from known visible labels', async () => {
    const codex = node(SWITCH_CODEX);
    const work = node('Switch mode, current mode: ChatGPT Work');
    for (const [switches, expected] of [
      [[], 'unknown'],
      [[node('private surface')], 'unknown'],
      [[codex], 'codex'],
      [[work], 'chatgpt-work'],
      [[node(SWITCH_CODEX, 'button', { visible: false })], 'unknown'],
      [[codex, codex], 'ambiguous'],
      [[codex, work], 'ambiguous'],
    ] as const) {
      const { state } = await failedState(new FakeDesktop([...switches]));
      expect(state!.observedSurface).toBe(expected);
    }
  });
});

describe('setup (prepare)', () => {
  it('opens one empty chat without readback or send', async () => {
    for (const [surface, label, count] of [
      ['chatgpt-work', WORK, 1],
      ['codex', CODEX, 3],
    ] as const) {
      const desktop = new FakeDesktop(ready(label, 'prior draft'));
      desktop.openPrompt = async (prompt) => {
        desktop.actions.push(['open', prompt]);
        desktop.nodes = ready(WORK, 'Ask anything here\n');
        desktop.nodes[1]!.enabled = false;
      };
      desktop.text = async () => {
        throw new Error('setup has no prompt to read back');
      };
      desktop.preserveDraft = false;
      const receipt = await driverFor(desktop).prepare(surface);
      expect(Object.keys(receipt).sort()).toEqual(RECEIPT_KEYS);
      expect(receipt).toMatchObject({
        status: 'ready',
        surface,
        action_count: count,
      });
      expect(desktop.actions[0]).toEqual(['open', '']);
      expect(desktop.names().filter((n) => n === 'open')).toHaveLength(1);
      expect(desktop.names()).not.toContain('Send');
    }
  });

  it('means ready controls, not verified emptiness', async () => {
    const desktop = new FakeDesktop(ready(WORK, 'prior draft'));
    desktop.stall = 'open';
    desktop.text = async () => {
      throw new Error('no setup emptiness predicate');
    };
    expect((await driverFor(desktop).prepare('chatgpt-work')).status).toBe(
      'ready'
    );
    expect(desktop.actions).toEqual([['open', '']]);
    expect(composer(desktop.nodes).text).toBe('prior draft');
  });

  it('still requires the surface, one composer and one Send after the open', async () => {
    const mutations: Record<string, (nodes: FakeNode[]) => void> = {
      surface: (ns) => void (ns[0]!.name = 'unknown mode'),
      'composer-missing': (ns) => void ns.pop(),
      'composer-ambiguous': (ns) => void ns.push(editor('other', 'entry')),
      'send-missing': (ns) => void ns.splice(1, 1),
      'send-ambiguous': (ns) => void ns.push(node('Send')),
    };
    for (const mutate of Object.values(mutations)) {
      const desktop = new FakeDesktop();
      desktop.hookOpen(() => mutate(desktop.nodes));
      await expect(driverFor(desktop).prepare('chatgpt-work')).rejects.toThrow(
        DriverFailure
      );
      expect(desktop.actions).toEqual([['open', '']]);
    }
  });

  it('skips the known intro, then opens one empty chat', async () => {
    const desktop = new FakeDesktop([
      node('Engineering', 'radio button'),
      node('Continue'),
    ]);
    desktop.staleChecked = true;
    const receipt = await driverFor(desktop).prepare('chatgpt-work');
    expect(Object.keys(receipt).sort()).toEqual(RECEIPT_KEYS);
    expect(desktop.names()).toEqual([
      'Engineering',
      'Continue',
      'Skip',
      'Go to ChatGPT',
      SWITCH_CODEX,
      WORK_ITEM,
      'open',
    ]);
    expect(desktop.actions.at(-1)).toEqual(['open', '']);
    expect(receipt.action_count).toBe(7);
  });

  it('keeps the configured model when an announcement opens', async () => {
    const desktop = new FakeDesktop([
      node('Engineering', 'radio button'),
      node('Continue'),
    ]);
    desktop.staleChecked = true;
    desktop.announcement = true;
    await driverFor(desktop).prepare('chatgpt-work');
    expect(desktop.names()).toEqual([
      'Engineering',
      'Continue',
      'Skip',
      'Go to ChatGPT',
      'Continue with current model',
      SWITCH_CODEX,
      WORK_ITEM,
      'open',
    ]);
  });

  it('dismisses a late announcement over the draft once', async () => {
    const desktop = new FakeDesktop(ready(WORK));
    desktop.hookOpen(() => {
      desktop.nodes = [node('Continue with current model')];
    });
    const original = desktop.activate.bind(desktop);
    desktop.activate = async (control, allowed) => {
      if (control.name === 'Continue with current model') {
        desktop.actions.push([control.name, allowed]);
        desktop.nodes = ready(WORK);
        return;
      }
      await original(control, allowed);
    };
    await driverFor(desktop).prepare('chatgpt-work');
    expect(desktop.names()).toEqual(['open', 'Continue with current model']);
  });

  it('never skips unknown or partial intro screens', async () => {
    for (const [nodes, error] of [
      [[node('Skip')], 'state_transition_unobserved'],
      // Skip plus only one of the two known intro markers.
      [
        [node('Skip'), node('Leave a note on my Desktop')],
        'mode_missing_or_ambiguous',
      ],
      [
        [
          node('Engineering', 'radio button'),
          node('Engineering', 'radio button'),
        ],
        'profession_ambiguous',
      ],
    ] as const) {
      const desktop = new FakeDesktop([...nodes]);
      expect(await failure(driverFor(desktop).prepare('chatgpt-work'))).toBe(
        error
      );
      expect(desktop.actions).toEqual([]);
    }
  });

  it('waits for Continue to enable and never retries it', async () => {
    for (const selected of [false, true]) {
      const desktop = new FakeDesktop([
        node('Engineering', 'radio button', { selected }),
        node('Continue', 'button', { enabled: false }),
      ]);
      desktop.staleChecked = true;
      const clock = fakeClock((count) => {
        if (count === 3) desktop.nodes[1]!.enabled = true;
      });
      await driverFor(desktop, { clock }).prepare('chatgpt-work');
      expect(desktop.names().filter((n) => n === 'Engineering')).toHaveLength(
        selected ? 0 : 1
      );
      expect(desktop.names().filter((n) => n === 'Continue')).toHaveLength(1);
      expect(clock.sleeps).toBe(3 + SETUP_SETTLE_POLLS);
    }
    const desktop = new FakeDesktop([
      node('Engineering', 'radio button'),
      node('Continue', 'button', { enabled: false }),
    ]);
    const clock = fakeClock();
    const driver = driverFor(desktop, { clock });
    expect(await failure(driver.prepare('chatgpt-work'))).toBe(
      'state_transition_unobserved'
    );
    expect((await driver.receipt('failed')).phase).toBe('continue-ready');
    expect(desktop.names()).toEqual(['Engineering']);
    expect(clock.sleeps).toBe(100);
  });

  it('settles read-only so a late setup route lands before submit', async () => {
    expect(SETUP_SETTLE_POLLS).toBe(50); // 5 s of read-only polls.
    const placeholder = '\nWork with ChatGPT';
    const desktop = new FakeDesktop(ready(WORK, placeholder));
    desktop.stall = 'open';
    const clock = fakeClock((count) => {
      if (count === SETUP_SETTLE_POLLS - 10)
        desktop.nodes = ready(WORK, placeholder); // The late setup route: a fresh chat.
    });
    expect(
      (await driverFor(desktop, { clock }).prepare('chatgpt-work')).status
    ).toBe('ready');
    expect(clock.sleeps).toBe(SETUP_SETTLE_POLLS);
    desktop.openPrompt = async (prompt) => {
      desktop.actions.push(['open', prompt]);
      composer(desktop.nodes).text = prompt;
    };
    expect(
      (await driverFor(desktop).submit(PROMPT, 'chatgpt-work')).status
    ).toBe('submitted');
    expect(desktop.actions.slice(0, 2)).toEqual([
      ['open', ''],
      ['open', PROMPT],
    ]);
    expect(desktop.names()).toEqual(['open', 'open', 'Send']);
  });

  it('settles by observation only, within the overall deadline', async () => {
    const desktop = new FakeDesktop();
    await driverFor(desktop).prepare('chatgpt-work');
    expect(desktop.actions).toEqual([['open', '']]);
    // 1 initial + 1 surface/composer + settle + draft-surface + readback.
    expect(desktop.snapshots).toBe(3 + SETUP_SETTLE_POLLS + 1);
    const driver = driverFor(new FakeDesktop(), { timeout: 2_000 });
    expect(await failure(driver.prepare('chatgpt-work'))).toBe(
      'deadline_exceeded'
    );
    expect(driver.actions).toBe(1);
  });
});

describe('submit', () => {
  it('sends once on an exact echo or one trailing LF, with the unmodified prompt', async () => {
    for (const prompt of ['Find docs', PROMPT, 'π\n\n'])
      for (const suffix of ['', '\n'])
        for (const corrected of [false, true]) {
          const desktop = new FakeDesktop(ready(WORK, 'prior draft'));
          desktop.hookOpen((value) => {
            composer(desktop.nodes).text = value + suffix;
          });
          desktop.openSurface = corrected ? CODEX : undefined;
          const receipt = await driverFor(desktop).submit(
            prompt,
            'chatgpt-work'
          );
          expect(Object.keys(receipt).sort()).toEqual(RECEIPT_KEYS);
          expect(receipt).toMatchObject({
            status: 'submitted',
            action_count: corrected ? 4 : 2,
          });
          expect(desktop.actions[0]).toEqual(['open', prompt]);
          // One open, one Send, nothing else (no Enter or keyboard fallback).
          expect(desktop.names()).toEqual(
            corrected
              ? ['open', SWITCH_CODEX, WORK_ITEM, 'Send']
              : ['open', 'Send']
          );
          expect(composer(desktop.nodes).text).toBe(prompt + suffix);
        }
  });

  it('accepts inline code shown without backticks, and only that', async () => {
    const prompt = 'How do I use the `jira` CLI with `--json` output?';
    for (const shown of [
      prompt,
      'How do I use the jira CLI with --json output?',
    ])
      for (const suffix of ['', '\n']) {
        const desktop = new FakeDesktop(ready(WORK, 'prior draft'));
        desktop.hookOpen(() => {
          composer(desktop.nodes).text = shown + suffix;
        });
        expect(
          (await driverFor(desktop).submit(prompt, 'chatgpt-work')).status
        ).toBe('submitted');
        expect(desktop.names()).toEqual(['open', 'Send']);
      }
    const strict = 'Use `a` and `b` with ``c`` and `d\ne`';
    for (const text of [
      'Use a and `b` with ``c`` and `d\ne`', // partial removal
      'Use a and b with c and d\ne', // double and multiline spans stay literal
      'Use a and b with `c` and `d\ne`',
      'Use a and b with ``c`` and d\ne',
      'Use `a` and `b` with ``c`` and `d\ne` ',
      'Use and with ``c`` and `d\ne`',
    ]) {
      expect(matchesPrompt(text, strict)).toBe(false);
      const desktop = new FakeDesktop();
      desktop.hookOpen(() => {
        composer(desktop.nodes).text = text;
      });
      await expect(
        driverFor(desktop).submit(strict, 'chatgpt-work')
      ).rejects.toThrow(DriverFailure);
      expect(desktop.names()).not.toContain('Send');
    }
  });

  it('blocks Send on a draft mismatch, before and after a mode correction', async () => {
    const mismatches = [
      `${PROMPT}\n\n`,
      `prefix${PROMPT}`,
      `${PROMPT}suffix`,
      PROMPT.trim(),
      PROMPT.trimStart(),
      PROMPT.trimEnd(),
      PROMPT.slice(0, -1),
      `${PROMPT}\r\n`,
      PROMPT.replaceAll('\n', ''),
      '',
    ];
    for (const text of mismatches)
      for (const afterCorrection of [false, true]) {
        const desktop = new FakeDesktop();
        desktop.openSurface = CODEX;
        desktop.hookOpen((value) => {
          composer(desktop.nodes).text = afterCorrection ? `${value}\n` : text;
        });
        const original = desktop.activate.bind(desktop);
        desktop.activate = async (control, allowed) => {
          await original(control, allowed);
          if (control.name === WORK_ITEM) composer(desktop.nodes).text = text;
        };
        const driver = driverFor(desktop);
        // An unchanged (empty) draft has its own, equally fail-closed code.
        expect(await failure(driver.submit(PROMPT, 'chatgpt-work'))).toBe(
          text === '' && !afterCorrection
            ? 'draft_prompt_not_applied'
            : 'state_transition_unobserved'
        );
        expect(desktop.names()).toEqual(
          afterCorrection ? ['open', SWITCH_CODEX, WORK_ITEM] : ['open']
        );
        expect(driver.step).toBe(
          afterCorrection ? 'draft-readback' : 'draft-surface'
        );
      }
  });

  it('requires an exact echo and one enabled Send before sending', async () => {
    const mutations: Record<string, (d: FakeDesktop, v: string) => void> = {
      'wrong-text': (d, v) => void (composer(d.nodes).text = v.trim()),
      composer: (d) => void d.nodes.push(editor()),
      send: (d) => void d.nodes.push(node('Send')),
      'send-disabled': (d) => void (d.nodes[1]!.enabled = false),
    };
    for (const [kind, mutate] of Object.entries(mutations))
      for (const settles of [false, true]) {
        const desktop = new FakeDesktop();
        desktop.hookOpen((value) => mutate(desktop, value));
        const clock = fakeClock(() => {
          if (!settles) return;
          expect(desktop.names()).not.toContain('Send');
          desktop.nodes = ready(WORK, PROMPT);
        });
        const driver = driverFor(desktop, { clock });
        if (settles) {
          expect((await driver.submit(PROMPT, 'chatgpt-work')).status).toBe(
            'submitted'
          );
          expect(desktop.names()).toEqual(['open', 'Send']);
        } else {
          await expect(driver.submit(PROMPT, 'chatgpt-work')).rejects.toThrow(
            DriverFailure
          );
          expect(desktop.names()).toEqual(['open']);
          // A draft that never appears waits the 30 s draft window; a draft
          // whose Send stays disabled fails the shorter readback.
          expect(clock.sleeps).toBe(
            kind === 'send-disabled' ? 100 : DRAFT_POLLS
          );
        }
      }
  });

  it('awaits a slow draft within 30 s without reopening', async () => {
    expect(DRAFT_POLLS).toBe(300);
    const desktop = new FakeDesktop();
    desktop.stall = 'open';
    const clock = fakeClock((count) => {
      if (count === 151) desktop.nodes = ready(WORK, 'private prompt');
    });
    expect(
      (
        await driverFor(desktop, { clock }).submit(
          'private prompt',
          'chatgpt-work'
        )
      ).status
    ).toBe('submitted');
    expect(desktop.names()).toEqual(['open', 'Send']);
  });

  it('does not retry an uncertain Send', async () => {
    const desktop = new FakeDesktop();
    desktop.uncertainSend = true;
    const driver = driverFor(desktop);
    expect(await failure(driver.submit('private', 'chatgpt-work'))).toBe(
      'action_acknowledgement_uncertain'
    );
    expect(desktop.names()).toEqual(['open', 'Send']);
    expect((await driver.receipt('failed')).step).toBe('send');
  });

  it('switches mode once after the deep link and requires the preserved draft', async () => {
    for (const preserve of [true, false])
      for (const [surface, start, opened] of [
        ['chatgpt-work', WORK, CODEX],
        ['codex', CODEX, WORK],
      ] as const) {
        const desktop = new FakeDesktop(ready(start));
        desktop.openSurface = opened;
        desktop.preserveDraft = preserve;
        const driver = driverFor(desktop);
        if (preserve) {
          const receipt = await driver.submit(PROMPT, surface);
          expect([receipt.surface, receipt.action_count]).toEqual([surface, 4]);
        } else
          expect(await failure(driver.submit(PROMPT, surface))).toBe(
            'state_transition_unobserved'
          );
        expect(desktop.actions[0]).toEqual(['open', PROMPT]);
        expect(desktop.names().filter((n) => n === 'open')).toHaveLength(1);
        expect(
          desktop.names().filter((n) => n.startsWith('Switch mode'))
        ).toHaveLength(1);
        expect(desktop.names().filter((n) => n === 'Send')).toHaveLength(
          preserve ? 1 : 0
        );
      }
  });

  it('waits for the draft before correcting a delayed mode change', async () => {
    const desktop = new FakeDesktop();
    desktop.stall = 'open';
    const clock = fakeClock(() => {
      expect(desktop.actions).toEqual([['open', PROMPT]]);
      desktop.nodes = ready(CODEX, PROMPT);
    });
    expect(
      (await driverFor(desktop, { clock }).submit(PROMPT, 'chatgpt-work'))
        .action_count
    ).toBe(4);
    expect(desktop.names()).toEqual(['open', SWITCH_CODEX, WORK_ITEM, 'Send']);
    expect(clock.sleeps).toBe(1);
  });

  it('does not repeat a stalled mode correction', async () => {
    const desktop = new FakeDesktop();
    desktop.openSurface = CODEX;
    desktop.stall = WORK_ITEM;
    const clock = fakeClock();
    expect(
      await failure(
        driverFor(desktop, { clock }).submit('private', 'chatgpt-work')
      )
    ).toBe('state_transition_unobserved');
    expect(desktop.names()).toEqual(['open', SWITCH_CODEX, WORK_ITEM]);
    expect(clock.sleeps).toBe(100);
  });

  it('opens a later case from the previous conversation', async () => {
    // After case 0 the app shows that conversation: no mode switch, composer or Send.
    const desktop = new FakeDesktop([node('Share')]);
    desktop.openSurface = WORK;
    const clock = fakeClock();
    expect(
      (await driverFor(desktop, { clock }).submit('private', 'chatgpt-work'))
        .action_count
    ).toBe(2);
    expect(desktop.names()).toEqual(['open', 'Send']);
    expect(clock.sleeps).toBe(IDLE_POLLS);
  });

  it('settles briefly when the new chat becomes ready', async () => {
    const busy = [node('Share')];
    const desktop = new FakeDesktop(ready());
    let calls = 0;
    desktop.snapshot = async () => (++calls <= 3 ? busy : desktop.nodes);
    const clock = fakeClock();
    await driverFor(desktop, { clock }).submit('private', 'chatgpt-work');
    expect(desktop.names()).toEqual(['open', 'Send']);
    expect(clock.sleeps).toBeLessThan(IDLE_POLLS);
  });

  it('fails before any action when another surface is visible', async () => {
    const desktop = new FakeDesktop(ready(CODEX));
    const clock = fakeClock();
    const driver = driverFor(desktop, { clock });
    expect(await failure(driver.submit('private', 'chatgpt-work'))).toBe(
      'surface_mismatch'
    );
    expect([driver.actions, desktop.actions]).toEqual([0, []]);
    expect(clock.sleeps).toBe(0);
  });

  it('does not repeat the deep link when no draft appears', async () => {
    const desktop = new FakeDesktop([node('Share')]);
    desktop.stall = 'open';
    expect(
      await failure(driverFor(desktop).submit('private', 'chatgpt-work'))
    ).toBe('state_transition_unobserved');
    expect(desktop.names()).toEqual(['open']);
  });

  it('names a late setup route that resets the draft', async () => {
    const placeholder = '\nWork with ChatGPT'; // Matches the failure receipt hash.
    expect(readableState(placeholder).textSha256).toBe(
      '59e8647b3d83551c8a637c66a1e3eb278b72964a6793baa68ec2f99fac67f38c'
    );
    const desktop = new FakeDesktop(ready(WORK, placeholder));
    desktop.stall = 'open';
    // Without the settle, setup returns before its route lands...
    const setupClock = fakeClock();
    await driverFor(desktop, {
      clock: setupClock,
      setupSettlePolls: 0,
    }).prepare('chatgpt-work');
    expect(setupClock.sleeps).toBe(0);
    // ...and then lands after the case route, which resets the draft.
    desktop.openPrompt = async (prompt) => {
      desktop.actions.push(['open', prompt]);
      composer(desktop.nodes).text = prompt;
      desktop.nodes = ready(WORK, placeholder);
    };
    const clock = fakeClock();
    const driver = driverFor(desktop, { clock });
    expect(await failure(driver.submit(PROMPT, 'chatgpt-work'))).toBe(
      'draft_prompt_not_applied'
    );
    expect(desktop.names()).toEqual(['open', 'open']);
    expect(clock.sleeps).toBe(DRAFT_POLLS);
    const receipt = await driver.receipt('failed');
    expect([receipt.phase, receipt.step]).toEqual([
      'composer',
      'draft-surface',
    ]);
    expect(receipt.draftState).toEqual(readableState(placeholder));
    expect(JSON.stringify(receipt)).not.toContain(PROMPT);
  });

  it('uses the specific code only for a ready surface with unchanged readable text', async () => {
    const placeholder = '\nWork with ChatGPT';
    for (const [kind, after, error] of [
      ['unchanged', () => {}, 'draft_prompt_not_applied'],
      [
        'changed',
        (d: FakeDesktop) => void (composer(d.nodes).text = 'other text'),
        'state_transition_unobserved',
      ],
      [
        'not-ready',
        (d: FakeDesktop) => void d.nodes.splice(1, 1),
        'state_transition_unobserved',
      ],
      ['baseline-unreadable', () => {}, 'state_transition_unobserved'],
    ] as const) {
      const desktop = new FakeDesktop(ready(WORK, placeholder));
      desktop.openPrompt = async (prompt) => {
        desktop.actions.push(['open', prompt]);
        after(desktop);
      };
      if (kind === 'baseline-unreadable') {
        let first = true;
        const original = desktop.text.bind(desktop);
        desktop.text = async (control) => {
          if (first) {
            first = false;
            throw new DriverFailure('composer_text_unavailable');
          }
          return original(control);
        };
      }
      const driver = driverFor(desktop);
      expect(await failure(driver.submit(PROMPT, 'chatgpt-work'))).toBe(error);
      expect(LINUX_CHATGPT_ERROR_CODES).toContain(error);
      expect(desktop.names()).toEqual(['open']);
      expect(driver.step).toBe('draft-surface');
    }
  });

  it('blocks invalid input, a surface mismatch or a missing helper before any action', async () => {
    const missing = new FakeDesktop();
    missing.requireHelpers = () => {
      throw new DriverFailure('helper_missing');
    };
    const cases: [string, FakeDesktop, unknown, string, string][] = [
      [
        'submit',
        new FakeDesktop(ready(CODEX)),
        'private',
        'chatgpt-work',
        'surface_mismatch',
      ],
      ['submit', new FakeDesktop(), 'private', 'unknown', 'invalid_surface'],
      ['prepare', new FakeDesktop(), null, 'unknown', 'invalid_surface'],
      ['prepare', missing, null, 'chatgpt-work', 'helper_missing'],
      ['submit', missing, 'private', 'chatgpt-work', 'helper_missing'],
      ...[null, '', ' \n', 123].map(
        (bad): [string, FakeDesktop, unknown, string, string] => [
          'submit',
          new FakeDesktop(),
          bad,
          'chatgpt-work',
          'invalid_prompt',
        ]
      ),
    ];
    for (const [mode, desktop, prompt, surface, error] of cases) {
      const driver = driverFor(desktop);
      expect(
        await failure(
          mode === 'prepare'
            ? driver.prepare(surface)
            : driver.submit(prompt, surface)
        )
      ).toBe(error);
      expect(driver.actions).toBe(0);
      expect(desktop.actions).toEqual([]);
    }
  });

  it('neither sends nor reopens after a hand-off failure', async () => {
    for (const mode of ['prepare', 'submit'])
      for (const code of ['helper_failed', 'helper_timeout']) {
        const desktop = new FakeDesktop();
        const prompts: string[] = [];
        desktop.openPrompt = async (prompt) => {
          prompts.push(prompt);
          throw new DriverFailure(code);
        };
        const driver = driverFor(desktop);
        expect(
          await failure(
            mode === 'prepare'
              ? driver.prepare('chatgpt-work')
              : driver.submit('private', 'chatgpt-work')
          )
        ).toBe(code);
        expect(prompts).toEqual([mode === 'prepare' ? '' : 'private']);
        expect([driver.actions, desktop.actions]).toEqual([1, []]);
        expect((await driver.receipt('failed')).step).toBe('draft-open');
      }
  });

  it('settles an initial editor overlap before opening one draft', async () => {
    const desktop = new FakeDesktop([...ready(CODEX), editor()]);
    const clock = fakeClock(() => {
      desktop.nodes = ready(CODEX);
    });
    expect(
      (await driverFor(desktop, { clock }).submit(PROMPT, 'codex')).status
    ).toBe('submitted');
    expect(desktop.names()).toEqual(['open', 'Send']);
    expect(clock.sleeps).toBe(1);
  });

  it('lets draft text reads settle without reopening or sending twice', async () => {
    const desktop = new FakeDesktop(ready(CODEX));
    const original = desktop.text.bind(desktop);
    let pending = true;
    desktop.text = async (control) => {
      if (desktop.actions.length && pending) {
        pending = false;
        throw new DriverFailure('composer_text_unavailable');
      }
      return original(control);
    };
    const clock = fakeClock();
    expect(
      (await driverFor(desktop, { clock }).submit(PROMPT, 'codex')).status
    ).toBe('submitted');
    expect(desktop.names()).toEqual(['open', 'Send']);
    expect(clock.sleeps).toBe(1);
  });

  it('fails without sending when the draft stays unreadable', async () => {
    const desktop = new FakeDesktop(ready(CODEX));
    desktop.text = async () => {
      throw new DriverFailure('composer_text_unavailable');
    };
    const clock = fakeClock();
    expect(
      await failure(driverFor(desktop, { clock }).submit(PROMPT, 'codex'))
    ).toBe('composer_text_unavailable');
    expect(desktop.names()).toEqual(['open']);
    expect(clock.sleeps).toBe(DRAFT_POLLS);
  });
});

describe('budgets, deadline and waits', () => {
  it('block before Send', async () => {
    const desktop = new FakeDesktop();
    expect(
      await failure(
        driverFor(desktop, { actions: 1 }).submit('private', 'chatgpt-work')
      )
    ).toBe('action_budget_exhausted');
    expect(desktop.actions).toEqual([['open', 'private']]);
    for (const mode of ['prepare', 'submit']) {
      const blocked = new FakeDesktop();
      const driver = driverFor(blocked, { timeout: 0 });
      expect(
        await failure(
          mode === 'prepare'
            ? driver.prepare('chatgpt-work')
            : driver.submit('private', 'chatgpt-work')
        )
      ).toBe('deadline_exceeded');
      expect(blocked.actions).toEqual([]);
    }
  });

  it('keep a transient ambiguity when the overall deadline passes', async () => {
    for (const kind of ['composer', 'send']) {
      const desktop = new FakeDesktop();
      desktop.nodes.push(kind === 'composer' ? editor() : node('Send'));
      const driver = driverFor(desktop, { timeout: 250 });
      expect(
        await failure(driver.wait((ns) => driver.ready(ns, 'chatgpt-work')))
      ).toBe(`${kind}_missing_or_ambiguous`);
      expect(driver.actions).toBe(0);
    }
  });

  it('bound the initial wait and never retry snapshot failures', async () => {
    const desktop = new FakeDesktop([]);
    const clock = fakeClock();
    expect(
      await failure(driverFor(desktop, { clock }).prepare('chatgpt-work'))
    ).toBe('state_transition_unobserved');
    expect(clock.sleeps).toBe(300);
    expect(desktop.actions).toEqual([]);
    const failing = new FakeDesktop();
    failing.snapshot = async () => {
      throw new DriverFailure('composer_missing_or_ambiguous');
    };
    const quiet = fakeClock();
    expect(
      await failure(driverFor(failing, { clock: quiet }).wait(() => true))
    ).toBe('composer_missing_or_ambiguous');
    expect(quiet.sleeps).toBe(0);
  });

  it('require one available editable composer root', () => {
    const nodes = [
      ...ready(),
      editor('paragraph', 'paragraph', { ancestors: [0, 2] }),
    ];
    expect(composer(nodes)).toBe(nodes[2]);
    for (const flag of [
      'showing',
      'visible',
      'enabled',
      'sensitive',
      'editable',
      undefined,
    ] as const) {
      const candidates = flag
        ? ready()
        : [...ready(), editor('separate', 'entry')];
      if (flag) candidates.at(-1)![flag] = false;
      expect(() => composer(candidates)).toThrow(
        'composer_missing_or_ambiguous'
      );
    }
  });
});

describe('error codes', () => {
  it('map only contract codes and never native detail', () => {
    expect(errorCode(new DriverFailure('helper_timeout'))).toBe(
      'helper_timeout'
    );
    expect(errorCode(new DriverFailure('private'))).toBe(
      'desktop_driver_failed'
    );
    expect(errorCode(new AtspiError('accessibility_node_defunct'))).toBe(
      'accessibility_node_defunct'
    );
    expect(errorCode(new AtspiError('private'))).toBe('desktop_driver_failed');
    expect(errorCode(new TypeError('private'))).toBe('desktop_driver_failed');
  });

  it('cover every code the driver raises', async () => {
    const { readFile } = await import('node:fs/promises');
    const sources = await Promise.all(
      ['linuxDriver.ts', 'linuxAtspiDesktop.ts', 'linuxDriverMain.ts'].map(
        (file) => readFile(new URL(file, import.meta.url), 'utf8')
      )
    );
    const raised = new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/DriverFailure\('([a-z_]+)'\)/g)].map(
          (match) => match[1]!
        )
      )
    );
    expect(raised.size).toBeGreaterThan(15);
    for (const code of raised)
      expect(LINUX_CHATGPT_ERROR_CODES).toContain(code);
  });
});
