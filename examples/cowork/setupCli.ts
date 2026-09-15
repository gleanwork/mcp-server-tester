import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  launchIsolatedCoworkSetup,
  openIsolatedCoworkBundle,
  stopIsolatedCoworkSetup,
} from './setupIsolated.js';

const USAGE = `Usage:
  npx tsx examples/cowork/setupCli.ts launch /absolute/setup/cowork-run.json
  npx tsx examples/cowork/setupCli.ts open-records /absolute/setup/cowork-run.json
  npx tsx examples/cowork/setupCli.ts open-decoy /absolute/setup/cowork-run.json
  npx tsx examples/cowork/setupCli.ts stop /absolute/setup/cowork-run.json

Launch uses only the dedicated profile. Authentication, MFA, installation consent,
and tool approvals remain user-controlled.`;

export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE);
    return;
  }
  const [command, configPath] = args;
  if (!configPath || args.length !== 2) throw new Error(USAGE);
  if (command === 'launch') {
    const pid = await launchIsolatedCoworkSetup(configPath);
    console.log(`Launched isolated Claude Desktop setup process ${pid}.`);
    return;
  }
  if (command === 'stop') {
    await stopIsolatedCoworkSetup(configPath);
    console.log('Stopped the isolated Claude Desktop setup process.');
    return;
  }
  if (command === 'open-records') {
    await openIsolatedCoworkBundle(configPath, 'desktop_records');
    console.log('Opened the records fixture installation dialog.');
    return;
  }
  if (command === 'open-decoy') {
    await openIsolatedCoworkBundle(configPath, 'desktop_decoy');
    console.log('Opened the decoy fixture installation dialog.');
    return;
  }
  throw new Error(USAGE);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Cowork setup failed.'
    );
    process.exitCode = 1;
  });
}
