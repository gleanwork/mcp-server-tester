import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real entry point, driver and AT-SPI transport. Only OS seams
// are faked: no account, desktop, child process or D-Bus socket is opened.
const external = vi.hoisted(() => ({
  createClient: vi.fn(),
  createConnection: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock('@homebridge/dbus-native', () => ({
  default: { createClient: external.createClient },
}));
vi.mock('node:net', () => ({ createConnection: external.createConnection }));
vi.mock('node:child_process', () => ({
  spawn: external.spawn,
  execFile: external.execFile,
}));

interface Message {
  path: string;
  member: string;
  body?: unknown[];
}
interface FixtureNode {
  name: string;
  role: string;
  children: string[];
  selected?: boolean;
  text?: string;
}
class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit('close');
  });
}
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  kill = vi.fn((signal: string) => {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  });
}
const savedArgv = process.argv;
const savedStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
let tree: Record<string, FixtureNode>;
let sockets: FakeSocket[];
let children: FakeChild[];
let calls: Message[];
let withheldType: number;
let withheldMember: string | undefined;
let replyToInput: ((error: unknown, value?: unknown) => void) | undefined;
let replyToUnlock: ((error: unknown, value?: unknown) => void) | undefined;
let holdUnlock: boolean;
let connectedAt: number;
let output: string;

function reply(message: Message): unknown {
  if (message.member === 'GetAddress') return 'unix:abstract=atspi-main-test';
  if (message.path === '/org/a11y/atspi/accessible/root')
    return [[':1.20', '/app']];
  if (message.member === 'GenerateKeyboardEvent') return undefined;
  const node = tree[message.path]!;
  switch (message.member) {
    case 'Get':
      return [[{ type: 's', child: [] }], [node.name]];
    case 'GetRoleName':
      return node.role;
    case 'GetState':
      return [
        (1 << 8) |
          (1 << 24) |
          (1 << 25) |
          (1 << 30) |
          (node.selected ? 1 << 23 : 0),
        0,
      ];
    case 'GetChildren':
      return node.children.map((path) => [':1.20', path]);
    case 'GetInterfaces':
      return node.text !== undefined ? ['org.a11y.atspi.Text'] : [];
    case 'GetText':
      return node.text;
    case 'GrabFocus':
    case 'DoAction':
      return true;
    default:
      throw new Error(`Unexpected fixture member: ${message.member}`);
  }
}
function keys(): unknown[] {
  return calls
    .filter((message) => message.member === 'GenerateKeyboardEvent')
    .map((message) => message.body?.[2]);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  tree = {
    '/app': {
      name: 'Claude',
      role: 'application',
      children: ['/cowork', '/chat', '/entry', '/model', '/start'],
    },
    '/cowork': {
      name: 'Cowork',
      role: 'radio button',
      children: [],
      selected: true,
    },
    '/chat': { name: 'Chat', role: 'radio button', children: [] },
    '/entry': {
      name: 'Write your prompt to Claude',
      role: 'entry',
      children: [],
      text: '',
    },
    '/model': { name: 'Model: Sonnet 4.5', role: 'push button', children: [] },
    '/start': { name: 'Start task', role: 'push button', children: [] },
  };
  sockets = [];
  children = [];
  calls = [];
  withheldType = 5;
  withheldMember = undefined;
  holdUnlock = false;
  replyToInput = undefined;
  replyToUnlock = undefined;
  connectedAt = 0;
  output = '';
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/tmp/mst-main-test');
  vi.stubEnv('MST_COWORK_ACCOUNT_OWNER', 'test-owner');
  vi.stubEnv('MST_COWORK_ACCOUNT_PROFILE', 'test-profile');
  vi.stubEnv('MST_COWORK_ACCOUNT_MARKER', 'test-marker');
  process.argv = [
    savedArgv[0]!,
    'linuxFirstPartyMain.ts',
    '--mode',
    'submit',
    '--timeout-ms',
    '1000',
  ];
  Object.defineProperty(process, 'stdin', {
    value: Readable.from([Buffer.from(JSON.stringify({ prompt: 'hello' }))]),
    configurable: true,
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  external.createConnection.mockImplementation(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  external.createClient.mockImplementation(
    ({ stream }: { stream: FakeSocket }) => ({
      connection: new EventEmitter(),
      invoke(
        message: Message,
        callback: (error: unknown, value?: unknown) => void
      ) {
        expect(stream.destroyed).toBe(false);
        calls.push(message);
        if (message.member === 'GetAddress') connectedAt = Date.now();
        if (message.member === withheldMember) return;
        if (message.member === 'GenerateKeyboardEvent') {
          const type = message.body?.[2];
          if (type === 3) tree['/entry']!.text = 'hello';
          if (type === 6 && holdUnlock) {
            replyToUnlock = callback;
            return;
          }
          if (type === withheldType) {
            replyToInput = callback;
            return;
          }
        }
        queueMicrotask(() => callback(null, reply(message)));
      },
    })
  );
  external.spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  external.execFile.mockImplementation(
    (_file, _args, _options, callback: (error: Error | null) => void) => {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => callback(null));
      return child;
    }
  );
});
afterEach(() => {
  process.argv = savedArgv;
  Object.defineProperty(process, 'stdin', savedStdin);
  process.exitCode = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function reachPasteDeadline() {
  const main = import('./linuxFirstPartyMain.js');
  await vi.waitFor(() =>
    expect(keys()).toEqual(withheldType === 5 ? [5] : [5, 3])
  );
  await vi.advanceTimersByTimeAsync(connectedAt + 1000 - Date.now());
  return { main };
}
function expectDeadlineReceipt(): void {
  expect(JSON.parse(output)).toMatchObject({
    status: 'failed',
    error: 'deadline_exceeded',
    action_count: 2,
    duration_ms: 1000,
  });
  expect(calls.filter((message) => message.member === 'DoAction')).toHaveLength(
    0
  );
  expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  expect(children.at(-1)!.kill).toHaveBeenCalledWith('SIGKILL');
}

describe('Linux first-party main shutdown through the native OS seams', () => {
  it.each([5, 3])(
    'unlocks before closing transport when keyboard event type %i stalls at the driver deadline',
    async (type) => {
      withheldType = type;
      const { main } = await reachPasteDeadline();
      await main;
      expectDeadlineReceipt();
      expect(keys()).toEqual(type === 5 ? [5, 6] : [5, 3, 6]);
      expect(Date.now() - connectedAt).toBe(1000);
    }
  );

  it('waits at most one extra second for a stalled unlock, never replaying paste or submission', async () => {
    withheldType = 3;
    holdUnlock = true;
    const { main } = await reachPasteDeadline();
    expect(keys()).toEqual([5, 3, 6]);
    expect(sockets.at(-1)!.destroyed).toBe(false);
    expect(output).toBe('');
    await vi.advanceTimersByTimeAsync(999);
    expect(output).toBe('');
    expect(sockets.at(-1)!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await main;
    expectDeadlineReceipt();
    expect(Date.now() - connectedAt).toBe(2000);
    expect(keys()).toEqual([5, 3, 6]);
    // A late acknowledgement after shutdown must not initiate another input.
    replyToInput?.(null);
    replyToUnlock?.(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(keys()).toEqual([5, 3, 6]);
    expectDeadlineReceipt();
  });

  it.each([null, new Error('unlock acknowledgement failed')])(
    'closes as soon as cleanup settles, preserving the deadline receipt (%s)',
    async (error) => {
      holdUnlock = true;
      const { main } = await reachPasteDeadline();
      expect(sockets.at(-1)!.destroyed).toBe(false);
      expect(keys()).toEqual([5, 6]);
      await vi.advanceTimersByTimeAsync(250);
      // Even a late lock acknowledgement cannot cause a paste after deadline.
      replyToInput?.(null);
      replyToUnlock?.(error);
      await main;
      expectDeadlineReceipt();
      expect(Date.now() - connectedAt).toBe(1250);
      expect(keys()).toEqual([5, 6]);
    }
  );

  it('does not reserve cleanup time when focus stalls before any lock attempt', async () => {
    withheldMember = 'GrabFocus';
    const main = import('./linuxFirstPartyMain.js');
    await vi.waitFor(() =>
      expect(calls.some((call) => call.member === 'GrabFocus')).toBe(true)
    );
    await vi.advanceTimersByTimeAsync(connectedAt + 1000 - Date.now());
    await main;
    expectDeadlineReceipt();
    expect(keys()).toEqual([]);
    expect(Date.now() - connectedAt).toBe(1000);
  });

  it('still pastes and submits exactly once on success without an extra unlock at shutdown', async () => {
    withheldType = -1;
    const main = import('./linuxFirstPartyMain.js');
    await vi.waitFor(() => expect(output).not.toBe(''));
    await main;
    expect(JSON.parse(output)).toMatchObject({
      status: 'submitted',
      action_count: 3,
    });
    expect(keys()).toEqual([5, 3, 6]);
    expect(calls.filter((call) => call.member === 'DoAction')).toHaveLength(1);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });
});
