/**
 * How MST reads and operates a desktop app's window: one interface, which no
 * product owns (ADR 0017).
 *
 * A transport implements it over one way of reaching the app's accessibility
 * tree. A desktop client's rules are written over it, so the transport under
 * a client can change without a change to its rules. Nothing here knows an
 * app, an account, an approval or a retry.
 */

/** One control of the app's window, as the latest snapshot saw it. */
export interface DesktopUiNode {
  /** Names the control within the snapshot that returned it, and no longer. */
  id: string;
  parentId?: string;
  name: string;
  /** The control's role, by its AT-SPI name on every OS (`button`, `entry`). */
  role: string;
  /** Not hidden. A control scrolled out of view is still visible. */
  visible: boolean;
  /** Visible and on screen. */
  showing: boolean;
  enabled: boolean;
  /** Selected or checked. */
  selected: boolean;
}

export interface DesktopUi {
  /** A complete bounded snapshot of the one app's window, or an error. */
  snapshot(): Promise<readonly DesktopUiNode[]>;
  readText(node: DesktopUiNode): Promise<string>;
  activate(node: DesktopUiNode): Promise<void>;
  /** Brings a control into view. */
  reveal(node: DesktopUiNode): Promise<void>;
  /** Enters `text` in a control, once. The caller reads the result back. */
  enterText(node: DesktopUiNode, text: string): Promise<void>;
  /** Hands `url` to the app, once. Fails with `DesktopUiError(failure)`. */
  openLink(url: string, failure: string): Promise<void>;
  /** Stops input. Only releasing held keys may take longer, by one second. */
  close(): void | Promise<void>;
}

/** A failure with a stable, allowlistable code and no native detail. */
export class DesktopUiError extends Error {
  constructor(readonly code: string) {
    super(code);
    // Kept from when the Linux drivers owned this class: logs carry it.
    this.name = 'LinuxUiError';
  }
}
