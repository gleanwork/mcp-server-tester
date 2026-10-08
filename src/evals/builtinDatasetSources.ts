import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveConfigPath } from './evalConfig.js';
import type { DatasetConfig } from './evalConfig.js';
import type {
  DatasetRequest,
  DatasetSource,
  DatasetSourceContext,
} from './evalFrameworkTypes.js';
import { extensionLookup } from '../plugins/extensions.js';
import {
  BUILTIN_NAMESPACE,
  parseExtensionReference,
} from '../plugins/plugin.js';
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
  const source = FileDatasetSchema.parse(config);
  const filePath = resolveConfigPath(source.path, context);
  return buildEvalDataset(
    JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown,
    context.evalConfig
  );
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
  const { uri } = GCSDatasetSchema.parse(config);
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
    context.evalConfig
  );
}

async function loadDirectoryDataset(
  config: DatasetConfig,
  context: DatasetSourceContext
): Promise<EvalDataset> {
  const source = FileDatasetSchema.parse(config);
  const directory = resolveConfigPath(source.path, context);
  if (!(await fs.stat(directory)).isDirectory())
    return loadFileDataset(config, context);
  async function collect(dir: string): Promise<string[]> {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name)
    );
    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory() && source.recursive)
        files.push(...(await collect(entryPath)));
      else if (entry.isFile() && entry.name.endsWith('.json'))
        files.push(entryPath);
    }
    return files;
  }
  const files = await collect(directory);
  if (!files.length)
    throw new Error(
      `Dataset directory contains no JSON datasets: ${directory}`
    );
  const datasets = await Promise.all(
    files.map((filePath) =>
      loadFileDataset(
        { type: 'file', path: filePath },
        {
          ...context,
          evalConfig: {
            ...context.evalConfig,
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
    context.evalConfig
  );
}

/** Built-in dataset sources by name. */
function builtinDatasetSources(): Readonly<Record<string, DatasetSource>> {
  return {
    file: { schema: FileDatasetSchema, load: loadFileDataset },
    dir: { schema: FileDatasetSchema, load: loadDirectoryDataset },
    gcs: { schema: GCSDatasetSchema, load: loadGCSDataset },
  };
}

const datasetSources = extensionLookup('datasetSources', builtinDatasetSources);

/** The dataset source `reference` names: a built-in, or `<namespace>/dataset/<name>` from a plugin. */
export function getDatasetSource(reference: string): DatasetSource {
  return datasetSources.get(reference);
}

/** Built-in and installed plugins' dataset sources, by name, sorted. */
export function listDatasetSources(): Array<[string, DatasetSource]> {
  return datasetSources.list();
}

/** Whether a source needs no options: a dataset an eval config lists by name. */
export function takesNoOptions(
  reference: string,
  source: DatasetSource
): boolean {
  return source.schema.safeParse({ type: reference }).success;
}

/** The keys MST reads off a dataset declaration for a source with snapshots. */
const REQUEST_KEYS = ['snapshot', 'source'] as const;

/**
 * Which copy a declaration asks for: `{ source?: "snapshot" | "live",
 * snapshot?: "<id>" }`, checked together. Undefined when it asks for neither.
 */
export function datasetRequest(
  config: Pick<DatasetConfig, 'snapshot' | 'source'>
): DatasetRequest | undefined {
  const { snapshot, source } = config as {
    snapshot?: unknown;
    source?: unknown;
  };
  if (snapshot === undefined && source === undefined) return undefined;
  if (source !== undefined && source !== 'snapshot' && source !== 'live')
    throw new Error(
      `A dataset's source is "snapshot" or "live", not ${JSON.stringify(source)}.`
    );
  if (snapshot !== undefined && (typeof snapshot !== 'string' || !snapshot))
    throw new Error(
      'A dataset\'s snapshot is a snapshot id, such as "2026-10-01".'
    );
  if (source === 'live' && snapshot !== undefined)
    throw new Error(
      'A live dataset has no snapshot: drop "snapshot" or "source": "live".'
    );
  return {
    source: source ?? 'snapshot',
    ...(snapshot !== undefined ? { snapshot } : {}),
  };
}

/** A declaration without the keys MST reads for snapshots: what the source's schema sees. */
export function withoutRequest(config: DatasetConfig): DatasetConfig {
  const rest: Record<string, unknown> = { ...config };
  for (const key of REQUEST_KEYS) delete rest[key];
  return rest as DatasetConfig;
}

/**
 * Throws unless `source` can serve what `config` asks for: only a source
 * with `snapshots` takes `snapshot` or `source`.
 */
export function assertDatasetRequest(
  config: DatasetConfig,
  source: DatasetSource
): void {
  if (datasetRequest(config) && !source.snapshots)
    throw new Error(
      `Dataset source "${config.type}" has no snapshots: drop "snapshot" and "source".`
    );
}

/**
 * Load a declared dataset: the source's cases, plus where they came from for
 * a plugin's dataset. A source with snapshots that returns a snapshot other
 * than the one asked for fails here, so a run never records the wrong one.
 */
export async function loadDataset(
  config: DatasetConfig,
  context: DatasetSourceContext
): Promise<EvalDataset> {
  const source = getDatasetSource(config.type);
  assertDatasetRequest(config, source);
  const request = source.snapshots
    ? (datasetRequest(config) ?? { source: 'snapshot' as const })
    : undefined;
  const dataset = await source.load(withoutRequest(config), {
    ...context,
    ...(request ? { request } : {}),
  });
  if (request) {
    if (dataset.snapshot !== undefined && typeof dataset.snapshot !== 'string')
      throw new Error(`Dataset "${config.type}": snapshot must be a string.`);
    if (request.source === 'live' && dataset.snapshot !== undefined)
      throw new Error(
        `Dataset "${config.type}": asked for live data, got snapshot ${dataset.snapshot}.`
      );
    if (request.snapshot !== undefined && dataset.snapshot !== request.snapshot)
      throw new Error(
        `Dataset "${config.type}": asked for snapshot ${request.snapshot}, got ${dataset.snapshot ?? 'none'}.`
      );
  }
  // Built-ins read files the eval config names; a plugin's dataset says which.
  const { namespace } = parseExtensionReference(config.type);
  if (namespace === undefined || namespace === BUILTIN_NAMESPACE)
    return dataset;
  return {
    ...dataset,
    origin: {
      ref: config.type,
      ...(request && dataset.snapshot !== undefined
        ? { snapshot: dataset.snapshot }
        : {}),
      ...(request?.source === 'live' ? { live: true as const } : {}),
    },
  };
}
