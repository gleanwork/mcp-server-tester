import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { prepareCoworkApplication } from '../../src/evals/cowork/application.js';
import { writePrivateJson } from './files.js';
import type { SharedCoworkConfig } from './sharedConfig.js';

const DiagnosticSchema = z
  .object({
    ownedPid: z.number().int().positive().optional(),
    submitArmed: z.boolean(),
    quarantined: z.boolean(),
  })
  .passthrough();

/** Recover only suite-owned processes from failed runs that never armed submit. */
export async function teardownSharedCowork(
  config: SharedCoworkConfig
): Promise<number> {
  const receiptRoot = join(
    config.fixtureRoot,
    'evaluator',
    'cowork-attempts',
    config.attemptId
  );
  const caseNames = await directoryNames(receiptRoot);
  for (const caseName of caseNames) {
    if (await exists(join(receiptRoot, caseName, 'armed.json'))) {
      throw new Error(
        'Automatic teardown refused: a submit receipt requires native reconciliation.'
      );
    }
  }

  const attemptRoot = join(config.outputDir, 'attempts');
  const pids = new Set<number>();
  for (const caseName of await directoryNames(attemptRoot)) {
    const diagnosticsPath = join(attemptRoot, caseName, 'diagnostics.json');
    if (!(await exists(diagnosticsPath))) continue;
    const diagnostics = DiagnosticSchema.parse(
      JSON.parse(await readFile(diagnosticsPath, 'utf8'))
    );
    if (diagnostics.submitArmed) {
      throw new Error(
        'Automatic teardown refused: diagnostics report an armed submission.'
      );
    }
    if (diagnostics.quarantined && diagnostics.ownedPid)
      pids.add(diagnostics.ownedPid);
  }

  if (pids.size === 0) return 0;
  const application = await prepareCoworkApplication({
    executablePath: config.executablePath,
    profilePath: config.profilePath,
  });
  for (const pid of pids) await application.stop(pid, 15_000);
  await writePrivateJson(join(config.outputDir, 'teardown.json'), {
    automatic: true,
    submitted: false,
    stoppedOwnedProcesses: pids.size,
  });
  return pids.size;
}

async function directoryNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
