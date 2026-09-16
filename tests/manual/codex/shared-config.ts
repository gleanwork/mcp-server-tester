import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { requireAbsent, writePrivateJson } from './files.js';

const absolutePath = z
  .string()
  .refine(
    (value) =>
      isAbsolute(value) &&
      resolve(value) === value &&
      !value.includes('REPLACE_ME'),
    'Use a canonical absolute path without placeholders'
  );

export const SharedCodexConfigSchema = z
  .object({
    attemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/),
    executablePath: absolutePath,
    profilePath: absolutePath,
    outputDir: absolutePath,
  })
  .strict();

export type SharedCodexConfig = z.infer<typeof SharedCodexConfigSchema>;

export function parseSharedCodexConfig(value: unknown): SharedCodexConfig {
  return SharedCodexConfigSchema.parse(value);
}

export async function readSharedCodexConfig(
  path: string
): Promise<SharedCodexConfig> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(
      'Codex shared config path must be canonical and absolute.'
    );
  }
  const config = parseSharedCodexConfig(
    JSON.parse(await readFile(path, 'utf8'))
  );
  await Promise.all([
    access(config.executablePath, constants.X_OK),
    assertCanonicalDirectory(config.profilePath),
    assertCanonicalOutputParent(config.outputDir),
    requireAbsent(config.outputDir),
  ]);
  return config;
}

export async function writeSharedCodexConfig(
  path: string,
  value: unknown
): Promise<SharedCodexConfig> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(
      'Codex shared config path must be canonical and absolute.'
    );
  }
  const config = parseSharedCodexConfig(value);
  await writePrivateJson(path, config);
  return config;
}

export function caseAttemptId(
  suiteAttemptId: string,
  index: number,
  caseId: string
): string {
  const attemptId = `${suiteAttemptId}-${index + 1}-${caseId}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(attemptId)) {
    throw new Error('Canonical case produced an invalid Codex attempt ID.');
  }
  return attemptId;
}

export function caseOutputDir(
  outputDir: string,
  index: number,
  caseId: string
): string {
  return join(outputDir, 'cases', `${index + 1}-${caseId}`);
}

async function assertCanonicalDirectory(path: string): Promise<void> {
  if ((await realpath(path)) !== path) {
    throw new Error(`Directory must be canonical: ${path}`);
  }
}

async function assertCanonicalOutputParent(path: string): Promise<void> {
  const parent = dirname(path);
  const canonicalParent = await realpath(parent);
  if (join(canonicalParent, basename(path)) !== path) {
    throw new Error('Output path must have a canonical existing parent.');
  }
}
