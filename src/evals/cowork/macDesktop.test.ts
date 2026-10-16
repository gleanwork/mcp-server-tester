import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Offline: the Swift helper and system commands are mocked; nothing reaches the display. */

const runs: Array<{ args: string[]; stdin?: string }> = [];
const replies = new Map<string, unknown>();

vi.mock('../nativeHelper.js', () => ({
  compileSwiftHelper: vi.fn(async () => ({
    async run(args: string[], options: { stdin?: string }) {
      runs.push({
        args,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
      return replies.get(args[0]!) ?? { ok: true };
    },
  })),
}));

const { keyCodes, macComputerUseDesktop, screenPoint } =
  await import('./macDesktop.js');
const { DesktopBlockedError } = await import('./computerUseLoop.js');

const platform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  runs.length = 0;
  replies.clear();
  replies.set('screen', { width: 1440, height: 900 });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
});

function desktop() {
  return macComputerUseDesktop({ sleep: async () => undefined });
}

describe('key names', () => {
  it.each([
    ['Return', [0x24]],
    ['enter', [0x24]],
    ['Escape', [0x35]],
    ['BackSpace', [0x33]],
    ['Delete', [0x33]],
    ['Tab', [0x30]],
    ['ctrl+a', [0x3b, 0x00]],
    ['super+n', [0x37, 0x2d]],
    ['cmd+shift+t', [0x37, 0x38, 0x11]],
    ['Page_Down', [0x79]],
    ['Up', [0x7e]],
    ['F5', [0x60]],
  ])('maps %s', (text, codes) => {
    expect(keyCodes(text)).toEqual(codes);
  });

  it('refuses an unknown name instead of guessing', () => {
    expect(keyCodes('hyper+q')).toBeUndefined();
    expect(keyCodes('')).toBeUndefined();
  });
});

describe('the desktop', () => {
  it("scales the planner's coordinates to the display's points", async () => {
    expect(screenPoint([640, 400], { width: 1440, height: 900 })).toEqual([
      720, 450,
    ]);
    expect(screenPoint([1279, 799], { width: 1728, height: 1117 })).toEqual([
      1726, 1115,
    ]);
    await desktop().execute({ action: 'double_click', coordinate: [640, 400] });
    expect(runs.at(-1)!.args).toEqual(['click', '720', '450', 'left', '2']);
  });

  it('types text over stdin only, with Shift+Enter for line breaks', async () => {
    await desktop().execute({ action: 'type', text: 'héllo\nworld' });
    expect(runs).toEqual([
      { args: ['type'], stdin: 'héllo' },
      { args: ['chord', '56', '36'] },
      { args: ['type'], stdin: 'world' },
    ]);
    expect(JSON.stringify(runs.map((run) => run.args))).not.toContain('héllo');
  });

  it('reports a press of Enter as the submission', async () => {
    const enter = await desktop().execute({ action: 'key', text: 'Return' });
    expect(enter.submitted).toBe(true);
    const tab = await desktop().execute({ action: 'key', text: 'Tab' });
    expect(tab.submitted).toBe(false);
  });

  it("doesn't send an unknown key", async () => {
    const result = await desktop().execute({ action: 'key', text: 'hyper+q' });
    expect(result).toEqual({
      result: 'key not sent: unknown key in hyper+q',
      submitted: false,
    });
    expect(runs.filter((run) => run.args[0] === 'chord')).toEqual([]);
  });

  it('scrolls in all four directions', async () => {
    const d = desktop();
    for (const direction of ['down', 'up', 'left', 'right'])
      await d.execute({
        action: 'scroll',
        scroll_direction: direction,
        scroll_amount: 2,
      });
    expect(
      runs
        .filter((run) => run.args[0] === 'scroll')
        .map((run) => run.args.slice(3))
    ).toEqual([
      ['-2', '0'],
      ['2', '0'],
      ['0', '2'],
      ['0', '-2'],
    ]);
  });

  it('needs a coordinate for a click', async () => {
    await expect(desktop().execute({ action: 'left_click' })).rejects.toThrow(
      'left_click needs a coordinate'
    );
  });

  it('caps a wait at five seconds', async () => {
    const sleeps: number[] = [];
    await macComputerUseDesktop({
      sleep: async (ms) => void sleeps.push(ms),
    }).execute({
      action: 'wait',
      duration: 30,
    });
    expect(sleeps).toEqual([5000]);
  });

  it('reports a missing permission as its code', async () => {
    replies.set('permissions', { screenRecording: true, accessibility: false });
    const error = await desktop()
      .checkPermissions()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DesktopBlockedError);
    expect((error as InstanceType<typeof DesktopBlockedError>).code).toBe(
      'accessibility_required'
    );
  });

  it('reads the frontmost app, or nothing when it cannot', async () => {
    replies.set('frontmost', { name: 'Claude' });
    expect(await desktop().frontmostApp()).toBe('Claude');
    replies.set('frontmost', { name: 7 });
    expect(await desktop().frontmostApp()).toBeUndefined();
  });

  it('runs only on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(desktop().frontmostApp()).resolves.toBeUndefined();
    await expect(
      desktop().execute({ action: 'mouse_move', coordinate: [1, 1] })
    ).rejects.toThrow('only on macOS');
  });
});
