import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'import-meta-resolve';
import { assertPlugin, type Plugin } from './plugin.js';

export interface LoadPluginsOptions {
  /** Where relative specifiers resolve first (a manifest's directory). */
  baseDir?: string;
  /** Where they resolve next (the working directory). Defaults to cwd. */
  fallbackDir?: string;
}

// Shared across the CommonJS and ESM copies of this package, so each plugin
// module is imported, and validated, once per process.
const PLUGIN_LOADS_KEY = Symbol.for('mcp-server-tester.plugin-loads');
const globalState = globalThis as unknown as Record<symbol, unknown>;
const pluginLoads = (globalState[PLUGIN_LOADS_KEY] ??= new Map<
  string,
  Promise<Plugin>
>()) as Map<string, Promise<Plugin>>;

const INDEX_FILES = ['index.ts', 'index.js', 'index.mjs', 'index.cjs'];

function fileOrIndex(candidate: string): string | undefined {
  if (!fs.existsSync(candidate)) return undefined;
  if (fs.statSync(candidate).isFile()) return candidate;
  for (const index of INDEX_FILES) {
    const file = path.join(candidate, index);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve a package specifier from `dir` exactly as `import` would (exports
 * maps, conditions, subpath patterns, `main`), using Node's algorithm through
 * import-meta-resolve, as Prettier does for its plugins. Returns undefined
 * when no such package is installed there.
 */
function resolvePackage(specifier: string, dir: string): string | undefined {
  // Resolution is relative to a file in `dir`; the file needn't exist.
  const parent = pathToFileURL(path.join(dir, 'mst-plugins.js')).href;
  try {
    const url = resolve(specifier, parent);
    // `fs` resolves to node:fs, which is not a plugin.
    return url.startsWith('file:') ? fileURLToPath(url) : undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw new Error(
      `Plugin "${specifier}" can't be imported: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

/** `.`, `..`, `./x` and `../x` name paths; anything else may be a package. */
function isPathSpecifier(specifier: string): boolean {
  return /^\.\.?(?:[/\\]|$)/.test(specifier);
}

/** Manifest directory, then working directory, then package (ADR-0001). */
function resolveEntry(specifier: string, options: LoadPluginsOptions): string {
  const dirs = [
    ...new Set([
      options.baseDir ?? process.cwd(),
      options.fallbackDir ?? process.cwd(),
    ]),
  ];
  if (path.isAbsolute(specifier)) {
    const entry = fileOrIndex(specifier);
    if (entry) return entry;
    throw new Error(`Plugin "${specifier}" not found.`);
  } else {
    for (const dir of dirs) {
      const entry = fileOrIndex(path.resolve(dir, specifier));
      if (entry) return entry;
    }
    if (!isPathSpecifier(specifier)) {
      for (const dir of dirs) {
        const entry = resolvePackage(specifier, dir);
        if (entry) return entry;
      }
    }
  }
  throw new Error(
    `Plugin "${specifier}" not found (looked in ${dirs.join(', ')}${isPathSpecifier(specifier) ? '' : ', then for a package'}).`
  );
}

async function importPlugin(entry: string, specifier: string): Promise<Plugin> {
  const module = (await import(pathToFileURL(entry).href)) as Record<
    string,
    unknown
  >;
  if (module.default === undefined) {
    // A 1.x module exports register(); assertPlugin gives it the migration message.
    if (typeof module.register === 'function') assertPlugin(module, specifier);
    throw new Error(`Plugin at ${specifier} has no default export.`);
  }
  // Importing CommonJS gives `module.exports` as the default; a module compiled
  // from ESM keeps its own default one level down.
  const value = module.default;
  const plugin =
    isRecord(value) && value.__esModule === true && 'default' in value
      ? value.default
      : value;
  return assertPlugin(plugin, specifier);
}

async function loadPlugin(
  specifier: string,
  options: LoadPluginsOptions
): Promise<Plugin> {
  const entry = fs.realpathSync(resolveEntry(specifier, options));
  const existing = pluginLoads.get(entry);
  if (existing) return existing;
  const loading = importPlugin(entry, specifier);
  pluginLoads.set(entry, loading);
  try {
    return await loading;
  } catch (error) {
    if (pluginLoads.get(entry) === loading) pluginLoads.delete(entry);
    throw error;
  }
}

/**
 * Import plugin modules or packages and return their plugin objects, in
 * order. Loading does not install them; see `installPlugins`.
 */
export async function loadPlugins(
  specifiers: readonly string[],
  options: LoadPluginsOptions = {}
): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const specifier of specifiers)
    plugins.push(await loadPlugin(specifier, options));
  return plugins;
}
