import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { LinuxUiError, type LinuxUi, type LinuxUiNode } from './linuxUi.js';

const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const COMPONENT = 'org.a11y.atspi.Component';
const TEXT = 'org.a11y.atspi.Text';
const REGISTRY = 'org.a11y.atspi.Registry';
const ROOT = '/org/a11y/atspi/accessible/root';
const MAX_NODES = 5000;
const CONCURRENCY = 16;
const SKIPPED_ROLES = new Set(['table', 'tree table']);
const TEXT_ROLES = new Set(['static', 'text', 'label', 'paragraph', 'heading']);

type Reference = { destination: string; path: string };
type Message = Reference & {
  interface: string;
  member: string;
  signature?: string;
  body?: readonly unknown[];
};

// 0.7.9 exports createClient at runtime but omits it from its declarations.
// Keep the untyped SDK boundary here, not in the AT-SPI implementation.
interface NativeBus {
  connection: { on(event: string, listener: () => void): unknown };
  invoke(
    message: Message,
    callback: (error: unknown, value?: unknown) => void
  ): void;
}
interface NativeDbus {
  createClient(options: { stream: Socket; authMethods: string[] }): NativeBus;
}
async function nativeDbus(): Promise<NativeDbus> {
  const imported: unknown = await import('@homebridge/dbus-native');
  const candidate = imported as { default?: unknown; createClient?: unknown };
  const sdk = (candidate.default ?? candidate) as Partial<NativeDbus>;
  if (typeof sdk.createClient !== 'function')
    throw new LinuxUiError('accessibility_dbus_unavailable');
  return sdk as NativeDbus;
}

/** No SDK address parsing: in particular, unixexec must never reach createClient. */
function unixSocketPath(address: string | undefined): string {
  if (!address || address.length > 4096 || !address.startsWith('unix:'))
    throw new LinuxUiError('invalid_dbus_address');
  const fields = new Map<string, string>();
  for (const field of address.slice(5).split(',')) {
    const match = /^(path|abstract|guid)=([^;=]*)$/.exec(field);
    if (!match || fields.has(match[1]!))
      throw new LinuxUiError('invalid_dbus_address');
    let value: string;
    try {
      value = decodeURIComponent(match[2]!);
    } catch {
      throw new LinuxUiError('invalid_dbus_address');
    }
    if (
      !value ||
      [...value].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      )
    )
      throw new LinuxUiError('invalid_dbus_address');
    fields.set(match[1]!, value);
  }
  const path = fields.get('path');
  const abstract = fields.get('abstract');
  if (Boolean(path) === Boolean(abstract) || (path && !isAbsolute(path)))
    throw new LinuxUiError('invalid_dbus_address');
  const guid = fields.get('guid');
  if (guid && !/^[a-fA-F0-9]{32}$/.test(guid))
    throw new LinuxUiError('invalid_dbus_address');
  return path ?? `\0${abstract!}`;
}

class Bus {
  private readonly socket: Socket;
  private readonly native: NativeBus;
  private failure?: LinuxUiError;
  private readonly pending = new Set<(error: LinuxUiError) => void>();

  constructor(
    sdk: NativeDbus,
    address: string | undefined,
    private readonly deadlineAt: number
  ) {
    remaining(deadlineAt);
    this.socket = createConnection({ path: unixSocketPath(address) });
    const failed = () =>
      this.fail(new LinuxUiError('accessibility_bus_disconnected'));
    this.socket.on('error', failed);
    this.socket.on('close', failed);
    this.socket.on('end', failed);
    try {
      this.native = sdk.createClient({
        stream: this.socket,
        authMethods: ['EXTERNAL'],
      });
      this.native.connection.on('error', failed);
      this.native.connection.on('end', failed);
    } catch {
      this.socket.destroy();
      throw new LinuxUiError('accessibility_dbus_unavailable');
    }
  }

  private fail(error: LinuxUiError): void {
    this.failure ??= error;
    for (const reject of this.pending) reject(this.failure);
  }

  async call(message: Message, cleanup = false): Promise<unknown> {
    if (this.failure) throw this.failure;
    // A modifier unlock is cleanup, not a replay. Give it one bounded chance
    // even when the input call exhausted the operation's deadline.
    const timeout = cleanup ? 1000 : remaining(this.deadlineAt);
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, value?: unknown) => {
        clearTimeout(timer);
        this.pending.delete(fail);
        if (error) reject(error);
        else resolve(value);
      };
      const fail = (error: LinuxUiError) => finish(error);
      const timer = setTimeout(
        () => fail(new LinuxUiError('deadline_exceeded')),
        timeout
      );
      this.pending.add(fail);
      try {
        this.native.invoke(message, (error, value) => {
          finish(
            error ? new LinuxUiError('accessibility_dbus_error') : null,
            value
          );
        });
      } catch {
        finish(new LinuxUiError('accessibility_dbus_error'));
      }
    });
  }

  close(): void {
    this.fail(new LinuxUiError('accessibility_bus_closed'));
    this.socket.destroy();
  }
}

function remaining(deadlineAt: number): number {
  const ms = deadlineAt - Date.now();
  if (!Number.isFinite(ms) || ms <= 0)
    throw new LinuxUiError('deadline_exceeded');
  return Math.min(ms, 2_147_483_647);
}

function string(value: unknown): string {
  if (typeof value !== 'string')
    throw new LinuxUiError('accessibility_invalid_reply');
  return value;
}

function references(value: unknown): Reference[] {
  if (!Array.isArray(value))
    throw new LinuxUiError('accessibility_invalid_reply');
  if (value.length > MAX_NODES)
    throw new LinuxUiError('accessibility_tree_budget');
  return value.map((item: unknown) => {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== 'string' ||
      !/^:[0-9]+\.[0-9]+$/.test(item[0]) ||
      typeof item[1] !== 'string' ||
      !/^\/(?:[A-Za-z0-9_]+\/?)*$/.test(item[1]) ||
      item[1] === '/org/a11y/atspi/null'
    )
      throw new LinuxUiError('accessibility_invalid_reply');
    return { destination: item[0], path: item[1] };
  });
}

function id(ref: Reference): string {
  return JSON.stringify([ref.destination, ref.path]);
}

async function name(bus: Bus, ref: Reference): Promise<string> {
  const value = await bus.call({
    ...ref,
    interface: 'org.freedesktop.DBus.Properties',
    member: 'Get',
    signature: 'ss',
    body: [ACCESSIBLE, 'Name'],
  });
  // dbus-native's low-level variant is [signature AST, array of values], not
  // the ['s', value] form accepted by its marshaller or the proxy's bare value.
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Array.isArray(value[0]) ||
    value[0].length !== 1 ||
    (value[0][0] as { type?: unknown } | undefined)?.type !== 's' ||
    !Array.isArray(value[1]) ||
    value[1].length !== 1
  )
    throw new LinuxUiError('accessibility_invalid_reply');
  return string(value[1][0]);
}

async function children(bus: Bus, ref: Reference): Promise<Reference[]> {
  return references(
    await bus.call({ ...ref, interface: ACCESSIBLE, member: 'GetChildren' })
  );
}

async function boundedMap<T, R>(
  items: readonly T[],
  visit: (item: T) => Promise<R>
): Promise<R[]> {
  const output: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    output.push(
      ...(await Promise.all(items.slice(i, i + CONCURRENCY).map(visit)))
    );
  }
  return output;
}

function states(value: unknown): (bit: number) => boolean {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(
      (word: unknown) =>
        typeof word === 'number' &&
        Number.isInteger(word) &&
        word >= 0 &&
        word <= 0xffffffff
    )
  )
    throw new LinuxUiError('accessibility_invalid_reply');
  const words = value as number[];
  if ((words[0]! & (1 << 6)) !== 0)
    throw new LinuxUiError('accessibility_node_defunct');
  return (bit) => (words[Math.floor(bit / 32)]! & (1 << (bit % 32))) !== 0;
}

interface TreeItem {
  ref: Reference;
  parentId?: string;
}
interface Visited<T> {
  value: T;
  children: Reference[];
}

/** Bounded parallel fetch, then depth-first order independent of reply timing. */
async function walk<T>(
  root: Reference,
  visit: (item: TreeItem) => Promise<Visited<T>>
): Promise<T[]> {
  const queue: TreeItem[] = [{ ref: root }];
  const seen = new Set([id(root)]);
  const records = new Map<string, Visited<T>>();
  for (let offset = 0; offset < queue.length; ) {
    const batch = queue.slice(offset, offset + CONCURRENCY);
    offset += batch.length;
    const results = await Promise.all(batch.map(visit));
    for (let index = 0; index < batch.length; index++) {
      const parentId = id(batch[index]!.ref);
      const result = results[index]!;
      records.set(parentId, result);
      for (const ref of result.children) {
        const childId = id(ref);
        if (seen.has(childId))
          throw new LinuxUiError('accessibility_tree_invalid');
        if (seen.size >= MAX_NODES)
          throw new LinuxUiError('accessibility_tree_budget');
        seen.add(childId);
        queue.push({ ref, parentId });
      }
    }
  }
  const output: T[] = [];
  const pending = [root];
  while (pending.length) {
    const record = records.get(id(pending.pop()!))!;
    output.push(record.value);
    pending.push(...record.children.slice().reverse());
  }
  return output;
}

/** Native AT-SPI primitives only. No account, readiness, permission or retry policy. */
export async function connectLinuxUi(
  env: Record<string, string | undefined>,
  deadlineAt: number
): Promise<LinuxUi> {
  remaining(deadlineAt);
  // Validate before loading the SDK as well as before opening each socket.
  unixSocketPath(env.DBUS_SESSION_BUS_ADDRESS);
  const sdk = await nativeDbus();
  const session = new Bus(sdk, env.DBUS_SESSION_BUS_ADDRESS, deadlineAt);
  let address: string;
  try {
    address = string(
      await session.call({
        destination: 'org.a11y.Bus',
        path: '/org/a11y/bus',
        interface: 'org.a11y.Bus',
        member: 'GetAddress',
      })
    );
  } finally {
    session.close();
  }
  const bus = new Bus(sdk, address, deadlineAt);
  const processes = new Set<ChildProcess>();
  let known = new Map<string, Reference>();
  let clipboard: ChildProcess | undefined;
  let closed = false;

  function check(): void {
    if (closed) throw new LinuxUiError('accessibility_bus_closed');
    remaining(deadlineAt);
  }
  function reference(node: LinuxUiNode): Reference {
    check();
    const ref = known.get(node.id);
    if (!ref) throw new LinuxUiError('accessibility_unknown_node');
    return ref;
  }
  function stop(child: ChildProcess): void {
    processes.delete(child);
    child.kill('SIGKILL');
  }
  async function keyboard(
    key: number,
    type: number,
    cleanup = false
  ): Promise<void> {
    await bus.call(
      {
        destination: REGISTRY,
        path: '/org/a11y/atspi/registry/deviceeventcontroller',
        interface: 'org.a11y.atspi.DeviceEventController',
        member: 'GenerateKeyboardEvent',
        signature: 'isu',
        body: [key, '', type],
      },
      cleanup
    );
  }
  async function startClipboard(text: string): Promise<ChildProcess> {
    check();
    if (clipboard) stop(clipboard);
    const child = spawn('xclip', ['-selection', 'clipboard', '-quiet'], {
      env,
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    processes.add(child);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let settle: ReturnType<typeof setTimeout> | undefined;
        const deadline = setTimeout(
          () => finish(new LinuxUiError('deadline_exceeded')),
          remaining(deadlineAt)
        );
        function finish(error?: Error): void {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          clearTimeout(settle);
          if (error) reject(error);
          else resolve();
        }
        child.on('error', () =>
          finish(new LinuxUiError('clipboard_unavailable'))
        );
        child.on('exit', () =>
          finish(new LinuxUiError('clipboard_unavailable'))
        );
        child.stdin.on('error', () =>
          finish(new LinuxUiError('clipboard_unavailable'))
        );
        child.stdin.end(text, 'utf8', () => {
          if (settled) return;
          // xclip has no ownership-ready acknowledgement. Match the native
          // driver's bounded settling time; never retry or synthesize typing.
          settle = setTimeout(() => finish(), 500);
        });
      });
      clipboard = child;
      return child;
    } catch (error) {
      stop(child);
      throw error;
    }
  }

  return {
    async snapshot() {
      known.clear();
      try {
        check();
        const apps = await children(bus, { destination: REGISTRY, path: ROOT });
        const names = await boundedMap(apps, async (ref) => ({
          ref,
          name: await name(bus, ref),
        }));
        const matches = names.filter((app) =>
          ['claude', 'claude-desktop'].includes(app.name.toLowerCase())
        );
        if (matches.length !== 1)
          throw new LinuxUiError('desktop_missing_or_ambiguous');
        const refs = new Map<string, Reference>();
        const nodes = await walk(matches[0]!.ref, async ({ ref, parentId }) => {
          const role = string(
            await bus.call({
              ...ref,
              interface: ACCESSIBLE,
              member: 'GetRoleName',
            })
          );
          const [label, state, descendants] = await Promise.all([
            name(bus, ref),
            bus.call({ ...ref, interface: ACCESSIBLE, member: 'GetState' }),
            SKIPPED_ROLES.has(role) ? Promise.resolve([]) : children(bus, ref),
          ]);
          const has = states(state);
          refs.set(id(ref), ref);
          return {
            value: {
              id: id(ref),
              ...(parentId ? { parentId } : {}),
              name: label,
              // Older AT-SPI bridges call the same native button role "push button".
              role: role === 'push button' ? 'button' : role,
              visible: has(30),
              showing: has(25),
              enabled: has(8) && has(24),
              selected: has(4) || has(23),
            },
            children: descendants,
          };
        });
        known = refs;
        return nodes;
      } catch (error) {
        known.clear();
        if (error instanceof LinuxUiError && error.code === 'deadline_exceeded')
          throw new LinuxUiError('accessibility_scan_timeout');
        throw error;
      }
    },
    async readText(node) {
      const root = reference(node);
      const pieces = await walk(root, async ({ ref }) => {
        const interfaces = await bus.call({
          ...ref,
          interface: ACCESSIBLE,
          member: 'GetInterfaces',
        });
        if (
          !Array.isArray(interfaces) ||
          !interfaces.every((entry: unknown) => typeof entry === 'string')
        )
          throw new LinuxUiError('accessibility_invalid_reply');
        if (interfaces.includes(TEXT)) {
          const text = string(
            await bus.call({
              ...ref,
              interface: TEXT,
              member: 'GetText',
              signature: 'ii',
              body: [0, -1],
            })
          );
          return { value: text, children: [] };
        }
        const role = string(
          await bus.call({
            ...ref,
            interface: ACCESSIBLE,
            member: 'GetRoleName',
          })
        );
        return {
          value: TEXT_ROLES.has(role) ? await name(bus, ref) : '',
          children: SKIPPED_ROLES.has(role) ? [] : await children(bus, ref),
        };
      });
      return pieces.filter(Boolean).join('\n');
    },
    async activate(node) {
      const ref = reference(node);
      try {
        const accepted = await bus.call({
          ...ref,
          interface: 'org.a11y.atspi.Action',
          member: 'DoAction',
          signature: 'i',
          body: [0],
        });
        if (accepted !== true)
          throw new LinuxUiError('action_acknowledgement_uncertain');
      } catch {
        throw new LinuxUiError('action_acknowledgement_uncertain');
      }
    },
    async reveal(node) {
      const accepted = await bus.call({
        ...reference(node),
        interface: COMPONENT,
        member: 'ScrollTo',
        signature: 'u',
        body: [6],
      });
      if (accepted !== true) throw new LinuxUiError('reveal_failed');
    },
    async paste(node, text) {
      const ref = reference(node);
      const child = await startClipboard(text);
      try {
        const focused = await bus.call({
          ...ref,
          interface: COMPONENT,
          member: 'GrabFocus',
        });
        if (focused !== true) throw new LinuxUiError('composer_not_focused');
        if (child.exitCode !== null || child.signalCode !== null)
          throw new LinuxUiError('clipboard_unavailable');
        try {
          await keyboard(1 << 2, 5); // LOCKMODIFIERS, Control
          await keyboard(0x76, 3); // SYM, v — exactly one paste
        } finally {
          await keyboard(1 << 2, 6, true); // UNLOCKMODIFIERS, even after an uncertain lock
        }
        // Keep selection ownership until close: the application may consume it
        // after the key-event reply. The driver verifies the resulting text.
      } catch (error) {
        stop(child);
        throw error;
      }
    },
    async openCowork() {
      check();
      const opener = env.MST_COWORK_URL_OPENER;
      if (opener !== undefined && !isAbsolute(opener))
        throw new LinuxUiError('invalid_url_opener');
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          opener ?? 'xdg-open',
          ['claude://cowork/new'],
          {
            env,
            shell: false,
            timeout: Math.min(15_000, remaining(deadlineAt)),
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024,
          },
          (error) => {
            processes.delete(child);
            if (error) reject(new LinuxUiError('open_cowork_failed'));
            else resolve();
          }
        );
        processes.add(child);
      });
    },
    close() {
      closed = true;
      bus.close();
      for (const child of processes) stop(child);
      known.clear();
    },
  };
}
