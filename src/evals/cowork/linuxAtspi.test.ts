import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type * as Net from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectLinuxUi } from './linuxAtspi.js';
import type { LinuxUi } from './linuxUi.js';

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
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature?: string;
  body?: unknown[];
}
interface FixtureNode {
  name: string;
  role: string;
  children: string[];
  state: number[];
  text?: string;
}
class FakeSocket extends EventEmitter {
  destroy = vi.fn(() => {
    this.emit('close');
  });
}
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  input = '';
  stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.input += chunk.toString();
      callback();
    },
  });
  kill = vi.fn((signal: string) => {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  });
}
const ROOT = '/org/a11y/atspi/accessible/root';
const env = {
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/session',
  DISPLAY: ':1',
};
const normalStates = [(1 << 8) | (1 << 24) | (1 << 25) | (1 << 30), 0];
let nodes: Map<string, FixtureNode>;
let apps: string[];
let sockets: FakeSocket[];
let connections: EventEmitter[];
let calls: Message[];
let children: FakeChild[];
let uis: LinuxUi[];
let accessibilityAddress: string;
let failCall: ((message: Message) => boolean) | undefined;
let hangCall: ((message: Message) => boolean) | undefined;
let heldKeyboardReplies: Map<number, (error: unknown) => void>;
let override:
  | ((message: Message) => { value: unknown } | undefined)
  | undefined;
let delayReply: boolean;
let activeCalls: number;
let maxActiveCalls: number;

function node(
  name: string,
  role: string,
  children: string[] = []
): FixtureNode {
  return { name, role, children, state: [...normalStates] };
}
function variant(value: string): unknown {
  return [[{ type: 's', child: [] }], [value]];
}
function reply(message: Message): unknown {
  const overridden = override?.(message);
  if (overridden) return overridden.value;
  if (message.member === 'GetAddress') return accessibilityAddress;
  if (message.path === ROOT) return apps.map((path) => [':1.20', path]);
  if (message.member === 'GenerateKeyboardEvent') return undefined;
  const value = nodes.get(message.path);
  if (!value) throw new Error(`Missing fixture: ${message.path}`);
  switch (message.member) {
    case 'Get':
      return variant(value.name);
    case 'GetRoleName':
      return value.role;
    case 'GetState':
      return value.state;
    case 'GetChildren':
      return value.children.map((path) => [':1.20', path]);
    case 'GetInterfaces':
      return value.text !== undefined ? ['org.a11y.atspi.Text'] : [];
    case 'GetText':
      return value.text;
    case 'DoAction':
    case 'GrabFocus':
    case 'ScrollTo':
      return true;
    default:
      throw new Error(`Unexpected member: ${message.member}`);
  }
}
async function connect(
  ms = 10_000,
  environment: Record<string, string | undefined> = env
): Promise<LinuxUi> {
  const ui = await connectLinuxUi(environment, Date.now() + ms);
  uis.push(ui);
  return ui;
}
async function entry(ui: LinuxUi) {
  return (await ui.snapshot()).find((item) => item.role === 'entry')!;
}
function keyboardCalls(): Message[] {
  return calls.filter((call) => call.member === 'GenerateKeyboardEvent');
}

beforeEach(() => {
  vi.useFakeTimers({ loopLimit: 100_000 });
  vi.clearAllMocks();
  nodes = new Map([
    ['/app', node('Claude', 'application', ['/entry', '/table', '/button'])],
    [
      '/entry',
      node('Write your prompt to Claude', 'entry', ['/line1', '/group']),
    ],
    ['/line1', node('first', 'static')],
    ['/group', node('', 'section', ['/line2'])],
    ['/line2', node('second', 'text')],
    ['/table', node('Expensive table', 'table', ['/never-read'])],
    ['/button', node('Send', 'push button')],
  ]);
  apps = ['/app'];
  sockets = [];
  connections = [];
  calls = [];
  children = [];
  uis = [];
  accessibilityAddress = 'unix:abstract=atspi-test';
  failCall = undefined;
  hangCall = undefined;
  heldKeyboardReplies = new Map();
  override = undefined;
  delayReply = false;
  activeCalls = 0;
  maxActiveCalls = 0;
  external.createConnection.mockImplementation(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  external.createClient.mockImplementation(() => {
    const connection = new EventEmitter();
    connections.push(connection);
    return {
      connection,
      invoke: (
        message: Message,
        callback: (error: unknown, value?: unknown) => void
      ) => {
        calls.push(message);
        if (hangCall?.(message)) {
          if (message.member === 'GenerateKeyboardEvent')
            heldKeyboardReplies.set(Number(message.body?.[2]), callback);
          return;
        }
        activeCalls++;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        const respond = () => {
          activeCalls--;
          if (failCall?.(message))
            callback({
              name: 'org.freedesktop.DBus.Error.Failed',
              message: 'private details',
            });
          else callback(null, reply(message));
        };
        if (delayReply) setTimeout(respond, 1);
        else queueMicrotask(respond);
      },
    };
  });
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
afterEach(async () => {
  for (const ui of uis) await ui.close();
  vi.useRealTimers();
});

describe('Linux AT-SPI transport at the native D-Bus seam', () => {
  it('discovers accessibility via the session bus and supplies only owned Unix streams to the SDK', async () => {
    const ui = await connect();
    expect(calls[0]).toEqual({
      destination: 'org.a11y.Bus',
      path: '/org/a11y/bus',
      interface: 'org.a11y.Bus',
      member: 'GetAddress',
    });
    expect(external.createConnection.mock.calls).toEqual([
      [{ path: '/tmp/session' }],
      [{ path: '\0atspi-test' }],
    ]);
    expect(external.createClient.mock.calls).toEqual(
      sockets.map((stream) => [{ stream, authMethods: ['EXTERNAL'] }])
    );
    expect(sockets[0]!.destroy).toHaveBeenCalledOnce();
    expect(sockets[1]!.destroy).not.toHaveBeenCalled();
    await ui.close();
    expect(sockets[1]!.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    'unixexec:path=/bin/sh,arg1=-c,arg2=bad',
    'tcp:host=example.com,port=1',
    'unix:path=/tmp/a;unixexec:path=/bin/sh',
    'unix:path=relative',
    'unix:path=/tmp/a,abstract=b',
    'unix:abstract=',
    'unix:path=/tmp/a,path=/tmp/b',
    'unix:path=/tmp/%00socket',
    'unix:path=/tmp/%zz',
    'unix:socket=/tmp/a',
    'unix:path=/tmp/a,guid=bad',
  ])(
    'rejects unsafe session address %s before touching the SDK or network',
    async (address) => {
      await expect(
        connect(10_000, { ...env, DBUS_SESSION_BUS_ADDRESS: address })
      ).rejects.toThrow('invalid_dbus_address');
      expect(external.createConnection).not.toHaveBeenCalled();
      expect(external.createClient).not.toHaveBeenCalled();
    }
  );

  it('validates the discovered accessibility address too and closes the session on failure', async () => {
    accessibilityAddress = 'unixexec:path=/tmp/evil';
    await expect(connect()).rejects.toThrow('invalid_dbus_address');
    expect(external.createConnection).toHaveBeenCalledTimes(1);
    expect(sockets[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('decodes escaped Unix paths and accepts a valid optional bus GUID', async () => {
    accessibilityAddress =
      'unix:path=/tmp/a%20b,guid=0123456789abcdef0123456789abcdef';
    await connect();
    expect(external.createConnection).toHaveBeenLastCalledWith({
      path: '/tmp/a b',
    });
  });

  it('preserves parent IDs and reading order, prunes tables, and decodes native states', async () => {
    nodes.get('/button')!.state = [(1 << 8) | (1 << 4) | (1 << 30), 0];
    const ui = await connect();
    const snapshot = await ui.snapshot();
    expect(snapshot.map((item) => item.name)).toEqual([
      'Claude',
      'Write your prompt to Claude',
      'first',
      '',
      'second',
      'Expensive table',
      'Send',
    ]);
    expect(snapshot[1]).toMatchObject({
      parentId: snapshot[0]!.id,
      enabled: true,
      visible: true,
      showing: true,
    });
    expect(snapshot[4]).toMatchObject({ parentId: snapshot[3]!.id });
    expect(snapshot[6]).toMatchObject({
      role: 'button',
      enabled: false,
      selected: true,
      visible: true,
      showing: false,
    });
    expect(
      calls.some(
        (call) => call.path === '/table' && call.member === 'GetChildren'
      )
    ).toBe(false);
    expect(calls.some((call) => call.path === '/never-read')).toBe(false);
    expect(calls.some((call) => call.member === 'Introspect')).toBe(false);
  });

  it('recognizes SELECTED separately from CHECKED', async () => {
    nodes.get('/button')!.state = [1 << 23, 0];
    const ui = await connect();
    expect(
      (await ui.snapshot()).find((item) => item.name === 'Send')!.selected
    ).toBe(true);
  });

  it.each(['claude-desktop', 'CLAUDE'])(
    'selects the exact application name %s',
    async (appName) => {
      nodes.get('/app')!.name = appName;
      const ui = await connect();
      expect((await ui.snapshot())[0]!.name).toBe(appName);
    }
  );

  it('rejects multiple Claude applications instead of picking one', async () => {
    nodes.set('/other', node('claude-desktop', 'application'));
    apps.push('/other');
    const ui = await connect();
    await expect(ui.snapshot()).rejects.toThrow('desktop_missing_or_ambiguous');
  });

  it('does not match application name substrings', async () => {
    nodes.get('/app')!.name = 'Claude settings';
    const ui = await connect();
    await expect(ui.snapshot()).rejects.toThrow('desktop_missing_or_ambiguous');
  });

  it('never treats a failed or malformed descendant read as a complete scan', async () => {
    const ui = await connect();
    const old = await entry(ui);
    failCall = (message) =>
      message.path === '/line2' && message.member === 'GetState';
    await expect(ui.snapshot()).rejects.toThrow('accessibility_dbus_error');
    await expect(ui.activate(old)).rejects.toThrow(
      'accessibility_unknown_node'
    );
    expect(calls.filter((call) => call.member === 'DoAction')).toHaveLength(0);
  });

  it.each([
    { member: 'Get', value: ['s', 'not the low-level variant ABI'] },
    { member: 'GetState', value: [1] },
    { member: 'GetState', value: [-1, 0] },
    { member: 'GetChildren', value: [['', '/org/a11y/atspi/null']] },
  ])('rejects malformed $member replies', async ({ member, value }) => {
    const ui = await connect();
    override = (message) =>
      message.path === '/app' && message.member === member
        ? { value }
        : undefined;
    await expect(ui.snapshot()).rejects.toThrow('accessibility_invalid_reply');
  });

  it('rejects defunct nodes and cycles', async () => {
    const ui = await connect();
    nodes.get('/line1')!.state = [1 << 6, 0];
    await expect(ui.snapshot()).rejects.toThrow('accessibility_node_defunct');
    nodes.get('/line1')!.state = [...normalStates];
    nodes.get('/line1')!.children = ['/app'];
    await expect(ui.snapshot()).rejects.toThrow('accessibility_tree_invalid');
  });

  it('accepts exactly 5000 nodes with bounded parallelism; rejects a 5001st node', async () => {
    const paths = Array.from({ length: 4999 }, (_, index) => `/n${index}`);
    nodes.get('/app')!.children = paths;
    for (const path of paths) nodes.set(path, node(path, 'static'));
    const ui = await connect();
    delayReply = true;
    const scan = ui.snapshot();
    await vi.runAllTimersAsync();
    expect(await scan).toHaveLength(5000);
    expect(maxActiveCalls).toBeGreaterThan(1);
    expect(maxActiveCalls).toBeLessThanOrEqual(48);
    nodes.set('/extra', node('extra', 'static'));
    paths.push('/extra');
    delayReply = false;
    await expect(ui.snapshot()).rejects.toThrow('accessibility_tree_budget');
  });

  it('reads descendant text in depth-first order and uses Text.GetText without duplicate children', async () => {
    const ui = await connect();
    const target = await entry(ui);
    expect(await ui.readText(target)).toBe('first\nsecond');
    nodes.get('/entry')!.text = 'native full text';
    calls.length = 0;
    expect(await ui.readText(target)).toBe('native full text');
    expect(calls).toEqual([
      expect.objectContaining({ member: 'GetInterfaces', path: '/entry' }),
      expect.objectContaining({
        member: 'GetText',
        interface: 'org.a11y.atspi.Text',
        signature: 'ii',
        body: [0, -1],
      }),
    ]);
  });

  it.each(['\n', 'existing draft', 'first paragraph\nsecond paragraph'])(
    'reads Chromium embedded paragraph text without discarding a draft: %j',
    async (text) => {
      nodes.get('/entry')!.text = '\ufffc';
      nodes.get('/entry')!.children = ['/paragraph'];
      nodes.set('/paragraph', { ...node('', 'paragraph'), text });
      const ui = await connect();
      expect(await ui.readText(await entry(ui))).toBe(text);
    }
  );

  it('resolves nested structural objects once and preserves paragraph order', async () => {
    nodes.get('/entry')!.text = '\ufffc\ufffc';
    nodes.get('/entry')!.children = ['/paragraph1', '/paragraph2'];
    nodes.set('/paragraph1', {
      ...node('', 'paragraph', ['/static']),
      text: '\ufffc',
    });
    nodes.set('/static', { ...node('', 'static'), text: 'first' });
    nodes.set('/paragraph2', { ...node('', 'paragraph'), text: 'second' });
    const ui = await connect();
    expect(await ui.readText(await entry(ui))).toBe('first\nsecond');
  });

  it.each([
    { text: 'literal\ufffc', children: ['/line1'], role: 'text' },
    { text: '\ufffc', children: [], role: 'text' },
    { text: '\ufffc\ufffc', children: ['/line1'], role: 'text' },
    { text: '\ufffc', children: ['/line1'], role: 'image' },
    { text: '\ufffc', children: ['/line1'], role: 'password text' },
  ])(
    'refuses ambiguous embedded content rather than treating it as empty: %j',
    async ({ text, children, role }) => {
      Object.assign(nodes.get('/entry')!, { text, children });
      Object.assign(nodes.get('/line1')!, { role, text: '' });
      const ui = await connect();
      await expect(ui.readText(await entry(ui))).rejects.toThrow(
        'accessibility_text_unavailable'
      );
    }
  );

  it('does one DoAction(0), never replays an uncertain acknowledgement, and uses native ScrollTo', async () => {
    const ui = await connect();
    const target = await entry(ui);
    await ui.reveal(target);
    expect(calls.at(-1)).toMatchObject({
      interface: 'org.a11y.atspi.Component',
      member: 'ScrollTo',
      signature: 'u',
      body: [6],
    });
    failCall = (message) => message.member === 'DoAction';
    await expect(ui.activate(target)).rejects.toThrow(
      'action_acknowledgement_uncertain'
    );
    expect(calls.filter((call) => call.member === 'DoAction')).toEqual([
      expect.objectContaining({
        interface: 'org.a11y.atspi.Action',
        signature: 'i',
        body: [0],
      }),
    ]);
  });

  it('bounds a missing reply by the deadline and closes owned sockets', async () => {
    const ui = await connect(100);
    hangCall = (message) => message.member === 'GetState';
    const assertion = expect(ui.snapshot()).rejects.toThrow(
      'accessibility_scan_timeout'
    );
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    await ui.close();
    expect(
      sockets.every((socket) => socket.destroy.mock.calls.length > 0)
    ).toBe(true);
  });

  it.each(['error', 'end', 'close'])(
    'rejects an outstanding read on socket %s',
    async (event) => {
      const ui = await connect();
      hangCall = (message) => message.path === ROOT;
      const assertion = expect(ui.snapshot()).rejects.toThrow(
        'accessibility_bus_disconnected'
      );
      sockets[1]!.emit(event, new Error('socket failure'));
      await assertion;
    }
  );

  it('handles SDK connection errors and rejects pending calls on close', async () => {
    const ui = await connect();
    hangCall = (message) => message.path === ROOT;
    const assertion = expect(ui.snapshot()).rejects.toThrow(
      'accessibility_bus_disconnected'
    );
    connections[1]!.emit('error', new Error('handshake failed'));
    await assertion;
    const other = await connect();
    const closed = expect(other.snapshot()).rejects.toThrow(
      'accessibility_bus_closed'
    );
    await other.close();
    await closed;
  });
});

describe('real dbus-native wire ABI', () => {
  it('authenticates and reads variants, structs, state words and text over an actual Unix socket', async () => {
    vi.useRealTimers();
    const net = await vi.importActual<typeof Net>('node:net');
    const sdk = await vi.importActual<{
      default: { createClient(options: unknown): unknown };
    }>('@homebridge/dbus-native');
    external.createConnection.mockImplementation(net.createConnection);
    external.createClient.mockImplementation(sdk.default.createClient);
    const load = createRequire(import.meta.url);
    // This test pins the 0.7.9 wire ABI independently of the invoke seam fixtures.
    const loaded: unknown = load('@homebridge/dbus-native/lib/message.js');
    const wire = loaded as {
      marshall(message: object): Buffer;
      unmarshalMessages(
        stream: PassThrough,
        receive: (message: Message & { serial: number }) => void
      ): void;
    };
    const directory = await mkdtemp(join(tmpdir(), 'mst-atspi-wire-'));
    const path = join(directory, 'bus');
    const peers = new Set<Socket>();
    let serial = 1;
    const received: Message[] = [];
    const server = net.createServer((socket) => {
      peers.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => peers.delete(socket));
      const input = new PassThrough();
      wire.unmarshalMessages(input, (message) => {
        received.push(message);
        let signature: string;
        let value: unknown;
        if (message.member === 'Hello') {
          signature = 's';
          value = ':1.99';
        } else if (message.member === 'GetAddress') {
          signature = 's';
          value = `unix:path=${path}`;
        } else {
          const signatures: Record<string, string> = {
            Get: 'v',
            GetChildren: 'a(so)',
            GetRoleName: 's',
            GetState: 'au',
            GetInterfaces: 'as',
            GetText: 's',
            DoAction: 'b',
            ScrollTo: 'b',
          };
          signature = signatures[message.member]!;
          value =
            message.member === 'Get'
              ? ['s', nodes.get(message.path)!.name]
              : reply(message);
        }
        socket.write(
          wire.marshall({
            type: 2,
            serial: serial++,
            replySerial: message.serial,
            signature,
            body: [value],
          })
        );
      });
      let bytes = Buffer.alloc(0);
      let binary = false;
      socket.on('data', (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        while (!binary) {
          const end = bytes.indexOf('\r\n');
          if (end < 0) return;
          const line = bytes.subarray(0, end).toString();
          bytes = bytes.subarray(end + 2);
          if (line.includes('AUTH EXTERNAL'))
            socket.write('OK 0123456789abcdef0123456789abcdef\r\n');
          else if (line === 'BEGIN') binary = true;
          else throw new Error(`Unexpected auth: ${line}`);
        }
        input.write(bytes);
        bytes = Buffer.alloc(0);
      });
    });
    let ui: LinuxUi | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
      });
      ui = await connect(5000, {
        ...env,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${path}`,
      });
      const target = await entry(ui);
      expect(target.name).toBe('Write your prompt to Claude');
      expect(target.enabled).toBe(true);
      nodes.get('/entry')!.text = 'real wire text 日本語';
      expect(await ui.readText(target)).toBe('real wire text 日本語');
      await ui.activate(target);
      expect(
        received.filter((message) => message.member === 'Hello')
      ).toHaveLength(2);
      expect(
        received.find((message) => message.member === 'DoAction')
      ).toMatchObject({ signature: 'i', body: [0] });
    } finally {
      await ui?.close();
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('clipboard and URL process seam', () => {
  it('writes the full prompt to xclip, focuses once, pastes once, unlocks, and retains ownership until close', async () => {
    const ui = await connect();
    const target = await entry(ui);
    const text = 'Unicode 日本語\n$HOME; $(not a command)';
    const paste = ui.paste(target, text);
    await vi.advanceTimersByTimeAsync(500);
    await paste;
    expect(external.spawn).toHaveBeenCalledExactlyOnceWith(
      'xclip',
      ['-selection', 'clipboard', '-quiet'],
      {
        env,
        shell: false,
        stdio: ['pipe', 'ignore', 'ignore'],
      }
    );
    expect(children[0]!.input).toBe(text);
    expect(calls.filter((call) => call.member === 'GrabFocus')).toHaveLength(1);
    expect(
      keyboardCalls().map((call) => ({
        signature: call.signature,
        body: call.body,
      }))
    ).toEqual([
      { signature: 'isu', body: [4, '', 5] },
      { signature: 'isu', body: [0x76, '', 3] },
      { signature: 'isu', body: [4, '', 6] },
    ]);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await ui.close();
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it.each([5, 3])(
    'always unlocks after uncertain keyboard event type %i and never replays',
    async (type) => {
      const ui = await connect();
      const target = await entry(ui);
      failCall = (message) =>
        message.member === 'GenerateKeyboardEvent' &&
        message.body?.[2] === type;
      const assertion = expect(ui.paste(target, 'hello')).rejects.toThrow(
        'accessibility_dbus_error'
      );
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
      expect(keyboardCalls().map((call) => call.body?.[2])).toEqual(
        type === 5 ? [5, 6] : [5, 3, 6]
      );
      expect(children[0]!.kill).toHaveBeenCalledOnce();
    }
  );

  it('attempts one bounded unlock even if the lock acknowledgement times out', async () => {
    const ui = await connect(600);
    const target = await entry(ui);
    hangCall = (message) =>
      message.member === 'GenerateKeyboardEvent' && message.body?.[2] === 5;
    const assertion = expect(ui.paste(target, 'hello')).rejects.toThrow(
      'deadline_exceeded'
    );
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(keyboardCalls().map((call) => call.body?.[2])).toEqual([5, 6]);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it('shares one unlock with shutdown and never pastes after a late pre-deadline lock reply', async () => {
    const ui = await connect();
    const target = await entry(ui);
    hangCall = (message) => message.member === 'GenerateKeyboardEvent';
    const assertion = expect(ui.paste(target, 'hello')).rejects.toThrow(
      'accessibility_bus_closed'
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(keyboardCalls().map((call) => call.body?.[2])).toEqual([5]);
    const closing = ui.close();
    expect(ui.close()).toBe(closing);
    expect(keyboardCalls().map((call) => call.body?.[2])).toEqual([5, 6]);
    expect(sockets[1]!.destroy).not.toHaveBeenCalled();
    heldKeyboardReplies.get(5)!(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(keyboardCalls().map((call) => call.body?.[2])).toEqual([5, 6]);
    heldKeyboardReplies.get(6)!(null);
    await closing;
    await assertion;
    expect(sockets[1]!.destroy).toHaveBeenCalledOnce();
  });

  it('does not restart the one-second budget when shutdown joins an existing unlock', async () => {
    const ui = await connect();
    const target = await entry(ui);
    failCall = (message) =>
      message.member === 'GenerateKeyboardEvent' && message.body?.[2] === 5;
    hangCall = (message) =>
      message.member === 'GenerateKeyboardEvent' && message.body?.[2] === 6;
    const assertion = expect(ui.paste(target, 'hello')).rejects.toThrow(
      'deadline_exceeded'
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(keyboardCalls().map((call) => call.body?.[2])).toEqual([5, 6]);
    await vi.advanceTimersByTimeAsync(250);
    const closing = ui.close();
    await vi.advanceTimersByTimeAsync(749);
    expect(sockets[1]!.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    await assertion;
    expect(sockets[1]!.destroy).toHaveBeenCalledOnce();
    expect(keyboardCalls().map((call) => call.body?.[2])).toEqual([5, 6]);
  });

  it('does not send keys when focus fails', async () => {
    const ui = await connect();
    const target = await entry(ui);
    override = (message) =>
      message.member === 'GrabFocus' ? { value: false } : undefined;
    const assertion = expect(ui.paste(target, 'hello')).rejects.toThrow(
      'composer_not_focused'
    );
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(keyboardCalls()).toHaveLength(0);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it('surfaces clipboard spawn errors and cleans up without sending input', async () => {
    const ui = await connect();
    const target = await entry(ui);
    const assertion = expect(ui.paste(target, 'hello')).rejects.toThrow(
      'clipboard_unavailable'
    );
    children[0]!.emit('error', new Error('ENOENT'));
    await assertion;
    expect(keyboardCalls()).toHaveLength(0);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it('opens only the fixed Cowork URL without a shell and bounds the child', async () => {
    const custom = { ...env, MST_COWORK_URL_OPENER: '/prepared/open-url' };
    const ui = await connect(10_000, custom);
    await ui.openCowork();
    expect(external.execFile).toHaveBeenCalledWith(
      '/prepared/open-url',
      ['claude://cowork/new'],
      {
        env: custom,
        shell: false,
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
      expect.any(Function)
    );
  });

  it('uses xdg-open by default and rejects relative configured openers', async () => {
    const ui = await connect();
    await ui.openCowork();
    expect(external.execFile.mock.calls[0]!.slice(0, 2)).toEqual([
      'xdg-open',
      ['claude://cowork/new'],
    ]);
    const invalid = await connect(10_000, {
      ...env,
      MST_COWORK_URL_OPENER: 'sh -c evil',
    });
    await expect(invalid.openCowork()).rejects.toThrow('invalid_url_opener');
    expect(external.execFile).toHaveBeenCalledTimes(1);
  });
});
