import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { CodexProcessFacade } from './launcher.js';
import { CODEX_DESKTOP_BUILD } from './version.js';

interface CodexApplication {
  executablePath: string;
  bundlePath: string;
  version: string;
}

const EXPECTED_CODEX_TEAM_IDENTIFIER = '2DC432GLL2';
const CODEX_FAMILY_TOKEN =
  /(?:^|[^A-Za-z0-9])(?:Codex|ChatGPT)(?:[^A-Za-z0-9]|$)/i;

function bundleForExecutable(executablePath: string): string | undefined {
  return /^(.*?\.app)\/Contents\//.exec(executablePath)?.[1];
}

export async function identifyCodexApplication(
  executablePath: string,
  processes: CodexProcessFacade
): Promise<CodexApplication> {
  if (processes.platform !== 'darwin')
    throw new Error('Codex app setup requires macOS.');
  try {
    if (!isAbsolute(executablePath)) throw new Error('relative');
    const canonical = await realpath(executablePath);
    const bundlePath = bundleForExecutable(canonical);
    if (
      !bundlePath ||
      dirname(canonical) !== join(bundlePath, 'Contents/MacOS')
    )
      throw new Error('not app');
    const info = await processes.readBundleInfo(bundlePath);
    const signature = await processes.verifyBundleSignature?.(bundlePath);
    if (
      info.identifier !== 'com.openai.codex' ||
      info.executable !== basename(canonical) ||
      info.version !== CODEX_DESKTOP_BUILD ||
      signature?.teamIdentifier !== EXPECTED_CODEX_TEAM_IDENTIFIER
    )
      throw new Error('identity');
    if (!(await stat(canonical)).isFile()) throw new Error('not file');
    await access(canonical, constants.X_OK);
    return {
      executablePath: canonical,
      bundlePath,
      version: CODEX_DESKTOP_BUILD,
    };
  } catch {
    throw new Error(
      'An explicit executable from the com.openai.codex macOS Codex app is required; no CLI substitution.'
    );
  }
}

/** Uses executable paths and bundle metadata, never process display names or argv. */
export async function assertNoCodexProcesses(
  application: CodexApplication,
  processes: CodexProcessFacade
): Promise<void> {
  let found = false;
  try {
    const bundles = new Map<string, string>();
    for (const running of await processes.listProcesses()) {
      const bundle = bundleForExecutable(running.executablePath);
      if (
        running.executablePath === application.executablePath ||
        bundle === application.bundlePath
      ) {
        found = true;
        break;
      }
      if (bundle && CODEX_FAMILY_TOKEN.test(running.executablePath)) {
        let identifier = bundles.get(bundle);
        if (!identifier) {
          identifier = (await processes.readBundleInfo(bundle)).identifier;
          bundles.set(bundle, identifier);
        }
        if (identifier === 'com.openai.codex') {
          found = true;
          break;
        }
      } else if (
        !isAbsolute(running.executablePath) &&
        CODEX_FAMILY_TOKEN.test(running.executablePath)
      ) {
        // An incomplete process identity is not evidence that launch is safe.
        throw new Error('ambiguous');
      }
    }
  } catch {
    throw new Error('Cannot verify that no Codex app processes are running.');
  }
  if (found)
    throw new Error(
      'A Codex app process is already running. Quit it yourself before setup.'
    );
}
