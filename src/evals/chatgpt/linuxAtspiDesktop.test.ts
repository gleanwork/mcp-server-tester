/** The Linux ChatGPT driver's AT-SPI desktop against a fake accessibility bus. No live app. */
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATSPI_COORDS,
  ATSPI_STATE,
  AtspiError,
  type AtspiBus,
  type AtspiRect,
  type AtspiRef,
} from '../linuxAtspiBus.js';
import {
  AtspiChatgptDesktop,
  type AtspiChatgptNode,
  type AtspiChatgptOptions,
} from './linuxAtspiDesktop.js';
import {
  ChatgptDriver,
  DriverFailure,
  INPUT_LIMIT,
  composer,
} from './linuxDriver.js';

const PROMPT = '  π 😀e\u0301\n\nExact.  \n';
const UNREADABLE = [
  'composerRootCount',
  'observedSurface',
  'sendControlCount',
  'textReadable',
];

interface FakeAccessible {
  name: string;
  role: string;
  states: Set<number>;
  interfaces: string[];
  children: (FakeAccessible | null)[];
  value: string;
  links: Map<number, (FakeAccessible | null)[]>;
  actions: string[];
  acknowledge: boolean | Error;
  window?: AtspiRect;
  screen?: AtspiRect;
  hit: boolean;
}

function accessible(
  name: string,
  role = 'button',
  {
    editable = false,
    children = [],
    value = '',
  }: { editable?: boolean; children?: FakeAccessible[]; value?: string } = {}
): FakeAccessible {
  const states = new Set<number>([
    ATSPI_STATE.showing,
    ATSPI_STATE.visible,
    ATSPI_STATE.enabled,
    ATSPI_STATE.sensitive,
  ]);
  const interfaces = ['Accessible', 'Action', 'Component'];
  if (editable) {
    states.add(ATSPI_STATE.editable);
    interfaces.push('Text');
  }
  return {
    name,
    role,
    states,
    interfaces,
    children,
    value,
    links: new Map(),
    actions: ['click'],
    acknowledge: true,
    hit: true,
  };
}

type Method = keyof FakeBus;

/** The AT-SPI calls the driver makes, over a tree of fake accessibles. */
class FakeBus {
  readonly calls: [string, string][] = [];
  /** Replaces one method's reply, or throws from it. */
  readonly hooks: Partial<
    Record<string, (node: FakeAccessible, ...args: number[]) => unknown>
  > = {};
  private readonly refs = new Map<string, FakeAccessible>();
  private readonly links = new Map<string, (FakeAccessible | null)[]>();
  private readonly ids = new WeakMap<object, string>();
  private next = 0;

  constructor(readonly desktop: FakeAccessible[]) {}

  ref(item: FakeAccessible): AtspiRef {
    let id = this.ids.get(item);
    if (!id) {
      id = `/fake/${this.next++}`;
      this.ids.set(item, id);
      this.refs.set(id, item);
    }
    return { destination: ':1.1', path: id };
  }

  private node(
    ref: AtspiRef,
    method: string,
    ...args: number[]
  ): FakeAccessible {
    const item = this.refs.get(ref.path);
    if (!item) throw new AtspiError('accessibility_node_defunct');
    this.calls.push([method, item.name]);
    const hook = this.hooks[method];
    if (hook) {
      const value = hook(item, ...args);
      if (value instanceof Error) throw value;
    }
    return item;
  }

  private reply<T>(
    method: string,
    item: FakeAccessible,
    fallback: T,
    ...args: number[]
  ): T {
    const hook = this.hooks[method];
    return hook ? ((hook(item, ...args) as T) ?? fallback) : fallback;
  }

  private reference(item: FakeAccessible | null): AtspiRef {
    if (!item) throw new AtspiError('accessibility_invalid_reply');
    return this.ref(item);
  }

  async applications() {
    const hook = this.hooks.applications;
    if (hook) {
      const value = hook(this.desktop[0]!);
      if (value instanceof Error) throw value;
    }
    return this.desktop.map((app) => ({ ref: this.ref(app), name: app.name }));
  }
  async name(ref: AtspiRef) {
    const item = this.node(ref, 'name');
    return item.name;
  }
  async children(ref: AtspiRef) {
    const item = this.node(ref, 'children');
    return item.children.map((child) => this.reference(child));
  }
  async role(ref: AtspiRef) {
    const item = this.node(ref, 'role');
    return item.role === 'push button' ? 'button' : item.role;
  }
  async states(ref: AtspiRef) {
    const item = this.node(ref, 'states');
    return (bit: number) => item.states.has(bit);
  }
  async interfaces(ref: AtspiRef) {
    const item = this.node(ref, 'interfaces');
    return item.interfaces.map((name) => `org.a11y.atspi.${name}`);
  }
  async characterCount(ref: AtspiRef) {
    const item = this.node(ref, 'characterCount');
    return this.reply('characterCount', item, [...item.value].length);
  }
  async text(ref: AtspiRef, start: number, end: number) {
    const item = this.node(ref, 'text', start, end);
    return this.reply(
      'text',
      item,
      [...item.value].slice(start, end).join(''),
      start,
      end
    );
  }
  async linkIndex(ref: AtspiRef, offset: number) {
    const item = this.node(ref, 'linkIndex', offset);
    return this.reply(
      'linkIndex',
      item,
      item.links.has(offset) ? offset : -1,
      offset
    );
  }
  async link(ref: AtspiRef, index: number) {
    const item = this.node(ref, 'link', index);
    const anchors = item.links.get(index);
    if (!anchors) throw new AtspiError('accessibility_invalid_reply');
    const path = `${this.ref(item).path}/link/${index}`;
    this.links.set(path, anchors);
    return { destination: ':1.1', path };
  }
  async anchorCount(link: AtspiRef) {
    this.calls.push(['anchorCount', link.path]);
    const hook = this.hooks.anchorCount;
    if (hook) {
      const value = hook(this.desktop[0]!);
      if (value instanceof Error) throw value;
    }
    return this.links.get(link.path)!.length;
  }
  async linkObject(link: AtspiRef, index: number) {
    this.calls.push(['linkObject', link.path]);
    const hook = this.hooks.linkObject;
    if (hook) {
      const value = hook(this.desktop[0]!);
      if (value instanceof Error) throw value;
    }
    return this.reference(this.links.get(link.path)![index] ?? null);
  }
  async actionNames(ref: AtspiRef) {
    return this.node(ref, 'actionNames').actions;
  }
  async doAction(ref: AtspiRef, index: number) {
    const item = this.node(ref, 'doAction', index);
    if (item.acknowledge instanceof Error) throw item.acknowledge;
    return item.acknowledge;
  }
  async extents(ref: AtspiRef, coords: number) {
    const item = this.node(ref, 'extents', coords);
    return coords === ATSPI_COORDS.window ? item.window! : item.screen!;
  }
  async contains(ref: AtspiRef, x: number, y: number, coords: number) {
    const item = this.node(ref, 'contains', x, y, coords);
    return item.hit;
  }

  count(method: Method): number {
    return this.calls.filter(([name]) => name === method).length;
  }
}

/** A ChatGPT app with a mode switch, Send and one composer. */
function chatgpt(value = '') {
  const editor = accessible('private composer', 'text', {
    editable: true,
    value,
  });
  const app = accessible('ChatGPT', 'application', {
    children: [
      accessible('Switch mode, current mode: ChatGPT Work'),
      accessible('Send'),
      editor,
    ],
  });
  return { editor, app };
}

function desktopFor(
  bus: FakeBus,
  options: Partial<AtspiChatgptOptions> = {}
): AtspiChatgptDesktop {
  return new AtspiChatgptDesktop({
    bus: bus as unknown as AtspiBus,
    deadlineAt: Date.now() + 30_000,
    connect: () => {
      throw new Error('no channel in this test');
    },
    ...options,
  });
}

async function snapshotFor(bus: FakeBus, desktop = desktopFor(bus)) {
  const nodes = await desktop.snapshot();
  return { desktop, nodes };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DriverFailure || error instanceof AtspiError)
      return error instanceof DriverFailure ? error.message : error.code;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('snapshot', () => {
  it('reads the one app and marks only visible enabled editable text roles as a composer', async () => {
    const { editor, app } = chatgpt(PROMPT);
    const bus = new FakeBus([accessible('gnome-shell', 'application'), app]);
    const { desktop, nodes } = await snapshotFor(bus);
    expect(nodes.map((n) => n.name)).toEqual([
      'ChatGPT',
      'Switch mode, current mode: ChatGPT Work',
      'Send',
      'private composer',
    ]);
    expect(nodes.map((n) => n.ancestors)).toEqual([[], [0], [0], [0]]);
    const current = composer(nodes);
    expect(current.textInterface).toBe(true);
    expect(current.editableInterface).toBe(false); // Text alone suffices for readback.
    // The snapshot queries interfaces only for candidate editors.
    expect(
      bus.calls.filter(([m]) => m === 'interfaces').map(([, n]) => n)
    ).toEqual(['private composer']);
    expect(await desktop.text(current)).toBe(PROMPT);
    editor.interfaces.push('EditableText');
    expect(composer((await snapshotFor(bus)).nodes).editableInterface).toBe(
      true
    );

    const mutations: Record<string, () => void> = {
      static: () => editor.states.delete(ATSPI_STATE.editable),
      password: () => void (editor.role = 'password text'),
      'wrong-role': () => void (editor.role = 'document web'),
      hidden: () => editor.states.delete(ATSPI_STATE.showing),
      disabled: () => editor.states.delete(ATSPI_STATE.sensitive),
      'no-text': () => void (editor.interfaces = ['EditableText']),
    };
    for (const mutate of Object.values(mutations)) {
      const fresh = chatgpt();
      Object.assign(editor, fresh.editor);
      mutate();
      const { nodes: changed } = await snapshotFor(new FakeBus([app]));
      expect(() => composer(changed)).toThrow('composer_missing_or_ambiguous');
    }
  });

  it('is empty without an app and ambiguous with two', async () => {
    expect(
      (
        await snapshotFor(
          new FakeBus([accessible('gnome-shell', 'application')])
        )
      ).nodes
    ).toEqual([]);
    const bus = new FakeBus([
      chatgpt().app,
      accessible('codex', 'application'),
    ]);
    expect(await code(desktopFor(bus).snapshot())).toBe('desktop_ambiguous');
  });

  it('reads checked and selected states and nested ancestry', async () => {
    const choice = accessible('Engineering', 'radio button');
    choice.states.add(ATSPI_STATE.checked);
    const frame = accessible('ChatGPT', 'frame', { children: [choice] });
    const app = accessible('Codex-Launcher', 'application', {
      children: [frame],
    });
    const { nodes } = await snapshotFor(new FakeBus([app]));
    expect(nodes.map((n) => [n.name, n.ancestors, n.selected])).toEqual([
      ['Codex-Launcher', [], false],
      ['ChatGPT', [0], false],
      ['Engineering', [0, 1], true],
    ]);
  });

  it('retries only a transient read, at most three times', async () => {
    const bus = new FakeBus([chatgpt().app]);
    for (const transient of [
      'accessibility_dbus_error',
      'accessibility_node_defunct',
      'accessibility_invalid_reply',
      // A node that moved under a new parent mid-scan is seen twice.
      'accessibility_tree_invalid',
    ] as const) {
      let failures = 2;
      bus.hooks.applications = () =>
        failures-- > 0 ? new AtspiError(transient) : undefined;
      expect((await desktopFor(bus).snapshot()).length).toBe(4);
    }
    let calls = 0;
    bus.hooks.applications = () => {
      calls += 1;
      return new AtspiError('accessibility_node_defunct');
    };
    expect(await code(desktopFor(bus).snapshot())).toBe(
      'accessibility_node_defunct'
    );
    expect(calls).toBe(3);
    calls = 0;
    bus.hooks.applications = () => {
      calls += 1;
      return new AtspiError('accessibility_bus_closed');
    };
    expect(await code(desktopFor(bus).snapshot())).toBe(
      'accessibility_bus_closed'
    );
    expect(calls).toBe(1);
  });
});

describe('activate', () => {
  async function send(configure: (send: FakeAccessible) => void) {
    const { app } = chatgpt();
    const target = app.children[1]!;
    configure(target);
    const bus = new FakeBus([app]);
    const { desktop, nodes } = await snapshotFor(bus);
    const control = nodes.find((n) => n.name === 'Send')!;
    return { bus, result: code(desktop.activate(control, ['click', 'press'])) };
  }

  it('runs the one observed allowed action, once', async () => {
    const { app } = chatgpt();
    const bus = new FakeBus([app]);
    const { desktop, nodes } = await snapshotFor(bus);
    await desktop.activate(nodes.find((n) => n.name === 'Send')!, ['click']);
    expect(bus.calls.filter(([m]) => m === 'doAction')).toEqual([
      ['doAction', 'Send'],
    ]);
  });

  it('fails without acting on a missing, ambiguous or unavailable action', async () => {
    for (const actions of [['delete'], ['click', 'press']]) {
      const { bus, result } = await send((n) => void (n.actions = actions));
      expect(await result).toBe('action_missing_or_ambiguous');
      expect(bus.count('doAction')).toBe(0);
    }
    const { bus, result } = await send(
      (n) => void (n.interfaces = ['Accessible'])
    );
    expect(await result).toBe('action_unavailable');
    expect(bus.count('actionNames')).toBe(0);
  });

  it('does not retry an uncertain acknowledgement', async () => {
    for (const acknowledge of [
      false,
      new AtspiError('accessibility_dbus_error'),
    ]) {
      const { bus, result } = await send(
        (n) => void (n.acknowledge = acknowledge)
      );
      expect(await result).toBe('action_acknowledgement_uncertain');
      expect(bus.count('doAction')).toBe(1);
    }
  });
});

describe('composer text', () => {
  /** An entry whose one marker links to an editable paragraph. */
  function linked(value = '') {
    const { editor, app } = chatgpt();
    editor.role = 'entry';
    editor.value = '\ufffc';
    const paragraph = accessible('private paragraph name', 'paragraph', {
      editable: true,
      value,
    });
    paragraph.children = [accessible('private static name', 'static')];
    editor.children = [paragraph];
    link(editor, 0, paragraph);
    return { bus: new FakeBus([app]), editor, paragraph };
  }

  function link(
    parent: FakeAccessible,
    offset: number,
    ...anchors: (FakeAccessible | null)[]
  ) {
    if (!parent.interfaces.includes('Hypertext'))
      parent.interfaces.push('Hypertext');
    parent.links.set(offset, anchors);
  }

  /** The editor's one owned child, with no hyperlink. */
  function structural(value = '', isStatic = false, hypertext = false) {
    const fixture = linked(value);
    fixture.editor.interfaces = [
      'Accessible',
      'Text',
      ...(hypertext ? ['Hypertext'] : []),
    ];
    fixture.editor.links = new Map();
    if (isStatic) {
      fixture.paragraph.value = '\ufffc';
      fixture.paragraph.children[0]!.name = value;
    }
    return fixture;
  }

  async function read(
    bus: FakeBus,
    editor: FakeAccessible,
    limit?: number,
    options = {}
  ) {
    const desktop = desktopFor(bus, options);
    const control = { ref: bus.ref(editor) } as AtspiChatgptNode;
    return desktop.text(control, limit);
  }

  async function unavailable(
    bus: FakeBus,
    editor: FakeAccessible,
    limit?: number
  ) {
    try {
      await read(bus, editor, limit);
    } catch (error) {
      expect(error).toBeInstanceOf(DriverFailure);
      expect((error as Error).message).toBe('composer_text_unavailable');
      return;
    }
    throw new Error('expected composer_text_unavailable');
  }

  function names(bus: FakeBus): string[] {
    return bus.calls.filter(([m]) => m === 'name').map(([, n]) => n);
  }

  it('reads a linked paragraph exactly, without names', async () => {
    for (const value of [
      '',
      'single line',
      '  π 😀e\u0301\t\r\n\nExact.  \n',
      'a\ufffcb',
    ]) {
      const { bus, editor, paragraph } = linked(value);
      paragraph.interfaces.push('Hypertext'); // An unlinked marker stays literal.
      expect(await read(bus, editor)).toBe(value);
      expect(names(bus)).toEqual([]);
      expect(bus.calls.filter(([m]) => m === 'text')).toEqual([
        ['text', 'private composer'],
        ['text', 'private paragraph name'],
      ]);
      expect(bus.count('linkObject')).toBe(1);
    }
  });

  it('expands only linked markers, at character offsets, with the separators the app reports', async () => {
    const first = linked('child');
    first.editor.value = '😀\ufffc \n\ufffc\t';
    first.editor.links = new Map();
    link(first.editor, 4, first.paragraph);
    expect(await read(first.bus, first.editor)).toBe('😀\ufffc \nchild\t');
    expect(first.bus.calls.filter(([m]) => m === 'linkIndex')).toHaveLength(2);
    expect(first.bus.count('link')).toBe(1);

    const nested = linked('before\ufffcafter');
    const child = accessible('private nested name', 'text', {
      editable: true,
      value: 'inner\n',
    });
    link(nested.paragraph, 6, child);
    nested.editor.value = '\ufffc\r\n\ufffc';
    link(nested.editor, 3, child);
    expect(await read(nested.bus, nested.editor)).toBe(
      'beforeinner\nafter\r\ninner\n'
    );
  });

  it('falls back to one owned child or a static leaf', async () => {
    for (const hypertext of [false, true])
      for (const isStatic of [false, true])
        for (const value of [
          '',
          '  π 😀e\u0301\r\n\nExact. \t\n',
          'a\ufffcb',
        ]) {
          const { bus, editor, paragraph } = structural(
            value,
            isStatic,
            hypertext
          );
          if (!isStatic) {
            paragraph.role = 'text';
            paragraph.states.delete(ATSPI_STATE.editable);
          }
          expect(await read(bus, editor)).toBe(value);
          expect(bus.count('link')).toBe(0);
          if (!isStatic) expect(names(bus)).toEqual([]);
        }
    const withText = structural('name', true);
    const leaf = withText.paragraph.children[0]!;
    leaf.interfaces.push('Text');
    leaf.value = 'actual Text value';
    expect(await read(withText.bus, withText.editor)).toBe('actual Text value'); // Text beats the name.
    expect(names(withText.bus)).toEqual([]);

    const both = linked('linked value');
    both.editor.children = [
      accessible('x', 'paragraph', { editable: true, value: 'structural' }),
    ];
    expect(await read(both.bus, both.editor)).toBe('linked value'); // Hypertext wins.
  });

  it('never guesses order, ownership or literals', async () => {
    for (const value of ['literal', ' \ufffc', '\ufffc\n', '\ufffc\ufffc']) {
      const { bus, editor } = structural('not content');
      editor.value = value;
      expect(await read(bus, editor)).toBe(value);
    }
    for (const hypertext of [false, true])
      for (const count of [0, 2]) {
        const { bus, editor, paragraph } = structural('', false, hypertext);
        editor.children = Array.from({ length: count }, () => paragraph);
        expect(await read(bus, editor)).toBe('\ufffc');
        expect(bus.count('role')).toBe(1); // Only the editor's own role.
      }
    const notOwned = structural('not owned');
    notOwned.editor.states.delete(ATSPI_STATE.editable);
    expect(await read(notOwned.bus, notOwned.editor)).toBe('\ufffc');
    const linkOnly = linked('\ufffc');
    linkOnly.editor.children = []; // A hyperlink alone does not establish ownership.
    expect(await read(linkOnly.bus, linkOnly.editor)).toBe('\ufffc');
    expect(names(linkOnly.bus)).toEqual([]);
  });

  it('fails on unsafe children, links and metadata without reading names', async () => {
    const cases: Record<string, (f: ReturnType<typeof linked>) => void> = {
      image: (f) => void (f.paragraph.role = 'image'),
      password: (f) => void (f.paragraph.role = 'password text'),
      'no-text': (f) => void (f.paragraph.interfaces = ['Accessible']),
      'no-anchor': (f) => link(f.editor, 0),
      'none-anchor': (f) => link(f.editor, 0, null),
      'two-anchors': (f) =>
        link(f.editor, 0, accessible('private'), accessible('private')),
      cycle: (f) => link(f.paragraph, 0, f.editor),
      'bad-count': (f) => void (f.bus.hooks.characterCount = () => -1),
      'huge-count': (f) =>
        void (f.bus.hooks.characterCount = () => INPUT_LIMIT + 1),
      'short-text': (f) => void (f.bus.hooks.text = () => 'private incomplete'),
      'index--2': (f) => void (f.bus.hooks.linkIndex = () => -2),
    };
    for (const [kind, mutate] of Object.entries(cases)) {
      const fixture = linked(kind === 'cycle' ? '\ufffc' : 'private');
      mutate(fixture);
      await unavailable(fixture.bus, fixture.editor);
      expect(names(fixture.bus)).toEqual([]);
    }
    for (const kind of ['label', 'entry', 'static-not-leaf', 'hidden', 'rpc']) {
      const { bus, editor, paragraph } = structural('private', true);
      const leaf = paragraph.children[0]!;
      if (kind === 'label' || kind === 'entry') paragraph.role = kind;
      else if (kind === 'static-not-leaf')
        leaf.children = [accessible('private')];
      else if (kind === 'hidden') leaf.states.delete(ATSPI_STATE.visible);
      else
        bus.hooks.children = () => new AtspiError('accessibility_dbus_error');
      await unavailable(bus, editor);
      expect(names(bus)).toEqual([]);
    }
  });

  it('bounds depth, cycles, bytes and the deadline', async () => {
    const deep = structural('\ufffc');
    let current = deep.paragraph;
    for (let depth = 0; depth < 16; depth++) {
      const child = accessible('private', 'paragraph', {
        editable: true,
        value: '\ufffc',
      });
      current.children = [child];
      current = child;
    }
    await unavailable(deep.bus, deep.editor); // Depth, not a stack overflow.
    const cyclic = structural('\ufffc');
    cyclic.paragraph.children = [cyclic.paragraph];
    await unavailable(cyclic.bus, cyclic.editor); // Structural cycle.

    for (const isStatic of [false, true]) {
      // Source and expanded UTF-8 bytes share one caller limit.
      const total = isStatic ? 10 : 7;
      const fixture = structural('😀', isStatic);
      expect(await read(fixture.bus, fixture.editor, total)).toBe('😀');
      await unavailable(fixture.bus, fixture.editor, total - 1);
    }
    const emoji = linked('😀');
    await unavailable(emoji.bus, emoji.editor, 0);
    expect(emoji.bus.count('text')).toBe(0);
    await expect(
      read(emoji.bus, emoji.editor, undefined, { deadlineAt: Date.now() - 1 })
    ).rejects.toThrow('deadline_exceeded');
  });

  it('hides RPC errors and leaves the draft unreadable in diagnostics', async () => {
    for (const method of [
      'text',
      'linkIndex',
      'link',
      'anchorCount',
      'linkObject',
    ]) {
      const { bus, editor } = linked('private prompt');
      bus.hooks[method] = () => new AtspiError('accessibility_dbus_error');
      await unavailable(bus, editor);
      const driver = new ChatgptDriver(desktopFor(bus), 60_000, 24);
      await driver.snapshot();
      const receipt = await driver.receipt('failed');
      expect(Object.keys(receipt.draftState!).sort()).toEqual(UNREADABLE);
      expect(JSON.stringify(receipt)).not.toContain('private');
    }
  });

  it('measures a bounded diagnostic read', async () => {
    const { bus, editor } = linked('\ufffc');
    editor.links = new Map();
    editor.interfaces = ['Accessible', 'Text'];
    editor.children = [];
    const driver = new ChatgptDriver(desktopFor(bus), 60_000, 24);
    await driver.snapshot();
    expect((await driver.receipt('failed')).draftState).toMatchObject({
      textReadable: true,
      textLength: 1,
      embeddedObjectCount: 1,
    });
    editor.value = 'a'.repeat(INPUT_LIMIT + 1);
    await driver.snapshot();
    const before = bus.count('text');
    expect((await driver.receipt('failed')).draftState!.textReadable).toBe(
      false
    );
    expect(bus.count('text')).toBe(before);
  });
});

describe('hand-off channel', () => {
  let root: string;
  let server: Server;
  let requests: string[];
  let replies: (Buffer | string | null)[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mst-chatgpt-open-'));
    requests = [];
    replies = [];
    server = createServer((socket: Socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += String(chunk);
        if (!data.includes('\n')) return;
        requests.push(data);
        const reply = replies.shift();
        if (reply === null || reply === undefined) return;
        if (reply === '') socket.end();
        else socket.write(reply);
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) =>
      server.listen(join(root, 'open.sock'), resolve)
    );
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  function opener(options: Partial<AtspiChatgptOptions> = {}) {
    return desktopFor(new FakeBus([]), {
      connect: () => connect(join(root, 'open.sock')),
      ...options,
    });
  }

  it('requests once with only the UTF-8 SHA-256 of the draft', async () => {
    for (const prompt of ['  π 😀\n\nprivate "quoted" \\draft\t  \n', '']) {
      requests = [];
      replies.push('{"opened":true}\n');
      const desktop = opener();
      desktop.requireHelpers();
      await desktop.openPrompt(prompt);
      const digest = createHash('sha256').update(prompt, 'utf8').digest('hex');
      expect(requests).toEqual([`${JSON.stringify({ open: digest })}\n`]);
      expect(requests[0]).not.toContain('private');
    }
  });

  it('makes one request per process and never retries', async () => {
    replies.push('{"opened":false}\n');
    const desktop = opener();
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(desktop.openPrompt('private')).rejects.toThrow(
        /^helper_failed$/
      );
    expect(requests).toHaveLength(1);
  });

  it('rejects invalid or oversized receipts without their output', async () => {
    for (const output of [
      'private-query\n',
      '{"opened":false}\n',
      '{"opened":1}\n',
      '{"opened":true,"url":"private-query"}\n',
      '{"opened":true,"opened":true}\n',
      '[["opened",true]]\n',
      '{"opened":true}\n{}',
      'x'.repeat(1025),
      '',
    ]) {
      replies.push(output);
      const error = await code(opener().openPrompt('private'));
      expect(error).toBe('helper_failed');
    }
  });

  it('never requests an oversized or unencodable prompt, or without a channel', async () => {
    const desktop = opener();
    expect(
      await code(desktop.openPrompt('😀'.repeat(INPUT_LIMIT / 4 + 1)))
    ).toBe('input_too_large');
    expect(await code(desktop.openPrompt('bad\ud800'))).toBe('invalid_prompt');
    expect(requests).toEqual([]);
    const regular = join(root, 'regular');
    await writeFile(regular, '');
    const fd = openSync(regular, 'r');
    try {
      for (const openFd of [undefined, 0, 2, 999, fd]) {
        const missing = desktopFor(new FakeBus([]), {
          openFd,
          connect: undefined,
        });
        expect(() => missing.requireHelpers()).toThrow(/^helper_missing$/);
      }
    } finally {
      closeSync(fd);
    }
  });

  it('times out within the driver deadline, without a retry', async () => {
    replies.push(null);
    const started = Date.now();
    expect(
      await code(opener({ deadlineAt: Date.now() + 80 }).openPrompt('private'))
    ).toBe('helper_timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(requests).toHaveLength(1);
  });
});

describe('profession click', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mst-chatgpt-xdotool-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function xdotool(body: string): Promise<string> {
    const path = join(root, 'xdotool');
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  function geometry() {
    const choice = accessible('Engineering', 'radio button');
    choice.window = { x: 20, y: 40, width: 100, height: 40 };
    const frame = accessible('ChatGPT', 'frame', { children: [choice] });
    frame.screen = { x: 300, y: 200, width: 800, height: 600 };
    const app = accessible('ChatGPT', 'application', { children: [frame] });
    return { bus: new FakeBus([app]), choice, frame };
  }

  async function click(
    fixture: ReturnType<typeof geometry>,
    helper: string,
    change?: (nodes: AtspiChatgptNode[]) => AtspiChatgptNode[]
  ) {
    const desktop = desktopFor(fixture.bus, {
      xdotool: helper,
      env: {
        DISPLAY: ':99',
        HOME: '/home/mst',
        OPENAI_API_KEY: 'private',
        PATH: '/usr/bin:/bin',
      },
    });
    let nodes = await desktop.snapshot();
    if (change) nodes = change(nodes);
    const choice = nodes.find((n) => n.name === 'Engineering')!;
    return desktop.selectProfession(nodes, choice);
  }

  it('clicks once at the live window plus screen geometry', async () => {
    const log = join(root, 'argv');
    const helper = await xdotool(`echo "$@" > ${log}; env > ${log}.env`);
    const fixture = geometry();
    await click(fixture, helper);
    expect((await readFile(log, 'utf8')).trim()).toBe(
      'mousemove 370 260 click 1'
    );
    const env = await readFile(`${log}.env`, 'utf8');
    expect(env).toContain('DISPLAY=:99');
    expect(env).not.toContain('OPENAI_API_KEY');
    expect(fixture.bus.calls.filter(([m]) => m === 'contains')).toEqual([
      ['contains', 'Engineering'],
    ]);
  });

  it('never clicks on invalid geometry, a missing frame or component, or a missed hit test', async () => {
    const log = join(root, 'argv');
    const helper = await xdotool(`echo "$@" >> ${log}`);
    const cases: Record<
      string,
      (
        f: ReturnType<typeof geometry>
      ) => ((n: AtspiChatgptNode[]) => AtspiChatgptNode[]) | void
    > = {
      'x<0': (f) => void (f.choice.window!.x = -1),
      'width=0': (f) => void (f.choice.window!.width = 0),
      'y-outside': (f) => void (f.choice.window!.y = 900),
      miss: (f) => void (f.choice.hit = false),
      'no-frame': () => (nodes) =>
        nodes.map((n) =>
          n.name === 'Engineering' ? { ...n, ancestors: [] } : n
        ),
      'two-frames': () => (nodes) => {
        const frame = nodes.find((n) => n.role === 'frame')!;
        const copy = [...nodes, frame];
        return copy.map((n) =>
          n.name === 'Engineering'
            ? { ...n, ancestors: [1, copy.length - 1] }
            : n
        );
      },
      'no-component': (f) =>
        void (f.choice.interfaces = ['Accessible', 'Action']),
    };
    for (const mutate of Object.values(cases)) {
      const fixture = geometry();
      const change = mutate(fixture) ?? undefined;
      expect(await code(click(fixture, helper, change))).toBe(
        'profession_geometry_invalid'
      );
    }
    await expect(readFile(log, 'utf8')).rejects.toThrow();
  });

  it('maps a failed or slow mouse helper to a fixed code, without a retry', async () => {
    const count = join(root, 'count');
    const failing = await xdotool(
      `echo x >> ${count}; echo private >&2; exit 1`
    );
    expect(await code(click(geometry(), failing))).toBe('helper_failed');
    expect((await readFile(count, 'utf8')).trim().split('\n')).toHaveLength(1);
    const slow = await xdotool('sleep 5');
    const fixture = geometry();
    const desktop = desktopFor(fixture.bus, {
      xdotool: slow,
      deadlineAt: Date.now() + 300,
    });
    const nodes = await desktop.snapshot();
    expect(
      await code(
        desktop.selectProfession(
          nodes,
          nodes.find((n) => n.name === 'Engineering')!
        )
      )
    ).toBe('helper_timeout');
    expect(await code(click(geometry(), join(root, 'missing')))).toBe(
      'helper_missing'
    );
  });
});
