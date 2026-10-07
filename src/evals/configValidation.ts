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
  assertHostSupports,
  getHost,
  resolveHostName,
} from './builtinHosts.js';
import { getJudge } from '../judge/builtinJudges.js';
import { getMetric } from './metrics.js';
import { getResultStore } from './builtinResultStores.js';
import {
  parseExtensionOptions,
  parseExtensionReference,
} from '../plugins/plugin.js';
import type {
  EvalConfig,
  ExtensionConfig,
  ClientConfig,
  TaggedConfig,
} from './evalConfig.js';
import { judgeOwnOptions } from '../judge/evaluateJudge.js';

/**
 * The lookups validation resolves references through. With `namespaces`, each
 * reference is checked against the suite's plugins where it is resolved: the
 * extension table is shared by every suite in a process (a batch), so without
 * this a suite could pass only because another one loaded the plugin
 * (ADR-0001).
 */
interface ConfigLookups {
  datasetSource(reference: string): DatasetSource;
  host(reference: string): ClientDefinition;
  metric(reference: string): MetricDefinition;
  judge(reference: string): JudgeDefinition;
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
    host: scoped(getHost),
    metric: scoped(getMetric),
    judge: scoped(getJudge),
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

const SuiteControlsSchema = z
  .object({
    trials: z.number().int().positive().optional(),
    maxCases: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
    filterTags: z.array(z.string().min(1)).optional(),
    passThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();

/** Canonical top-level controls, with explicit support for the run namespace. */
export function normalizeSuiteControls(evalConfig: EvalConfig): EvalConfig {
  if (evalConfig.profile !== undefined) {
    throw new Error(
      'Evaluation profile is not supported; use explicit host and run controls.'
    );
  }
  const nested = SuiteControlsSchema.parse(evalConfig.run ?? {});
  const top = SuiteControlsSchema.parse(
    Object.fromEntries(
      Object.keys(SuiteControlsSchema.shape).map((key) => [
        key,
        evalConfig[key],
      ])
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

function parseJudges(
  configs: ExtensionConfig[] | undefined,
  lookups: ConfigLookups
): ExtensionConfig[] | undefined {
  return configs?.map((config) => {
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

/** Eval config settings that default every host's option of the same name. */
const HOST_DEFAULTS = [
  'model',
  'provider',
  'maxToolCalls',
  'timeout',
  'temperature',
  'maxTokens',
] as const;

/** Whether a host's schema takes `key`: declared, or accepted by a loose schema. */
function takesOption(schema: ZodType, key: string): boolean {
  if (!(schema instanceof z.ZodObject)) return true;
  if (key in schema.shape) return true;
  const catchall = (
    schema._zod.def as { catchall?: { _zod: { def: { type: string } } } }
  ).catchall?._zod.def.type;
  return catchall !== undefined && catchall !== 'never';
}

/**
 * A host's options with the eval config's defaults filled in, for the options
 * its schema takes (a shared `provider` doesn't reach a host that has none).
 */
export function parseHostConfig(
  config: ClientConfig,
  defaults?: EvalConfig,
  lookups: ConfigLookups = configLookups()
): ClientConfig {
  const definition = lookups.host(config.type);
  // A deprecated name is recorded as the current one.
  const options: ClientConfig = {
    ...config,
    type: resolveHostName(config.type),
  };
  for (const key of HOST_DEFAULTS) {
    if (
      options[key] === undefined &&
      defaults?.[key] !== undefined &&
      takesOption(definition.schema, key)
    )
      options[key] = defaults[key];
  }
  return parseConfig(options, definition, 'host options');
}

/** A variant's (or case's) client: the base client's options apply only to the same client. */
export function inheritHost(
  base: ClientConfig | undefined,
  patch: Partial<ClientConfig>
): ClientConfig {
  // Deprecated names resolve first, so `cowork_cu` inherits from `cowork`.
  const type = resolveHostName(patch.type ?? base?.type ?? 'claude-code');
  const inherited =
    base !== undefined && resolveHostName(base.type) === type ? base : {};
  return { ...inherited, ...patch, type } as ClientConfig;
}

/** An eval config default no host of the run takes would silently do nothing. */
function assertDefaultsUsed(
  evalConfig: EvalConfig,
  hosts: ClientConfig[],
  lookups: ConfigLookups
): void {
  for (const key of HOST_DEFAULTS) {
    if (evalConfig[key] === undefined || hosts.length === 0) continue;
    const used = hosts.some((host) =>
      takesOption(lookups.host(host.type).schema, key)
    );
    if (!used)
      throw new Error(
        `The eval config sets "${key}", but none of its clients (${[...new Set(hosts.map((host) => host.type))].join(', ')}) takes it.`
      );
  }
}

function effectiveHost(
  evalConfig: EvalConfig,
  host: ClientConfig | undefined,
  lookups: ConfigLookups
): ClientConfig | undefined {
  return host ? parseHostConfig(host, evalConfig, lookups) : undefined;
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

/** Reject references to plugin namespaces the suite didn't load (ADR-0001). */
export function assertListedNamespaces(
  references: readonly string[],
  namespaces: readonly string[],
  context = 'The eval config'
): void {
  for (const reference of references) {
    const { namespace } = parseExtensionReference(reference);
    if (namespace !== undefined && !namespaces.includes(namespace)) {
      throw new Error(
        `${context} references "${reference}", but doesn't load the "${namespace}" plugin. Add the plugin to "plugins".`
      );
    }
  }
}

export interface ValidateEvalConfigOptions {
  /**
   * Namespaces of the plugins this suite loads. When given, references to any
   * other namespace are rejected.
   */
  namespaces?: readonly string[];
}

/**
 * Validate an eval config against the schemas of the extensions it names and return
 * parsed options, including effective variant inheritance. Callers must use the returned eval config to retain defaults and
 * transforms. The input is not mutated, and each effective config is parsed once. Apply an eval config's `extends`
 * first, with `resolveConfigExtends`; `runEvalSuite` does both.
 */
export function validateEvalConfig(
  evalConfig: EvalConfig,
  options: ValidateEvalConfigOptions = {}
): EvalConfig {
  evalConfig = normalizeSuiteControls(evalConfig);
  const lookups = configLookups(options.namespaces);
  validateLabels(evalConfig.servers ?? [], 'the eval config');
  const datasets = evalConfig.datasets.map((config) =>
    parseConfig(config, lookups.datasetSource(config.type), 'dataset options')
  );
  const base = clientOf(evalConfig);
  const host = effectiveHost(evalConfig, base, lookups);
  const metrics = parseMetrics(evalConfig.metrics, lookups);
  const judges = parseJudges(evalConfig.judges, lookups);
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
  if (!evalConfig.variants?.length && host) {
    assertHostSupports(host, {
      servers: evalConfig.servers ?? [],
      tools: evalConfig.tools,
      concurrency: evalConfig.concurrency,
      context: 'The eval config',
    });
  }
  const variantHosts: ClientConfig[] = [];
  const variants = evalConfig.variants?.map((variant) => {
    const servers = variant.servers ?? evalConfig.servers;
    validateLabels(servers ?? [], `variant "${variant.name}"`);
    const patch = clientPatchOf(variant);
    const variantHost = patch
      ? effectiveHost(evalConfig, inheritHost(base, patch), lookups)
      : host;
    if (patch && variantHost) variantHosts.push(variantHost);
    if (variantHost) {
      assertHostSupports(variantHost, {
        servers: servers ?? [],
        tools: variant.tools ?? evalConfig.tools,
        concurrency: evalConfig.concurrency,
        context: `Variant "${variant.name}"`,
      });
    }
    return {
      ...variant,
      servers,
      ...(variantHost ? clientFieldsOf(variantHost) : {}),
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
        : host
          ? [host]
          : []),
      ...variantHosts,
    ],
    lookups
  );
  return {
    ...evalConfig,
    datasets,
    ...(host ? clientFieldsOf(host) : {}),
    metrics,
    judges,
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
