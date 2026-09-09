import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { registerDatasetSource } from './frameworkRegistries.js';
import type { DatasetConfig } from './evalManifest.js';
import type { DatasetSourceContext } from './evalFrameworkTypes.js';
import { buildEvalDataset } from './buildEvalDataset.js';
import type { EvalDataset } from './datasetTypes.js';

const FileDatasetSchema = z
  .object({
    type: z.enum(['file', 'dir']),
    path: z.string().min(1),
    recursive: z.boolean().optional(),
  })
  .passthrough();
const GCSDatasetSchema = z
  .object({
    type: z.literal('gcs'),
    uri: z.string().regex(/^gs:\/\/[^/]+\/.+/),
  })
  .passthrough();

async function loadFileDataset(
  config: DatasetConfig,
  context: DatasetSourceContext
): Promise<EvalDataset> {
  if (typeof config.path !== 'string') {
    throw new Error(`Dataset source "${config.type}" requires a path.`);
  }
  const filePath = path.isAbsolute(config.path)
    ? config.path
    : path.resolve(context.rootDir, config.path);
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  return buildEvalDataset(raw, context.hostConfig, context.manifest);
}

interface GCSStorage {
  bucket(name: string): {
    file(name: string): { download(): Promise<[Buffer]> };
  };
}

async function loadGCSDataset(
  config: DatasetConfig,
  context: DatasetSourceContext
): Promise<EvalDataset> {
  const uri = String(config.uri);
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw new Error(`Invalid GCS dataset URI: ${uri}`);
  let Storage: new () => GCSStorage;
  try {
    ({ Storage } = (await import('@google-cloud/storage')) as unknown as {
      Storage: new () => GCSStorage;
    });
  } catch (error) {
    throw new Error(
      'GCS datasets require the optional `@google-cloud/storage` package. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const [buffer] = await new Storage()
    .bucket(match[1]!)
    .file(match[2]!)
    .download();
  return buildEvalDataset(
    JSON.parse(buffer.toString('utf8')) as unknown,
    context.hostConfig,
    context.manifest
  );
}

let registered = false;

/** Register the provider-neutral file and directory dataset sources. */
export function registerBuiltinDatasetSources(): void {
  if (registered) return;
  for (const name of ['file', 'dir'] as const) {
    registerDatasetSource({
      name,
      schema: FileDatasetSchema,
      load: loadFileDataset,
    });
  }
  registerDatasetSource({
    name: 'gcs',
    schema: GCSDatasetSchema,
    load: loadGCSDataset,
  });
  registered = true;
}
