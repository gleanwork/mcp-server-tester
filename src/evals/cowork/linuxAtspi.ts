import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {
  ATSPI_COMPONENT,
  ATSPI_REGISTRY,
  ATSPI_STATE,
  ATSPI_TEXT,
  atspiId,
  openAtspiBus,
  remainingMs,
  walkAtspi,
  type AtspiRef,
} from '../linuxAtspiBus.js';
import { hasLoneSurrogate, percentEncodeUtf8 } from '../urlComponent.js';
import { LinuxUiError, type LinuxUi, type LinuxUiNode } from './linuxUi.js';

const SKIPPED_ROLES = new Set(['table', 'tree table']);
const TEXT_ROLES = new Set(['static', 'text', 'label', 'paragraph', 'heading']);

/** Claude Desktop's accessible application names, compared case-insensitively. */
function isClaude(name: string): boolean {
  return ['claude', 'claude-desktop'].includes(name.toLowerCase());
}

export interface LinuxUiOptions {
  /** Which application to read. Default: exactly `Claude` or `claude-desktop`. */
  application?: (name: string) => boolean;
}

/** Native AT-SPI primitives only. No account, readiness, permission or retry policy. */
export async function connectLinuxUi(
  env: Record<string, string | undefined>,
  deadlineAt: number,
  options: LinuxUiOptions = {}
): Promise<LinuxUi> {
  const bus = await openAtspiBus(env, deadlineAt);
  const application = options.application ?? isClaude;
  const processes = new Set<ChildProcess>();
  let known = new Map<string, AtspiRef>();
  let clipboard: ChildProcess | undefined;
  let closed = false;
  let modifierCleanup: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;

  function check(): void {
    if (closed) throw new LinuxUiError('accessibility_bus_closed');
    remainingMs(deadlineAt);
  }
  function reference(node: LinuxUiNode): AtspiRef {
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
          () => finish(new LinuxUiError('deadline_exceeded')),
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
  /** One bounded run of the URL opener, without a shell. Never retried. */
  async function open(url: string, code: string): Promise<void> {
    check();
    const opener = env.MST_COWORK_URL_OPENER;
    if (opener !== undefined && !isAbsolute(opener))
      throw new LinuxUiError('invalid_url_opener');
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        opener ?? 'xdg-open',
        [url],
        {
          env,
          shell: false,
          timeout: Math.min(15_000, remainingMs(deadlineAt)),
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
        },
        (error) => {
          processes.delete(child);
          if (error) reject(new LinuxUiError(code));
          else resolve();
        }
      );
      processes.add(child);
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
          throw new LinuxUiError('desktop_missing_or_ambiguous');
        const refs = new Map<string, AtspiRef>();
        const nodes = await walkAtspi(
          matches[0]!.ref,
          async ({ ref, parentId }) => {
            const role = await bus.role(ref);
            const [label, has, descendants] = await Promise.all([
              bus.name(ref),
              bus.states(ref),
              SKIPPED_ROLES.has(role) ? Promise.resolve([]) : bus.children(ref),
            ]);
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
        if (error instanceof LinuxUiError && error.code === 'deadline_exceeded')
          throw new LinuxUiError('accessibility_scan_timeout');
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
          if (!TEXT_ROLES.has(role) || !interfaces.includes(ATSPI_TEXT))
            throw new LinuxUiError('accessibility_text_unavailable');
        }
        if (interfaces.includes(ATSPI_TEXT)) {
          const text = await bus.text(ref, 0, -1);
          if (text.includes('\ufffc')) {
            // Chromium represents editor paragraphs as embedded objects, even
            // when empty. Resolve their text instead of discarding the markers.
            // Mixed literals/objects need hyperlink-offset reconstruction; fail
            // closed rather than lose literal text or guess its reading order.
            if (text.replace(/[\ufffc\r\n]/g, '') !== '')
              throw new LinuxUiError('accessibility_text_unavailable');
            const descendants = await bus.children(ref);
            const markers = [...text].filter(
              (char) => char === '\ufffc'
            ).length;
            if (descendants.length !== markers)
              throw new LinuxUiError('accessibility_text_unavailable');
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
    },
    async activate(node) {
      const ref = reference(node);
      try {
        const accepted = await bus.doAction(ref, 0);
        if (!accepted)
          throw new LinuxUiError('action_acknowledgement_uncertain');
      } catch {
        throw new LinuxUiError('action_acknowledgement_uncertain');
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
      if (accepted !== true) throw new LinuxUiError('reveal_failed');
    },
    async paste(node, text) {
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
        if (focused !== true) throw new LinuxUiError('composer_not_focused');
        if (child.exitCode !== null || child.signalCode !== null)
          throw new LinuxUiError('clipboard_unavailable');
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
    async openCowork() {
      await open('claude://cowork/new', 'open_cowork_failed');
    },
    async openNewTask(prompt) {
      if (hasLoneSurrogate(prompt)) throw new LinuxUiError('invalid_prompt');
      await open(
        `claude://claude.ai/new?q=${percentEncodeUtf8(prompt)}`,
        'open_task_failed'
      );
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
