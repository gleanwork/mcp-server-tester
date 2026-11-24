/**
 * The desktop interface over agent-desktop on Linux. Only what Linux adds to
 * `agentDesktopUi.ts`: the session's one window, by the application's name
 * on the accessibility bus; links through the URL opener; and text by
 * paste, because an editor built on the web platform ignores a value set
 * over AT-SPI.
 *
 * A key reaches the app only while an accessibility client is on the bus
 * (`heldAccessibilityClient.ts`); the batch that runs a driver holds one.
 */
import {
  agentDesktop,
  agentDesktopBinary,
  type AgentDesktop,
  type AgentDesktopWindowTarget,
} from './agentDesktop.js';
import { agentDesktopUi, agentDesktopUiError } from './agentDesktopUi.js';
import { DesktopUiError, type DesktopUi } from './desktopUi.js';
import { openLinuxLink } from './linuxLink.js';

export interface AgentDesktopLinuxUiOptions {
  /** Whether an accessible application of this name is the app to read. */
  application: (name: string) => boolean;
  /** The program that hands a link to the app. Default: `xdg-open`. */
  urlOpener?: string;
  /** The agent-desktop to run. Default: the installed package. */
  desktop?: AgentDesktop;
}

export async function connectAgentDesktopLinuxUi(
  env: Record<string, string | undefined>,
  deadlineAt: number,
  options: AgentDesktopLinuxUiOptions
): Promise<DesktopUi> {
  let desktop = options.desktop;
  if (!desktop) {
    const binary = agentDesktopBinary();
    if (!binary) throw new DesktopUiError('agent_desktop_not_installed');
    desktop = agentDesktop({ binary, deadlineAt, env });
  }
  const found = desktop;
  // One window for the connection: a connection lasts one driver operation.
  let window: AgentDesktopWindowTarget | undefined;
  return agentDesktopUi(found, {
    textEntry: 'paste',
    async window() {
      if (window) return window;
      let all;
      try {
        all = await found.windows();
      } catch (error) {
        throw agentDesktopUiError(error, false);
      }
      const mine = all.filter(
        (candidate) =>
          candidate.accessible &&
          candidate.app_name !== undefined &&
          options.application(candidate.app_name)
      );
      if (mine.length !== 1)
        throw new DesktopUiError('desktop_missing_or_ambiguous');
      window = { id: mine[0]!.id, app: mine[0]!.app_name! };
      return window;
    },
    open(url, code) {
      return openLinuxLink(url, code, {
        env,
        deadlineAt,
        ...(options.urlOpener !== undefined
          ? { opener: options.urlOpener }
          : {}),
      });
    },
  });
}
