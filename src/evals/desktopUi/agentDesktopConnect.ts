/**
 * The desktop interface over agent-desktop, for the OS this process runs on
 * (ADR 0011: the OS is read from the machine that runs the trial, never from
 * an option).
 */
import { connectAgentDesktopLinuxUi } from './agentDesktopLinux.js';
import { connectAgentDesktopMacUi } from './agentDesktopMac.js';
import { DesktopUiError, type DesktopUi } from './desktopUi.js';

export interface AgentDesktopUiOptions {
  /** Whether an application of this name is the app to read. */
  application: (name: string) => boolean;
  /** Linux: the program that hands a link to the app. Default: `xdg-open`. */
  urlOpener?: string;
}

export async function connectAgentDesktopUi(
  env: Record<string, string | undefined>,
  deadlineAt: number,
  options: AgentDesktopUiOptions,
  platform: NodeJS.Platform = process.platform
): Promise<DesktopUi> {
  switch (platform) {
    case 'linux':
      return connectAgentDesktopLinuxUi(env, deadlineAt, options);
    case 'darwin':
      return connectAgentDesktopMacUi(env, deadlineAt, {
        application: options.application,
      });
    default:
      throw new DesktopUiError('desktop_os_unsupported');
  }
}
