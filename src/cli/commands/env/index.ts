import path from 'node:path';
import { loadEvalConfig } from '../../../evals/evalConfig.js';
import { resolveEnvironment } from '../../../evals/environments/builtinEnvironments.js';
import { installPlugins } from '../../../plugins/extensions.js';
import {
  loadPlugins,
  resolvePluginPackage,
  type PluginPackage,
} from '../../../plugins/loadPlugins.js';
import { parseEnvOptions } from '../run/index.js';

export interface EnvSetupOptions {
  /** `--env-option key=value`, each time it was given. */
  envOption?: string[];
  /** Plugin modules, for a plugin's environment. */
  plugins?: string[];
  /** An eval config whose plugins the environment's machines need. */
  config?: string;
  rootDir?: string;
}

/** `mst env setup <environment>`: what runs in it need, prepared once. */
export async function setupEnvironment(
  reference: string,
  options: EnvSetupOptions
): Promise<void> {
  const rootDir = path.resolve(options.rootDir ?? '.');
  if (options.plugins?.length)
    installPlugins(await loadPlugins(options.plugins, { baseDir: rootDir }));
  const plugins = options.config
    ? await evalPluginPackages(options.config, rootDir)
    : undefined;
  const environment = resolveEnvironment(
    reference,
    parseEnvOptions(options.envOption ?? [])
  );
  if (!environment.definition.setup) {
    console.log(`${environment.name} needs no setup.`);
    return;
  }
  await environment.definition.setup(environment.options, {
    log: (line) => console.error(`[mst] ${line}`),
    ...(plugins ? { plugins } : {}),
  });
}

/**
 * The eval config's plugins, as packages installed on this machine. Its
 * plugins are loaded too, in case one provides the environment.
 */
async function evalPluginPackages(
  configPath: string,
  rootDir: string
): Promise<PluginPackage[]> {
  const config = loadEvalConfig(configPath, { rootDir });
  const options = {
    baseDir: path.dirname(path.resolve(configPath)),
    fallbackDir: rootDir,
  };
  const specifiers = config.plugins ?? [];
  installPlugins(await loadPlugins(specifiers, options));
  return specifiers.map((specifier) => {
    const found = resolvePluginPackage(specifier, options);
    if (!found)
      throw new Error(
        `Plugin "${specifier}" is a file, not a package: an environment's machines install plugins as packages. Make it a package (a directory with a package.json, installed where the eval config is) and name the package in the eval config's plugins.`
      );
    return found;
  });
}
