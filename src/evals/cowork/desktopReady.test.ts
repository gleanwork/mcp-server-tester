import { describe, expect, it } from 'vitest';
import {
  desktopReady,
  lastLine,
  startGaveUp,
  vmReady,
  type ReadyDesktop,
  type ReadyOptions,
} from './desktopReady.js';
import type { LinuxUiNode } from './linuxUi.js';

function node(role: string, name: string, id = `${role}:${name}`): LinuxUiNode {
  return {
    id,
    name,
    role,
    visible: true,
    showing: true,
    enabled: true,
    selected: false,
  };
}

const PROMPT = node('entry', 'Write your prompt to Claude');
const START = node('button', 'Start task');

/** A scripted desktop on a fake clock: every tick advances `now`. */
class FakeDesktop implements ReadyDesktop {
  time = 0;
  vm = '';
  opened: string[] = [];
  pressed: string[] = [];
  lines: string[] = [];
  /** What the app shows; read on every nodes(). */
  screen: () => readonly LinuxUiNode[] | undefined = () => [PROMPT];
  /** What a press of Start task appends to the VM log, by press count. */
  onStart: (count: number) => string = () => '';

  async nodes() {
    return this.screen();
  }
  async press(target: LinuxUiNode) {
    this.pressed.push(target.name);
    if (target.name === 'Start task')
      this.vm += this.onStart(
        this.pressed.filter((name) => name === 'Start task').length
      );
    return true;
  }
  async open(url: string) {
    this.opened.push(url);
  }
  async vmLog(offset: number) {
    return this.vm.slice(offset);
  }
  async vmLogSize() {
    return this.vm.length;
  }
  log(line: string) {
    this.lines.push(line);
  }

  options(overrides: Partial<ReadyOptions> = {}): ReadyOptions {
    return {
      promptDeadlineS: 10,
      warmVm: false,
      warmDeadlineS: 60,
      stallS: 1000,
      now: () => this.time,
      tick: async (ms) => {
        this.time += ms;
      },
      ...overrides,
    };
  }
}

describe('desktopReady', () => {
  it('is ready once the prompt shows, without acting', async () => {
    const desktop = new FakeDesktop();
    await expect(
      desktopReady(desktop, desktop.options())
    ).resolves.toBeUndefined();
    expect(desktop.pressed).toEqual([]);
    expect(desktop.opened).toEqual([]);
  });

  it('waits while the app is not on the bus, then reports the deadline', async () => {
    const desktop = new FakeDesktop();
    desktop.screen = () => undefined;
    await expect(desktopReady(desktop, desktop.options())).resolves.toBe(
      "Cowork's prompt didn't appear within 10 s"
    );
    expect(desktop.time).toBe(10_000);
  });

  it('presses Continue on the gateway notice once', async () => {
    const desktop = new FakeDesktop();
    const notice = [
      node('label', 'This app uses a custom inference gateway'),
      node('button', 'Continue'),
    ];
    desktop.screen = () => (desktop.time < 3000 ? notice : [PROMPT]);
    await expect(
      desktopReady(desktop, desktop.options())
    ).resolves.toBeUndefined();
    expect(desktop.pressed).toEqual(['Continue']);
  });

  it('warms the VM with one task, then opens a new task', async () => {
    const desktop = new FakeDesktop();
    desktop.screen = () => [PROMPT, START];
    desktop.onStart = () => '[Keepalive] Starting\n';
    await expect(
      desktopReady(desktop, desktop.options({ warmVm: true }))
    ).resolves.toBeUndefined();
    expect(desktop.opened).toEqual([
      'claude://claude.ai/new?q=Reply%20with%20OK.',
      'claude://claude.ai/new',
    ]);
    expect(desktop.pressed).toEqual(['Start task']);
  });

  it('starts another warm-up task when Claude gives up on a start', async () => {
    const desktop = new FakeDesktop();
    desktop.screen = () => [PROMPT, START];
    desktop.onStart = (count) =>
      count === 1
        ? 'Startup failed\nAll files ready\n'
        : 'sdk_install completed\n';
    await expect(
      desktopReady(desktop, desktop.options({ warmVm: true }))
    ).resolves.toBeUndefined();
    expect(desktop.pressed).toEqual(['Start task', 'Start task']);
  });

  it('starts another warm-up task when the VM log stalls', async () => {
    const desktop = new FakeDesktop();
    desktop.screen = () => [PROMPT, START];
    desktop.onStart = (count) =>
      count === 1 ? 'booting\n' : 'sdk_install completed\n';
    await expect(
      desktopReady(desktop, desktop.options({ warmVm: true, stallS: 5 }))
    ).resolves.toBeUndefined();
    expect(desktop.pressed).toEqual(['Start task', 'Start task']);
    expect(desktop.lines).toEqual([
      "Cowork's VM log was silent for 5 s; starting another warm-up task",
    ]);
  });

  it("reports the VM log's last line when the VM never warms", async () => {
    const desktop = new FakeDesktop();
    desktop.screen = () => [PROMPT, START];
    desktop.onStart = () => 'booting\n';
    await expect(
      desktopReady(
        desktop,
        desktop.options({ warmVm: true, warmDeadlineS: 20 })
      )
    ).resolves.toBe(
      "Cowork's VM wasn't ready within 20 s (its log last said: booting)"
    );
    expect(desktop.pressed).toEqual(['Start task']);
  });

  it('reports a warm-up task that could not start', async () => {
    const desktop = new FakeDesktop();
    await expect(
      desktopReady(desktop, desktop.options({ warmVm: true }))
    ).resolves.toBe("the warm-up task couldn't be started");
    expect(desktop.pressed).toEqual([]);
  });
});

describe('the VM log', () => {
  it('is ready only after a startup completes after the last failure', () => {
    expect(vmReady('')).toBe(false);
    expect(vmReady('sdk_install completed\n')).toBe(true);
    expect(vmReady('[Keepalive] Starting\nStartup failed\n')).toBe(false);
    expect(vmReady('Startup failed\n[Keepalive] Starting\n')).toBe(true);
    expect(vmReady('sdk_install completed\nPost-connect setup failed\n')).toBe(
      false
    );
  });

  it('gives up on a failed start once files are ready or reinstall is skipped', () => {
    expect(startGaveUp('booting')).toBe(false);
    expect(startGaveUp('Post-connect setup failed')).toBe(true);
    expect(startGaveUp('Startup failed')).toBe(false);
    expect(startGaveUp('Startup failed\nAll files ready')).toBe(true);
    expect(startGaveUp('All files ready\nStartup failed')).toBe(false);
    expect(startGaveUp('Startup failed\nSkipping auto-reinstall')).toBe(true);
  });

  it('keeps the last non-blank line, at most 200 characters', () => {
    expect(lastLine('')).toBe('');
    expect(lastLine('one\n  two  \n\n')).toBe('two');
    expect(lastLine(`${'x'.repeat(300)}\r\n`)).toBe('x'.repeat(200));
  });
});
