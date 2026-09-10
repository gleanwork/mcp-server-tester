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
async function loadFileDataset(
  config: DatasetConfig,
  context: DatasetSourceContext
): Promise<EvalDataset> {
  const source = FileDatasetSchema.parse(config);
  const filePath = path.isAbsolute(source.path)
    ? source.path
    : path.resolve(context.rootDir, source.path);
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  return buildEvalDataset(raw, context.hostConfig, context.manifest);
}

let registered = false;

/**
 * Register source-only file, directory-entry, and GCS readers. Every payload is
 * validated as canonical EvalDataset JSON, regardless of its transport. The
 * suite expands directory declarations into individual JSON file entries.
 */
export function registerBuiltinDatasetSources(): void {
  if (registered) return;
  for (const name of ['file', 'dir'] as const) {
    registerDatasetSource({
      name,
      schema: FileDatasetSchema,
      load: loadFileDataset,
    });
  }
  registered = true;
}
