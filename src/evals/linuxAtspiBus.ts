/**
 * AT-SPI over D-Bus, the transport MST's Linux desktop drivers share.
 *
 * AT-SPI is a D-Bus protocol, so the drivers talk to it directly with
 * `@homebridge/dbus-native`; no native binding or GObject layer is involved
 * (ADR 0006). This module holds only transport and typed primitive reads.
 * Which application to read, what counts as ready and every action policy
 * stay in the drivers.
 */
import { createConnection, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';

const ATSPI_ACCESSIBLE = 'org.a11y.atspi.Accessible';
export const ATSPI_ACTION = 'org.a11y.atspi.Action';
export const ATSPI_COMPONENT = 'org.a11y.atspi.Component';
export const ATSPI_TEXT = 'org.a11y.atspi.Text';
const ATSPI_HYPERTEXT = 'org.a11y.atspi.Hypertext';
const ATSPI_HYPERLINK = 'org.a11y.atspi.Hyperlink';
export const ATSPI_EDITABLE_TEXT = 'org.a11y.atspi.EditableText';
export const ATSPI_REGISTRY = 'org.a11y.atspi.Registry';
const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

/** AT-SPI state bits (AtspiStateType). */
export const ATSPI_STATE = {
  checked: 4,
  defunct: 6,
  editable: 7,
  enabled: 8,
  selected: 23,
  sensitive: 24,
  showing: 25,
  visible: 30,
} as const;

/** AT-SPI coordinate types (AtspiCoordType). */
export const ATSPI_COORDS = { screen: 0, window: 1 } as const;

const ATSPI_MAX_NODES = 5000;
const CONCURRENCY = 16;

/** A failure with a stable, allowlistable code and no native detail. */
export class AtspiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'LinuxUiError';
  }
}

export type AtspiRef = { destination: string; path: string };
export type AtspiMessage = AtspiRef & {
  interface: string;
  member: string;
  signature?: string;
  body?: readonly unknown[];
};
export type AtspiStates = (bit: number) => boolean;
export interface AtspiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 0.7.9 exports createClient at runtime but omits it from its declarations.
// Keep the untyped SDK boundary here, not in the drivers.
interface NativeBus {
  connection: { on(event: string, listener: () => void): unknown };
  invoke(
    message: AtspiMessage,
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
    throw new AtspiError('accessibility_dbus_unavailable');
  return sdk as NativeDbus;
}

/** No SDK address parsing: in particular, unixexec must never reach createClient. */
function unixSocketPath(address: string | undefined): string {
  if (!address || address.length > 4096 || !address.startsWith('unix:'))
    throw new AtspiError('invalid_dbus_address');
  const fields = new Map<string, string>();
  for (const field of address.slice(5).split(',')) {
    const match = /^(path|abstract|guid)=([^;=]*)$/.exec(field);
    if (!match || fields.has(match[1]!))
      throw new AtspiError('invalid_dbus_address');
    let value: string;
    try {
      value = decodeURIComponent(match[2]!);
    } catch {
      throw new AtspiError('invalid_dbus_address');
    }
    if (
      !value ||
      [...value].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      )
    )
      throw new AtspiError('invalid_dbus_address');
    fields.set(match[1]!, value);
  }
  const path = fields.get('path');
  const abstract = fields.get('abstract');
  if (Boolean(path) === Boolean(abstract) || (path && !isAbsolute(path)))
    throw new AtspiError('invalid_dbus_address');
  const guid = fields.get('guid');
  if (guid && !/^[a-fA-F0-9]{32}$/.test(guid))
    throw new AtspiError('invalid_dbus_address');
  return path ?? `\0${abstract!}`;
}

/** Milliseconds left before `deadlineAt`; throws `deadline_exceeded` at zero. */
export function remainingMs(deadlineAt: number): number {
  const ms = deadlineAt - Date.now();
  if (!Number.isFinite(ms) || ms <= 0)
    throw new AtspiError('deadline_exceeded');
  return Math.min(ms, 2_147_483_647);
}

class Connection {
  private readonly socket: Socket;
  private readonly native: NativeBus;
  private failure?: AtspiError;
  private readonly pending = new Set<(error: AtspiError) => void>();

  constructor(
    sdk: NativeDbus,
    address: string | undefined,
    private readonly deadlineAt: number
  ) {
    remainingMs(deadlineAt);
    this.socket = createConnection({ path: unixSocketPath(address) });
    const failed = () =>
      this.fail(new AtspiError('accessibility_bus_disconnected'));
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
      throw new AtspiError('accessibility_dbus_unavailable');
    }
  }

  private fail(error: AtspiError): void {
    this.failure ??= error;
    for (const reject of this.pending) reject(this.failure);
  }

  async call(message: AtspiMessage, cleanup = false): Promise<unknown> {
    if (this.failure) throw this.failure;
    // A modifier unlock is cleanup, not a replay. Give it one bounded chance
    // even when the input call exhausted the operation's deadline.
    const timeout = cleanup ? 1000 : remainingMs(this.deadlineAt);
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, value?: unknown) => {
        clearTimeout(timer);
        this.pending.delete(fail);
        if (error) reject(error);
        else resolve(value);
      };
      const fail = (error: AtspiError) => finish(error);
      const timer = setTimeout(
        () => fail(new AtspiError('deadline_exceeded')),
        timeout
      );
      this.pending.add(fail);
      try {
        this.native.invoke(message, (error, value) => {
          finish(
            error ? new AtspiError('accessibility_dbus_error') : null,
            value
          );
        });
      } catch {
        finish(new AtspiError('accessibility_dbus_error'));
      }
    });
  }

  close(): void {
    this.fail(new AtspiError('accessibility_bus_closed'));
    this.socket.destroy();
  }
}

function invalid(): AtspiError {
  return new AtspiError('accessibility_invalid_reply');
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw invalid();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function reference(item: unknown): AtspiRef {
  if (
    !Array.isArray(item) ||
    item.length !== 2 ||
    typeof item[0] !== 'string' ||
    !/^:[0-9]+\.[0-9]+$/.test(item[0]) ||
    typeof item[1] !== 'string' ||
    !/^\/(?:[A-Za-z0-9_]+\/?)*$/.test(item[1]) ||
    item[1] === ATSPI_NULL_PATH
  )
    throw invalid();
  return { destination: item[0], path: item[1] };
}

const ATSPI_NULL_PATH = '/org/a11y/atspi/null';

/**
 * A child list. AT-SPI sends the null reference for a child it can't produce
 * (at-spi2-atk's spi_object_append_null_reference); libatspi, and so the
 * Python drivers this replaced, skipped it, and so does this. Anything else
 * malformed still fails the read.
 */
function childReferences(value: unknown): AtspiRef[] {
  if (!Array.isArray(value)) throw invalid();
  if (value.length > ATSPI_MAX_NODES)
    throw new AtspiError('accessibility_tree_budget');
  return value
    .filter(
      (item) =>
        !(
          Array.isArray(item) &&
          item.length === 2 &&
          typeof item[0] === 'string' &&
          item[1] === ATSPI_NULL_PATH
        )
    )
    .map(reference);
}

/** dbus-native's low-level variant: [signature AST, array of values]. */
function variant(value: unknown, type: string): unknown {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Array.isArray(value[0]) ||
    value[0].length !== 1 ||
    (value[0][0] as { type?: unknown } | undefined)?.type !== type ||
    !Array.isArray(value[1]) ||
    value[1].length !== 1
  )
    throw invalid();
  return value[1][0];
}

function states(value: unknown): AtspiStates {
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
    throw invalid();
  const words = value as number[];
  if ((words[0]! & (1 << ATSPI_STATE.defunct)) !== 0)
    throw new AtspiError('accessibility_node_defunct');
  return (bit) => (words[Math.floor(bit / 32)]! & (1 << (bit % 32))) !== 0;
}

/** A stable ID for a node within one bus connection. */
export function atspiId(ref: AtspiRef): string {
  return JSON.stringify([ref.destination, ref.path]);
}

/** The typed AT-SPI reads and calls the drivers use. */
export class AtspiBus {
  constructor(private readonly connection: Connection) {}

  call(message: AtspiMessage, cleanup = false): Promise<unknown> {
    return this.connection.call(message, cleanup);
  }

  private async property(
    ref: AtspiRef,
    iface: string,
    name: string,
    type: string
  ): Promise<unknown> {
    return variant(
      await this.call({
        ...ref,
        interface: PROPERTIES,
        member: 'Get',
        signature: 'ss',
        body: [iface, name],
      }),
      type
    );
  }

  /** The desktop's applications, with their accessible names. */
  async applications(): Promise<{ ref: AtspiRef; name: string }[]> {
    const apps = await this.children({
      destination: ATSPI_REGISTRY,
      path: ROOT_PATH,
    });
    return boundedMap(apps, async (ref) => ({
      ref,
      name: await this.name(ref),
    }));
  }

  async name(ref: AtspiRef): Promise<string> {
    return string(await this.property(ref, ATSPI_ACCESSIBLE, 'Name', 's'));
  }

  async children(ref: AtspiRef): Promise<AtspiRef[]> {
    return childReferences(
      await this.call({
        ...ref,
        interface: ATSPI_ACCESSIBLE,
        member: 'GetChildren',
      })
    );
  }

  /** The role name. Older bridges call the native button role "push button". */
  async role(ref: AtspiRef): Promise<string> {
    const role = string(
      await this.call({
        ...ref,
        interface: ATSPI_ACCESSIBLE,
        member: 'GetRoleName',
      })
    );
    return role === 'push button' ? 'button' : role;
  }

  /** The state set. A defunct node is an error, never a state. */
  async states(ref: AtspiRef): Promise<AtspiStates> {
    return states(
      await this.call({
        ...ref,
        interface: ATSPI_ACCESSIBLE,
        member: 'GetState',
      })
    );
  }

  /** Full D-Bus interface names, such as `org.a11y.atspi.Text`. */
  async interfaces(ref: AtspiRef): Promise<string[]> {
    const value = await this.call({
      ...ref,
      interface: ATSPI_ACCESSIBLE,
      member: 'GetInterfaces',
    });
    if (
      !Array.isArray(value) ||
      !value.every((entry: unknown) => typeof entry === 'string')
    )
      throw invalid();
    return value;
  }

  /** Text between two character offsets; `end` -1 reads to the end. */
  async text(ref: AtspiRef, start: number, end: number): Promise<string> {
    return string(
      await this.call({
        ...ref,
        interface: ATSPI_TEXT,
        member: 'GetText',
        signature: 'ii',
        body: [start, end],
      })
    );
  }

  async characterCount(ref: AtspiRef): Promise<number> {
    return integer(await this.property(ref, ATSPI_TEXT, 'CharacterCount', 'i'));
  }

  /** The hyperlink index at a character offset, or -1. */
  async linkIndex(ref: AtspiRef, offset: number): Promise<number> {
    return integer(
      await this.call({
        ...ref,
        interface: ATSPI_HYPERTEXT,
        member: 'GetLinkIndex',
        signature: 'i',
        body: [offset],
      })
    );
  }

  async link(ref: AtspiRef, index: number): Promise<AtspiRef> {
    return reference(
      await this.call({
        ...ref,
        interface: ATSPI_HYPERTEXT,
        member: 'GetLink',
        signature: 'i',
        body: [index],
      })
    );
  }

  async anchorCount(link: AtspiRef): Promise<number> {
    return integer(await this.property(link, ATSPI_HYPERLINK, 'NAnchors', 'n'));
  }

  async linkObject(link: AtspiRef, index: number): Promise<AtspiRef> {
    return reference(
      await this.call({
        ...link,
        interface: ATSPI_HYPERLINK,
        member: 'GetObject',
        signature: 'i',
        body: [index],
      })
    );
  }

  /** The node's action names, in index order. */
  async actionNames(ref: AtspiRef): Promise<string[]> {
    const value = await this.call({
      ...ref,
      interface: ATSPI_ACTION,
      member: 'GetActions',
    });
    if (!Array.isArray(value) || value.length > 64) throw invalid();
    return value.map((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length !== 3) throw invalid();
      return string(entry[0]);
    });
  }

  /** One DoAction. Its reply is the app's acknowledgement, never retried. */
  async doAction(ref: AtspiRef, index: number): Promise<boolean> {
    return boolean(
      await this.call({
        ...ref,
        interface: ATSPI_ACTION,
        member: 'DoAction',
        signature: 'i',
        body: [index],
      })
    );
  }

  async extents(ref: AtspiRef, coords: number): Promise<AtspiRect> {
    const value = await this.call({
      ...ref,
      interface: ATSPI_COMPONENT,
      member: 'GetExtents',
      signature: 'u',
      body: [coords],
    });
    if (!Array.isArray(value) || value.length !== 4) throw invalid();
    const [x, y, width, height] = value.map(integer) as [
      number,
      number,
      number,
      number,
    ];
    return { x, y, width, height };
  }

  async contains(
    ref: AtspiRef,
    x: number,
    y: number,
    coords: number
  ): Promise<boolean> {
    return boolean(
      await this.call({
        ...ref,
        interface: ATSPI_COMPONENT,
        member: 'Contains',
        signature: 'iiu',
        body: [x, y, coords],
      })
    );
  }

  close(): void {
    this.connection.close();
  }
}

/**
 * Connects to the accessibility bus: `AT_SPI_BUS_ADDRESS` when set, as
 * libatspi does, otherwise the address the session bus's `org.a11y.Bus` gives.
 */
export async function openAtspiBus(
  env: Record<string, string | undefined>,
  deadlineAt: number
): Promise<AtspiBus> {
  remainingMs(deadlineAt);
  const direct = env.AT_SPI_BUS_ADDRESS;
  // Validate before loading the SDK as well as before opening each socket.
  unixSocketPath(direct ?? env.DBUS_SESSION_BUS_ADDRESS);
  const sdk = await nativeDbus();
  let address = direct;
  if (address === undefined) {
    const session = new Connection(
      sdk,
      env.DBUS_SESSION_BUS_ADDRESS,
      deadlineAt
    );
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
  }
  return new AtspiBus(new Connection(sdk, address, deadlineAt));
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

export interface AtspiTreeItem {
  ref: AtspiRef;
  parentId?: string;
  depth: number;
}
export interface AtspiVisited<T> {
  value: T;
  children: AtspiRef[];
}

/**
 * Bounded parallel fetch, then depth-first order independent of reply timing.
 * A repeated node is an error, as is a tree over ATSPI_MAX_NODES.
 */
export async function walkAtspi<T>(
  root: AtspiRef,
  visit: (item: AtspiTreeItem) => Promise<AtspiVisited<T>>
): Promise<T[]> {
  const queue: AtspiTreeItem[] = [{ ref: root, depth: 0 }];
  const seen = new Set([atspiId(root)]);
  const records = new Map<string, AtspiVisited<T>>();
  for (let offset = 0; offset < queue.length; ) {
    const batch = queue.slice(offset, offset + CONCURRENCY);
    offset += batch.length;
    const results = await Promise.all(batch.map(visit));
    for (let index = 0; index < batch.length; index++) {
      const parent = batch[index]!;
      const parentId = atspiId(parent.ref);
      const result = results[index]!;
      records.set(parentId, result);
      for (const ref of result.children) {
        const childId = atspiId(ref);
        if (seen.has(childId))
          throw new AtspiError('accessibility_tree_invalid');
        if (seen.size >= ATSPI_MAX_NODES)
          throw new AtspiError('accessibility_tree_budget');
        seen.add(childId);
        queue.push({ ref, parentId, depth: parent.depth + 1 });
      }
    }
  }
  const output: T[] = [];
  const pending = [root];
  while (pending.length) {
    const record = records.get(atspiId(pending.pop()!))!;
    output.push(record.value);
    pending.push(...record.children.slice().reverse());
  }
  return output;
}
