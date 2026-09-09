import { z } from 'zod';
import { registerResultStore } from './frameworkRegistries.js';
import {
  FileEvalResultStore,
  GCSEvalResultStore,
  type EvalResultStore,
} from './resultStore.js';
import type { ExtensionConfig } from './evalManifest.js';

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
  return new GCSEvalResultStore({
    provider: 'gcs',
    bucket: String(config.bucket),
    prefix: config.prefix === undefined ? undefined : String(config.prefix),
  });
}

let registered = false;

/** Register provider-neutral local and GCS result stores. */
export function registerBuiltinResultStores(): void {
  if (registered) return;
  registerResultStore({
    name: 'file',
    schema: FileResultStoreSchema,
    create: createFileStore,
  });
  registerResultStore({
    name: 'gcs',
    schema: GCSResultStoreSchema,
    create: createGCSStore,
  });
  registered = true;
}
