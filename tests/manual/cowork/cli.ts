import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkConfig } from './config.js';
import { prepareFixture } from './prepare.js';

const USAGE = `Usage (from the repository root):
  node build/cowork/cli.js prepare /absolute/unused/setup-directory
  node build/cowork/cli.js check /absolute/setup-directory/run.json
  node build/cowork/cli.js run /absolute/setup-directory/run.json

prepare/check are offline. Only run connects to the desktop and submits a task.
Install the fixture, approve it, verify the native config, and quit Claude manually first.`;

export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE);
    return;
  }
  const [command, path] = args;
  if (
    args.length !== 2 ||
    !path ||
    !['prepare', 'check', 'run'].includes(command ?? '')
  )
    throw new Error(USAGE);
  if (command === 'prepare') {
    await prepareFixture(path);
    console.log(
      `Prepared ${path}/fixture.mcpb and private evaluator.json. Edit ${path}/run.json before use.`
    );
    return;
  }
  const config = await checkConfig(path);
  if (command === 'check') {
    console.log(
      'Offline config, bundle checksum, and unused paths passed. Native installation, permissions, and prefix still require manual verification.'
    );
    return;
  }
  const { runCoworkExample } = await import('./run.js');
  const { result, runtimeRetained } = await runCoworkExample(config);
  console.log(
    `${result.passed}/${result.total} cases passed. Results: ${config.outputDir}/results.json`
  );
  process.exitCode = result.failed || runtimeRetained ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Cowork example failed'
    );
    // Never force process exit: a retained Cua runtime may hold native state.
    process.exitCode = 1;
  });
}
