import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoworkDriverError,
  CoworkHitlError,
  type CoworkDriverOptions,
} from './interaction.js';
import type { LinuxUi, LinuxUiNode } from './linuxUi.js';
import {
  macDriverAvailable,
  runMacDriver,
  setMacDriverRuntime,
} from './macDriver.js';

const computerUse = vi.hoisted(() => ({
  submit: vi.fn(),
  hitl: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('./anthropicComputerUse.js', () => ({
  runAnthropicComputerUseSubmission: computerUse.submit,
  runAnthropicComputerUseHitl: computerUse.hitl,
  runAnthropicComputerUseReset: computerUse.reset,
}));
const { coworkMacos, coworkMacosFirstParty, requireMacDriver } =
  await import('./macos.js');

/** The prompt that started the eval's task. */
const TASK = 'Find the doc';

function node(name: string, role = 'button', selected = false): LinuxUiNode {
  return {
    id: `${role}:${name}`,
    name,
    role,
    visible: true,
    showing: true,
    enabled: true,
    selected,
  };
}

/** The account-mode Cowork surface, as the UI seam reports it. */
class Surface implements LinuxUi {
  draft = '';
  /** The prompt of the task the app shows, as it names the user's turn. */
  task: string | undefined = TASK;
  extra: LinuxUiNode[] = [];
  pressed: string[] = [];
  opened = 0;
  closed = 0;
  sent: string[] = [];
  async snapshot() {
    return [
      node('Cowork', 'radio button', true),
      node('Chat', 'radio button'),
      node('Write your prompt to Claude', 'entry'),
      node('Model: Opus 5.5 Medium'),
      ...(this.task === undefined
        ? []
        : [node(`You said: ${this.task}`, 'heading')]),
      ...this.extra,
      ...(this.draft ? [node('Start task')] : []),
    ];
  }
  async readText() {
    return this.draft;
  }
  async activate(target: LinuxUiNode) {
    this.pressed.push(target.name);
    this.extra = this.extra.filter((item) => item.name !== target.name);
    if (target.name === 'Start task') {
      this.sent.push(this.draft);
      this.draft = '';
    }
  }
  async reveal() {}
  async paste(_entry: LinuxUiNode, text: string) {
    this.draft = text;
  }
  async openCowork() {
    this.opened += 1;
  }
  async openNewTask() {
    throw new Error('account mode never opens a new-task link');
  }
  close() {
    this.closed += 1;
  }
}

let surface: Surface;
let available: boolean;
let connections: {
  appPath: string;
  deadlineAt: number;
  env: NodeJS.ProcessEnv;
}[];
let connectError: Error | undefined;
let restore: () => void;
beforeEach(() => {
  surface = new Surface();
  available = true;
  connections = [];
  connectError = undefined;
  for (const spy of Object.values(computerUse)) spy.mockReset();
  restore = setMacDriverRuntime({
    available: () => available,
    async connect(options) {
      connections.push(options);
      if (connectError) throw connectError;
      return surface;
    },
  });
});
afterEach(() => restore());

/** The error a promise rejects with. */
async function rejection<T extends Error = Error>(
  promise: Promise<unknown>
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    return error as T;
  }
  throw new Error('Expected a rejection.');
}

const appPath = '/Applications/Claude.app';
function options(
  extra: Partial<CoworkDriverOptions> = {}
): CoworkDriverOptions {
  return { deadlineAt: Date.now() + 20_000, appPath, ...extra };
}
/** A HITL look at the eval's task. */
function hitl(
  extra: Partial<CoworkDriverOptions> = {}
): CoworkDriverOptions & { prompt: string } {
  return { ...options(extra), prompt: TASK };
}

describe('runMacDriver', () => {
  it('runs one operation over one connection and closes it', async () => {
    const receipt = await runMacDriver(
      'probe',
      {},
      options({ env: { MST_TEST_MARKER: 'from the eval' } })
    );
    expect(receipt).toMatchObject({ status: 'ready', action_count: 0 });
    expect(connections).toHaveLength(1);
    expect(connections[0]!.appPath).toBe(appPath);
    expect(connections[0]!.env.MST_TEST_MARKER).toBe('from the eval');
    expect(connections[0]!.env.PATH).toBe(process.env.PATH);
    expect(surface.closed).toBe(1);
  });

  it.each([
    ['submit', 10 * 60_000],
    ['hitl', 15_000],
    ['diagnose', 20_000],
  ] as const)(
    'bounds %s within the case deadline',
    async (operation, limit) => {
      const started = Date.now();
      await runMacDriver(
        operation,
        { prompt: 'a prompt', dir: '/nonexistent' },
        options({ deadlineAt: started + 3_600_000 })
      ).catch(() => undefined);
      const budget = connections[0]!.deadlineAt - started;
      expect(budget).toBeGreaterThan(limit - 1_000);
      expect(budget).toBeLessThanOrEqual(limit + 1_000);
    }
  );

  it("names the driver's reason when an operation fails, and closes the connection", async () => {
    surface.draft = 'a draft someone left';
    const error = await rejection<CoworkDriverError>(
      runMacDriver('probe', {}, options())
    );
    expect(error).toBeInstanceOf(CoworkDriverError);
    expect(error.message).toBe(
      'macOS desktop probe failed or its receipt was uncertain (composer_not_empty); no retry attempted.'
    );
    expect(error.telemetry).toMatchObject({
      accounting: 'partial',
      action_count: 0,
      planner: { status: 'not-applicable' },
    });
    expect(surface.closed).toBe(1);
  });

  it('fails without acting when it cannot connect', async () => {
    connectError = new Error('private detail: /Users/someone');
    const error = await rejection(
      runMacDriver('submit', { prompt: 'p' }, options())
    );
    expect(error).toBeInstanceOf(CoworkDriverError);
    expect(error.message).toBe(
      'macOS desktop submit failed or its receipt was uncertain (desktop_missing_or_unreadable); no retry attempted.'
    );
    expect(surface.opened).toBe(0);
  });

  it.each([
    [
      'its deadline has passed',
      { deadlineAt: Date.now() - 1 },
      'deadline exceeded',
    ],
    [
      'the session gave no app bundle',
      { appPath: undefined },
      "session's Claude Desktop bundle",
    ],
  ])('does not connect when %s', async (_name, extra, message) => {
    await expect(runMacDriver('probe', {}, options(extra))).rejects.toThrow(
      message
    );
    expect(connections).toEqual([]);
  });
});

describe('account mode on macOS', () => {
  it('needs agent-desktop, and says how to install it', () => {
    expect(macDriverAvailable()).toBe(true);
    expect(() => requireMacDriver()).not.toThrow();
    available = false;
    expect(() => requireMacDriver()).toThrow(
      /agent-desktop, which isn't installed here\..*npm install agent-desktop/
    );
  });

  it('keeps managed mode on Computer Use', () => {
    expect(coworkMacos.submit).toBe(computerUse.submit);
    expect(coworkMacos.handleHitl).toBe(computerUse.hitl);
    expect(coworkMacosFirstParty.prepare).toBe(coworkMacos.prepare);
    expect(coworkMacosFirstParty.dataDirectory).toBe(coworkMacos.dataDirectory);
  });

  describe('submit', () => {
    it('sends the prompt through the accessibility tree, with no planner', async () => {
      const receipt = await coworkMacosFirstParty.submit(
        'Find the doc',
        options({ targetModel: 'claude-opus-5-5', model: 'a-planner-model' })
      );
      expect(receipt).toMatchObject({
        status: 'submitted',
        action_count: 3,
        telemetry: {
          accounting: 'complete',
          action_count: 3,
          planner: { status: 'not-applicable' },
          cost: { status: 'not-applicable' },
        },
      });
      expect(surface.sent).toEqual(['Find the doc']);
      expect(surface.closed).toBe(1);
      expect(computerUse.submit).not.toHaveBeenCalled();
    });

    it('rejects a model the picker cannot name', async () => {
      await expect(
        coworkMacosFirstParty.submit('p', options({ targetModel: 'gpt-9' }))
      ).rejects.toThrow('(invalid_target_model)');
      expect(surface.sent).toEqual([]);
    });

    it('never falls back to Computer Use after the driver fails', async () => {
      surface.extra = [node('Stop task')];
      await expect(
        coworkMacosFirstParty.submit('p', options())
      ).rejects.toThrow('(first_party_task_running)');
      expect(computerUse.submit).not.toHaveBeenCalled();
      expect(surface.sent).toEqual([]);
    });

    it('never uses Computer Use, with or without agent-desktop', async () => {
      available = false;
      connectError = new Error('agent-desktop is not installed.');
      await expect(
        coworkMacosFirstParty.submit('p', options({ model: 'a-planner-model' }))
      ).rejects.toBeInstanceOf(CoworkDriverError);
      expect(computerUse.submit).not.toHaveBeenCalled();
      expect(surface.sent).toEqual([]);
    });
  });

  describe('handleHitl', () => {
    it('watches a bound session until it completes, approving once with a write policy', async () => {
      surface.extra = [node('Allow once')];
      let checks = 0;
      const receipt = await coworkMacosFirstParty.handleHitl(
        hitl({
          approveWriteTools: true,
          isComplete: async () => (checks += 1) > 2,
        })
      );
      expect(receipt).toMatchObject({
        status: 'hitl_checked',
        action_count: 1,
        telemetry: { accounting: 'complete', action_count: 1 },
      });
      expect(surface.pressed).toEqual(['Allow once']);
      // One connection per pass, each closed.
      expect(connections).toHaveLength(2);
      expect(surface.closed).toBe(2);
      expect(computerUse.hitl).not.toHaveBeenCalled();
    });

    it('does not approve without a write policy, and says it touched nothing', async () => {
      surface.extra = [node('Allow once')];
      const error = await rejection<CoworkHitlError>(
        coworkMacosFirstParty.handleHitl(
          hitl({ isComplete: async () => false })
        )
      );
      expect(error).toBeInstanceOf(CoworkHitlError);
      expect(error.message).toBe(
        'macOS HITL failed for the bound native session: macOS desktop hitl failed or its receipt was uncertain (approval_requires_explicit_write_policy); no retry attempted.'
      );
      expect(error.touchedUi).toBe(false);
      expect(surface.pressed).toEqual([]);
    });

    it('denies a request for a folder and counts it', async () => {
      surface.extra = [node('Choose folder'), node('Deny')];
      let checks = 0;
      const receipt = await coworkMacosFirstParty.handleHitl(
        hitl({ isComplete: async () => (checks += 1) > 1 })
      );
      expect(surface.pressed).toEqual(['Deny']);
      expect(receipt.telemetry).toMatchObject({
        action_count: 1,
        folder_requests_denied: 1,
      });
    });

    it('fails fast on a question nobody can answer', async () => {
      await expect(
        coworkMacosFirstParty.handleHitl(
          hitl({
            isComplete: async () => false,
            awaitingUser: async () => true,
          })
        )
      ).rejects.toMatchObject({ kind: 'awaiting-user' });
      expect(connections).toEqual([]);
    });

    // An answer names no task to check, so macOS gives none: a question in
    // view could be another task's.
    it('answers no question, even one with options to choose from', async () => {
      surface.extra = [node('Yes'), node('Submit')];
      await expect(
        coworkMacosFirstParty.handleHitl(
          hitl({
            isComplete: async () => false,
            awaitingUser: async () => true,
            pendingQuestion: async () => ({
              questions: [{ labels: ['Yes', 'No'], multiSelect: false }],
            }),
          })
        )
      ).rejects.toMatchObject({ kind: 'awaiting-user' });
      expect(connections).toEqual([]);
      expect(surface.pressed).toEqual([]);
    });

    it('makes one pass for a later look that has no completion check', async () => {
      surface.extra = [node('Allow once')];
      const receipt = await coworkMacosFirstParty.handleHitl(
        hitl({ approveWriteTools: true, maxActions: 4 })
      );
      expect(receipt).toMatchObject({
        status: 'hitl_checked',
        action_count: 1,
        telemetry: { accounting: 'complete' },
      });
      expect(connections).toHaveLength(1);
      await expect(
        coworkMacosFirstParty.handleHitl(hitl({ maxActions: 4 }))
      ).resolves.toMatchObject({ action_count: 0 });
    });

    // This is the user's own app: another of their tasks may be in view.
    it.each([
      ['another task', 'Delete every draft in the folder'],
      ['no task', undefined],
    ])(
      'approves nothing while the app shows %s, in the watch and in a later look',
      async (_name, shown) => {
        surface.task = shown;
        surface.extra = [node('Allow once')];
        const watched = await rejection<CoworkHitlError>(
          coworkMacosFirstParty.handleHitl(
            hitl({ approveWriteTools: true, isComplete: async () => false })
          )
        );
        expect(watched).toBeInstanceOf(CoworkHitlError);
        expect(watched.message).toContain('(hitl_task_not_shown)');
        expect(watched.touchedUi).toBe(false);
        await expect(
          coworkMacosFirstParty.handleHitl(hitl({ approveWriteTools: true }))
        ).rejects.toThrow('(hitl_task_not_shown)');
        expect(surface.pressed).toEqual([]);
      }
    );

    it('does not look at the app without the prompt of its task', async () => {
      surface.extra = [node('Allow once')];
      await expect(
        coworkMacosFirstParty.handleHitl(
          options({ approveWriteTools: true, isComplete: async () => false })
        )
      ).rejects.toThrow(
        'macOS HITL needs the prompt that started its task; no action attempted.'
      );
      expect(connections).toEqual([]);
      expect(computerUse.hitl).not.toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    it('opens a new task and waits for an empty composer', async () => {
      const restartApp = vi.fn();
      await coworkMacosFirstParty.reset!({ ...options(), restartApp });
      expect(surface.opened).toBe(1);
      expect(surface.pressed).toEqual([]);
      expect(restartApp).not.toHaveBeenCalled();
      expect(computerUse.reset).not.toHaveBeenCalled();
    });

    it('restarts the app when a task is still running', async () => {
      surface.extra = [node('Stop task')];
      const restartApp = vi.fn().mockResolvedValue(undefined);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        await coworkMacosFirstParty.reset!({ ...options(), restartApp });
        expect(restartApp).toHaveBeenCalledTimes(1);
        expect(stderr.mock.calls.join('')).toContain(
          'first_party_task_running'
        );
      } finally {
        stderr.mockRestore();
      }
      // The driver never presses Stop: that is the restart's job.
      expect(surface.pressed).toEqual([]);
    });

    it('fails when it cannot reset and has no restart', async () => {
      surface.extra = [node('Stop task')];
      await expect(coworkMacosFirstParty.reset!(options())).rejects.toThrow(
        '(first_party_task_running)'
      );
    });

    it('says why both the reset and the restart failed', async () => {
      surface.extra = [node('Stop task')];
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        await expect(
          coworkMacosFirstParty.reset!({
            ...options(),
            restartApp: async () => {
              throw new Error('Claude Desktop did not quit');
            },
          })
        ).rejects.toThrow(
          /^Reset failed \(.*first_party_task_running.*\), and restarting Claude Desktop failed too: Claude Desktop did not quit$/
        );
      } finally {
        stderr.mockRestore();
      }
    });

    it('never uses Computer Use, with or without agent-desktop', async () => {
      available = false;
      connectError = new Error('agent-desktop is not installed.');
      await expect(
        coworkMacosFirstParty.reset!(options())
      ).rejects.toBeInstanceOf(CoworkDriverError);
      expect(computerUse.reset).not.toHaveBeenCalled();
    });
  });
});
