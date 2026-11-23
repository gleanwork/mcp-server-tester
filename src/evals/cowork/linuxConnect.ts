/**
 * Connects a Linux driver process to the session's Claude Desktop. The one
 * place Cowork on Linux names a transport of the desktop interface.
 */
import { connectAtspiDesktopUi } from '../desktopUi/atspi.js';
import { coworkUi, isClaude, type LinuxUi } from './linuxUi.js';

export async function connectLinuxUi(
  env: Record<string, string | undefined>,
  deadlineAt: number
): Promise<LinuxUi> {
  return coworkUi(
    await connectAtspiDesktopUi(env, deadlineAt, {
      application: isClaude,
      ...(env.MST_COWORK_URL_OPENER !== undefined
        ? { urlOpener: env.MST_COWORK_URL_OPENER }
        : {}),
    })
  );
}
