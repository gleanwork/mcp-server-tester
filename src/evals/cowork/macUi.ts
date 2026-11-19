/**
 * The native UI seam (`linuxUi.ts`) for Claude Desktop on macOS, read and
 * driven through its accessibility tree with agent-desktop.
 *
 * Only the translation lives here: one window of the session's app bundle,
 * agent-desktop's nodes as the seam's nodes, and its errors as the seam's
 * codes. Mode, readiness, approvals and the one submission stay in the
 * drivers.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_DESKTOP_MAX_TEXT_BYTES,
  AgentDesktopError,
  type AgentDesktop,
  type AgentDesktopNode,
} from '../agentDesktop.js';
import { percentEncodeUtf8 } from '../urlComponent.js';
import { LinuxUiError, type LinuxUi, type LinuxUiNode } from './linuxUi.js';

/** How long a launched or raised app has to show a readable window. */
const WINDOW_TIMEOUT_MS = 20_000;
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
 * The seam's code for a failed agent-desktop call. An action that may have
 * reached the app is uncertain, never retried.
 */
function uiError(error: unknown, acting: boolean): LinuxUiError {
  if (error instanceof LinuxUiError) return error;
  if (!(error instanceof AgentDesktopError))
    return new LinuxUiError('accessibility_unavailable');
  if (acting && error.mayHaveActed)
    return new LinuxUiError('action_acknowledgement_uncertain');
  switch (error.code) {
    case 'TIMEOUT':
    case 'APP_UNRESPONSIVE':
      return new LinuxUiError('accessibility_scan_timeout');
    case 'STALE_REF':
    case 'ELEMENT_NOT_FOUND':
    case 'SNAPSHOT_NOT_FOUND':
      return new LinuxUiError('accessibility_node_defunct');
    case 'WINDOW_NOT_FOUND':
    case 'APP_NOT_FOUND':
    case 'AMBIGUOUS_TARGET':
      return new LinuxUiError('desktop_missing_or_ambiguous');
    case 'NO_REPLY':
      return new LinuxUiError('accessibility_invalid_reply');
    default:
      return new LinuxUiError('accessibility_unavailable');
  }
}

function run(file: string, args: readonly string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, killSignal: 'SIGKILL', env: {} },
      (error, stdout) =>
        error
          ? reject(new Error(`${file} failed`, { cause: error }))
          : resolve(String(stdout))
    );
  });
}

export interface MacUiOptions {
  desktop: AgentDesktop;
  /** The session's exact app bundle. Another Claude Desktop is never driven. */
  appPath: string;
  deadlineAt: number;
  /** Every running process and its executable's path. Tests replace it. */
  processes?: () => Promise<{ pid: number; path: string }[]>;
  /** Runs `/usr/bin/open` with these arguments. Tests replace it. */
  open?: (args: readonly string[]) => Promise<void>;
  /** Tests replace it. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Connects to the one readable window of the session's Claude Desktop. When
 * the app shows none (it is hidden, or on another Space), it is raised once.
 */
export async function connectMacUi(options: MacUiOptions): Promise<LinuxUi> {
  const { desktop, deadlineAt } = options;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const remaining = () => Math.max(1, deadlineAt - Date.now());
  const processes =
    options.processes ??
    (async () => {
      const listed = await run(
        '/bin/ps',
        ['-axo', 'pid=,comm='],
        Math.min(5_000, remaining())
      );
      return listed.split('\n').flatMap((line) => {
        const match = /^\s*(\d+) (.+)$/.exec(line);
        return match ? [{ pid: Number(match[1]), path: match[2]! }] : [];
      });
    });
  const open =
    options.open ??
    (async (args: readonly string[]) => {
      await run('/usr/bin/open', args, Math.min(10_000, remaining()));
    });
  if (!options.appPath.startsWith('/') || /[\0\r\n]/.test(options.appPath))
    throw new LinuxUiError('desktop_missing_or_ambiguous');
  // A process reports the path it was launched from, which may be a link.
  const executables = [`${join(options.appPath, 'Contents', 'MacOS')}/`];
  try {
    const resolved = `${join(await realpath(options.appPath), 'Contents', 'MacOS')}/`;
    if (!executables.includes(resolved)) executables.push(resolved);
  } catch {
    throw new LinuxUiError('desktop_missing_or_ambiguous');
  }

  /**
   * The readable windows of the session's bundle, and of no other app.
   * Undefined when the bundle has no running process.
   */
  async function windows(): Promise<string[] | undefined> {
    let all;
    let running;
    try {
      all = await desktop.windows();
      running = await processes();
    } catch (error) {
      throw uiError(error, false);
    }
    const mine = new Set(
      running
        .filter((process) =>
          executables.some((directory) => process.path.startsWith(directory))
        )
        .map((process) => process.pid)
    );
    if (!mine.size) return undefined;
    return all
      .filter(
        (window) => window.accessible && window.visible && mine.has(window.pid)
      )
      .map((window) => window.id);
  }

  // One window for the connection: a connection lasts one driver operation.
  let window: string | undefined;
  async function target(): Promise<string> {
    if (window) return window;
    let ids = await windows();
    // The session starts the app. The driver never launches one.
    if (!ids) throw new LinuxUiError('desktop_missing_or_ambiguous');
    if (!ids.length) {
      // An app nobody can see has no accessibility tree. Raise it once.
      try {
        await open(['-a', options.appPath]);
      } catch {
        throw new LinuxUiError('desktop_missing_or_ambiguous');
      }
      const until = Math.min(deadlineAt, Date.now() + WINDOW_TIMEOUT_MS);
      while (ids && !ids.length && Date.now() < until) {
        await sleep(Math.min(500, Math.max(1, until - Date.now())));
        ids = await windows();
      }
    }
    if (ids?.length !== 1)
      throw new LinuxUiError('desktop_missing_or_ambiguous');
    window = ids[0]!;
    return window;
  }

  // Refs of the latest snapshot only: a node from an older one names nothing.
  let generation = 0;
  let refs = new Map<string, string>();

  function ref(node: LinuxUiNode): string {
    const found = refs.get(node.id);
    if (!found) throw new LinuxUiError('accessibility_unknown_node');
    return found;
  }

  async function openUrl(url: string, code: string): Promise<void> {
    // A link is for the running session's app: `open` would launch one.
    await target();
    try {
      await open(['-a', options.appPath, url]);
    } catch {
      throw new LinuxUiError(code);
    }
  }

  return {
    async snapshot() {
      const id = await target();
      let read;
      try {
        read = await desktop.snapshot(id);
      } catch (error) {
        throw uiError(error, false);
      }
      if (!read.complete) throw new LinuxUiError('accessibility_scan_timeout');
      generation += 1;
      const next = new Map<string, string>();
      const nodes: LinuxUiNode[] = [];
      const pending: { node: AgentDesktopNode; parentId?: string }[] = [
        { node: read.tree },
      ];
      while (pending.length) {
        const { node, parentId } = pending.pop()!;
        if (nodes.length >= MAX_NODES)
          throw new LinuxUiError('accessibility_tree_budget');
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
        const children = node.children ?? [];
        // Reversed, so nodes come out in the order the window shows them.
        for (let index = children.length - 1; index >= 0; index -= 1)
          pending.push({ node: children[index]!, parentId: id });
      }
      refs = next;
      return nodes;
    },
    async readText(node) {
      const found = refs.get(node.id);
      // Text that no action can target has no value beyond its name.
      if (!found) return node.name;
      try {
        return (await desktop.value(found)) ?? '';
      } catch (error) {
        throw uiError(error, false);
      }
    },
    async activate(node) {
      const found = ref(node);
      try {
        await desktop.click(found);
      } catch (error) {
        throw uiError(error, true);
      }
    },
    async reveal(node) {
      const found = ref(node);
      try {
        await desktop.scrollTo(found);
      } catch {
        throw new LinuxUiError('reveal_failed');
      }
    },
    async paste(node, text) {
      const found = ref(node);
      if (
        !text ||
        text.includes('\0') ||
        Buffer.byteLength(text, 'utf8') > AGENT_DESKTOP_MAX_TEXT_BYTES
      )
        throw new LinuxUiError('invalid_prompt');
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
        throw uiError(error, true);
      }
    },
    async openCowork() {
      await openUrl('claude://cowork/new', 'open_cowork_failed');
    },
    async openNewTask(prompt) {
      await openUrl(
        `claude://claude.ai/new?q=${percentEncodeUtf8(prompt)}`,
        'open_cowork_failed'
      );
    },
    close() {
      refs = new Map();
    },
  };
}
