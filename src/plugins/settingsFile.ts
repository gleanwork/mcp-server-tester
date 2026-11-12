import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  mergeSettings,
  SettingsSectionsSchema,
  type SettingsSections,
} from './settings.js';
import {
  mergeModelDefaults,
  ModelDefaultsSchema,
  type ModelDefaults,
} from '../llm/modelDefaults.js';

/**
 * Finding and reading `mst.config.json`: plugin settings (ADR 0008) and
 * model defaults (ADR 0015). Kept apart from settings.ts, which bundles that
 * only resolve settings (the reporter) also use, so they don't import the
 * file system for nothing.
 *
 * MST reads up to three files, lowest first:
 *
 * - the user's, `~/.mcp-server-tester/mst.config.json` (`MST_USER_CONFIG`
 *   names another; empty reads none). It may set only `models`: settings
 *   belong to the repo that runs evals.
 * - the repo's: the nearest `mst.config.json` at or above the eval config.
 * - the command line's, `mst --mst-config <path>`.
 */

/** The file a repo's plugin settings and model defaults are kept in. */
export const SETTINGS_FILE = 'mst.config.json';

const SettingsFileSchema = z
  .object({
    /** The editor schema the file may point to. */
    $schema: z.string().optional(),
    settings: SettingsSectionsSchema.optional(),
    models: ModelDefaultsSchema.optional(),
  })
  .strict();

/** What an `mst.config.json` sets. */
export interface ConfigFile {
  settings?: SettingsSections;
  models?: ModelDefaults;
}

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

/** What an `mst.config.json` sets: its settings sections and model defaults. */
export function readConfigFile(file: string): ConfigFile {
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
  const { settings, models } = result.data;
  return {
    ...(settings ? { settings } : {}),
    ...(models ? { models } : {}),
  };
}

/** The settings sections of an `mst.config.json`. */
function readSettingsFile(file: string): SettingsSections {
  return readConfigFile(file).settings ?? {};
}

/**
 * The user's `mst.config.json`: `MST_USER_CONFIG` when set (empty: none),
 * else `~/.mcp-server-tester/mst.config.json`. Undefined when there is none.
 */
function userConfigFile(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const named = env.MST_USER_CONFIG;
  if (named === '') return undefined;
  const file =
    named ?? path.join(os.homedir(), '.mcp-server-tester', SETTINGS_FILE);
  return fs.existsSync(file) ? file : undefined;
}

/** The user's `mst.config.json`, read: only its `models`. */
export function readUserConfigFile(
  env: NodeJS.ProcessEnv = process.env
): ModelDefaults | undefined {
  const file = userConfigFile(env);
  if (!file) return undefined;
  const { settings, models } = readConfigFile(file);
  if (settings)
    throw new Error(
      `${file} is your own mst.config.json, which sets only \`models\`. Plugin settings belong in the repo's mst.config.json (ADR 0008).`
    );
  return models;
}

/**
 * The model defaults the files give code in `dir` that has no eval config,
 * such as a Playwright test: the user's, under the repo's (the nearest
 * `mst.config.json` at or above `dir`).
 */
export function fileModelDefaults(dir: string): ModelDefaults | undefined {
  const repo = findSettingsFile(dir);
  return mergeModelDefaults(
    readUserConfigFile(),
    repo ? readConfigFile(repo).models : undefined
  );
}

let overrideFile: string | undefined;

/**
 * The file `mst --mst-config <path>` names, read on top of the user's and
 * the repo's for every eval config this process loads. Undefined clears it.
 */
export function setConfigOverrideFile(file: string | undefined): void {
  if (file !== undefined && !fs.existsSync(file))
    throw new Error(`--mst-config: ${path.resolve(file)} doesn't exist.`);
  overrideFile = file === undefined ? undefined : path.resolve(file);
}

/** The file `setConfigOverrideFile` named, if any. */
export function configOverrideFile(): string | undefined {
  return overrideFile;
}

/**
 * The plugin settings commands without an eval config use in `dir`: the
 * repo's `mst.config.json`, with the `--mst-config` file's sections over
 * it. Undefined when neither exists.
 */
export function fileSettings(dir: string): SettingsSections | undefined {
  const repo = findSettingsFile(dir);
  const settings = repo ? readSettingsFile(repo) : undefined;
  return overrideFile
    ? mergeSettings(settings, readSettingsFile(overrideFile))
    : settings;
}
