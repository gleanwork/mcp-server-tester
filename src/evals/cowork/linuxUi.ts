/**
 * What Cowork's drivers see of Claude Desktop: the desktop interface
 * (`desktopUi/desktopUi.ts`), with Claude's own links. Mode selection and
 * workflow policy stay in the drivers.
 */
import {
  DesktopUiError,
  type DesktopUi,
  type DesktopUiNode,
} from '../desktopUi/desktopUi.js';
import { hasLoneSurrogate, percentEncodeUtf8 } from '../urlComponent.js';

export type LinuxUiNode = DesktopUiNode;

export interface LinuxUi {
  /** A complete bounded snapshot of the single Claude application, or an error. */
  snapshot(): Promise<readonly LinuxUiNode[]>;
  readText(node: LinuxUiNode): Promise<string>;
  activate(node: LinuxUiNode): Promise<void>;
  reveal(node: LinuxUiNode): Promise<void>;
  /** The prompt, entered once in the specified entry. The driver verifies the result. */
  paste(node: LinuxUiNode, text: string): Promise<void>;
  openCowork(): Promise<void>;
  /** Open the managed new-task route without a draft parameter. Never sends. */
  openBlankManagedTask(): Promise<void>;
  /** One new-task link with `prompt` as its draft (empty for a blank task). Never sends. */
  openNewTask(prompt: string): Promise<void>;
  /** Stop input, then allow at most one extra second solely for modifier cleanup. */
  close(): void | Promise<void>;
}

export { DesktopUiError as LinuxUiError };

/** Claude Desktop's accessible application names, compared case-insensitively. */
export function isClaude(name: string): boolean {
  return ['claude', 'claude-desktop'].includes(name.toLowerCase());
}

/** Claude Desktop over any transport of the desktop interface. */
export function coworkUi(ui: DesktopUi): LinuxUi {
  return {
    snapshot: () => ui.snapshot(),
    readText: (node) => ui.readText(node),
    activate: (node) => ui.activate(node),
    reveal: (node) => ui.reveal(node),
    paste: (node, text) => ui.enterText(node, text),
    async openCowork() {
      await ui.openLink('claude://cowork/new', 'open_cowork_failed');
    },
    async openBlankManagedTask() {
      await ui.openLink('claude://claude.ai/new', 'open_task_failed');
    },
    async openNewTask(prompt) {
      if (hasLoneSurrogate(prompt)) throw new DesktopUiError('invalid_prompt');
      await ui.openLink(
        `claude://claude.ai/new?q=${percentEncodeUtf8(prompt)}`,
        'open_task_failed'
      );
    },
    close: () => ui.close(),
  };
}

export type LinuxDriverOperation =
  | 'probe'
  | 'reset'
  | 'submit'
  | 'hitl'
  | 'answer'
  | 'stop'
  | 'diagnose';

export interface LinuxDriverReceipt {
  status: 'ready' | 'submitted' | 'hitl_checked' | 'diagnosed' | 'failed';
  action_count: number;
  duration_ms: number;
  error?: string;
  scan?: 'incomplete';
  denied?: 'folder_request';
  answered?: 'option' | 'advance';
}

export interface LinuxDriverPayload {
  prompt?: string;
  targetModel?: string;
  approveWrites?: boolean;
  questions?: readonly { labels: readonly string[] }[];
  dir?: string;
}
