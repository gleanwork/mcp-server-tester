import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  CLAUDE_DESKTOP_BUILD,
  prepareCoworkApplication,
} from '@gleanwork/mcp-server-tester';
import { createPrivateDirectory, writePrivateJson } from './files.js';

const SetupConfigSchema = z
  .object({
    executablePath: z.string().refine(isAbsolute),
    profilePath: z.string().refine(isAbsolute),
    fixtureRoot: z.string().refine(isAbsolute),
  })
  .passthrough();

export async function launchIsolatedCoworkSetup(
  configPath: string
): Promise<number> {
  const config = await readSetupConfig(configPath);
  await assertNoClaudeDesktopProcess(config.executablePath);
  const application = await prepareCoworkApplication({
    executablePath: config.executablePath,
    profilePath: config.profilePath,
  });
  let pid: number | undefined;
  await application.launch((ownedPid) => {
    if (pid !== undefined)
      throw new Error('Setup launch reported multiple PIDs.');
    pid = ownedPid;
  });
  if (pid === undefined) throw new Error('Setup launch returned no owned PID.');
  await application.activate(pid, 'claude://cowork/new');
  const launches = join(config.fixtureRoot, 'setup-launches');
  try {
    await createPrivateDirectory(launches);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error;
    }
  }
  await writePrivateJson(join(launches, `${randomUUID()}.json`), {
    version: 1,
    pid,
    appVersion: CLAUDE_DESKTOP_BUILD,
    profilePath: application.profile.paths.root,
    launchedAt: new Date().toISOString(),
  });
  return pid;
}

export async function stopIsolatedCoworkSetup(
  configPath: string
): Promise<void> {
  const config = await readSetupConfig(configPath);
  const pids = await claudeDesktopPids(config.executablePath);
  if (pids.length !== 1)
    throw new Error('Exactly one Claude Desktop process is required.');
  const application = await prepareCoworkApplication({
    executablePath: config.executablePath,
    profilePath: config.profilePath,
  });
  await application.stop(pids[0]!, 15_000);
}

export async function openIsolatedCoworkBundle(
  configPath: string,
  label: 'desktop_records' | 'desktop_decoy'
): Promise<void> {
  const config = await readSetupConfig(configPath);
  const pid = await isolatedClaudeDesktopPid(config.executablePath);
  const application = await prepareCoworkApplication({
    executablePath: config.executablePath,
    profilePath: config.profilePath,
  });
  const bundle = join(
    config.fixtureRoot,
    'evaluator',
    'bundles',
    `${label}.mcpb`
  );
  await application.openFile(pid, bundle);
}

async function readSetupConfig(path: string) {
  return SetupConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

async function assertNoClaudeDesktopProcess(
  executablePath: string
): Promise<void> {
  const pids = await claudeDesktopPids(executablePath);
  if (pids.length > 0) {
    throw new Error(
      'A Claude Desktop process already exists; setup launch refused.'
    );
  }
}

async function isolatedClaudeDesktopPid(
  executablePath: string
): Promise<number> {
  const pids = await claudeDesktopPids(executablePath);
  if (pids.length !== 1) {
    throw new Error('Exactly one isolated Claude Desktop process is required.');
  }
  return pids[0]!;
}

async function claudeDesktopPids(executablePath: string): Promise<number[]> {
  const { stdout } = await promisify(execFile)(
    '/bin/ps',
    ['-axo', 'pid=,comm='],
    { env: {}, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout
    .split('\n')
    .map((line) => /^(\s*\d+)\s+(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => match[2] === executablePath)
    .map((match) => Number(match[1]));
}
