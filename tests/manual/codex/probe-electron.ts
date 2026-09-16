import { mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  getCodexElectronFailureDiagnostic,
  launchCodexElectron,
  type CodexElectronShutdown,
} from '../../../src/evals/codex/electron.js';
import { createCodexElectronControl } from '../../../src/evals/codex/electronControl.js';

const USAGE = `Usage: npx tsx tests/manual/codex/probe-electron.ts \\
  --attempt UNIQUE_PROBE_ID \\
  --executable /absolute/pinned/ChatGPT.app/Contents/MacOS/ChatGPT \\
  --profile /absolute/dedicated/codex-profile \\
  --output /absolute/new-output-directory

Opens one fresh generated workspace and records bounded renderer/window proof.
It never fills the composer, submits, selects a model, or reads history.`;

interface ProbeBrowserGlobal {
  location: { href: string };
  document: { querySelectorAll(selector: string): ArrayLike<unknown> };
}

function codexWindowReady() {
  const browser = globalThis as unknown as ProbeBrowserGlobal;
  return {
    readyRoute: browser.location.href === 'app://-/index.html',
    appContents:
      browser.document.querySelectorAll('[data-codex-composer-root]').length >
      0,
  };
}

/** No prompt, submit, model, history read, profile import, network, or force quit. */
export async function runCodexElectronProbe(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        attempt: { type: 'string' },
        executable: { type: 'string' },
        profile: { type: 'string' },
        output: { type: 'string' },
        help: { type: 'boolean' },
      },
    }).values;
  } catch {
    console.error(USAGE);
    return 1;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const attemptId = values.attempt;
  const executablePath = values.executable;
  const profilePath = values.profile;
  const outputDir = values.output;
  if (
    typeof attemptId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(attemptId) ||
    typeof executablePath !== 'string' ||
    typeof profilePath !== 'string' ||
    typeof outputDir !== 'string' ||
    ![executablePath, profilePath, outputDir].every(isAbsolute)
  ) {
    console.error(USAGE);
    return 1;
  }

  await mkdir(outputDir, { mode: 0o700 });
  const executionDeadline = Date.now() + 60_000;
  let launchStage: string | undefined;
  const handle = launchCodexElectron({
    executablePath,
    profilePath,
    executionDeadline,
    cleanupTimeoutMs: 20_000,
    windowReady: codexWindowReady,
    onLaunchStage(stage) {
      launchStage = stage;
    },
  });
  const report: Record<string, unknown> = {
    attemptId,
    submitted: false,
    promptFilled: false,
    historyRead: false,
    inputMode: 'none',
  };
  let shutdown: CodexElectronShutdown = { status: 'not-launched' };
  try {
    const session = await handle.ready;
    const control = createCodexElectronControl({
      session,
      attemptId,
      async beforeSubmit() {
        throw new Error('Probe submission is forbidden.');
      },
    });
    await control.openFreshWorkspace(session.workspacePath);
    const observation = await control.observe();
    report.profileId = session.profile.id;
    report.pid = observation.pid;
    report.browserWindowId = observation.browserWindowId;
    report.webContentsId = observation.webContentsId;
    report.workspace = session.workspacePath;
    report.route = observation.route;
    report.modeCodexCount = observation.modeCodexCount;
    report.homeComposerRootCount = observation.homeComposerRootCount;
    report.composerCount = observation.composerCount;
    report.composerEmpty = observation.composerText === '';
    report.composerPlainText = observation.composerPlainText;
    report.workspaceFooterMatches =
      observation.footerText === basename(session.workspacePath);
    report.sendButtonCount = observation.sendButtonCount;
    report.signInCount = observation.signInCount;
    report.dialogCount = observation.dialogCount;
    report.turnCount = observation.turnCount;
  } catch (error) {
    report.error = 'Electron probe failed; no prompt or submit was attempted.';
    report.launchStage = launchStage;
    report.failureDiagnostic = getCodexElectronFailureDiagnostic(error);
  } finally {
    await handle.settled();
    shutdown = await handle.quit();
    await writeFile(
      join(outputDir, 'observation.json'),
      JSON.stringify(report, null, 2),
      { mode: 0o600, flag: 'wx' }
    );
    await writeFile(
      join(outputDir, 'shutdown.json'),
      JSON.stringify(shutdown, null, 2),
      { mode: 0o600, flag: 'wx' }
    );
  }
  console.log(
    JSON.stringify({
      output: outputDir,
      submitted: false,
      shutdown: shutdown.status,
    })
  );
  return report.error || shutdown.status !== 'exited' ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runCodexElectronProbe(process.argv.slice(2));
}
