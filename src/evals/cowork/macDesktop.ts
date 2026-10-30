import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  compileSwiftHelper,
  NativeHelperBuildError,
  type NativeHelper,
} from '../nativeHelper.js';
import {
  actionField,
  DesktopBlockedError,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  type ComputerUseDesktop,
  type DesktopAction,
  type DesktopActionResult,
  type ImageBlock,
} from './computerUseLoop.js';
import { MAC_DESKTOP_HELPER_SOURCE } from './macDesktopSource.js';

/**
 * The Mac, for the Computer Use loop. Input, focus and permission checks go
 * through a small Swift helper; screenshots use the system's `screencapture`
 * and `sips`; paste uses the clipboard and System Events, as ChatGPT's
 * composer ignores synthetic Command+V and Unicode key events.
 */

const exec = promisify(execFile);
const HELPER_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
/** About 0.6 s of typing: the helper posts 16 units every 10 ms. */
const TYPE_PIECE_UNITS = 1000;
/** The most clipboard text a paste saves and puts back. */
const CLIPBOARD_LIMIT = 512 * 1024 * 1024;
/** Each input action is followed by this pause, so the UI can catch up. */
const INPUT_PAUSE_MS = 100;

/** macOS virtual key codes (Carbon `kVK_*`). */
const KEY_CODES: Record<string, number> = {
  a: 0x00,
  s: 0x01,
  d: 0x02,
  f: 0x03,
  h: 0x04,
  g: 0x05,
  z: 0x06,
  x: 0x07,
  c: 0x08,
  v: 0x09,
  b: 0x0b,
  q: 0x0c,
  w: 0x0d,
  e: 0x0e,
  r: 0x0f,
  y: 0x10,
  t: 0x11,
  '1': 0x12,
  '2': 0x13,
  '3': 0x14,
  '4': 0x15,
  '6': 0x16,
  '5': 0x17,
  '=': 0x18,
  '9': 0x19,
  '7': 0x1a,
  '-': 0x1b,
  '8': 0x1c,
  '0': 0x1d,
  ']': 0x1e,
  o: 0x1f,
  u: 0x20,
  '[': 0x21,
  i: 0x22,
  p: 0x23,
  l: 0x25,
  j: 0x26,
  "'": 0x27,
  k: 0x28,
  ';': 0x29,
  '\\': 0x2a,
  ',': 0x2b,
  '/': 0x2c,
  n: 0x2d,
  m: 0x2e,
  '.': 0x2f,
  '`': 0x32,
  enter: 0x24,
  tab: 0x30,
  space: 0x31,
  backspace: 0x33,
  escape: 0x35,
  command: 0x37,
  shift: 0x38,
  capslock: 0x39,
  option: 0x3a,
  ctrl: 0x3b,
  fn: 0x3f,
  forwarddelete: 0x75,
  home: 0x73,
  end: 0x77,
  pageup: 0x74,
  pagedown: 0x79,
  left: 0x7b,
  right: 0x7c,
  down: 0x7d,
  up: 0x7e,
  help: 0x72,
  f1: 0x7a,
  f2: 0x78,
  f3: 0x63,
  f4: 0x76,
  f5: 0x60,
  f6: 0x61,
  f7: 0x62,
  f8: 0x64,
  f9: 0x65,
  f10: 0x6d,
  f11: 0x67,
  f12: 0x6f,
};

/** Other names a planner uses (xdotool's, and pyautogui's). */
const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  super: 'command',
  cmd: 'command',
  meta: 'command',
  win: 'command',
  control: 'ctrl',
  alt: 'option',
  esc: 'escape',
  // macOS calls Backspace "delete"; pyautogui sent Delete as Backspace too.
  delete: 'backspace',
  del: 'backspace',
  page_up: 'pageup',
  pgup: 'pageup',
  prior: 'pageup',
  page_down: 'pagedown',
  pgdn: 'pagedown',
  next: 'pagedown',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  minus: '-',
  equal: '=',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  apostrophe: "'",
  grave: '`',
  bracketleft: '[',
  bracketright: ']',
  backslash: '\\',
};

/** A key chord's names (`ctrl+shift+t`) as key codes, or undefined if a name is unknown. */
export function keyCodes(text: string): number[] | undefined {
  const codes: number[] = [];
  for (const part of text.split('+')) {
    const raw = part.trim().toLowerCase();
    const name = KEY_ALIASES[raw] ?? raw;
    const code = KEY_CODES[name];
    if (code === undefined) return undefined;
    codes.push(code);
  }
  return codes.length ? codes : undefined;
}

/** Whether a chord presses Enter, which submits a filled composer. */
function pressesEnter(text: string): boolean {
  return text
    .split('+')
    .some((part) => ['enter', 'return'].includes(part.trim().toLowerCase()));
}

function coordinate(
  action: DesktopAction,
  field = 'coordinate'
): [number, number] {
  const value = action[field];
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
    throw new Error(`${String(action.action)} needs a ${field}`);
  return [value[0] as number, value[1] as number];
}

/** A planner coordinate (1280×800) in the main display's points. */
export function screenPoint(
  [x, y]: [number, number],
  screen: { width: number; height: number }
): [number, number] {
  return [
    Math.trunc((x * screen.width) / DISPLAY_WIDTH),
    Math.trunc((y * screen.height) / DISPLAY_HEIGHT),
  ];
}

const OkSchema = z.object({ ok: z.literal(true) });
const ScreenSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});

export interface MacDesktopOptions {
  /** Pauses between steps (paste, input). */
  sleep(ms: number): Promise<void>;
}

let compiled: Promise<NativeHelper> | undefined;

function helper(): Promise<NativeHelper> {
  compiled ??= compileSwiftHelper({
    name: 'computer-use',
    source: MAC_DESKTOP_HELPER_SOURCE,
  }).catch((error: unknown) => {
    compiled = undefined;
    if (error instanceof NativeHelperBuildError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(
      `Computer Use couldn't build its macOS helper (${code}). It needs the Xcode Command Line Tools: run \`xcode-select --install\`.`
    );
  });
  return compiled;
}

/** The macOS desktop. Off macOS, every method rejects. */
export function macComputerUseDesktop(
  options: MacDesktopOptions
): ComputerUseDesktop {
  let screen: Promise<{ width: number; height: number }> | undefined;

  async function run(args: string[], stdin?: string): Promise<unknown> {
    if (process.platform !== 'darwin')
      throw new Error('Computer Use runs only on macOS.');
    try {
      return await (
        await helper()
      ).run(args, {
        environment: 'minimal',
        timeoutMs: HELPER_TIMEOUT_MS,
        ...(stdin === undefined ? {} : { stdin }),
      });
    } catch (error) {
      // The raw error can carry arguments; name only the command.
      if (error instanceof Error && error.message.startsWith('Computer Use'))
        throw error;
      throw new Error(`Computer Use helper failed: ${args[0]}`);
    }
  }

  /**
   * One input primitive. The deadline is checked right before it, after any
   * wait the action did first (a screen lookup, a pause), so no input reaches
   * the desktop once the deadline has passed.
   */
  async function input(
    signal: AbortSignal,
    args: string[],
    stdin?: string
  ): Promise<void> {
    stopAtDeadline(signal);
    OkSchema.parse(await run(args, stdin));
    await options.sleep(INPUT_PAUSE_MS);
  }

  function screenSize() {
    screen ??= run(['screen']).then((value) => ScreenSchema.parse(value));
    return screen;
  }

  async function point(action: DesktopAction, field?: string) {
    return screenPoint(coordinate(action, field), await screenSize());
  }

  async function screenshot(): Promise<ImageBlock> {
    if (process.platform !== 'darwin')
      throw new Error('Computer Use runs only on macOS.');
    const directory = await mkdtemp(join(tmpdir(), 'mst-cu-shot-'));
    try {
      const raw = join(directory, 'screen.png');
      const scaled = join(directory, 'scaled.png');
      // -x: no sound; -m: the main display only.
      await exec('/usr/sbin/screencapture', ['-x', '-m', '-t', 'png', raw], {
        timeout: COMMAND_TIMEOUT_MS,
      });
      await exec(
        '/usr/bin/sips',
        [
          '-z',
          String(DISPLAY_HEIGHT),
          String(DISPLAY_WIDTH),
          raw,
          '--out',
          scaled,
        ],
        { timeout: COMMAND_TIMEOUT_MS }
      );
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: (await readFile(scaled)).toString('base64'),
        },
      };
    } catch {
      throw new Error(
        'Computer Use could not take a screenshot. Check that the terminal running MST has Screen Recording permission.'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function typeText(text: string, signal: AbortSignal): Promise<void> {
    // Line breaks must not submit the composer.
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (index)
        await input(signal, ['chord', ...keyCodes('shift+enter')!.map(String)]);
      for (const piece of pieces(line)) await input(signal, ['type'], piece);
    }
  }

  async function pasteText(text: string, signal: AbortSignal): Promise<void> {
    // The clipboard is put back afterwards. If it can't be saved, nothing is
    // pasted: overwriting it would lose what the user copied.
    let previous: Buffer;
    try {
      ({ stdout: previous } = await exec('/usr/bin/pbpaste', [], {
        encoding: 'buffer',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: CLIPBOARD_LIMIT,
      }));
    } catch {
      throw new Error(
        'Computer Use could not save the clipboard, so it did not paste the query.'
      );
    }
    stopAtDeadline(signal);
    await pipe('/usr/bin/pbcopy', Buffer.from(text, 'utf8'));
    try {
      await options.sleep(200);
      stopAtDeadline(signal);
      await exec(
        '/usr/bin/osascript',
        [
          '-e',
          'tell application "System Events" to keystroke "v" using command down',
        ],
        { timeout: COMMAND_TIMEOUT_MS }
      );
      await options.sleep(500);
    } finally {
      await pipe('/usr/bin/pbcopy', previous).catch(() => undefined);
    }
  }

  return {
    async checkPermissions() {
      const state = z
        .object({ screenRecording: z.boolean(), accessibility: z.boolean() })
        .parse(await run(['permissions']));
      if (!state.screenRecording)
        throw new DesktopBlockedError('screen_recording_required');
      if (!state.accessibility)
        throw new DesktopBlockedError('accessibility_required');
    },
    async launch(app, required) {
      try {
        await exec('/usr/bin/open', ['-a', app], {
          timeout: COMMAND_TIMEOUT_MS,
        });
      } catch {
        if (required) throw new Error(`Could not open ${app}`);
      }
    },
    async openUrl(url) {
      try {
        await exec('/usr/bin/open', [url], { timeout: COMMAND_TIMEOUT_MS });
      } catch {
        throw new Error('Could not open the Codex draft link');
      }
    },
    async newChatgptChat() {
      const script =
        'tell application "System Events" to tell process "ChatGPT"\n' +
        '  set frontmost to true\n' +
        '  click menu item "New Chat" of menu 1 of menu bar item "File" of menu bar 1\n' +
        'end tell';
      try {
        await exec('/usr/bin/osascript', ['-e', script], {
          timeout: COMMAND_TIMEOUT_MS,
        });
        return true;
      } catch {
        return false;
      }
    },
    screenshot,
    async frontmostApp() {
      try {
        const value = z
          .object({ name: z.string().optional() })
          .parse(await run(['frontmost']));
        return value.name;
      } catch {
        return undefined;
      }
    },
    async execute(action, signal): Promise<DesktopActionResult> {
      const name = String(action.action);
      switch (name) {
        case 'screenshot':
          return { result: await screenshot(), submitted: false };
        case 'left_click':
        case 'right_click':
        case 'middle_click':
        case 'double_click':
        case 'triple_click': {
          const [x, y] = await point(action);
          const button =
            name === 'right_click'
              ? 'right'
              : name === 'middle_click'
                ? 'middle'
                : 'left';
          const clicks =
            name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1;
          await input(signal, [
            'click',
            String(x),
            String(y),
            button,
            String(clicks),
          ]);
          return { result: `${name} completed`, submitted: false };
        }
        case 'cursor_position': {
          const value = z
            .object({ x: z.number(), y: z.number() })
            .parse(await run(['cursor']));
          return { result: value, submitted: false };
        }
        case 'mouse_move': {
          const [x, y] = await point(action);
          await input(signal, ['move', String(x), String(y)]);
          return { result: 'mouse_move completed', submitted: false };
        }
        case 'left_click_drag': {
          const [startX, startY] = await point(action, 'start_coordinate');
          const [endX, endY] = await point(action);
          await input(signal, [
            'drag',
            String(startX),
            String(startY),
            String(endX),
            String(endY),
          ]);
          return { result: 'drag completed', submitted: false };
        }
        case 'type':
          await typeText(actionField(action, 'text'), signal);
          return { result: 'text entered', submitted: false };
        case 'paste':
          await pasteText(actionField(action, 'text'), signal);
          return { result: 'text entered', submitted: false };
        case 'key': {
          const text = actionField(action, 'text');
          const codes = keyCodes(text);
          // An unknown key name is reported, not guessed at.
          if (!codes)
            return {
              result: `key not sent: unknown key in ${text}`,
              submitted: false,
            };
          await input(signal, ['chord', ...codes.map(String)]);
          return {
            result: `key completed: ${text}`,
            submitted: pressesEnter(text),
          };
        }
        case 'scroll': {
          const [x, y] = action.coordinate
            ? await point(action)
            : screenPoint(
                [DISPLAY_WIDTH / 2, DISPLAY_HEIGHT / 2],
                await screenSize()
              );
          const amount = Math.trunc(Number(action.scroll_amount ?? 3));
          if (!Number.isFinite(amount))
            throw new Error('scroll needs a scroll_amount');
          const direction = actionField(action, 'scroll_direction', 'down');
          const vertical =
            direction === 'down' ? -amount : direction === 'up' ? amount : 0;
          const horizontal =
            direction === 'right' ? -amount : direction === 'left' ? amount : 0;
          await input(signal, [
            'scroll',
            String(x),
            String(y),
            String(vertical),
            String(horizontal),
          ]);
          return { result: 'scroll completed', submitted: false };
        }
        case 'wait': {
          const seconds = Number(action.duration ?? 1);
          if (!Number.isFinite(seconds) || seconds < 0)
            throw new Error('wait needs a duration');
          await options.sleep(Math.min(seconds, 5) * 1000);
          return { result: 'wait completed', submitted: false };
        }
        default:
          throw new Error(`unsupported Computer Use action: ${name}`);
      }
    },
  };
}

/**
 * A line in pieces of at most `TYPE_PIECE_UNITS` UTF-16 units, never splitting
 * a character. Each piece is one helper run, well inside its time limit, and
 * the deadline is checked between pieces.
 */
export function pieces(line: string): string[] {
  const result: string[] = [];
  let current = '';
  for (const character of line) {
    if (current.length + character.length > TYPE_PIECE_UNITS) {
      result.push(current);
      current = '';
    }
    current += character;
  }
  if (current) result.push(current);
  return result;
}

function stopAtDeadline(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Computer Use deadline reached');
}

/** Runs `file` with `data` on stdin. */
function pipe(file: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [],
      { timeout: COMMAND_TIMEOUT_MS },
      (error) =>
        error
          ? reject(new Error(`${file} failed`, { cause: error }))
          : resolve()
    );
    child.stdin?.on('error', (error: Error) => reject(error));
    child.stdin?.end(data);
  });
}
