import path from 'node:path';
import type { ConfigDirs } from './evalConfig.js';
import { z } from 'zod';
import {
  FileEvalResultStore,
  GCSEvalResultStore,
  type EvalResultStore,
} from './resultStore.js';
import type { ExtensionConfig } from './evalConfig.js';
import type { ResultStoreDefinition } from './evalFrameworkTypes.js';
import { extensionLookup } from '../plugins/extensions.js';

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

function createFileStore(config: ExtensionConfig): EvalResultStore {
  return new FileEvalResultStore({
    provider: 'file',
    dir: String(config.dir),
  });
}

function createGCSStore(config: ExtensionConfig): EvalResultStore {
  const prefix = config.prefix;
  return new GCSEvalResultStore({
    provider: 'gcs',
    bucket: String(config.bucket),
    ...(typeof prefix === 'string' ? { prefix } : {}),
  });
}

/** Provider-neutral local and GCS result stores, by name. */
function builtinResultStores(): Readonly<
  Record<string, ResultStoreDefinition>
> {
  return {
    file: { schema: FileResultStoreSchema, create: createFileStore },
    gcs: { schema: GCSResultStoreSchema, create: createGCSStore },
  };
}

const resultStores = extensionLookup('resultStores', builtinResultStores);

/** The result store `reference` names: a built-in, or `namespace/name` from a plugin. */
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
