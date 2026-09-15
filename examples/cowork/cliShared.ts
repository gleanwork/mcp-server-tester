import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareSharedDesktopEval } from './prepareShared.js';
import {
  readSharedCoworkConfig,
  readSharedDesktopOracle,
  type SharedCoworkConfig,
} from './sharedConfig.js';

const USAGE = `Usage (from the repository root):
  node build/cowork-shared/examples/cowork/cliShared.js prepare /absolute/setup-directory
  node build/cowork-shared/examples/cowork/cliShared.js configure /absolute/setup-directory/cowork-run.json /absolute/cua-driver cowork-shared-001
  node build/cowork-shared/examples/cowork/cliShared.js suite /absolute/setup-directory/cowork-run.json /absolute/cua-driver cowork-shared-001
  node build/cowork-shared/examples/cowork/cliShared.js authorize /absolute/setup-directory/cowork-shared-001.json
  node build/cowork-shared/examples/cowork/cliShared.js check /absolute/setup-directory/cowork-shared-001.json
  node build/cowork-shared/examples/cowork/cliShared.js run /absolute/setup-directory/cowork-shared-001.json
  node build/cowork-shared/examples/cowork/cliShared.js teardown /absolute/setup-directory/cowork-shared-001.json

prepare/configure/authorize/check are offline. authorize records explicit operator consent for per-task Automatically-approve setup plus bounded Allow-once fallback for only the two records fixture tools. suite performs setup, test, and teardown. teardown recovers only failed pre-submit owned processes.`;

export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE);
    return;
  }
  const [command, path, runtimePath, attemptId] = args;
  if (!path) throw new Error(USAGE);
  if (command === 'configure' || command === 'suite') {
    if (args.length !== 4 || !runtimePath || !attemptId) throw new Error(USAGE);
    const { configureSharedCowork } = await import('./discoverShared.js');
    const readyPath = await configureSharedCowork(path, runtimePath, attemptId);
    console.log(`Setup complete: ${readyPath}`);
    if (command === 'configure') return;
    const config = await checkedConfig(readyPath);
    console.log('Test phase started.');
    await runConfig(config);
    return;
  }
  if (
    args.length !== 2 ||
    !['prepare', 'authorize', 'check', 'run', 'teardown'].includes(
      command ?? ''
    )
  ) {
    throw new Error(USAGE);
  }
  if (command === 'prepare') {
    await prepareSharedDesktopEval(path);
    console.log(
      `Prepared two private fixture bundles and ${path}/cowork-run.json.`
    );
    return;
  }
  const config = await baseConfig(path);
  if (command === 'authorize') {
    const { authorizeSharedCoworkTools } =
      await import('./approvalConsentShared.js');
    await authorizeSharedCoworkTools(config);
    console.log(
      'Recorded bounded automatic-mode and exact-tool HITL consent for the isolated fixture.'
    );
    return;
  }
  await assertAuthorized(config);
  if (command === 'check') {
    console.log(
      'Shared fixture, evaluator, unused output, and provisioned config passed offline checks.'
    );
    return;
  }
  if (command === 'teardown') {
    const { teardownSharedCowork } = await import('./teardownShared.js');
    const stopped = await teardownSharedCowork(config);
    console.log(`Teardown complete: ${stopped} owned process(es) stopped.`);
    return;
  }
  await runConfig(config);
}

async function baseConfig(path: string): Promise<SharedCoworkConfig> {
  const config = await readSharedCoworkConfig(path);
  await readSharedDesktopOracle(config.fixtureRoot);
  return config;
}

async function checkedConfig(path: string): Promise<SharedCoworkConfig> {
  const config = await baseConfig(path);
  await assertAuthorized(config);
  return config;
}

async function assertAuthorized(config: SharedCoworkConfig): Promise<void> {
  const { assertSharedCoworkToolAuthorization } =
    await import('./approvalConsentShared.js');
  await assertSharedCoworkToolAuthorization(config);
}

async function runConfig(config: SharedCoworkConfig): Promise<void> {
  const { runSharedCoworkEval } = await import('./runShared.js');
  const { result, runtimeRetained } = await runSharedCoworkEval(config);
  console.log(
    `${result.passed}/${result.total} shared Cowork cases passed. Results: ${config.outputDir}/results.json`
  );
  if (!runtimeRetained) console.log('Teardown complete.');
  process.exitCode = result.failed || runtimeRetained ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Shared Cowork eval failed.'
    );
    process.exitCode = 1;
  });
}
