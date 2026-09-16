import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  launchCodexApp,
  type CodexProcessFacade,
  type CodexSession,
} from '../../../src/evals/codex/launcher.js';

interface SetupTerminal {
  write(message: string): void;
  onInterrupt(listener: () => void): () => void;
}

const foregroundTerminal: SetupTerminal = {
  write(message) {
    console.log(message);
  },
  onInterrupt(listener) {
    process.on('SIGINT', listener);
    process.on('SIGTERM', listener);
    return () => {
      process.off('SIGINT', listener);
      process.off('SIGTERM', listener);
    };
  },
};

const usage =
  'Usage: tsx tests/manual/codex/setup.ts --executable /absolute/ChatGPT.app/Contents/MacOS/ChatGPT --profile /absolute/new-profile';

/** Foreground app setup. All sign-in actions stay with the user in the real app. */
export async function runCodexSetup(
  args: string[],
  processes?: CodexProcessFacade,
  terminal: SetupTerminal = foregroundTerminal
): Promise<number> {
  let options: { executablePath: string; profilePath: string };
  try {
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        executable: { type: 'string' },
        profile: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      terminal.write(usage);
      return 0;
    }
    if (!values.executable || !values.profile) throw new Error('missing paths');
    options = {
      executablePath: values.executable,
      profilePath: values.profile,
    };
  } catch {
    terminal.write(usage);
    return 1;
  }

  let session: CodexSession | undefined;
  let interrupted = false;
  let interruption = Promise.resolve();
  const removeListeners = terminal.onInterrupt(() => {
    if (interrupted) return;
    interrupted = true;
    terminal.write(
      'Setup interrupted. Quit the app manually; waiting for app exit.'
    );
    if (session) interruption = session.quarantine();
    // Keep failures handled until the foreground wait completes. The lease stays held.
    void interruption.catch(() => {});
  });
  try {
    session = await launchCodexApp(options, processes);
    terminal.write(
      `Profile: ${session.profile.root}\nOwned app PID: ${session.process.pid}`
    );
    if (interrupted) await session.quarantine();
    else
      terminal.write(
        'Sign in in the app, then quit it normally. Do not submit a task.'
      );
    const exit = await session.exited;
    await interruption;
    if (interrupted || exit.status === 'quarantined') {
      terminal.write(
        'App lifecycle ended with a quarantined profile; do not reuse it. Sign-in was not verified.'
      );
      return 1;
    }
    terminal.write(
      'App exited cleanly. Profile retained; sign-in was not verified.'
    );
    return 0;
  } catch {
    terminal.write(
      'Setup failed. Check app identity, running app processes, and profile ownership/lease. Quit any opened app manually. No sign-in state was inspected.'
    );
    return 1;
  } finally {
    removeListeners();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await runCodexSetup(process.argv.slice(2));
}
