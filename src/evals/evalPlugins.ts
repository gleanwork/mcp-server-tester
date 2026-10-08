import path from 'node:path';
import type { EvalDataset } from './datasetTypes.js';
import type { EvalConfig } from './evalConfig.js';
import { assertListedNamespaces } from './configValidation.js';
import { installPlugins } from '../plugins/extensions.js';
import { loadPlugins } from '../plugins/loadPlugins.js';
import type { Plugin } from '../plugins/plugin.js';

export interface EvalPluginSources {
  configPath: string;
  evalConfig: EvalConfig;
  /** The working directory: the fallback for eval config specifiers, and where CLI specifiers resolve. */
  rootDir: string;
  /** From the CLI (`--plugins`); added to the eval config's own list. */
  pluginPaths?: readonly string[];
  /** Plugin objects passed in code. */
  plugins?: readonly Plugin[];
}

/**
 * Load and install every plugin an eval uses: the eval config's `plugins`
 * (relative to the eval config, then `rootDir`, then as packages), CLI paths, and
 * objects passed in code. Returns the namespaces the eval may reference.
 */
export async function loadEvalPlugins(
  sources: EvalPluginSources
): Promise<string[]> {
  const configDir = path.dirname(path.resolve(sources.configPath));
  const plugins = installPlugins([
    ...(await loadPlugins(sources.evalConfig.plugins ?? [], {
      baseDir: configDir,
      fallbackDir: sources.rootDir,
    })),
    ...(await loadPlugins(sources.pluginPaths ?? [], {
      baseDir: sources.rootDir,
    })),
    ...(sources.plugins ?? []),
  ]);
  return [...new Set(plugins.map((plugin) => plugin.meta.namespace))].sort();
}

/** Extensions a dataset's cases name themselves: clients and judges. */
function datasetReferences(dataset: EvalDataset): string[] {
  const clients = dataset.cases.flatMap((evalCase) =>
    typeof evalCase.client === 'string' ? [evalCase.client] : []
  );
  const judges = dataset.cases.flatMap((evalCase) =>
    (evalCase.judges ?? []).map((judge) =>
      typeof judge === 'string' ? judge : judge.type
    )
  );
  return [...clients, ...judges];
}

/** Datasets may name plugin extensions too; they must come from the eval's plugins. */
export function assertDatasetNamespaces(
  dataset: EvalDataset,
  namespaces: readonly string[]
): void {
  assertListedNamespaces(
    datasetReferences(dataset),
    namespaces,
    `Dataset "${dataset.name}"`
  );
}
