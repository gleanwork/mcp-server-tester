import path from 'node:path';
import { resolveConfigExtends } from '../../../evals/configExtends.js';
import { loadEvalConfig } from '../../../evals/evalConfig.js';
import { resolveRunner } from '../../../evals/runners/builtinRunners.js';
import { installPlugins } from '../../../plugins/extensions.js';
import {
  loadPlugins,
  resolvePluginPackage,
  type PluginPackage,
} from '../../../plugins/loadPlugins.js';
import { parseRunnerOptions } from '../run/index.js';
import {
  settingsFor,
  type SettingsSections,
} from '../../../plugins/settings.js';
import { fileSettings } from '../../../plugins/settingsFile.js';

export interface RunnerSetupOptions {
  /** `--runner-option key=value`, each time it was given. */
  runnerOption?: string[];
  /** Plugin modules, for a plugin's runner. */
  plugins?: string[];
  /** An eval config whose plugins the runner's machines need. */
  config?: string;
  rootDir?: string;
}

/** `mst runner setup <runner>`: what runs in it need, prepared once. */
export async function setupRunner(
  reference: string,
  options: RunnerSetupOptions
): Promise<void> {
  const rootDir = path.resolve(options.rootDir ?? '.');
  if (options.plugins?.length)
    installPlugins(await loadPlugins(options.plugins, { baseDir: rootDir }));
  const fromConfig = options.config
    ? await evalPluginPackages(options.config, rootDir)
    : undefined;
  const plugins = fromConfig?.packages;
  // The eval config's settings, else the mst.config.json above rootDir's.
  const settings: SettingsSections | undefined = fromConfig
    ? fromConfig.settings
    : fileSettings(rootDir);
  // The eval's client picks the image a runner builds (docker:
  // Cowork's or ChatGPT's), as its shared configs (`extends`) set it.
  const client = fromConfig?.client;
  const runner = resolveRunner(
    reference,
    parseRunnerOptions(options.runnerOption ?? [])
  );
  if (!runner.definition.setup) {
    console.log(`${runner.name} needs no setup.`);
    return;
  }
  await runner.definition.setup(runner.options, {
    log: (line) => console.error(`[mst] ${line}`),
    settings: settingsFor(settings, runner.name),
    ...(plugins ? { plugins } : {}),
    ...(client ? { client } : {}),
  });
}

/**
 * The eval config's plugins, as packages installed on this machine, and its
 * settings. Its plugins are loaded too, in case one provides the runner.
 */
async function evalPluginPackages(
  configPath: string,
  rootDir: string
): Promise<{
  packages: PluginPackage[];
  settings?: SettingsSections;
  client?: string;
}> {
  const config = loadEvalConfig(configPath, { rootDir });
  const options = {
    baseDir: path.dirname(path.resolve(configPath)),
    fallbackDir: rootDir,
  };
  const specifiers = config.plugins ?? [];
  const loaded = installPlugins(await loadPlugins(specifiers, options));
  const { client } = resolveConfigExtends(config, [
    ...new Set(loaded.map((plugin) => plugin.meta.namespace)),
  ]);
  const packages = specifiers.map((specifier) => {
    const found = resolvePluginPackage(specifier, options);
    if (!found)
      throw new Error(
        `Plugin "${specifier}" is a file, not a package: a runner's machines install plugins as packages. Make it a package (a directory with a package.json, installed where the eval config is) and name the package in the eval config's plugins.`
      );
    return found;
  });
  return {
    packages,
    ...(config.settings ? { settings: config.settings } : {}),
    ...(client ? { client } : {}),
  };
}
