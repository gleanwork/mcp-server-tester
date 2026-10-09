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

export interface DiscoveryOptions {
  config?: string;
  plugins?: string[];
  rootDir?: string;
  json?: boolean;
}

/** Load the plugins and return their namespaces, sorted. */
export async function loadDiscoveryPlugins(
  options: DiscoveryOptions
): Promise<{ namespaces: string[]; rootDir: string; configDir?: string }> {
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
    return {
      namespaces,
      rootDir,
      configDir: path.dirname(path.resolve(options.config)),
    };
  }
  if (!options.plugins?.length)
    throw new Error(
      'Name the plugins to look in: --plugins <module...>, or --config <eval config>.'
    );
  const plugins = installPlugins(
    await loadPlugins(options.plugins, { baseDir: rootDir })
  );
  return {
    namespaces: [
      ...new Set(plugins.map((plugin) => plugin.meta.namespace)),
    ].sort(),
    rootDir,
  };
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
