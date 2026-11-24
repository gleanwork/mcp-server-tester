/**
 * The desktop interface (`desktopUi.ts`) over agent-desktop, for every OS.
 *
 * Only the translation lives here: agent-desktop's nodes as the interface's
 * nodes, and its errors as the interface's codes. What differs by OS or by
 * app is which window is the session's, how a link reaches the app, and how
 * text goes into an editor; a caller supplies those as an
 * `AgentDesktopUiHost`. Readiness, approvals and the one submission stay in
 * the drivers.
 */
import {
  AGENT_DESKTOP_MAX_TEXT_BYTES,
  AgentDesktopError,
  type AgentDesktop,
  type AgentDesktopNode,
  type AgentDesktopWindowTarget,
} from './agentDesktop.js';
import {
  DesktopUiError,
  type DesktopUi,
  type DesktopUiNode,
} from './desktopUi.js';

/** A window larger than this is not a tree the drivers can reason about. */
const MAX_NODES = 20_000;

/**
 * agent-desktop's role names, as the AT-SPI names the drivers match. Roles
 * not listed keep their name.
 */
const ROLES: Readonly<Record<string, string>> = {
  radiobutton: 'radio button',
  checkbox: 'check box',
  textfield: 'entry',
  statictext: 'static',
  // A button that opens a menu is a pop-up button on macOS and a button in AT-SPI.
  combobox: 'button',
  // The same on Linux: AT-SPI calls a button with a menu a button.
  menubutton: 'button',
  group: 'section',
  window: 'frame',
  webarea: 'document web',
};

function role(node: AgentDesktopNode): string {
  // A menu item with an on/off value is one of a set of choices.
  if (node.role === 'menuitem')
    return node.value === '0' || node.value === '1'
      ? 'radio menu item'
      : 'menu item';
  return ROLES[node.role] ?? node.role;
}

/**
 * The interface's code for a failed agent-desktop call. An action that may
 * have reached the app is uncertain, never retried.
 */
export function agentDesktopUiError(
  error: unknown,
  acting: boolean
): DesktopUiError {
  if (error instanceof DesktopUiError) return error;
  if (!(error instanceof AgentDesktopError))
    return new DesktopUiError('accessibility_unavailable');
  if (acting && error.mayHaveActed)
    return new DesktopUiError('action_acknowledgement_uncertain');
  switch (error.code) {
    case 'TIMEOUT':
    case 'APP_UNRESPONSIVE':
      return new DesktopUiError('accessibility_scan_timeout');
    case 'STALE_REF':
    case 'ELEMENT_NOT_FOUND':
    case 'SNAPSHOT_NOT_FOUND':
      return new DesktopUiError('accessibility_node_defunct');
    case 'WINDOW_NOT_FOUND':
    case 'APP_NOT_FOUND':
    case 'AMBIGUOUS_TARGET':
      return new DesktopUiError('desktop_missing_or_ambiguous');
    case 'NO_REPLY':
      return new DesktopUiError('accessibility_invalid_reply');
    default:
      return new DesktopUiError('accessibility_unavailable');
  }
}

/**
 * On Linux, Chromium gives an editor's text as one U+FFFC per paragraph, and
 * agent-desktop returns it as is. The paragraphs' own text is in the
 * snapshot: one line per child, from its text descendants.
 */
function embeddedText(node: AgentDesktopNode): string {
  function inline(part: AgentDesktopNode): string {
    const children = part.children ?? [];
    return children.length ? children.map(inline).join('') : (part.name ?? '');
  }
  return (node.children ?? []).map(inline).join('\n');
}

/** What a caller supplies: the session's window, its links, and its editors. */
export interface AgentDesktopUiHost {
  /** The one readable window of the session's app. */
  window(): Promise<AgentDesktopWindowTarget>;
  /** Hands `url` to the session's running app. Throws `DesktopUiError(code)`. */
  open(url: string, code: string): Promise<void>;
  /**
   * How text goes into an editor. `set-value` writes it as the element's
   * value, which an editor built on the web platform (Chromium over AT-SPI)
   * ignores; `paste` puts it on the clipboard, focuses the editor and sends
   * one paste key, which every editor takes. Default: `set-value`.
   */
  textEntry?: 'set-value' | 'paste';
  /** Releases what the host holds. */
  close?(): void | Promise<void>;
}

export function agentDesktopUi(
  desktop: AgentDesktop,
  host: AgentDesktopUiHost
): DesktopUi {
  // Refs of the latest snapshot only: a node from an older one names nothing.
  let generation = 0;
  let refs = new Map<string, string>();
  let sources = new Map<string, AgentDesktopNode>();

  function ref(node: DesktopUiNode): string {
    const found = refs.get(node.id);
    if (!found) throw new DesktopUiError('accessibility_unknown_node');
    return found;
  }

  return {
    async snapshot() {
      const target = await host.window();
      let read;
      try {
        read = await desktop.snapshot(target);
      } catch (error) {
        throw agentDesktopUiError(error, false);
      }
      if (!read.complete)
        throw new DesktopUiError('accessibility_scan_timeout');
      generation += 1;
      const next = new Map<string, string>();
      const nextSources = new Map<string, AgentDesktopNode>();
      const nodes: DesktopUiNode[] = [];
      const pending: { node: AgentDesktopNode; parentId?: string }[] = [
        { node: read.tree },
      ];
      while (pending.length) {
        const { node, parentId } = pending.pop()!;
        if (nodes.length >= MAX_NODES)
          throw new DesktopUiError('accessibility_tree_budget');
        const id = `${generation}:${nodes.length}`;
        const states = new Set(node.states ?? []);
        const visible = !states.has('hidden');
        nodes.push({
          id,
          ...(parentId === undefined ? {} : { parentId }),
          name:
            node.name || (node.role === 'statictext' ? node.value : '') || '',
          role: role(node),
          visible,
          showing: visible && !states.has('offscreen'),
          enabled: !states.has('disabled'),
          selected: states.has('checked') || states.has('selected'),
        });
        if (node.ref_id) next.set(id, node.ref_id);
        if (node.value?.includes('\ufffc')) nextSources.set(id, node);
        const children = node.children ?? [];
        // Reversed, so nodes come out in the order the window shows them.
        for (let index = children.length - 1; index >= 0; index -= 1)
          pending.push({ node: children[index]!, parentId: id });
      }
      refs = next;
      sources = nextSources;
      return nodes;
    },
    async readText(node) {
      const found = refs.get(node.id);
      // Text that no action can target has no value beyond its name.
      if (!found) return node.name;
      const source = sources.get(node.id);
      if (source) return embeddedText(source);
      try {
        return (await desktop.value(found)) ?? '';
      } catch (error) {
        throw agentDesktopUiError(error, false);
      }
    },
    async activate(node) {
      const found = ref(node);
      try {
        await desktop.click(found);
      } catch (error) {
        throw agentDesktopUiError(error, true);
      }
    },
    async reveal(node) {
      const found = ref(node);
      try {
        await desktop.scrollTo(found);
      } catch {
        throw new DesktopUiError('reveal_failed');
      }
    },
    async enterText(node, text) {
      const found = ref(node);
      if (
        !text ||
        text.includes('\0') ||
        Buffer.byteLength(text, 'utf8') > AGENT_DESKTOP_MAX_TEXT_BYTES
      )
        throw new DesktopUiError('invalid_prompt');
      if (host.textEntry === 'paste') {
        // The clipboard and the focus reach no editor's text; only the key
        // does, so only it is uncertain when it fails.
        try {
          await desktop.clipboardSet(text);
        } catch {
          throw new DesktopUiError('clipboard_unavailable');
        }
        try {
          await desktop.focus(found);
        } catch {
          throw new DesktopUiError('composer_not_focused');
        }
        try {
          await desktop.press('ctrl+v');
        } catch (error) {
          throw agentDesktopUiError(error, true);
        }
        return;
      }
      try {
        await desktop.setValue(found, text);
      } catch (error) {
        // The editor can hold the text in a form agent-desktop's own check
        // doesn't expect (a trailing line break). The driver reads the draft
        // back, so only a value that was never delivered fails here.
        if (
          error instanceof AgentDesktopError &&
          error.kind === 'post_action_verification' &&
          error.mayHaveActed
        )
          return;
        throw agentDesktopUiError(error, true);
      }
    },
    async openLink(url, failure) {
      await host.open(url, failure);
    },
    async close() {
      refs = new Map();
      sources = new Map();
      await host.close?.();
    },
  };
}
