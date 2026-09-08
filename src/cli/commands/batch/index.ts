import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEvalManifest } from '../../../evals/evalManifest.js';
import { loadPlugins } from '../../../plugins/loadPlugins.js';

export interface BatchOptions {
  manifests?: string[];
  manifestDir?: string;
  rootDir?: string;
  outputRoot?: string;
  workers?: number;
  skipExisting?: boolean;
  plugins?: string[];
  dryRun?: boolean;
}

async function resolveManifestPaths(options: BatchOptions): Promise<string[]> {
  if (options.manifests?.length) return options.manifests;
  if (!options.manifestDir) {
    throw new Error('Provide --manifests or --manifest-dir.');
  }
  const names = (await fs.readdir(options.manifestDir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  return names.map((name) => path.join(options.manifestDir!, name));
}

/** Validate and plan a batch. Runtime scheduling is added by the operations branch. */
export async function batch(options: BatchOptions): Promise<void> {
  const manifestPaths = await resolveManifestPaths(options);
  if (options.plugins?.length) await loadPlugins(options.plugins);
  const manifests = manifestPaths.map((manifestPath) =>
    loadEvalManifest(manifestPath, {
      rootDir: options.rootDir,
      skipDatasetValidation: Boolean(options.dryRun),
    })
  );

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          manifests: manifests.map((manifest, index) => ({
            path: manifestPaths[index],
            name: manifest.name,
          })),
          workers: options.workers,
          skipExisting: options.skipExisting,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  throw new Error(
    'Manifest batch execution is not wired in the scaffolding branch; use --dry-run.'
  );
}
