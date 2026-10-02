import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

/** Plugins are imported, so package exports resolve with ESM conditions. */
const CONDITIONS = new Set(['import', 'module-sync', 'node', 'default']);

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item);
      if (target) return target;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  // Condition order is the package's, as in Node.
  for (const [condition, nested] of Object.entries(value)) {
    if (!CONDITIONS.has(condition)) continue;
    const target = exportTarget(nested);
    if (target) return target;
  }
  return undefined;
}

function packageParts(
  specifier: string
): { name: string; subpath: string } | undefined {
  const parts = specifier.split('/');
  const nameLength = specifier.startsWith('@') ? 2 : 1;
  if (
    parts.length < nameLength ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    return undefined;
  const rest = parts.slice(nameLength);
  return {
    name: parts.slice(0, nameLength).join('/'),
    subpath: rest.length ? `./${rest.join('/')}` : '.',
  };
}

function findPackageDir(name: string, fromDir: string): string | undefined {
  for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * Resolve a package specifier the way `import` would: the `exports` map with
 * import/node/default conditions, or `main`. Subpath patterns aren't supported.
 */
function resolvePackage(specifier: string, dir: string): string | undefined {
  const parts = packageParts(specifier);
  if (!parts) return undefined;
  const packageDir = findPackageDir(parts.name, dir);
  if (!packageDir) return undefined;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
  ) as { exports?: unknown; main?: unknown };
  if (manifest.exports !== undefined) {
    const exportsMap =
      isRecord(manifest.exports) &&
      Object.keys(manifest.exports).some((key) => key.startsWith('.'))
        ? manifest.exports
        : { '.': manifest.exports };
    const target = exportTarget(exportsMap[parts.subpath]);
    if (!target) {
      throw new Error(
        `Plugin package "${parts.name}" doesn't export "${parts.subpath}" for import.`
      );
    }
    // As in Node, targets stay inside the package.
    if (!target.startsWith('./') || target.split('/').includes('..')) {
      throw new Error(
        `Plugin package "${parts.name}" exports "${parts.subpath}" to "${target}", which is not a "./" path inside the package.`
      );
    }
    return path.join(packageDir, target);
  }
  if (parts.subpath !== '.')
    return fileOrIndex(path.join(packageDir, parts.subpath));
  const main = typeof manifest.main === 'string' ? manifest.main : '';
  return withExtension(path.join(packageDir, main));
}

/** A CommonJS `main` may omit its extension. */
function withExtension(candidate: string): string | undefined {
  return (
    fileOrIndex(candidate) ??
    ['.js', '.cjs', '.mjs']
      .map((extension) => candidate + extension)
      .find((file) => fs.existsSync(file) && fs.statSync(file).isFile())
  );
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
