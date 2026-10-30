import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SettingsSectionsSchema, type SettingsSections } from './settings.js';

/**
 * Finding and reading `mst.config.json` (ADR 0008). Kept apart from
 * settings.ts, which bundles that only resolve settings (the reporter, the
 * fixtures) also use, so they don't import the file system for nothing.
 */

/** The file a repo's plugin settings are kept in. */
export const SETTINGS_FILE = 'mst.config.json';

const SettingsFileSchema = z
  .object({
    /** The editor schema the file may point to. */
    $schema: z.string().optional(),
    settings: SettingsSectionsSchema.optional(),
  })
  .strict();

/**
 * The `mst.config.json` that applies to an eval config in `dir`: in `dir` or
 * the nearest directory above it, stopping at the repository root (the
 * directory that holds `.git`). Undefined when there is none.
 */
export function findSettingsFile(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const candidate = path.join(current, SETTINGS_FILE);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(current, '.git'))) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The settings sections of an `mst.config.json`. */
export function readSettingsFile(file: string): SettingsSections {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Settings file ${file} isn't valid JSON: ${(error as Error).message}`,
      { cause: error }
    );
  }
  const result = SettingsFileSchema.safeParse(raw);
  if (!result.success)
    throw new Error(`Invalid settings file ${file}: ${result.error.message}`);
  return result.data.settings ?? {};
}
