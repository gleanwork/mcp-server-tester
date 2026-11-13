/** The Linux ChatGPT driver's native desktop: AT-SPI over D-Bus, MST's hand-off channel and xdotool. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, fstatSync, statSync } from 'node:fs';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  ATSPI_ACTION,
  ATSPI_COMPONENT,
  ATSPI_COORDS,
  ATSPI_EDITABLE_TEXT,
  ATSPI_STATE,
  ATSPI_TEXT,
  AtspiError,
  atspiId,
  walkAtspi,
  type AtspiBus,
  type AtspiRef,
} from '../linuxAtspiBus.js';
import { hasLoneSurrogate } from '../urlComponent.js';
import {
  LINUX_CHATGPT_HELPER_ENVIRONMENT,
  LINUX_CHATGPT_PROFILE_ENVIRONMENT,
  LINUX_CHATGPT_SESSION_ENVIRONMENT,
  pickEnvironment,
} from './linuxContract.js';
import {
  DriverFailure,
  INPUT_LIMIT,
  available,
  unique,
  type ChatgptLinuxDesktop,
  type ChatgptNode,
} from './linuxDriver.js';

const APP_NAMES = new Set(['chatgpt', 'codex', 'codex-launcher']);
const MAX_APPS = 128;
const EDITOR_ROLES = new Set([
  'entry',
  'text',
  'text area',
  'editable text',
  'paragraph',
]);
const STATIC_ROLES = new Set(['static', 'static text']);
const XDOTOOL = '/usr/bin/xdotool';
const TEXT_NODE_LIMIT = 256;
const TEXT_DEPTH_LIMIT = 16;
const OUTPUT_LIMIT = 1024;
const OPEN_TIMEOUT_MS = 30_000;
const SNAPSHOT_ATTEMPTS = 3;
/** A read that fails while the tree changes under a scan. Only the read-only scan repeats. */
const TRANSIENT = new Set([
  'accessibility_dbus_error',
  'accessibility_node_defunct',
  'accessibility_invalid_reply',
]);
const SESSION_KEYS: readonly string[] = [
  ...LINUX_CHATGPT_SESSION_ENVIRONMENT,
  ...LINUX_CHATGPT_PROFILE_ENVIRONMENT,
  ...LINUX_CHATGPT_HELPER_ENVIRONMENT,
];

export interface AtspiChatgptNode extends ChatgptNode {
  ref: AtspiRef;
}

function hasInterface(interfaces: readonly string[], name: string): boolean {
  return (
    interfaces.includes(name) || interfaces.includes(`org.a11y.atspi.${name}`)
  );
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export interface AtspiChatgptOptions {
  bus: AtspiBus;
  deadlineAt: number;
  /** The MST parent's hand-off channel (`--open-fd`). */
  openFd?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Tests: the hand-off connection in place of `openFd`. */
  connect?: () => Duplex;
  /** Tests: the mouse helper in place of /usr/bin/xdotool. */
  xdotool?: string;
}

export class AtspiChatgptDesktop implements ChatgptLinuxDesktop<AtspiChatgptNode> {
  private readonly bus: AtspiBus;
  private readonly deadlineAt: number;
  private readonly openFd: number | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly connect: (() => Duplex) | undefined;
  private readonly xdotool: string;
  private openUsed = false;

  constructor(options: AtspiChatgptOptions) {
    this.bus = options.bus;
    this.deadlineAt = options.deadlineAt;
    this.openFd = options.openFd;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.connect = options.connect;
    this.xdotool = options.xdotool ?? XDOTOOL;
  }

  /** Milliseconds left, at most `cap`. */
  remaining(cap = 2000): number {
    const ms = this.deadlineAt - this.now();
    if (ms <= 0) throw new DriverFailure('deadline_exceeded');
    return Math.min(cap, ms);
  }

  requireHelpers(): void {
    // The MST parent owns the deep-link hand-off. Without its channel no
    // draft can be opened, so fail before any UI action.
    if (this.connect) return;
    const fd = this.openFd;
    try {
      if (!Number.isInteger(fd) || fd! < 3 || !fstatSync(fd!).isSocket())
        throw new Error('no channel');
    } catch {
      throw new DriverFailure('helper_missing');
    }
  }

  async snapshot(): Promise<AtspiChatgptNode[]> {
    // Retry only a read-only traversal, discarding every partial tree.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.scan();
      } catch (error) {
        if (
          attempt >= SNAPSHOT_ATTEMPTS ||
          !(error instanceof AtspiError) ||
          !TRANSIENT.has(error.code)
        )
          throw error;
        this.remaining();
      }
    }
  }

  private async scan(): Promise<AtspiChatgptNode[]> {
    const apps = (await this.bus.applications())
      .slice(0, MAX_APPS)
      .filter((app) => APP_NAMES.has(app.name.toLowerCase()));
    if (!apps.length) return [];
    if (apps.length !== 1) throw new DriverFailure('desktop_ambiguous');
    type Visit = Omit<AtspiChatgptNode, 'ancestors'> & {
      id: string;
      parentId?: string;
    };
    const visited = await walkAtspi<Visit>(
      apps[0]!.ref,
      async ({ ref, parentId }) => {
        // A stale or incomplete tree cannot authorize an action.
        const [has, role, name, children] = await Promise.all([
          this.bus.states(ref),
          this.bus.role(ref),
          this.bus.name(ref),
          this.bus.children(ref),
        ]);
        const editableState = has(ATSPI_STATE.editable);
        // Query interfaces only for candidate roles.
        let textInterface = false;
        let editableInterface = false;
        if (EDITOR_ROLES.has(role) && editableState) {
          const interfaces = await this.bus.interfaces(ref);
          textInterface = interfaces.includes(ATSPI_TEXT);
          editableInterface = interfaces.includes(ATSPI_EDITABLE_TEXT);
        }
        return {
          value: {
            id: atspiId(ref),
            ...(parentId ? { parentId } : {}),
            ref,
            name,
            role,
            showing: has(ATSPI_STATE.showing),
            visible: has(ATSPI_STATE.visible),
            enabled: has(ATSPI_STATE.enabled),
            sensitive: has(ATSPI_STATE.sensitive),
            editable: EDITOR_ROLES.has(role) && editableState && textInterface,
            editableState,
            editableInterface,
            textInterface,
            selected: has(ATSPI_STATE.checked) || has(ATSPI_STATE.selected),
          },
          children,
        };
      }
    );
    const index = new Map<string, number>();
    const nodes: AtspiChatgptNode[] = [];
    for (const [position, { id, parentId, ...node }] of visited.entries()) {
      index.set(id, position);
      const parent = parentId === undefined ? undefined : index.get(parentId);
      nodes.push({
        ...node,
        ancestors:
          parent === undefined ? [] : [...nodes[parent]!.ancestors, parent],
      });
    }
    return nodes;
  }

  async activate(
    control: AtspiChatgptNode,
    allowed: readonly string[]
  ): Promise<void> {
    if (!(await this.bus.interfaces(control.ref)).includes(ATSPI_ACTION))
      throw new DriverFailure('action_unavailable');
    const names = await this.bus.actionNames(control.ref);
    const matches = names.flatMap((name, index) =>
      allowed.includes(name) ? [index] : []
    );
    if (matches.length !== 1)
      throw new DriverFailure('action_missing_or_ambiguous');
    let accepted = false;
    try {
      accepted = await this.bus.doAction(control.ref, matches[0]!);
    } catch {
      // Even a failed acknowledgement may have had an effect.
      accepted = false;
    }
    if (!accepted) throw new DriverFailure('action_acknowledgement_uncertain');
  }

  /**
   * The composer's exact text. Prefers public Hypertext references. The
   * structural fallback follows only a single direct child of a whole-marker
   * owned composer node. Bounds both source reads and expanded output; never
   * exports UI content.
   */
  async text(control: AtspiChatgptNode, limit?: number): Promise<string> {
    const byteLimit =
      limit === undefined ? INPUT_LIMIT : Math.min(limit, INPUT_LIMIT);
    let nodesRead = 0;
    let bytesRead = 0;
    let outputBytes = 0;
    const fragments: string[] = [];
    const unavailable = () => new DriverFailure('composer_text_unavailable');

    const append = (value: string) => {
      outputBytes += bytes(value);
      if (outputBytes > byteLimit) throw unavailable();
      fragments.push(value);
    };
    const read = (value: string) => {
      bytesRead += bytes(value);
      if (bytesRead > byteLimit) throw unavailable();
    };

    const structural = async (
      ref: AtspiRef,
      role: string,
      ancestors: readonly string[],
      owned: boolean
    ): Promise<boolean> => {
      if (!owned) return false;
      if (
        !ancestors.length &&
        (!EDITOR_ROLES.has(role) ||
          !(await this.bus.states(ref))(ATSPI_STATE.editable))
      )
        return false;
      const children = await this.bus.children(ref);
      if (children.length !== 1) return false; // No separators or child order can be inferred.
      const child = children[0]!;
      const childRole = await this.bus.role(child);
      const isStatic = role === 'paragraph' && STATIC_ROLES.has(childRole);
      if (childRole !== 'paragraph' && childRole !== 'text' && !isStatic)
        throw unavailable();
      await expand(child, [...ancestors, atspiId(ref)], true, isStatic);
      return true;
    };

    const expand = async (
      ref: AtspiRef,
      ancestors: readonly string[],
      owned = false,
      isStatic = false
    ): Promise<void> => {
      this.remaining();
      if (
        ancestors.length >= TEXT_DEPTH_LIMIT ||
        nodesRead >= TEXT_NODE_LIMIT ||
        ancestors.includes(atspiId(ref))
      )
        throw unavailable();
      nodesRead += 1;
      const interfaces = await this.bus.interfaces(ref);
      const role = await this.bus.role(ref);
      if (isStatic) {
        const children = await this.bus.children(ref);
        const has = await this.bus.states(ref);
        if (
          children.length !== 0 ||
          !STATIC_ROLES.has(role) ||
          !has(ATSPI_STATE.showing) ||
          !has(ATSPI_STATE.visible)
        )
          throw unavailable();
        if (!hasInterface(interfaces, 'Text')) {
          // Only a visible static leaf under an owned paragraph has a name
          // that represents content, not an arbitrary label.
          const value = await this.bus.name(ref);
          if (hasLoneSurrogate(value)) throw unavailable();
          read(value);
          append(value);
          return;
        }
      }
      if (
        role === 'image' ||
        role === 'password text' ||
        !hasInterface(interfaces, 'Text')
      )
        throw unavailable();
      const count = await this.bus.characterCount(ref);
      if (
        !Number.isInteger(count) ||
        count < 0 ||
        count > byteLimit - bytesRead
      )
        throw unavailable();
      const value = await this.bus.text(ref, 0, count);
      const characters = [...value];
      if (characters.length !== count) throw unavailable();
      read(value);
      if (!hasInterface(interfaces, 'Hypertext')) {
        if (
          value === '\ufffc' &&
          (await structural(ref, role, ancestors, owned))
        )
          return;
        append(value);
        return;
      }
      let start = 0;
      for (let offset = 0; offset < characters.length; offset++) {
        if (characters[offset] !== '\ufffc') continue;
        this.remaining();
        const link = await this.bus.linkIndex(ref, offset);
        if (!Number.isInteger(link) || link < -1) throw unavailable();
        if (link === -1) {
          if (
            value === '\ufffc' &&
            (await structural(ref, role, ancestors, owned))
          )
            return;
          continue; // An unresolved object character is not empty.
        }
        append(characters.slice(start, offset).join(''));
        const hyperlink = await this.bus.link(ref, link);
        if ((await this.bus.anchorCount(hyperlink)) !== 1) throw unavailable();
        await expand(await this.bus.linkObject(hyperlink, 0), [
          ...ancestors,
          atspiId(ref),
        ]);
        start = offset + 1;
      }
      append(characters.slice(start).join(''));
    };

    try {
      await expand(control.ref, [], true);
      return fragments.join('');
    } catch (error) {
      if (error instanceof DriverFailure) throw error;
      // Native errors can carry private text. Never propagate them.
      throw unavailable();
    }
  }

  /** The session variables xdotool may see. */
  environment(): Record<string, string> {
    return pickEnvironment(this.env, SESSION_KEYS);
  }

  async openPrompt(prompt: string): Promise<void> {
    // One request to MST, bound to the exact draft by its UTF-8 SHA-256. MST
    // knows the prompt; it is never echoed. No argv, shell, or retry.
    if (typeof prompt !== 'string' || hasLoneSurrogate(prompt))
      throw new DriverFailure('invalid_prompt');
    const encoded = Buffer.from(prompt, 'utf8');
    if (encoded.length > INPUT_LIMIT)
      throw new DriverFailure('input_too_large');
    const request = `${JSON.stringify({
      open: createHash('sha256').update(encoded).digest('hex'),
    })}\n`;
    await this.open(request);
  }

  private async open(request: string): Promise<void> {
    if (this.openUsed) throw new DriverFailure('helper_failed');
    this.openUsed = true;
    const timeout = this.remaining(OPEN_TIMEOUT_MS);
    let socket: Duplex;
    try {
      socket = this.connect
        ? this.connect()
        : new Socket({ fd: this.openFd, readable: true, writable: true });
    } catch {
      throw new DriverFailure('helper_failed');
    }
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let output = Buffer.alloc(0);
        const timer = setTimeout(
          () => reject(new DriverFailure('helper_timeout')),
          timeout
        );
        const done = (error?: DriverFailure, value?: string) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value!);
        };
        socket.on('error', () => done(new DriverFailure('helper_failed')));
        socket.on('end', () => done(new DriverFailure('helper_failed')));
        socket.on('data', (chunk: Buffer) => {
          output = Buffer.concat([output, chunk]);
          if (output.length > OUTPUT_LIMIT)
            return done(new DriverFailure('helper_failed'));
          const newline = output.indexOf(0x0a);
          if (newline < 0) return;
          // Nothing may follow the one receipt line.
          if (newline !== output.length - 1)
            return done(new DriverFailure('helper_failed'));
          done(undefined, output.subarray(0, newline).toString('utf8'));
        });
        socket.write(request);
      });
      // Only MST's exact receipt acknowledges the hand-off: no extra or
      // duplicate keys, and a boolean true.
      if (line !== '{"opened":true}') throw new DriverFailure('helper_failed');
    } finally {
      socket.destroy();
    }
  }

  async selectProfession(
    nodes: readonly AtspiChatgptNode[],
    choice: AtspiChatgptNode
  ): Promise<void> {
    // The observed radio's WINDOW extents plus its top-level frame's SCREEN
    // origin. Never reuse guessed coordinates.
    try {
      if (!statSync(this.xdotool).isFile()) throw new Error('missing');
      accessSync(this.xdotool, constants.X_OK);
    } catch {
      throw new DriverFailure('helper_missing');
    }
    const invalid = () => new DriverFailure('profession_geometry_invalid');
    const frame = unique(
      choice.ancestors
        .map((index) => nodes[index]!)
        .filter((node) => node.role === 'frame' && available(node, false)),
      'profession_geometry_invalid'
    );
    for (const control of [choice, frame])
      if (!(await this.bus.interfaces(control.ref)).includes(ATSPI_COMPONENT))
        throw invalid();
    const target = await this.bus.extents(choice.ref, ATSPI_COORDS.window);
    const bounds = await this.bus.extents(frame.ref, ATSPI_COORDS.screen);
    if (
      target.x < 0 ||
      target.y < 0 ||
      target.width <= 0 ||
      target.height <= 0 ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      target.x + target.width > bounds.width ||
      target.y + target.height > bounds.height
    )
      throw invalid();
    const x = bounds.x + target.x + Math.floor(target.width / 2);
    const y = bounds.y + target.y + Math.floor(target.height / 2);
    if (x < 0 || y < 0) throw invalid();
    // Component.Contains is a hit test on this actual accessible.
    if (!(await this.bus.contains(choice.ref, x, y, ATSPI_COORDS.screen)))
      throw invalid();
    await new Promise<void>((resolve, reject) => {
      execFile(
        this.xdotool,
        ['mousemove', String(x), String(y), 'click', '1'],
        {
          env: this.environment(),
          timeout: this.remaining(),
          killSignal: 'SIGKILL',
          shell: false,
        },
        (error) => {
          if (!error) resolve();
          else
            reject(
              new DriverFailure(
                error.killed ? 'helper_timeout' : 'helper_failed'
              )
            );
        }
      );
    });
  }
}
