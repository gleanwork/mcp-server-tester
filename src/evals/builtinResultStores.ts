import path from 'node:path';
import type { ConfigDirs } from './evalConfig.js';
import { z } from 'zod';
import type { ExtensionConfig } from './evalConfig.js';
import type { ResultStoreDefinition } from './evalFrameworkTypes.js';
import { extensionLookup } from '../plugins/extensions.js';
import { fileRunStore, gcsRunStore, isRunStore } from './runStore.js';
import type { RunStore } from './runStore.js';

const FileResultStoreSchema = z
  .object({ type: z.literal('file'), dir: z.string().min(1) })
  .passthrough();
const GCSResultStoreSchema = z
  .object({
    type: z.literal('gcs'),
    bucket: z.string().min(1),
    prefix: z.string().optional(),
  })
  .passthrough();

/** Provider-neutral local and GCS result stores, by name. */
function builtinResultStores(): Readonly<
  Record<string, ResultStoreDefinition>
> {
  return {
    file: {
      schema: FileResultStoreSchema,
      description: 'A local directory (`dir`)',
      create: (config: ExtensionConfig) => fileRunStore(String(config.dir)),
    },
    gcs: {
      schema: GCSResultStoreSchema,
      description: 'A GCS bucket (`bucket`, optional `prefix`)',
      create: (config: ExtensionConfig) =>
        gcsRunStore({
          bucket: String(config.bucket),
          ...(typeof config.prefix === 'string'
            ? { prefix: config.prefix }
            : {}),
        }),
    },
  };
}

const resultStores = extensionLookup('resultStores', builtinResultStores);

/** The result store `reference` names: a built-in, or `<namespace>/result-store/<name>` from a plugin. */
export function getResultStore(reference: string): ResultStoreDefinition {
  return resultStores.get(reference);
}

/**
 * A result store config with a `file` store's relative `dir` resolved
 * against the eval config's directory. Unlike an input, where a store writes
 * mustn't depend on what happens to exist in the working directory.
 */
export function resolveStorePaths<T extends { type: string; dir?: unknown }>(
  config: T,
  dirs: ConfigDirs
): T {
  return config.type === 'file' &&
    typeof config.dir === 'string' &&
    !path.isAbsolute(config.dir)
    ? {
        ...config,
        dir: path.resolve(dirs.configDir ?? dirs.rootDir ?? '.', config.dir),
      }
    : config;
}

/**
 * The store config `--results` names: `gs://<bucket>[/<prefix>]`,
 * `file:<dir>` (relative to the working directory), or a store extension
 * that needs no options, such as `acme/result-store/eval-results`.
 */
export function parseResultsFlag(value: string): ExtensionConfig {
  if (value.startsWith('gs://')) {
    const [bucket, ...prefix] = value.slice('gs://'.length).split('/');
    if (!bucket)
      throw new Error(
        `--results ${value} names no bucket: use gs://<bucket>/<prefix>.`
      );
    return {
      type: 'gcs',
      bucket,
      ...(prefix.join('/') ? { prefix: prefix.join('/') } : {}),
    };
  }
  if (value.startsWith('file:')) {
    const dir = value.slice('file:'.length);
    if (!dir)
      throw new Error(`--results ${value} names no directory: use file:<dir>.`);
    return { type: 'file', dir: path.resolve(dir) };
  }
  if (/^[^/\s]+\/result-store\/[^/\s]+$/.test(value)) return { type: value };
  throw new Error(
    `--results ${value} isn't a result store: use gs://<bucket>/<prefix>, file:<dir>, or <namespace>/result-store/<name>.`
  );
}

/**
 * Create a store from its definition, and check it holds runs. A store
 * written for MST before 2.0.0-beta.12 (`saveArtifact`) fails with what to
 * change.
 */
export function createRunStore(
  reference: string,
  definition: ResultStoreDefinition,
  config: ExtensionConfig
): RunStore {
  const store: unknown = definition.create(config);
  if (isRunStore(store)) return store;
  throw new Error(
    typeof store === 'object' && store !== null && 'saveArtifact' in store
      ? `Result store "${reference}" returns an artifact store (saveArtifact). Result stores now hold whole runs: return a RunStore (put, get, list) from create. See docs/migrations/2.0-prereleases.md.`
      : `Result store "${reference}"'s create returned no RunStore (put, get, list).`
  );
}
