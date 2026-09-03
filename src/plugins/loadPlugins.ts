import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface EvalPluginModule {
  register?: () => void | Promise<void>;
  default?: () => void | Promise<void>;
  [exportName: string]: unknown;
}

export interface LoadPluginsOptions {
  /** Additional register function names to invoke after import. */
  registerExportNames?: string[];
}

const DEFAULT_REGISTER_EXPORTS = [
  'register',
  'registerPlugins',
  'registerGleanJudges',
];

function resolvePluginEntry(pluginPath: string): string {
  const absPath = path.isAbsolute(pluginPath)
    ? pluginPath
    : path.resolve(process.cwd(), pluginPath);

  if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
    return absPath;
  }

  const candidates = [
    path.join(absPath, 'index.ts'),
    path.join(absPath, 'index.js'),
    path.join(absPath, 'index.mjs'),
    path.join(absPath, 'index.cjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Plugin entry not found for: ${pluginPath}`);
}

async function invokeRegisterExport(
  pluginModule: EvalPluginModule,
  exportName: string
): Promise<boolean> {
  const candidate = pluginModule[exportName];
  if (typeof candidate !== 'function') {
    return false;
  }
  const register = candidate as () => void | Promise<void>;
  await register();
  return true;
}

/**
 * Dynamically import a plugin module and invoke its registration hooks.
 *
 * Convention (first match wins):
 * 1. Named export `register`, `registerPlugins`, or `registerGleanJudges`
 * 2. Default export function
 */
export async function loadPluginModule(
  pluginPath: string,
  options: LoadPluginsOptions = {}
): Promise<void> {
  const entry = resolvePluginEntry(pluginPath);
  const pluginModule = (await import(
    pathToFileURL(entry).href
  )) as EvalPluginModule;
  const exportNames = [
    ...(options.registerExportNames ?? []),
    ...DEFAULT_REGISTER_EXPORTS,
  ];

  for (const exportName of exportNames) {
    if (await invokeRegisterExport(pluginModule, exportName)) {
      return;
    }
  }

  if (typeof pluginModule.default === 'function') {
    await pluginModule.default();
    return;
  }

  throw new Error(
    `Plugin at ${entry} does not export a register function. ` +
      `Expected one of: ${exportNames.join(', ')}, or a default function.`
  );
}

/**
 * Load one or more plugin paths in order.
 */
export async function loadPlugins(
  pluginPaths: string[],
  options: LoadPluginsOptions = {}
): Promise<void> {
  for (const pluginPath of pluginPaths) {
    await loadPluginModule(pluginPath, options);
  }
}
