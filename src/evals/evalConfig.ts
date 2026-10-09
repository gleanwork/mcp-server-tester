import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  extensionReferenceSchema,
  taggedReferenceSchema,
} from './referenceSchemas.js';
import { checkReferenceKind } from '../plugins/extensions.js';
import { removedKeys, renamedKeys } from './renamedKeys.js';
import { clientFieldSchemas, type ClientFields } from './clientFields.js';
import { MCPConfigSchema, type MCPConfig } from '../config/mcpConfig.js';
import type {
  ToolMetadataOverride,
  ToolOverrideVariant,
} from '../types/index.js';
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

/** A tagged configuration block: `type` names a built-in or a plugin's `<namespace>/<kind>/<name>` extension. */
export interface TaggedConfig {
  type: string;
  [key: string]: unknown;
}

/** A dataset source declaration in an eval config. */
export interface DatasetConfig extends TaggedConfig {
  path?: string;
  recursive?: boolean;
}

/** A client implementation declaration. Client-specific options are plugin-owned. */
export type ClientConfig = TaggedConfig;

/** A judge, metric, or other named extension declaration. */
export interface ExtensionConfig extends TaggedConfig {
  name?: string;
}

/**
 * A server named by a plugin connector instead of a transport. `mst run`
 * expands it (see `expandConnectorServers`); `mst auth` signs in to it.
 */
export interface ConnectorServerConfig {
  /** `<namespace>/connector/<name>` of a plugin connector. */
  connector: string;
  /** The server's label. Default: the connector's name. */
  label?: string;
  /** Overrides the connector's endpoint. */
  url?: string;
}

/** A server in an eval config: a transport, or a connector. */
export type EvalServerConfig = MCPConfig | ConnectorServerConfig;

/** Whether `server` names a connector. */
export function isConnectorServer(
  server: EvalServerConfig
): server is ConnectorServerConfig {
  return 'connector' in server && !('transport' in server);
}

/** The servers a client gets: connector entries must be expanded first. */
export function transportServers(
  servers: readonly EvalServerConfig[] | undefined,
  context = 'This client'
): MCPConfig[] {
  return (servers ?? []).map((server) => {
    if (isConnectorServer(server))
      throw new Error(
        `${context} got connector server "${server.connector}" before it was expanded.`
      );
    return server;
  });
}

/**
 * The tool metadata a variant shows its client, by the tool's name on its
 * server: a new name, description or input schema.
 */
export type ToolMetadata = Record<string, ToolMetadataOverride>;

/**
 * One setup the eval tests. Unspecified values inherit from the eval
 * config; a different `client` doesn't inherit the config's
 * `clientOptions`.
 */
export interface EvalVariant extends ClientFields {
  name: string;
  description?: string;
  /**
   * The variant's servers. An eval config file names them by label
   * (`"servers": ["acme"]`), which loading keeps in `serverLabels`;
   * `validateEvalConfig` resolves those labels into this list. Omitted: every
   * server of the eval config.
   */
  servers?: EvalServerConfig[];
  /** The labels of the eval config's servers this variant uses, as written in the file. */
  serverLabels?: string[];
  toolMap?: Record<string, string[]>;
  /** The tool metadata this variant shows its client. */
  tools?: ToolMetadata;
  inputTemplate?: string;
  metrics?: ExtensionConfig[];
  judges?: ExtensionConfig[];
  coworkSetup?: CoworkSetupConfig;
}

/** An eval config: what to evaluate and how. */
export interface EvalConfig {
  name: string;
  datasets: DatasetConfig[];
  /**
   * The servers under test, each with its `label`. An eval config file
   * writes them as a map keyed by label: `"servers": { "acme": { ... } }`.
   */
  servers?: EvalServerConfig[];
  /**
   * The client under test: `mst`, `claude-code`, `cowork`, `chatgpt`, or a
   * plugin's `<namespace>/client/<name>`. @default 'claude-code'
   */
  client?: string;
  /** The client's own options, such as Cowork's `appVersion`. */
  clientOptions?: Record<string, unknown>;
  toolMap?: Record<string, string[]>;
  /** Tool metadata every variant shows its client, unless it sets its own. */
  tools?: ToolMetadata;
  inputTemplate?: string;
  /** The setups the eval compares. Without any, one variant runs the config as written. */
  variants?: EvalVariant[];
  /** The variant the others are compared with. @default the first */
  baseline?: string;
  metrics?: ExtensionConfig[];
  /** Judges every case runs, on top of each case's own `judges`. */
  judges?: ExtensionConfig[];
  /**
   * Pairwise judges (`<namespace>/pairwise-judge/<name>`): after every variant
   * runs, each compares each other variant with the baseline, case by case.
   */
  pairwiseJudges?: ExtensionConfig[];
  coworkSetup?: CoworkSetupConfig;
  /**
   * Connector servers' dry-run proxies answer writes with a success reply,
   * instead of a planned-write result, and record them; each trial's tool
   * calls they answered are marked `simulatedWrite`. Writes still never
   * reach the server. Default false.
   */
  simulateWrites?: boolean;
  results?: {
    store: ExtensionConfig;
  };
  plugins?: string[];
  /**
   * Shared configs (`<namespace>/config/<name>`) from listed plugins, applied in order
   * under the eval config's own settings.
   */
  extends?: string[];
  /** The model the client uses: a default for every variant and case. */
  model?: string;
  provider?: string;
  concurrency?: number;
  trials?: number;
  maxCases?: number;
  timeout?: number;
  maxToolCalls?: number;
  /** Require HTTP server URLs to use an explicit /eval endpoint. */
  requireEvalEndpoint?: boolean;
  /** USD per million tokens, by model: estimates cost for clients that don't report it. */
  pricing?: Record<string, ModelPricing>;
  /** Generation defaults for clients that call a model API (mst). */
  temperature?: number;
  maxTokens?: number;
  /** Default share of a client case's trials that must pass (cases may set their own). */
  passThreshold?: number;
  [key: string]: unknown;
}

/**
 * The tool metadata a variant shows its client (its own `tools`, else the
 * config's), as the runtime's tool variant, identified by the variant's name.
 * Undefined when neither sets any.
 */
export function variantToolMetadata(
  evalConfig: Pick<EvalConfig, 'name' | 'tools'>,
  variant?: Pick<EvalVariant, 'name' | 'tools' | 'description'>
): ToolOverrideVariant | undefined {
  const tools = variant?.tools ?? evalConfig.tools;
  if (!tools) return undefined;
  return {
    id: variant?.name ?? evalConfig.name,
    ...(variant?.tools && variant.description !== undefined
      ? { description: variant.description }
      : {}),
    tools,
  };
}

// A bare dataset string is a path; a tagged dataset names its source.
const DatasetConfigSchema = z.union([
  z.string().min(1),
  taggedReferenceSchema('dataset'),
]);
const MetricConfigSchema = extensionReferenceSchema('metric');
const JudgeConfigSchema = extensionReferenceSchema('judge');
const PairwiseJudgeConfigSchema = extensionReferenceSchema('pairwise-judge');
const ResultStoreConfigSchema = extensionReferenceSchema('result-store');

/**
 * A server an eval config names by connector (`{ "connector": "acme/slack" }`)
 * instead of by transport. `mst run` expands it into the connector's server
 * entry with a fresh token; `mst auth` signs in to it.
 */
const ConnectorServerSchema = z
  .object({
    connector: z.string().superRefine((reference, context) => {
      if (!reference.includes('/')) {
        context.addIssue({
          code: 'custom',
          message: `A connector is \`<namespace>/connector/<name>\`: use "<namespace>/connector/${reference}".`,
        });
        return;
      }
      try {
        checkReferenceKind(reference, 'connector');
      } catch (error) {
        context.addIssue({ code: 'custom', message: (error as Error).message });
      }
    }),
    /** The server's label. Default: the connector's name. */
    label: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
      .optional(),
    /** Overrides the connector's endpoint. */
    url: z.string().url().optional(),
  })
  .strict();

const ServerConfigSchema = z.union([MCPConfigSchema, ConnectorServerSchema]);

const SERVERS_ARE_A_MAP =
  '`servers` is a map keyed by label: { "acme": { "transport": "http", ... } }; variants pick servers by label: "servers": ["acme"]. See docs/migrations/migration-2.0.md#servers-are-a-map-keyed-by-label';

/**
 * Top-level `servers`: a map keyed by label, read into labelled configs.
 * The key is the label, so an entry may not set one.
 */
const ServerMapSchema = z
  .record(
    z.string().min(1, { error: 'a server label (the map key) is empty' }),
    ServerConfigSchema,
    {
      error: (issue) =>
        Array.isArray(issue.input) ? SERVERS_ARE_A_MAP : undefined,
    }
  )
  .superRefine((servers, context) => {
    for (const [label, server] of Object.entries(servers)) {
      // A connector's label names its token env var, so it is an identifier.
      if ('connector' in server && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label))
        context.addIssue({
          code: 'custom',
          path: [label],
          message: `a connector server's label starts with a letter and has only letters, digits, "_" and "-": "${label}"`,
        });
      if (server.label !== undefined)
        context.addIssue({
          code: 'custom',
          path: [label, 'label'],
          message: `the key is the server's label; remove "label" from "${label}"`,
        });
    }
  })
  .transform((servers): EvalServerConfig[] =>
    Object.entries(servers).map(([label, server]) => ({ ...server, label }))
  );

/** A variant's `servers`: labels of the eval config's servers. */
const SERVER_LABEL = (issue: { input?: unknown }) =>
  typeof issue.input === 'object' && issue.input !== null
    ? "define this server under the eval config's top-level `servers`, keyed by its label, and list the label here"
    : 'a server label';
const ServerLabelsSchema = z.array(
  z.string({ error: SERVER_LABEL }).min(1, { error: SERVER_LABEL }),
  {
    error: (issue) =>
      typeof issue.input === 'object' && issue.input !== null
        ? 'a variant names its servers by label: "servers": ["acme"]'
        : typeof issue.input === 'string'
          ? `a variant lists its servers' labels: "servers": ["${issue.input}"]`
          : undefined,
  }
);

const ToolMapSchema = z.record(z.string(), z.array(z.string()));

/** A variant's input template: `{{input}}` is replaced by the case's input. */
const InputTemplateSchema = z
  .string()
  .refine((template) => !template.includes('{{scenario}}'), {
    message: '`{{scenario}}` is now `{{input}}`',
  });

// One schema for a variant's tool metadata and the config's default.
const ToolMetadataSchema = z.record(
  z.string(),
  z
    .object({
      name: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,128}$/, 'Not a valid MCP tool name.')
        .optional(),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  {
    error: (issue) =>
      typeof issue.input === 'string'
        ? "`tools` is tool metadata: a new name, description or input schema per tool, keyed by the tool's name"
        : undefined,
  }
) satisfies z.ZodType<ToolMetadata>;

const TOOL_OVERRIDES_MOVED =
  "set the tool metadata itself in `tools`, keyed by tool name (what was `toolOverrides.tools`); the variant's name identifies it";

const EvalVariantSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    servers: ServerLabelsSchema.optional(),
    ...clientFieldSchemas,
    toolMap: ToolMapSchema.optional(),
    tools: ToolMetadataSchema.optional(),
    inputTemplate: InputTemplateSchema.optional(),
    metrics: z.array(MetricConfigSchema).optional(),
    judges: z.array(JudgeConfigSchema).optional(),
    coworkSetup: CoworkSetupConfigSchema.optional(),
    pairwiseJudges: z
      .never({
        message:
          "pairwise judges compare each variant with the baseline: list them in the eval config's top-level `pairwiseJudges`, not on a variant",
      })
      .optional(),
    ...renamedKeys({ scenarioTemplate: 'inputTemplate' }),
    ...removedKeys({ toolOverrides: TOOL_OVERRIDES_MOVED }),
  })
  .strict()
  .transform(({ servers, ...variant }) =>
    servers === undefined ? variant : { ...variant, serverLabels: servers }
  );

/** Eval config keys that 2.0 renamed (ADR 0002); each fails naming its replacement. */
export const RENAMED_CONFIG_KEYS = {
  scenarioTemplate: 'inputTemplate',
  iterations: 'trials',
  accuracyThreshold: 'passThreshold',
  arms: 'variants',
} as const;

export const EvalConfigSchema = z
  .object({
    /** The editor schema an eval config file may point to. */
    $schema: z.string().optional(),
    name: z.string().min(1),
    datasets: z.array(DatasetConfigSchema).min(1),
    servers: ServerMapSchema.optional(),
    ...clientFieldSchemas,
    toolMap: ToolMapSchema.optional(),
    tools: ToolMetadataSchema.optional(),
    inputTemplate: InputTemplateSchema.optional(),
    variants: z.array(EvalVariantSchema).optional(),
    baseline: z.string().min(1).optional(),
    metrics: z.array(MetricConfigSchema).optional(),
    judges: z.array(JudgeConfigSchema).optional(),
    pairwiseJudges: z.array(PairwiseJudgeConfigSchema).optional(),
    coworkSetup: CoworkSetupConfigSchema.optional(),
    results: z.object({ store: ResultStoreConfigSchema }).strict().optional(),
    plugins: z.array(z.string().min(1)).optional(),
    extends: z.array(z.string().min(1)).optional(),
    provider: z.string().optional(),
    concurrency: z.number().int().positive().optional(),
    trials: z.number().int().positive().optional(),
    maxCases: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
    requireEvalEndpoint: z.boolean().optional(),
    /** Generation defaults for API clients; the client validates their range. */
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    passThreshold: z.number().min(0).max(1).optional(),
    filterTags: z.array(z.string().min(1)).optional(),
    /** The same controls, grouped: `run.trials`, `run.passThreshold`, ... */
    run: z
      .object({
        trials: z.number().int().positive().optional(),
        maxCases: z.number().int().positive().optional(),
        concurrency: z.number().int().positive().optional(),
        filterTags: z.array(z.string().min(1)).optional(),
        passThreshold: z.number().min(0).max(1).optional(),
        ...renamedKeys({
          iterations: 'trials',
          accuracyThreshold: 'passThreshold',
        }),
      })
      .strict()
      .optional(),
    redactStoredResponses: z.boolean().optional(),
    simulateWrites: z.boolean().optional(),
    /**
     * USD per million tokens, by model, for clients that report tokens but not
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
    ...renamedKeys(RENAMED_CONFIG_KEYS),
    ...removedKeys({ toolOverrides: TOOL_OVERRIDES_MOVED }),
  })
  // Unknown keys are mistakes (a misspelt control would be silently ignored).
  .strict();

export type EvalConfigInput = z.input<typeof EvalConfigSchema>;

/** Keys that belong to the eval config itself; a shared config can't set them. */
const CONFIG_OWN_KEYS = [
  'name',
  'datasets',
  'variants',
  'baseline',
  'plugins',
  'extends',
] as const;

/**
 * The eval config settings a plugin shares in `configs`. An eval config applies one
 * with `extends: ["<namespace>/config/<name>"]`. Unknown keys are rejected.
 */
const PluginConfigSchema = EvalConfigSchema.pick({
  servers: true,
  client: true,
  model: true,
  clientOptions: true,
  host: true,
  toolMap: true,
  inputTemplate: true,
  metrics: true,
  judges: true,
  pairwiseJudges: true,
  coworkSetup: true,
  results: true,
  provider: true,
  concurrency: true,
  trials: true,
  maxCases: true,
  timeout: true,
  maxToolCalls: true,
  tools: true,
  requireEvalEndpoint: true,
  pricing: true,
  passThreshold: true,
  temperature: true,
  maxTokens: true,
}).strict();

/** A plugin's shared config: any eval config setting but its name, datasets, variants, plugins and extends. */
export type PluginConfig = z.input<typeof PluginConfigSchema>;

/** A parsed shared config: judge, metric and store shorthands are tagged configs. */
export type ParsedPluginConfig = Omit<
  z.output<typeof PluginConfigSchema>,
  'judges' | 'pairwiseJudges' | 'metrics' | 'results'
> & {
  judges?: ExtensionConfig[];
  pairwiseJudges?: ExtensionConfig[];
  metrics?: ExtensionConfig[];
  results?: { store: ExtensionConfig };
};

/** Parse a shared config; `label` names it in errors. */
export function parsePluginConfig(
  value: unknown,
  label: string
): ParsedPluginConfig {
  if (value && typeof value === 'object') {
    const own = CONFIG_OWN_KEYS.filter((key) => key in value);
    if ('arms' in value)
      throw new Error(
        `${label}: \`arms\` is now \`variants\`, which a shared config can't set.`
      );
    if (own.length > 0) {
      throw new Error(
        `${label} can't set ${own.map((key) => `"${key}"`).join(', ')}: an eval config's ${CONFIG_OWN_KEYS.join(', ')} are its own.`
      );
    }
  }
  const result = PluginConfigSchema.safeParse(value);
  if (!result.success)
    throw new Error(`Invalid ${label}: ${result.error.message}`);
  const { judges, pairwiseJudges, metrics, results, ...settings } = result.data;
  return {
    ...settings,
    ...(judges ? { judges: judges.map(normalizeExtension) } : {}),
    ...(pairwiseJudges
      ? { pairwiseJudges: pairwiseJudges.map(normalizeExtension) }
      : {}),
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

function normalizeConfig(value: z.output<typeof EvalConfigSchema>): EvalConfig {
  return {
    ...value,
    datasets: value.datasets.map(normalizeDataset),
    metrics: value.metrics?.map(normalizeExtension),
    judges: value.judges?.map(normalizeExtension),
    pairwiseJudges: value.pairwiseJudges?.map(normalizeExtension),
    results: value.results
      ? { ...value.results, store: normalizeExtension(value.results.store) }
      : undefined,
    variants: value.variants?.map((variant) => ({
      ...variant,
      metrics: variant.metrics?.map(normalizeExtension),
      judges: variant.judges?.map(normalizeExtension),
    })),
  } as EvalConfig;
}

/** Where an eval config's relative paths are looked up. */
export interface ConfigDirs {
  /** The eval config's own directory: relative paths resolve here first. */
  configDir?: string;
  /** The run's root (`--root-dir`): the fallback for paths not found by the eval config. */
  rootDir?: string;
}

/**
 * An input an eval config names (a dataset, a plugin): relative to the
 * eval config's directory, then to `rootDir`, whichever has it; the eval config's
 * directory when neither does, so the error names the expected place.
 */
export function resolveConfigPath(target: string, dirs: ConfigDirs): string {
  if (path.isAbsolute(target)) return target;
  const candidates = [dirs.configDir, dirs.rootDir]
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
  evalConfig: EvalConfig,
  rootDir = process.cwd(),
  configDir?: string
): string[] {
  return evalConfig.datasets.flatMap((dataset) => {
    if (dataset.type !== 'file' && dataset.type !== 'dir') return [];
    if (typeof dataset.path !== 'string') {
      throw new Error(`Dataset source "${dataset.type}" requires a path.`);
    }
    return [resolveConfigPath(dataset.path, { configDir, rootDir })];
  });
}

export interface LoadEvalConfigOptions {
  rootDir?: string;
  /** The eval config's directory; `loadEvalConfig` sets it from the path. */
  configDir?: string;
  skipDatasetValidation?: boolean;
}

export function loadEvalConfigFromObject(
  value: unknown,
  options: LoadEvalConfigOptions = {}
): EvalConfig {
  const evalConfig = normalizeConfig(EvalConfigSchema.parse(value));
  if (options.skipDatasetValidation) return evalConfig;

  for (const datasetPath of resolveDatasetPaths(
    evalConfig,
    options.rootDir,
    options.configDir
  )) {
    if (!fs.existsSync(datasetPath)) {
      throw new Error(`Dataset path not found: ${datasetPath}`);
    }
  }
  return evalConfig;
}

export function loadEvalConfig(
  configPath: string,
  options: LoadEvalConfigOptions = {}
): EvalConfig {
  const absolutePath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Eval config not found: ${absolutePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Eval config ${absolutePath} isn't valid JSON: ${(error as Error).message}`,
      { cause: error }
    );
  }
  return loadEvalConfigFromObject(raw, {
    ...options,
    rootDir: options.rootDir ?? path.dirname(absolutePath),
    configDir: path.dirname(absolutePath),
  });
}
