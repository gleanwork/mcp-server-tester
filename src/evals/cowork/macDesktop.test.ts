import type * as ChildProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Offline: the Swift helper and system commands are mocked; nothing reaches the display. */

const runs: Array<{ args: string[]; stdin?: string }> = [];
const replies = new Map<string, unknown>();

/** System commands (pbpaste, pbcopy, osascript): what ran, with its stdin. */
const commands = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; stdin?: string }>,
  /** Per command: its stdout, or an error to fail with. */
  results: new Map<string, { stdout?: string; error?: Error }>(),
}));

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        file: string,
        args: string[],
        options: { maxBuffer?: number },
        callback: (error: Error | null, result?: unknown) => void
      ) => {
        const call: { file: string; args: string[]; stdin?: string } = {
          file,
          args,
        };
        commands.calls.push(call);
        const result = commands.results.get(file) ?? {};
        const stdout = Buffer.from(result.stdout ?? '');
        // As Node does: more output than maxBuffer (default 1 MiB) fails the command.
        const overflow =
          stdout.length > (options.maxBuffer ?? 1024 * 1024)
            ? Object.assign(new Error('stdout maxBuffer length exceeded'), {
                code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
              })
            : undefined;
        setImmediate(() =>
          result.error || overflow
            ? callback((result.error ?? overflow)!)
            : callback(null, { stdout, stderr: '' })
        );
        return {
          stdin: {
            on: () => undefined,
            end: (data: Buffer) => {
              call.stdin = data.toString('utf8');
            },
          },
        };
      }
    ),
  };
});

vi.mock('../nativeHelper.js', () => ({
  compileSwiftHelper: vi.fn(async () => ({
    async run(args: string[], options: { stdin?: string }) {
      runs.push({
        args,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
      const reply = replies.get(args[0]!);
      // A function reply runs when the command does, for a test to act mid-command.
      return (
        (typeof reply === 'function' ? (reply as () => unknown)() : reply) ?? {
          ok: true,
        }
      );
    },
  })),
}));

const { keyCodes, macComputerUseDesktop, pieces, screenPoint } =
  await import('./macDesktop.js');
const { DesktopBlockedError } = await import('./computerUseLoop.js');

const platform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  runs.length = 0;
  replies.clear();
  commands.calls.length = 0;
  commands.results.clear();
  replies.set('screen', { width: 1440, height: 900 });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
});

function desktop(
  sleep: (ms: number) => Promise<void> = async () => undefined,
  signal = new AbortController().signal
) {
  const mac = macComputerUseDesktop({ sleep });
  return {
    ...mac,
    execute: (action: Record<string, unknown>) => mac.execute(action, signal),
  };
}

describe('typing pieces', () => {
  it('splits a long line into pieces of at most 1,000 units', () => {
    expect(pieces('a'.repeat(2500)).map((piece) => piece.length)).toEqual([
      1000, 1000, 500,
    ]);
    expect(pieces('')).toEqual([]);
  });

  it('never splits a character', () => {
    const line = `${'a'.repeat(999)}😀b`;
    expect(pieces(line)).toEqual(['a'.repeat(999), '😀b']);
    expect(pieces(line).join('')).toBe(line);
  });

  it('types a long line in several helper runs', async () => {
    await desktop().execute({ action: 'type', text: 'x'.repeat(2001) });
    expect(runs.map((run) => run.stdin?.length)).toEqual([1000, 1000, 1]);
  });
});

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

  it('presses Return only for the names the loop treats as Enter', () => {
    // The loop's submission rules recognize only enter and return; another
    // name for Return would get past them.
    expect(keyCodes('KP_Enter')).toBeUndefined();
    expect(keyCodes('enter')).toEqual([0x24]);
    expect(keyCodes('return')).toEqual([0x24]);
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
    await desktop(async (ms) => void sleeps.push(ms)).execute({
      action: 'wait',
      duration: 30,
    });
    expect(sleeps).toEqual([5000]);
  });

  it('stops typing between pieces of a long line once the deadline passes', async () => {
    const deadline = new AbortController();
    const d = desktop(async () => {
      if (runs.length === 1) deadline.abort();
    }, deadline.signal);
    await expect(
      d.execute({ action: 'type', text: 'x'.repeat(2500) })
    ).rejects.toThrow('deadline reached');
    expect(runs.map((run) => run.stdin?.length)).toEqual([1000]);
  });

  it("doesn't click when the deadline passes while it looks up the screen", async () => {
    const deadline = new AbortController();
    replies.set('screen', () => {
      deadline.abort();
      return { width: 1440, height: 900 };
    });
    await expect(
      desktop(undefined, deadline.signal).execute({
        action: 'left_click',
        coordinate: [10, 10],
      })
    ).rejects.toThrow('deadline reached');
    expect(runs.map((run) => run.args[0])).toEqual(['screen']);
  });

  it("doesn't press Command+V when the deadline passes before it, and puts the clipboard back", async () => {
    const deadline = new AbortController();
    commands.results.set('/usr/bin/pbpaste', {
      stdout: 'what the user copied',
    });
    await expect(
      desktop(async (ms) => {
        if (ms === 200) deadline.abort();
      }, deadline.signal).execute({ action: 'paste', text: 'private query' })
    ).rejects.toThrow('deadline reached');
    expect(commands.calls.map((call) => [call.file, call.stdin])).toEqual([
      ['/usr/bin/pbpaste', undefined],
      ['/usr/bin/pbcopy', 'private query'],
      ['/usr/bin/pbcopy', 'what the user copied'],
    ]);
  });

  it('saves and puts back a clipboard larger than 1 MiB', async () => {
    const large = 'y'.repeat(2 * 1024 * 1024);
    commands.results.set('/usr/bin/pbpaste', { stdout: large });
    await desktop().execute({ action: 'paste', text: 'query' });
    const restored = commands.calls.at(-1)!;
    expect(restored.file).toBe('/usr/bin/pbcopy');
    expect(restored.stdin).toHaveLength(large.length);
  });

  it('stops typing between lines once the deadline passes', async () => {
    const deadline = new AbortController();
    const d = desktop(async () => {
      if (runs.length === 1) deadline.abort();
    }, deadline.signal);
    await expect(
      d.execute({ action: 'type', text: 'one\ntwo\nthree' })
    ).rejects.toThrow('deadline reached');
    expect(runs).toEqual([{ args: ['type'], stdin: 'one' }]);
  });

  it('pastes over stdin only, and puts the clipboard back even when the paste fails', async () => {
    commands.results.set('/usr/bin/pbpaste', {
      stdout: 'what the user copied',
    });
    commands.results.set('/usr/bin/osascript', {
      error: new Error('System Events failed'),
    });
    await expect(
      desktop().execute({ action: 'paste', text: 'private query' })
    ).rejects.toThrow();
    expect(commands.calls.map((call) => [call.file, call.stdin])).toEqual([
      ['/usr/bin/pbpaste', undefined],
      ['/usr/bin/pbcopy', 'private query'],
      ['/usr/bin/osascript', undefined],
      ['/usr/bin/pbcopy', 'what the user copied'],
    ]);
    expect(
      JSON.stringify(commands.calls.map((call) => call.args))
    ).not.toContain('private');
  });

  it("doesn't paste when it can't save the clipboard", async () => {
    commands.results.set('/usr/bin/pbpaste', {
      error: Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      }),
    });
    await expect(
      desktop().execute({ action: 'paste', text: 'private query' })
    ).rejects.toThrow('could not save the clipboard');
    expect(commands.calls.map((call) => call.file)).toEqual([
      '/usr/bin/pbpaste',
    ]);
  });

  it.each([
    [
      { screenRecording: false, accessibility: true },
      'screen_recording_required',
    ],
    [
      { screenRecording: false, accessibility: false },
      'screen_recording_required',
    ],
    [{ screenRecording: true, accessibility: false }, 'accessibility_required'],
  ])('reports missing permissions %o as %s', async (state, code) => {
    replies.set('permissions', state);
    const error = await desktop()
      .checkPermissions()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DesktopBlockedError);
    expect((error as InstanceType<typeof DesktopBlockedError>).code).toBe(code);
  });

  it('passes with both permissions', async () => {
    replies.set('permissions', { screenRecording: true, accessibility: true });
    await expect(desktop().checkPermissions()).resolves.toBeUndefined();
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
