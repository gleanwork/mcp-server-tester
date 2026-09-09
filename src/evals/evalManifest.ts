import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MCPConfig } from '../config/mcpConfig.js';

/** A tagged configuration block resolved by a public registry. */
export interface TaggedConfig {
  type: string;
  [key: string]: unknown;
}

/** A dataset source declaration in an evaluation manifest. */
export interface DatasetConfig extends TaggedConfig {
  path?: string;
  recursive?: boolean;
}

/** A host implementation declaration. Host-specific options are plugin-owned. */
export type HostConfig = TaggedConfig;

/** A judge, metric, or other named extension declaration. */
export interface ExtensionConfig extends TaggedConfig {
  name?: string;
}

/** One comparison arm. Unspecified values inherit from the manifest. */
export interface EvalArm {
  name: string;
  servers?: MCPConfig[];
  host?: HostConfig;
  toolMap?: Record<string, string>;
  scenarioTemplate?: string;
  metrics?: ExtensionConfig[];
  judges?: ExtensionConfig[];
}

/** A complete, organization-neutral evaluation manifest. */
export interface EvalManifest {
  name: string;
  datasets: DatasetConfig[];
  servers?: MCPConfig[];
  host?: HostConfig;
  arms?: EvalArm[];
  metrics?: ExtensionConfig[];
  judges?: ExtensionConfig[];
  results?: {
    store: ExtensionConfig;
  };
  plugins?: string[];
  model?: string;
  provider?: string;
  concurrency?: number;
  iterations?: number;
  maxCases?: number;
  timeout?: number;
  maxToolCalls?: number;
  tools?: string;
  /** Require HTTP server URLs to use an explicit /eval endpoint. */
  requireEvalEndpoint?: boolean;
  [key: string]: unknown;
}

const TaggedConfigSchema = z.object({ type: z.string().min(1) }).passthrough();

const DatasetConfigSchema = z.union([z.string().min(1), TaggedConfigSchema]);
const ExtensionConfigSchema = z.union([z.string().min(1), TaggedConfigSchema]);

const ServerConfigSchema = z
  .object({
    transport: z.enum(['http', 'stdio']),
    label: z.string().min(1).optional(),
  })
  .passthrough();

const EvalArmSchema = z
  .object({
    name: z.string().min(1),
    servers: z.array(ServerConfigSchema).optional(),
    host: TaggedConfigSchema.optional(),
    toolMap: z.record(z.string(), z.string()).optional(),
    scenarioTemplate: z.string().optional(),
    metrics: z.array(ExtensionConfigSchema).optional(),
    judges: z.array(ExtensionConfigSchema).optional(),
  })
  .strict();

export const EvalManifestSchema = z
  .object({
    name: z.string().min(1),
    datasets: z.array(DatasetConfigSchema).min(1),
    servers: z.array(ServerConfigSchema).optional(),
    host: TaggedConfigSchema.optional(),
    arms: z.array(EvalArmSchema).optional(),
    metrics: z.array(ExtensionConfigSchema).optional(),
    judges: z.array(ExtensionConfigSchema).optional(),
    results: z.object({ store: ExtensionConfigSchema }).strict().optional(),
    plugins: z.array(z.string().min(1)).optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    concurrency: z.number().int().positive().optional(),
    iterations: z.number().int().positive().optional(),
    maxCases: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
    tools: z.string().optional(),
    requireEvalEndpoint: z.boolean().optional(),
  })
  .passthrough();

export type EvalManifestInput = z.input<typeof EvalManifestSchema>;

function normalizeDataset(value: string | TaggedConfig): DatasetConfig {
  return typeof value === 'string' ? { type: 'file', path: value } : value;
}

function normalizeExtension(value: string | TaggedConfig): ExtensionConfig {
  return typeof value === 'string' ? { type: value } : value;
}

function normalizeManifest(value: EvalManifestInput): EvalManifest {
  return {
    ...value,
    datasets: value.datasets.map(normalizeDataset),
    metrics: value.metrics?.map(normalizeExtension),
    judges: value.judges?.map(normalizeExtension),
    arms: value.arms?.map((arm) => ({
      ...arm,
      metrics: arm.metrics?.map(normalizeExtension),
      judges: arm.judges?.map(normalizeExtension),
    })),
  } as EvalManifest;
}

/** Resolve paths for the built-in file and directory dataset sources. */
export function resolveDatasetPaths(
  manifest: EvalManifest,
  rootDir = process.cwd()
): string[] {
  return manifest.datasets.flatMap((dataset) => {
    if (dataset.type !== 'file' && dataset.type !== 'dir') return [];
    if (typeof dataset.path !== 'string') {
      throw new Error(`Dataset source "${dataset.type}" requires a path.`);
    }
    return [
      path.isAbsolute(dataset.path)
        ? dataset.path
        : path.resolve(rootDir, dataset.path),
    ];
  });
}

export interface LoadEvalManifestOptions {
  rootDir?: string;
  skipDatasetValidation?: boolean;
}

export function loadEvalManifestFromObject(
  value: unknown,
  options: LoadEvalManifestOptions = {}
): EvalManifest {
  const manifest = normalizeManifest(EvalManifestSchema.parse(value));
  if (options.skipDatasetValidation) return manifest;

  for (const datasetPath of resolveDatasetPaths(manifest, options.rootDir)) {
    if (!fs.existsSync(datasetPath)) {
      throw new Error(`Dataset path not found: ${datasetPath}`);
    }
  }
  return manifest;
}

export function loadEvalManifest(
  manifestPath: string,
  options: LoadEvalManifestOptions = {}
): EvalManifest {
  const absolutePath = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.resolve(process.cwd(), manifestPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Evaluation manifest not found: ${absolutePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as unknown;
  return loadEvalManifestFromObject(raw, {
    ...options,
    rootDir: options.rootDir ?? path.dirname(absolutePath),
  });
}
