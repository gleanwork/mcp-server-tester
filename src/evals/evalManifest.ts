import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MCPConfigSchema, type MCPConfig } from '../config/mcpConfig.js';
import type { ToolOverrideVariant } from '../types/index.js';
import {
  CoworkSetupConfigSchema,
  type CoworkSetupConfig,
} from './coworkSetup/options.js';

/** USD per million tokens for one model. Cache rates default to the input rate. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** A tagged configuration block: `type` names a built-in or a plugin's `namespace/name` extension. */
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

/** An arm may patch options while inheriting the base host's type. */
export type HostConfigPatch = Partial<HostConfig>;

/** A judge, metric, or other named extension declaration. */
export interface ExtensionConfig extends TaggedConfig {
  name?: string;
}

/** One comparison arm. Unspecified values inherit from the manifest. */
export interface EvalArm {
  name: string;
  servers?: MCPConfig[];
  host?: HostConfigPatch;
  toolMap?: Record<string, string[]>;
  toolOverrides?: ToolOverrideVariant;
  scenarioTemplate?: string;
  metrics?: ExtensionConfig[];
  judges?: ExtensionConfig[];
  coworkSetup?: CoworkSetupConfig;
}

/** A complete, organization-neutral evaluation manifest. */
export interface EvalManifest {
  name: string;
  datasets: DatasetConfig[];
  servers?: MCPConfig[];
  host?: HostConfig;
  toolMap?: Record<string, string[]>;
  toolOverrides?: ToolOverrideVariant;
  scenarioTemplate?: string;
  arms?: EvalArm[];
  metrics?: ExtensionConfig[];
  judges?: ExtensionConfig[];
  coworkSetup?: CoworkSetupConfig;
  results?: {
    store: ExtensionConfig;
  };
  plugins?: string[];
  /**
   * Shared configs (`namespace/name`) from listed plugins, applied in order
   * under the manifest's own settings.
   */
  extends?: string[];
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
  /** USD per million tokens, by model: estimates cost for hosts that don't report it. */
  pricing?: Record<string, ModelPricing>;
  /** Generation defaults for API hosts (anthropic-api). */
  temperature?: number;
  maxTokens?: number;
  /** Default share of a host case's trials that must pass (cases may set their own). */
  accuracyThreshold?: number;
  [key: string]: unknown;
}

export const TaggedConfigSchema = z
  .object({ type: z.string().min(1) })
  .passthrough();

const DatasetConfigSchema = z.union([z.string().min(1), TaggedConfigSchema]);
const ExtensionConfigSchema = z.union([z.string().min(1), TaggedConfigSchema]);

const ServerConfigSchema = MCPConfigSchema;
const HostConfigPatchSchema = TaggedConfigSchema.partial();

const ToolMapSchema = z.record(z.string(), z.array(z.string()));

// The runtime runner owns the canonical type; share its manifest validation
// between defaults and arms rather than introducing a second override model.
const ToolOverrideVariantSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().optional(),
    tools: z.record(
      z.string(),
      z
        .object({
          description: z.string().optional(),
          inputSchema: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
    ),
  })
  .strict() satisfies z.ZodType<ToolOverrideVariant>;

const EvalArmSchema = z
  .object({
    name: z.string().min(1),
    servers: z.array(ServerConfigSchema).optional(),
    host: HostConfigPatchSchema.optional(),
    toolMap: ToolMapSchema.optional(),
    toolOverrides: ToolOverrideVariantSchema.optional(),
    scenarioTemplate: z.string().optional(),
    metrics: z.array(ExtensionConfigSchema).optional(),
    judges: z.array(ExtensionConfigSchema).optional(),
    coworkSetup: CoworkSetupConfigSchema.optional(),
  })
  .strict();

export const EvalManifestSchema = z
  .object({
    /** The editor schema a manifest file may point to. */
    $schema: z.string().optional(),
    name: z.string().min(1),
    datasets: z.array(DatasetConfigSchema).min(1),
    servers: z.array(ServerConfigSchema).optional(),
    host: TaggedConfigSchema.optional(),
    toolMap: ToolMapSchema.optional(),
    toolOverrides: ToolOverrideVariantSchema.optional(),
    scenarioTemplate: z.string().optional(),
    arms: z.array(EvalArmSchema).optional(),
    metrics: z.array(ExtensionConfigSchema).optional(),
    judges: z.array(ExtensionConfigSchema).optional(),
    coworkSetup: CoworkSetupConfigSchema.optional(),
    results: z.object({ store: ExtensionConfigSchema }).strict().optional(),
    plugins: z.array(z.string().min(1)).optional(),
    extends: z.array(z.string().min(1)).optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    concurrency: z.number().int().positive().optional(),
    iterations: z.number().int().positive().optional(),
    maxCases: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
    tools: z.string().optional(),
    requireEvalEndpoint: z.boolean().optional(),
    /** Generation defaults for API hosts; the host validates their range. */
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    accuracyThreshold: z.number().min(0).max(1).optional(),
    filterTags: z.array(z.string().min(1)).optional(),
    /** The same controls, grouped: `run.iterations`, `run.accuracyThreshold`, ... */
    run: z
      .object({
        iterations: z.number().int().positive().optional(),
        maxCases: z.number().int().positive().optional(),
        concurrency: z.number().int().positive().optional(),
        filterTags: z.array(z.string().min(1)).optional(),
        accuracyThreshold: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    redactStoredResponses: z.boolean().optional(),
    /**
     * USD per million tokens, by model, for hosts that report tokens but not
     * cost. MST ships no prices: they change, and every estimate should be
     * traceable to a table someone chose.
     */
    pricing: z
      .record(
        z.string().min(1),
        z
          .object({
            input: z.number().nonnegative(),
            output: z.number().nonnegative(),
            cacheRead: z.number().nonnegative().optional(),
            cacheWrite: z.number().nonnegative().optional(),
          })
          .strict()
      )
      .optional(),
    /** Removed; kept so validation can say what replaced it. */
    profile: z.unknown().optional(),
  })
  // Unknown keys are mistakes (a misspelt control would be silently ignored).
  .strict();

export type EvalManifestInput = z.input<typeof EvalManifestSchema>;

/** Keys that belong to the manifest itself; a shared config can't set them. */
const MANIFEST_OWN_KEYS = [
  'name',
  'datasets',
  'arms',
  'plugins',
  'extends',
] as const;

/**
 * The manifest settings a plugin shares in `configs`. A manifest applies one
 * with `extends: ["namespace/name"]`. Unknown keys are rejected.
 */
const PluginConfigSchema = EvalManifestSchema.pick({
  servers: true,
  host: true,
  toolMap: true,
  toolOverrides: true,
  scenarioTemplate: true,
  metrics: true,
  judges: true,
  coworkSetup: true,
  results: true,
  model: true,
  provider: true,
  concurrency: true,
  iterations: true,
  maxCases: true,
  timeout: true,
  maxToolCalls: true,
  tools: true,
  requireEvalEndpoint: true,
  pricing: true,
  accuracyThreshold: true,
  temperature: true,
  maxTokens: true,
}).strict();

/** A plugin's shared config: any manifest setting but its name, datasets, arms, plugins and extends. */
export type PluginConfig = z.input<typeof PluginConfigSchema>;

/** A parsed shared config: judge, metric and store shorthands are tagged configs. */
export type ParsedPluginConfig = Omit<
  z.output<typeof PluginConfigSchema>,
  'judges' | 'metrics' | 'results'
> & {
  judges?: ExtensionConfig[];
  metrics?: ExtensionConfig[];
  results?: { store: ExtensionConfig };
};

/** Parse a shared config; `label` names it in errors. */
export function parsePluginConfig(
  value: unknown,
  label: string
): ParsedPluginConfig {
  if (value && typeof value === 'object') {
    const own = MANIFEST_OWN_KEYS.filter((key) => key in value);
    if (own.length > 0) {
      throw new Error(
        `${label} can't set ${own.map((key) => `"${key}"`).join(', ')}: a manifest's ${MANIFEST_OWN_KEYS.join(', ')} are its own.`
      );
    }
  }
  const result = PluginConfigSchema.safeParse(value);
  if (!result.success)
    throw new Error(`Invalid ${label}: ${result.error.message}`);
  const { judges, metrics, results, ...settings } = result.data;
  return {
    ...settings,
    ...(judges ? { judges: judges.map(normalizeExtension) } : {}),
    ...(metrics ? { metrics: metrics.map(normalizeExtension) } : {}),
    ...(results
      ? { results: { store: normalizeExtension(results.store) } }
      : {}),
  };
}

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
    results: value.results
      ? { ...value.results, store: normalizeExtension(value.results.store) }
      : undefined,
    arms: value.arms?.map((arm) => ({
      ...arm,
      metrics: arm.metrics?.map(normalizeExtension),
      judges: arm.judges?.map(normalizeExtension),
    })),
  } as EvalManifest;
}

/** Where a manifest's relative paths are looked up. */
export interface ManifestDirs {
  /** The manifest's own directory: relative paths resolve here first. */
  manifestDir?: string;
  /** The run's root (`--root-dir`): the fallback for paths not found by the manifest. */
  rootDir?: string;
}

/**
 * An input a manifest names (a dataset, a plugin): relative to the
 * manifest's directory, then to `rootDir`, whichever has it; the manifest's
 * directory when neither does, so the error names the expected place.
 */
export function resolveManifestPath(
  target: string,
  dirs: ManifestDirs
): string {
  if (path.isAbsolute(target)) return target;
  const candidates = [dirs.manifestDir, dirs.rootDir]
    .filter((dir): dir is string => dir !== undefined)
    .map((dir) => path.resolve(dir, target));
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ??
    candidates[0] ??
    path.resolve(target)
  );
}

/** Resolve paths for the built-in file and directory dataset sources. */
export function resolveDatasetPaths(
  manifest: EvalManifest,
  rootDir = process.cwd(),
  manifestDir?: string
): string[] {
  return manifest.datasets.flatMap((dataset) => {
    if (dataset.type !== 'file' && dataset.type !== 'dir') return [];
    if (typeof dataset.path !== 'string') {
      throw new Error(`Dataset source "${dataset.type}" requires a path.`);
    }
    return [resolveManifestPath(dataset.path, { manifestDir, rootDir })];
  });
}

export interface LoadEvalManifestOptions {
  rootDir?: string;
  /** The manifest's directory; `loadEvalManifest` sets it from the path. */
  manifestDir?: string;
  skipDatasetValidation?: boolean;
}

export function loadEvalManifestFromObject(
  value: unknown,
  options: LoadEvalManifestOptions = {}
): EvalManifest {
  const manifest = normalizeManifest(EvalManifestSchema.parse(value));
  if (options.skipDatasetValidation) return manifest;

  for (const datasetPath of resolveDatasetPaths(
    manifest,
    options.rootDir,
    options.manifestDir
  )) {
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
    manifestDir: path.dirname(absolutePath),
  });
}
