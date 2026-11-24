/**
 * Connects a Linux driver process to the session's Claude Desktop. The one
 * place Cowork on Linux names a transport of the desktop interface; which one
 * is `linuxAutomation.ts`'s answer.
 */
import { connectAgentDesktopLinuxUi } from '../desktopUi/agentDesktopLinux.js';
import { connectAtspiDesktopUi } from '../desktopUi/atspi.js';
import { linuxCoworkAutomation } from './linuxAutomation.js';
import { coworkUi, isClaude, type LinuxUi } from './linuxUi.js';

export async function connectLinuxUi(
  env: Record<string, string | undefined>,
  deadlineAt: number
): Promise<LinuxUi> {
  const options = {
    application: isClaude,
    ...(env.MST_COWORK_URL_OPENER !== undefined
      ? { urlOpener: env.MST_COWORK_URL_OPENER }
      : {}),
  };
  const connect =
    linuxCoworkAutomation(env) === 'agent-desktop'
      ? connectAgentDesktopLinuxUi
      : connectAtspiDesktopUi;
  return coworkUi(await connect(env, deadlineAt, options));
}
