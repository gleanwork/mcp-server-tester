/** The native Linux UI seam. Mode selection and workflow policy stay in the driver. */
export interface LinuxUiNode {
  id: string;
  parentId?: string;
  name: string;
  role: string;
  visible: boolean;
  showing: boolean;
  enabled: boolean;
  selected: boolean;
}

export interface LinuxUi {
  /** A complete bounded snapshot of the single Claude application, or an error. */
  snapshot(): Promise<readonly LinuxUiNode[]>;
  readText(node: LinuxUiNode): Promise<string>;
  activate(node: LinuxUiNode): Promise<void>;
  reveal(node: LinuxUiNode): Promise<void>;
  /** One clipboard paste into the specified entry. The driver verifies the result. */
  paste(node: LinuxUiNode, text: string): Promise<void>;
  openCowork(): Promise<void>;
  /** One new-task link with `prompt` as its draft (empty for a blank task). Never sends. */
  openNewTask(prompt: string): Promise<void>;
  /** Stop input, then allow at most one extra second solely for modifier cleanup. */
  close(): void | Promise<void>;
}

export { AtspiError as LinuxUiError } from '../linuxAtspiBus.js';

export type LinuxDriverOperation =
  | 'probe'
  | 'reset'
  | 'submit'
  | 'hitl'
  | 'answer'
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
