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

async function loadDirectoryDataset(
  config: DatasetConfig,
  context: DatasetSourceContext
): Promise<EvalDataset> {
  const source = FileDatasetSchema.parse(config);
  const directory = path.resolve(context.rootDir, source.path);
  if (!(await fs.stat(directory)).isDirectory()) {
    return loadFileDataset(config, context);
  }

  async function collect(dir: string): Promise<string[]> {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name)
    );
    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory() && source.recursive) {
        files.push(...(await collect(entryPath)));
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(entryPath);
      }
    }
    return files;
  }

  const files = await collect(directory);
  if (files.length === 0) {
    throw new Error(
      `Dataset directory contains no JSON datasets: ${directory}`
    );
  }
  const datasets = await Promise.all(
    files.map((filePath) =>
      loadFileDataset(
        { type: 'file', path: filePath },
        {
          ...context,
          manifest: {
            ...context.manifest,
            maxCases: undefined,
            filterTags: undefined,
            run: undefined,
          },
        }
      )
    )
  );
  return buildEvalDataset(
    {
      name: path.basename(directory),
      cases: datasets.flatMap((dataset) => dataset.cases),
    },
    undefined,
    context.manifest
  );
}

let registered = false;

/** Register source-owned canonical file and recursive directory readers. */
export function registerBuiltinDatasetSources(): void {
  if (registered) return;
  registerDatasetSource({
    name: 'file',
    schema: FileDatasetSchema,
    load: loadFileDataset,
  });
  registerDatasetSource({
    name: 'dir',
    schema: FileDatasetSchema,
    load: loadDirectoryDataset,
  });
  registered = true;
}
