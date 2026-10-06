import path from 'node:path';
import type { EvalDataset } from './datasetTypes.js';
import type { EvalManifest } from './evalManifest.js';
import { assertListedNamespaces } from './manifestValidation.js';
import { installPlugins } from '../plugins/extensions.js';
import { loadPlugins } from '../plugins/loadPlugins.js';
import type { Plugin } from '../plugins/plugin.js';

export interface SuitePluginSources {
  manifestPath: string;
  manifest: EvalManifest;
  /** The working directory: the fallback for manifest specifiers, and where CLI specifiers resolve. */
  rootDir: string;
  /** From the CLI (`--plugins`); added to the manifest's own list. */
  pluginPaths?: readonly string[];
  /** Plugin objects passed in code. */
  plugins?: readonly Plugin[];
}

/**
 * Load and install every plugin a suite uses: the manifest's `plugins`
 * (relative to the manifest, then `rootDir`, then as packages), CLI paths, and
 * objects passed in code. Returns the namespaces the suite may reference.
 */
export async function loadSuitePlugins(
  sources: SuitePluginSources
): Promise<string[]> {
  const manifestDir = path.dirname(path.resolve(sources.manifestPath));
  const plugins = installPlugins([
    ...(await loadPlugins(sources.manifest.plugins ?? [], {
      baseDir: manifestDir,
      fallbackDir: sources.rootDir,
    })),
    ...(await loadPlugins(sources.pluginPaths ?? [], {
      baseDir: sources.rootDir,
    })),
    ...(sources.plugins ?? []),
  ]);
  return [...new Set(plugins.map((plugin) => plugin.meta.namespace))].sort();
}

/** Extensions a dataset's cases name themselves: hosts and judges. */
function datasetReferences(dataset: EvalDataset): string[] {
  const hosts = dataset.cases.flatMap((evalCase) =>
    typeof evalCase.host?.type === 'string' ? [evalCase.host.type] : []
  );
  const judges = dataset.cases.flatMap((evalCase) => {
    const configs = evalCase.assertions?.passesJudge;
    const list = Array.isArray(configs) ? configs : configs ? [configs] : [];
    return list.flatMap((judge) =>
      typeof judge.judge === 'string' ? [judge.judge] : []
    );
  });
  return [...hosts, ...judges];
}

/** Datasets may name plugin extensions too; they must come from the suite's plugins. */
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
