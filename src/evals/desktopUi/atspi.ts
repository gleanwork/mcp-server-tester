/**
 * The desktop interface over AT-SPI on D-Bus: MST's own accessibility
 * client, for an app on Linux. Native primitives only: which app this is and
 * how a link reaches it come from the caller.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  ATSPI_COMPONENT,
  ATSPI_HYPERTEXT,
  ATSPI_REGISTRY,
  ATSPI_STATE,
  ATSPI_TEXT,
  atspiId,
  openAtspiBus,
  remainingMs,
  walkAtspi,
  type AtspiRef,
  type AtspiStates,
} from '../linuxAtspiBus.js';
import {
  DesktopUiError,
  type DesktopUi,
  type DesktopUiNode,
} from './desktopUi.js';
import { openLinuxLink } from './linuxLink.js';

const SKIPPED_ROLES = new Set(['table', 'tree table']);
const TEXT_ROLES = new Set(['static', 'text', 'label', 'paragraph', 'heading']);
/** Roles whose text can stand for an embedded-object marker in a composer. */
const INLINE_ROLES = new Set([...TEXT_ROLES, 'link']);
const MAX_INLINE_DEPTH = 8;

export interface AtspiDesktopUiOptions {
  /** Whether an accessible application of this name is the app to read. */
  application: (name: string) => boolean;
  /** The program that hands a link to the app. Default: `xdg-open`. */
  urlOpener?: string;
}

/** Native AT-SPI primitives only. No account, readiness, permission or retry policy. */
export async function connectAtspiDesktopUi(
  env: Record<string, string | undefined>,
  deadlineAt: number,
  options: AtspiDesktopUiOptions
): Promise<DesktopUi> {
  const bus = await openAtspiBus(env, deadlineAt);
  const { application } = options;
  const processes = new Set<ChildProcess>();
  let known = new Map<string, AtspiRef>();
  let clipboard: ChildProcess | undefined;
  let closed = false;
  let modifierCleanup: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;

  function check(): void {
    if (closed) throw new DesktopUiError('accessibility_bus_closed');
    remainingMs(deadlineAt);
  }
  function reference(node: DesktopUiNode): AtspiRef {
    check();
    const ref = known.get(node.id);
    if (!ref) throw new DesktopUiError('accessibility_unknown_node');
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
    if (!cleanup) check();
    await bus.call(
      {
        destination: ATSPI_REGISTRY,
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
          () => finish(new DesktopUiError('deadline_exceeded')),
          remainingMs(deadlineAt)
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
          finish(new DesktopUiError('clipboard_unavailable'))
        );
        child.on('exit', () =>
          finish(new DesktopUiError('clipboard_unavailable'))
        );
        child.stdin.on('error', () =>
          finish(new DesktopUiError('clipboard_unavailable'))
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
  async function open(url: string, code: string): Promise<void> {
    check();
    await openLinuxLink(url, code, {
      env,
      deadlineAt,
      ...(options.urlOpener !== undefined ? { opener: options.urlOpener } : {}),
      track: (child, done) =>
        done ? processes.delete(child) : processes.add(child),
    });
  }

  return {
    async snapshot() {
      known.clear();
      try {
        check();
        const matches = (await bus.applications()).filter((app) =>
          application(app.name)
        );
        if (matches.length !== 1)
          throw new DesktopUiError('desktop_missing_or_ambiguous');
        const refs = new Map<string, AtspiRef>();
        const nodes = await walkAtspi(
          matches[0]!.ref,
          async ({ ref, parentId }) => {
            const role = await bus.role(ref);
            let label: string, has: AtspiStates, descendants: AtspiRef[];
            try {
              [label, has, descendants] = await Promise.all([
                bus.name(ref),
                bus.states(ref),
                SKIPPED_ROLES.has(role)
                  ? Promise.resolve([])
                  : bus.children(ref),
              ]);
            } catch (error) {
              // The app re-renders while the tree is read, so a node can go
              // defunct between listing and reading it. It can't be acted on;
              // omit it rather than lose the whole scan. The app root can't.
              if (
                parentId &&
                error instanceof DesktopUiError &&
                error.code === 'accessibility_node_defunct'
              )
                return null;
              throw error;
            }
            refs.set(atspiId(ref), ref);
            return {
              value: {
                id: atspiId(ref),
                ...(parentId ? { parentId } : {}),
                name: label,
                role,
                visible: has(ATSPI_STATE.visible),
                showing: has(ATSPI_STATE.showing),
                enabled: has(ATSPI_STATE.enabled) && has(ATSPI_STATE.sensitive),
                selected: has(ATSPI_STATE.checked) || has(ATSPI_STATE.selected),
              },
              children: descendants,
            };
          }
        );
        known = refs;
        return nodes;
      } catch (error) {
        known.clear();
        if (
          error instanceof DesktopUiError &&
          error.code === 'deadline_exceeded'
        )
          throw new DesktopUiError('accessibility_scan_timeout');
        throw error;
      }
    },
    async readText(node) {
      const root = reference(node);
      const embeddedChildren = new Set<string>();
      const pieces = await walkAtspi(root, async ({ ref }) => {
        const interfaces = await bus.interfaces(ref);
        if (embeddedChildren.has(atspiId(ref))) {
          const role = await bus.role(ref);
          if (!INLINE_ROLES.has(role) || !interfaces.includes(ATSPI_TEXT))
            throw new DesktopUiError('accessibility_text_unavailable');
        }
        if (interfaces.includes(ATSPI_TEXT)) {
          const text = await bus.text(ref, 0, -1);
          if (text.includes('\ufffc')) {
            // Chromium represents editor paragraphs as embedded objects, even
            // when empty. Resolve their text instead of discarding the markers.
            // Text mixed with objects (a pasted URL becomes an inline link)
            // is read through each marker's hyperlink; see inlineText.
            if (text.replace(/[\ufffc\r\n]/g, '') !== '')
              return { value: await inlineText(ref, text, 0), children: [] };
            const descendants = await bus.children(ref);
            const markers = [...text].filter(
              (char) => char === '\ufffc'
            ).length;
            if (descendants.length !== markers)
              throw new DesktopUiError('accessibility_text_unavailable');
            for (const child of descendants)
              embeddedChildren.add(atspiId(child));
            return { value: '', children: descendants };
          }
          return { value: text, children: [] };
        }
        const role = await bus.role(ref);
        return {
          value: TEXT_ROLES.has(role) ? await bus.name(ref) : '',
          children: SKIPPED_ROLES.has(role) ? [] : await bus.children(ref),
        };
      });
      return pieces.filter(Boolean).join('\n');

      /**
       * Replace each U+FFFC in `text` with the text of the object it stands
       * for, found through the hyperlink at that character offset. Where the
       * hyperlink route fails, the node's children stand in, in order, one
       * per marker, as Chromium embeds them. A child count that differs
       * from the markers, or an object that isn't text-like, fails closed
       * rather than guess.
       */
      async function inlineText(
        ref: AtspiRef,
        text: string,
        depth: number
      ): Promise<string> {
        if (depth > MAX_INLINE_DEPTH)
          throw new DesktopUiError('accessibility_text_unavailable');
        try {
          return await viaHyperlinks(ref, text, depth);
        } catch {
          return await viaChildren(ref, text, depth);
        }
      }

      async function viaChildren(
        ref: AtspiRef,
        text: string,
        depth: number
      ): Promise<string> {
        const unavailable = () =>
          new DesktopUiError('accessibility_text_unavailable');
        const characters = [...text];
        const children = await bus.children(ref);
        if (
          children.length !==
          characters.filter((char) => char === '\ufffc').length
        )
          throw unavailable();
        const parts: string[] = [];
        let next = 0;
        for (const character of characters) {
          if (character !== '\ufffc') {
            parts.push(character);
            continue;
          }
          const object = children[next++]!;
          const [role, interfaces] = await Promise.all([
            bus.role(object),
            bus.interfaces(object),
          ]);
          if (!INLINE_ROLES.has(role) || !interfaces.includes(ATSPI_TEXT))
            throw unavailable();
          const inner = await bus.text(object, 0, -1);
          // A link always has text; an empty object is not evidence of one.
          if (!inner) throw unavailable();
          parts.push(
            inner.includes('\ufffc')
              ? await inlineText(object, inner, depth + 1)
              : inner
          );
        }
        return parts.join('');
      }

      async function viaHyperlinks(
        ref: AtspiRef,
        text: string,
        depth: number
      ): Promise<string> {
        const unavailable = () =>
          new DesktopUiError('accessibility_text_unavailable');
        if (!(await bus.interfaces(ref)).includes(ATSPI_HYPERTEXT))
          throw unavailable();
        const characters = [...text];
        const parts: string[] = [];
        for (let offset = 0; offset < characters.length; offset++) {
          if (characters[offset] !== '\ufffc') {
            parts.push(characters[offset]!);
            continue;
          }
          const index = await bus.linkIndex(ref, offset);
          if (index < 0) throw unavailable();
          const hyperlink = await bus.link(ref, index);
          if ((await bus.anchorCount(hyperlink)) !== 1) throw unavailable();
          const object = await bus.linkObject(hyperlink, 0);
          const [role, interfaces] = await Promise.all([
            bus.role(object),
            bus.interfaces(object),
          ]);
          if (!INLINE_ROLES.has(role) || !interfaces.includes(ATSPI_TEXT))
            throw unavailable();
          const inner = await bus.text(object, 0, -1);
          parts.push(
            inner.includes('\ufffc')
              ? await inlineText(object, inner, depth + 1)
              : inner
          );
        }
        return parts.join('');
      }
    },
    async activate(node) {
      const ref = reference(node);
      try {
        const accepted = await bus.doAction(ref, 0);
        if (!accepted)
          throw new DesktopUiError('action_acknowledgement_uncertain');
      } catch {
        throw new DesktopUiError('action_acknowledgement_uncertain');
      }
    },
    async reveal(node) {
      const accepted = await bus.call({
        ...reference(node),
        interface: ATSPI_COMPONENT,
        member: 'ScrollTo',
        signature: 'u',
        body: [6],
      });
      if (accepted !== true) throw new DesktopUiError('reveal_failed');
    },
    /** One clipboard paste into the control. */
    async enterText(node, text) {
      let unlock: Promise<void> | undefined;
      function releaseModifiers(): Promise<void> {
        // Shutdown and paste's finally share exactly one bounded unlock,
        // including when the lock or paste acknowledgement never arrives.
        unlock ??= keyboard(1 << 2, 6, true); // UNLOCKMODIFIERS, Control
        return unlock;
      }
      const ref = reference(node);
      const child = await startClipboard(text);
      try {
        const focused = await bus.call({
          ...ref,
          interface: ATSPI_COMPONENT,
          member: 'GrabFocus',
        });
        if (focused !== true) throw new DesktopUiError('composer_not_focused');
        if (child.exitCode !== null || child.signalCode !== null)
          throw new DesktopUiError('clipboard_unavailable');
        modifierCleanup = releaseModifiers;
        try {
          await keyboard(1 << 2, 5); // LOCKMODIFIERS, Control
          await keyboard(0x76, 3); // SYM, v — exactly one paste
        } finally {
          try {
            await releaseModifiers();
          } finally {
            modifierCleanup = undefined;
          }
        }
        // Keep selection ownership until close: the application may consume it
        // after the key-event reply. The driver verifies the resulting text.
      } catch (error) {
        stop(child);
        throw error;
      }
    },
    async openLink(url, failure) {
      await open(url, failure);
    },
    close() {
      if (closed) return closing;
      closed = true;
      function finish(): void {
        bus.close();
        for (const child of processes) stop(child);
        known.clear();
      }
      if (modifierCleanup) {
        // Only modifier release may outlive the action deadline, for at most
        // its existing one-second call budget. Never wait for or replay input.
        closing = modifierCleanup().then(finish, finish);
        return closing;
      }
      return finish();
    },
  };
}
