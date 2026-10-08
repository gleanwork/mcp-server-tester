import { z, type ZodType } from 'zod';
import type {
  DatasetSource,
  ClientDefinition,
  JudgeDefinition,
  MetricDefinition,
  ResultStoreDefinition,
} from './evalFrameworkTypes.js';
import { getDatasetSource } from './builtinDatasetSources.js';
import { clientFieldsOf, clientOf, clientPatchOf } from './clientFields.js';
import {
  assertClientSupports,
  getClient,
  resolveClientName,
} from './builtinClients.js';
import { getJudge } from '../judge/builtinJudges.js';
import type { PairwiseJudgeDefinition } from '../judge/pairwiseContract.js';
import {
  getPairwiseJudge,
  type PairwiseJudgeSpec,
} from './pairwiseComparison.js';
import { getMetric } from './metrics.js';
import { getResultStore } from './builtinResultStores.js';
import {
  parseExtensionOptions,
  BUILTIN_NAMESPACE,
  parseExtensionReference,
} from '../plugins/plugin.js';
import {
  isConnectorServer,
  type EvalConfig,
  type EvalServerConfig,
  type EvalVariant,
  type ExtensionConfig,
  type ClientConfig,
  type TaggedConfig,
} from './evalConfig.js';
import { mcpServerLabel, type MCPConfig } from '../config/mcpConfig.js';

/**
 * The servers a client must support. A connector server is checked once `mst
 * run` has expanded it (to the entry its connector launches).
 */
function declaredTransports(
  servers: readonly EvalServerConfig[] | undefined
): MCPConfig[] {
  return (servers ?? []).filter(
    (server): server is MCPConfig => !isConnectorServer(server)
  );
}
import { judgeOwnOptions } from '../judge/evaluateJudge.js';

/**
 * The lookups validation resolves references through. With `namespaces`, each
 * reference is checked against the eval's plugins where it is resolved: the
 * extension table is shared by every eval in a process (a batch), so without
 * this an eval could pass only because another one loaded the plugin
 * (ADR-0001).
 */
interface ConfigLookups {
  datasetSource(reference: string): DatasetSource;
  client(reference: string): ClientDefinition;
  metric(reference: string): MetricDefinition;
  judge(reference: string): JudgeDefinition;
  pairwiseJudge(reference: string): PairwiseJudgeDefinition;
  resultStore(reference: string): ResultStoreDefinition;
}

function configLookups(namespaces?: readonly string[]): ConfigLookups {
  function scoped<T>(get: (reference: string) => T) {
    return (reference: string): T => {
      if (namespaces) assertListedNamespaces([reference], namespaces);
      return get(reference);
    };
  }
  return {
    datasetSource: scoped(getDatasetSource),
    client: scoped(getClient),
    metric: scoped(getMetric),
    judge: scoped(getJudge),
    pairwiseJudge: scoped(getPairwiseJudge),
    resultStore: scoped(getResultStore),
  };
}

/** Resolve by implementation type and retain parsed defaults/transforms for consumers. */
export function resolveResultStoreConfig(
  config: ExtensionConfig,
  options: ValidateEvalConfigOptions = {}
): {
  definition: ResultStoreDefinition;
  config: ExtensionConfig;
} {
  const definition = configLookups(options.namespaces).resultStore(config.type);
  return {
    definition,
    config: parseConfig(config, definition, 'result store options'),
  };
}

function parseConfig<T extends TaggedConfig>(
  config: T,
  implementation: { schema: ZodType },
  context: string
): T {
  const data = parseExtensionOptions(
    implementation.schema,
    config,
    `${context} "${config.type}"`
  );
  // Keep routing metadata even when an options schema strips unknown keys.
  // Do not merge raw options back in: that would undo stripping/transforms.
  return {
    ...data,
    type: config.type,
    ...(typeof config.name === 'string' ? { name: config.name } : {}),
  } as T;
}

const EvalControlsSchema = z
  .object({
    trials: z.number().int().positive().optional(),
    maxCases: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
    filterTags: z.array(z.string().min(1)).optional(),
    passThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();

/** Canonical top-level controls, with explicit support for the run namespace. */
export function normalizeEvalControls(evalConfig: EvalConfig): EvalConfig {
  if (evalConfig.profile !== undefined) {
    throw new Error(
      'Evaluation profile is not supported; use explicit client and run controls.'
    );
  }
  const nested = EvalControlsSchema.parse(evalConfig.run ?? {});
  const top = EvalControlsSchema.parse(
    Object.fromEntries(
      Object.keys(EvalControlsSchema.shape).map((key) => [key, evalConfig[key]])
    )
  );
  for (const key of Object.keys(nested) as Array<keyof typeof nested>) {
    if (
      top[key] !== undefined &&
      JSON.stringify(top[key]) !== JSON.stringify(nested[key])
    ) {
      throw new Error(
        `Conflicting evaluation controls: ${key} and run.${key}.`
      );
    }
  }
  return {
    ...evalConfig,
    ...nested,
    ...Object.fromEntries(
      Object.entries(top).filter(([, value]) => value !== undefined)
    ),
  };
}

function parseMetrics(
  configs: ExtensionConfig[] | undefined,
  lookups: ConfigLookups
): ExtensionConfig[] | undefined {
  // resolveMetric runs the spec's `metric` key when it has one, so validate that.
  return configs?.map((config) =>
    parseConfig(
      config,
      lookups.metric(
        typeof config.metric === 'string' ? config.metric : config.type
      ),
      'metric options'
    )
  );
}

/** How an eval config judge grades: checked here, since the entry is otherwise the judge's. */
const JudgeGradingSchema = z.object({
  threshold: z.number().min(0).max(1).optional(),
  reps: z.number().int().min(1).optional(),
});

function parseJudges(
  configs: ExtensionConfig[] | undefined,
  lookups: ConfigLookups
): ExtensionConfig[] | undefined {
  return configs?.map((config) => {
    const grading = JudgeGradingSchema.safeParse(config);
    if (!grading.success)
      throw new Error(
        `Invalid judge "${config.type}": ${grading.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
      );
    // The judge's schema sees only its own options; the assertion keys
    // (threshold, reference, reps) and routing (type, name) are kept as given.
    const own = judgeOwnOptions(config);
    const options = parseExtensionOptions(
      lookups.judge(config.type).schema,
      own,
      `judge options "${config.type}"`
    );
    const assertion = Object.fromEntries(
      Object.entries(config).filter(([key]) => !Object.hasOwn(own, key))
    );
    return { ...options, ...assertion } as ExtensionConfig;
  });
}

/** How a pairwise judge runs: `reps` per case and order; the rest are its options. */
const PairwiseRepsSchema = z.number().int().min(1).optional();

/**
 * Check each pairwise judge exists (in a loaded plugin) and takes its
 * options. The entries are returned as written: `comparePairwise` parses the
 * options itself, once.
 */
function checkPairwiseJudges(
  configs: ExtensionConfig[] | undefined,
  lookups: ConfigLookups
): ExtensionConfig[] | undefined {
  return configs?.map((config) => {
    const definition = lookups.pairwiseJudge(config.type);
    const reps = PairwiseRepsSchema.safeParse(config.reps);
    if (!reps.success)
      throw new Error(
        `Invalid pairwise judge "${config.type}": reps must be a whole number of at least 1.`
      );
    parseExtensionOptions(
      definition.schema,
      pairwiseJudgeSpec(config).options,
      `pairwise judge options "${config.type}"`
    );
    return config;
  });
}

/** A pairwise judge entry (`{ type, reps?, ...options }`) as comparePairwise takes it. */
export function pairwiseJudgeSpec(
  config: ExtensionConfig
): PairwiseJudgeSpec & { options: Record<string, unknown> } {
  const { type, reps, name: _name, ...options } = config;
  return {
    type,
    ...(typeof reps === 'number' ? { reps } : {}),
    options,
  };
}

/** Eval config settings that default every client's option of the same name. */
const HOST_DEFAULTS = [
  'model',
  'provider',
  'maxToolCalls',
  'timeout',
  'temperature',
  'maxTokens',
] as const;

/** Whether a client's schema takes `key`: declared, or accepted by a loose schema. */
function takesOption(schema: ZodType, key: string): boolean {
  if (!(schema instanceof z.ZodObject)) return true;
  if (key in schema.shape) return true;
  const catchall = (
    schema._zod.def as { catchall?: { _zod: { def: { type: string } } } }
  ).catchall?._zod.def.type;
  return catchall !== undefined && catchall !== 'never';
}

/**
 * A client's options with the eval config's defaults filled in, for the options
 * its schema takes (a shared `provider` doesn't reach a client that has none).
 */
export function parseClientConfig(
  config: ClientConfig,
  defaults?: EvalConfig,
  lookups: ConfigLookups = configLookups()
): ClientConfig {
  const definition = lookups.client(config.type);
  // A deprecated name is recorded as the current one.
  const options: ClientConfig = {
    ...config,
    type: resolveClientName(config.type),
  };
  for (const key of HOST_DEFAULTS) {
    if (
      options[key] === undefined &&
      defaults?.[key] !== undefined &&
      takesOption(definition.schema, key)
    )
      options[key] = defaults[key];
  }
  return parseConfig(options, definition, 'client options');
}

/** A variant's (or case's) client: the base client's options apply only to the same client. */
export function inheritClient(
  base: ClientConfig | undefined,
  patch: Partial<ClientConfig>
): ClientConfig {
  // Deprecated names resolve first, so `cowork_cu` inherits from `cowork`.
  const type = resolveClientName(patch.type ?? base?.type ?? 'claude-code');
  const inherited =
    base !== undefined && resolveClientName(base.type) === type ? base : {};
  return { ...inherited, ...patch, type } as ClientConfig;
}

/** An eval config default no client of the run takes would silently do nothing. */
function assertDefaultsUsed(
  evalConfig: EvalConfig,
  clientConfigs: ClientConfig[],
  lookups: ConfigLookups
): void {
  for (const key of HOST_DEFAULTS) {
    if (evalConfig[key] === undefined || clientConfigs.length === 0) continue;
    const used = clientConfigs.some((client) =>
      takesOption(lookups.client(client.type).schema, key)
    );
    if (!used)
      throw new Error(
        `The eval config sets "${key}", but none of its clients (${[...new Set(clientConfigs.map((client) => client.type))].join(', ')}) takes it.`
      );
  }
}

function effectiveClient(
  evalConfig: EvalConfig,
  client: ClientConfig | undefined,
  lookups: ConfigLookups
): ClientConfig | undefined {
  return client ? parseClientConfig(client, evalConfig, lookups) : undefined;
}

function validateLabels(
  servers: Array<{ label?: string }>,
  context: string
): void {
  const labels = servers.map((server) => server.label).filter(Boolean);
  if (labels.length !== new Set(labels).size) {
    throw new Error(`MCP server labels must be unique within ${context}.`);
  }
  if (servers.length > 1 && labels.length !== servers.length) {
    throw new Error(
      `Every MCP server in ${context} requires a label when the set has multiple entries.`
    );
  }
}

/**
 * A variant's servers: the eval config's servers it names by label, in the
 * order it lists them, or every server when it names none. A programmatic
 * variant may carry its own `servers` instead.
 */
function variantServers(
  variant: EvalVariant,
  servers: readonly EvalServerConfig[]
): EvalServerConfig[] | undefined {
  if (variant.serverLabels === undefined) return variant.servers;
  if (variant.servers !== undefined)
    throw new Error(
      `Variant "${variant.name}" sets both servers and serverLabels; name its servers by label only.`
    );
  const byLabel = new Map(
    servers.map((server, index) => [
      server.label ?? mcpServerLabel(server as MCPConfig, index),
      server,
    ])
  );
  const seen = new Set<string>();
  return variant.serverLabels.map((label) => {
    if (seen.has(label))
      throw new Error(
        `Variant "${variant.name}" lists server "${label}" more than once.`
      );
    seen.add(label);
    const server = byLabel.get(label);
    if (!server) {
      const known = [...byLabel.keys()].join(', ');
      throw new Error(
        `Variant "${variant.name}" names server "${label}", which the eval config doesn't define. ${known ? `Its servers are: ${known}.` : 'It defines no servers.'}`
      );
    }
    return server;
  });
}

/** Reject references to plugin namespaces the eval didn't load (ADR-0001). */
export function assertListedNamespaces(
  references: readonly string[],
  namespaces: readonly string[],
  context = 'The eval config'
): void {
  for (const reference of references) {
    const { namespace } = parseExtensionReference(reference);
    if (
      namespace !== undefined &&
      namespace !== BUILTIN_NAMESPACE &&
      !namespaces.includes(namespace)
    ) {
      throw new Error(
        `${context} references "${reference}", but doesn't load the "${namespace}" plugin. Add the plugin to "plugins".`
      );
    }
  }
}

export interface ValidateEvalConfigOptions {
  /**
   * Namespaces of the plugins this eval loads. When given, references to any
   * other namespace are rejected.
   */
  namespaces?: readonly string[];
}

/**
 * Validate an eval config against the schemas of the extensions it names and return
 * parsed options, including effective variant inheritance. Callers must use the returned eval config to retain defaults and
 * transforms. The input is not mutated, and each effective config is parsed once. Apply an eval config's `extends`
 * first, with `resolveConfigExtends`; `runEval` does both.
 */
export function validateEvalConfig(
  evalConfig: EvalConfig,
  options: ValidateEvalConfigOptions = {}
): EvalConfig {
  evalConfig = normalizeEvalControls(evalConfig);
  const lookups = configLookups(options.namespaces);
  // Connector servers resolve when the run expands them; check their namespaces now.
  if (options.namespaces)
    assertListedNamespaces(
      [evalConfig.servers, ...(evalConfig.variants ?? []).map((v) => v.servers)]
        .flatMap((servers) => servers ?? [])
        .filter(isConnectorServer)
        .map((server) => server.connector),
      options.namespaces
    );
  validateLabels(evalConfig.servers ?? [], 'the eval config');
  const datasets = evalConfig.datasets.map((config) =>
    parseConfig(config, lookups.datasetSource(config.type), 'dataset options')
  );
  const base = clientOf(evalConfig);
  const client = effectiveClient(evalConfig, base, lookups);
  const metrics = parseMetrics(evalConfig.metrics, lookups);
  const judges = parseJudges(evalConfig.judges, lookups);
  const pairwiseJudges = checkPairwiseJudges(
    evalConfig.pairwiseJudges,
    lookups
  );
  const results = evalConfig.results
    ? {
        ...evalConfig.results,
        store: parseConfig(
          evalConfig.results.store,
          lookups.resultStore(evalConfig.results.store.type),
          'result store options'
        ),
      }
    : undefined;
  if (!evalConfig.variants?.length && client) {
    assertClientSupports(client, {
      servers: declaredTransports(evalConfig.servers),
      tools: evalConfig.tools,
      concurrency: evalConfig.concurrency,
      context: 'The eval config',
    });
  }
  const variantClients: ClientConfig[] = [];
  const variants = evalConfig.variants?.map((variant) => {
    const servers =
      variantServers(variant, evalConfig.servers ?? []) ?? evalConfig.servers;
    validateLabels(servers ?? [], `variant "${variant.name}"`);
    const patch = clientPatchOf(variant);
    const variantClient = patch
      ? effectiveClient(evalConfig, inheritClient(base, patch), lookups)
      : client;
    if (patch && variantClient) variantClients.push(variantClient);
    if (variantClient) {
      assertClientSupports(variantClient, {
        servers: declaredTransports(servers),
        tools: variant.tools ?? evalConfig.tools,
        concurrency: evalConfig.concurrency,
        context: `Variant "${variant.name}"`,
      });
    }
    const { serverLabels: _labels, ...resolved } = variant;
    return {
      ...resolved,
      servers,
      ...(variantClient ? clientFieldsOf(variantClient) : {}),
      metrics: variant.metrics
        ? parseMetrics(variant.metrics, lookups)
        : metrics,
      judges: variant.judges ? parseJudges(variant.judges, lookups) : judges,
    };
  });
  assertDefaultsUsed(
    evalConfig,
    [
      ...(evalConfig.variants?.length &&
      evalConfig.variants.every((variant) => clientPatchOf(variant))
        ? []
        : client
          ? [client]
          : []),
      ...variantClients,
    ],
    lookups
  );
  return {
    ...evalConfig,
    datasets,
    ...(client ? clientFieldsOf(client) : {}),
    metrics,
    judges,
    ...(pairwiseJudges ? { pairwiseJudges } : {}),
    results,
    variants: baselineFirst(variants, evalConfig.baseline),
  };
}

/**
 * The variants with the baseline first: the one `baseline` names, else the
 * first. Comparisons read the baseline as the first variant.
 */
function baselineFirst<T extends { name: string }>(
  variants: T[] | undefined,
  baseline: string | undefined
): T[] | undefined {
  if (baseline === undefined) return variants;
  const index =
    variants?.findIndex((variant) => variant.name === baseline) ?? -1;
  if (index < 0)
    throw new Error(
      `baseline "${baseline}" names no variant${variants?.length ? `; the variants are ${variants.map((variant) => `"${variant.name}"`).join(', ')}` : ': the eval config has none'}.`
    );
  return [variants![index]!, ...variants!.filter((_, i) => i !== index)];
}
