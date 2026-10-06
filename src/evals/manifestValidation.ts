import { z, type ZodType } from 'zod';
import type {
  DatasetSource,
  HostDefinition,
  JudgeDefinition,
  MetricDefinition,
  ResultStoreDefinition,
} from './evalFrameworkTypes.js';
import { getDatasetSource } from './builtinDatasetSources.js';
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
  EvalManifest,
  ExtensionConfig,
  HostConfig,
  TaggedConfig,
} from './evalManifest.js';
import { judgeOwnOptions } from '../judge/evaluateJudge.js';

/**
 * The lookups validation resolves references through. With `namespaces`, each
 * reference is checked against the suite's plugins where it is resolved: the
 * extension table is shared by every suite in a process (a batch), so without
 * this a suite could pass only because another one loaded the plugin
 * (ADR-0001).
 */
interface ManifestLookups {
  datasetSource(reference: string): DatasetSource;
  host(reference: string): HostDefinition;
  metric(reference: string): MetricDefinition;
  judge(reference: string): JudgeDefinition;
  resultStore(reference: string): ResultStoreDefinition;
}

function manifestLookups(namespaces?: readonly string[]): ManifestLookups {
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
  options: ValidateManifestOptions = {}
): {
  definition: ResultStoreDefinition;
  config: ExtensionConfig;
} {
  const definition = manifestLookups(options.namespaces).resultStore(
    config.type
  );
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
export function normalizeSuiteControls(manifest: EvalManifest): EvalManifest {
  if (manifest.profile !== undefined) {
    throw new Error(
      'Evaluation profile is not supported; use explicit host and run controls.'
    );
  }
  const nested = SuiteControlsSchema.parse(manifest.run ?? {});
  const top = SuiteControlsSchema.parse(
    Object.fromEntries(
      Object.keys(SuiteControlsSchema.shape).map((key) => [key, manifest[key]])
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
    ...manifest,
    ...nested,
    ...Object.fromEntries(
      Object.entries(top).filter(([, value]) => value !== undefined)
    ),
  };
}

function parseMetrics(
  configs: ExtensionConfig[] | undefined,
  lookups: ManifestLookups
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
  lookups: ManifestLookups
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

/** Manifest settings that default every host's option of the same name. */
const HOST_DEFAULTS = [
  'model',
  'provider',
  'maxToolCalls',
  'timeout',
  'temperature',
  'maxTokens',
] as const;

/** Whether a host's schema takes `key`: declared, or accepted by a loose schema. */
export function takesOption(schema: ZodType, key: string): boolean {
  if (!(schema instanceof z.ZodObject)) return true;
  if (key in schema.shape) return true;
  const catchall = (
    schema._zod.def as { catchall?: { _zod: { def: { type: string } } } }
  ).catchall?._zod.def.type;
  return catchall !== undefined && catchall !== 'never';
}

/**
 * A host's options with the manifest's defaults filled in, for the options
 * its schema takes (a shared `provider` doesn't reach a host that has none).
 */
export function parseHostConfig(
  config: HostConfig,
  defaults?: EvalManifest,
  lookups: ManifestLookups = manifestLookups()
): HostConfig {
  const definition = lookups.host(config.type);
  // A deprecated name is recorded as the current one.
  const options: HostConfig = {
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

/** An arm's (or case's) host: the base host's options apply only to the same host. */
export function inheritHost(
  base: HostConfig | undefined,
  patch: Partial<HostConfig>
): HostConfig {
  // Deprecated names resolve first, so `cowork_cu` inherits from `cowork`.
  const type = resolveHostName(patch.type ?? base?.type ?? 'claude-cli');
  const inherited =
    base !== undefined && resolveHostName(base.type) === type ? base : {};
  return { ...inherited, ...patch, type } as HostConfig;
}

/** A manifest default no host of the run takes would silently do nothing. */
function assertDefaultsUsed(
  manifest: EvalManifest,
  hosts: HostConfig[],
  lookups: ManifestLookups
): void {
  for (const key of HOST_DEFAULTS) {
    if (manifest[key] === undefined || hosts.length === 0) continue;
    const used = hosts.some((host) =>
      takesOption(lookups.host(host.type).schema, key)
    );
    if (!used)
      throw new Error(
        `The manifest sets "${key}", but none of its hosts (${[...new Set(hosts.map((host) => host.type))].join(', ')}) takes it.`
      );
  }
}

function effectiveHost(
  manifest: EvalManifest,
  host: HostConfig | undefined,
  lookups: ManifestLookups
): HostConfig | undefined {
  return host ? parseHostConfig(host, manifest, lookups) : undefined;
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
  context = 'The manifest'
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

export interface ValidateManifestOptions {
  /**
   * Namespaces of the plugins this suite loads. When given, references to any
   * other namespace are rejected.
   */
  namespaces?: readonly string[];
}

/**
 * Validate a manifest against the schemas of the extensions it names and return
 * parsed options, including effective arm inheritance. Callers must use the returned manifest to retain defaults and
 * transforms. The input is not mutated, and each effective config is parsed once. Apply a manifest's `extends`
 * first, with `resolveManifestExtends`; `runEvalSuite` does both.
 */
export function validateManifest(
  manifest: EvalManifest,
  options: ValidateManifestOptions = {}
): EvalManifest {
  manifest = normalizeSuiteControls(manifest);
  const lookups = manifestLookups(options.namespaces);
  validateLabels(manifest.servers ?? [], 'the manifest');
  const datasets = manifest.datasets.map((config) =>
    parseConfig(config, lookups.datasetSource(config.type), 'dataset options')
  );
  const host = effectiveHost(manifest, manifest.host, lookups);
  const metrics = parseMetrics(manifest.metrics, lookups);
  const judges = parseJudges(manifest.judges, lookups);
  const results = manifest.results
    ? {
        ...manifest.results,
        store: parseConfig(
          manifest.results.store,
          lookups.resultStore(manifest.results.store.type),
          'result store options'
        ),
      }
    : undefined;
  if (!manifest.arms?.length && host) {
    assertHostSupports(host, {
      servers: manifest.servers ?? [],
      toolOverrides: manifest.toolOverrides,
      concurrency: manifest.concurrency,
      context: 'The manifest',
    });
  }
  const arms = manifest.arms?.map((arm) => {
    const servers = arm.servers ?? manifest.servers;
    validateLabels(servers ?? [], `arm "${arm.name}"`);
    const armHost = arm.host
      ? effectiveHost(manifest, inheritHost(manifest.host, arm.host), lookups)
      : host;
    if (armHost) {
      assertHostSupports(armHost, {
        servers: servers ?? [],
        toolOverrides: arm.toolOverrides ?? manifest.toolOverrides,
        concurrency: manifest.concurrency,
        context: `Arm "${arm.name}"`,
      });
    }
    return {
      ...arm,
      servers,
      host: armHost,
      metrics: arm.metrics ? parseMetrics(arm.metrics, lookups) : metrics,
      judges: arm.judges ? parseJudges(arm.judges, lookups) : judges,
    };
  });
  assertDefaultsUsed(
    manifest,
    [
      ...(manifest.arms?.length && manifest.arms.every((arm) => arm.host)
        ? []
        : host
          ? [host]
          : []),
      ...(arms ?? []).flatMap((arm) => (arm.host ? [arm.host] : [])),
    ],
    lookups
  );
  return { ...manifest, datasets, host, metrics, judges, results, arms };
}
