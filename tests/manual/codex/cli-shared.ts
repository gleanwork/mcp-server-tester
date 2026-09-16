import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readSharedCodexConfig,
  writeSharedCodexConfig,
} from './shared-config.js';

const USAGE = `Usage (from the repository root):
  node build/codex-shared/tests/manual/codex/cli-shared.js configure /absolute/codex-run.json SUITE_ATTEMPT_ID /absolute/pinned/Codex /absolute/dedicated/profile /absolute/new-output
  node build/codex-shared/tests/manual/codex/cli-shared.js check /absolute/codex-run.json
  node build/codex-shared/tests/manual/codex/cli-shared.js run /absolute/codex-run.json

configure and check are offline. run executes the three canonical desktop-eval cases sequentially. Each case gets a fresh attempt ID and output directory. A quarantined or unverified lifecycle stops later cases.`;

export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE);
    return;
  }
  const [command, path, attemptId, executablePath, profilePath, outputDir] =
    args;
  if (!path) throw new Error(USAGE);
  if (command === 'configure') {
    if (
      args.length !== 6 ||
      !attemptId ||
      !executablePath ||
      !profilePath ||
      !outputDir
    ) {
      throw new Error(USAGE);
    }
    await writeSharedCodexConfig(path, {
      attemptId,
      executablePath,
      profilePath,
      outputDir,
    });
    console.log(`Wrote Codex shared config: ${path}`);
    return;
  }
  if (args.length !== 2 || (command !== 'check' && command !== 'run')) {
    throw new Error(USAGE);
  }
  const config = await readSharedCodexConfig(path);
  if (command === 'check') {
    console.log(
      'Codex shared config, executable, profile, and unused output passed offline checks.'
    );
    return;
  }
  const { runSharedCodexEval } = await import('./run-shared.js');
  const result = await runSharedCodexEval(config);
  console.log(
    `${result.passed}/${result.planned} shared Codex cases passed. Results: ${config.outputDir}/suite-result.json`
  );
  if (result.fixtureRetained) {
    console.error(
      'The fixture and profile lifecycle are retained for manual review. Do not retry this profile.'
    );
  }
  process.exitCode =
    result.passed === result.planned && !result.fixtureRetained ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Shared Codex eval failed.'
    );
    process.exitCode = 1;
  });
}
