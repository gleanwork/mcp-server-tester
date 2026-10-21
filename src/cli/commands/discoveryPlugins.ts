/**
 * Plugins for the discovery commands (`mst datasets`, `mst judges`): an eval
 * config's (`--config`, plus `--plugins`), or `--plugins` alone.
 */
import path from 'node:path';
import { loadEvalConfig } from '../../evals/evalConfig.js';
import { loadEvalPlugins } from '../../evals/evalPlugins.js';
import { installPlugins } from '../../plugins/extensions.js';
import { loadPlugins } from '../../plugins/loadPlugins.js';
import { parseExtensionReference } from '../../plugins/plugin.js';
import {
  evalSettings,
  findSettingsFile,
  readSettingsFile,
  type SettingsSections,
} from '../../plugins/settings.js';

export interface DiscoveryOptions {
  config?: string;
  plugins?: string[];
  rootDir?: string;
  json?: boolean;
}

/**
 * Load the plugins and return their namespaces, sorted, with their settings:
 * the eval config's, or with `--plugins` alone, those of the `mst.config.json`
 * at or above `rootDir`.
 */
export async function loadDiscoveryPlugins(options: DiscoveryOptions): Promise<{
  namespaces: string[];
  rootDir: string;
  configDir?: string;
  settings?: SettingsSections;
}> {
  const rootDir = path.resolve(options.rootDir ?? '.');
  if (options.config) {
    const evalConfig = loadEvalConfig(options.config, {
      rootDir,
      skipDatasetValidation: true,
    });
    const namespaces = await loadEvalPlugins({
      configPath: options.config,
      evalConfig,
      rootDir,
      pluginPaths: options.plugins,
    });
    const settings = evalSettings(evalConfig.settings, namespaces);
    return {
      namespaces,
      rootDir,
      configDir: path.dirname(path.resolve(options.config)),
      ...(settings ? { settings } : {}),
    };
  }
  if (!options.plugins?.length)
    throw new Error(
      'Name the plugins to look in: --plugins <module...>, or --config <eval config>.'
    );
  const plugins = installPlugins(
    await loadPlugins(options.plugins, { baseDir: rootDir })
  );
  const namespaces = [
    ...new Set(plugins.map((plugin) => plugin.meta.namespace)),
  ].sort();
  const settingsFile = findSettingsFile(rootDir);
  const settings = evalSettings(
    settingsFile ? readSettingsFile(settingsFile) : undefined,
    namespaces
  );
  return { namespaces, rootDir, ...(settings ? { settings } : {}) };
}

/** Whether `reference` belongs to one of `namespaces` (bare names are built-ins). */
export function inNamespaces(
  reference: string,
  namespaces: readonly string[]
): boolean {
  const { namespace } = parseExtensionReference(reference);
  return namespace === undefined || namespaces.includes(namespace);
}

/**
 * Left-aligned columns, two spaces apart; the last column isn't padded and a
 * column empty in every row is left out.
 */
export function formatTable(table: string[][]): string {
  const kept = (table[0] ?? []).flatMap((_, column) =>
    table.some((row) => row[column]) ? [column] : []
  );
  const rows = table.map((row) => kept.map((column) => row[column] ?? ''));
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0))
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths![column]!)
        )
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}
