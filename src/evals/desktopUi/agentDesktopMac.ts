/**
 * The desktop interface over agent-desktop on macOS. Only what macOS adds to
 * `agentDesktopUi.ts`: the session's one window, found through the running
 * application of that name; links through `open`; and text set as a value,
 * which an editor in a native or a Chromium window takes over the AX API.
 */
import { execFile } from 'node:child_process';
import {
  agentDesktop,
  agentDesktopBinary,
  type AgentDesktop,
  type AgentDesktopWindowTarget,
} from './agentDesktop.js';
import { agentDesktopUi, agentDesktopUiError } from './agentDesktopUi.js';
import { DesktopUiError, type DesktopUi } from './desktopUi.js';

const OPEN = '/usr/bin/open';

export interface AgentDesktopMacUiOptions {
  /** Whether a running application of this name is the app to read. */
  application: (name: string) => boolean;
  /** The agent-desktop to run. Default: the installed package. */
  desktop?: AgentDesktop;
}

export async function connectAgentDesktopMacUi(
  env: Record<string, string | undefined>,
  deadlineAt: number,
  options: AgentDesktopMacUiOptions
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
    textEntry: 'set-value',
    async window() {
      if (window) return window;
      try {
        // Every window at once is slow to settle on a busy desktop; one
        // application's windows come at once.
        const names = new Set(
          (await found.apps())
            .map((app) => app.name)
            .filter((name) => options.application(name))
        );
        const mine: AgentDesktopWindowTarget[] = [];
        for (const name of names)
          for (const candidate of await found.windows(name))
            if (candidate.accessible && candidate.visible)
              mine.push({ id: candidate.id, app: name });
        if (mine.length !== 1)
          throw new DesktopUiError('desktop_missing_or_ambiguous');
        window = mine[0]!;
        return window;
      } catch (error) {
        throw agentDesktopUiError(error, false);
      }
    },
    /** One bounded run of `open`, without a shell. Never retried. */
    async open(url, code) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new DesktopUiError('deadline_exceeded');
      await new Promise<void>((resolve, reject) => {
        execFile(
          OPEN,
          [url],
          {
            env,
            shell: false,
            timeout: Math.min(15_000, remaining),
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024,
          },
          (error) => (error ? reject(new DesktopUiError(code)) : resolve())
        );
      });
    },
  });
}
