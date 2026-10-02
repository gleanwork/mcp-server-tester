import { z, type ZodType } from 'zod';
import type { ResultStoreDefinition } from './evalFrameworkTypes.js';
import { getDatasetSource } from './builtinDatasetSources.js';
import { getHost } from './builtinHosts.js';
import { getJudge } from '../judge/builtinJudges.js';
import { getMetric } from './metrics.js';
import { getResultStore } from './builtinResultStores.js';
import { parseExtensionReference } from '../plugins/plugin.js';
import type {
  EvalManifest,
  ExtensionConfig,
  HostConfig,
  TaggedConfig,
} from './evalManifest.js';

/** Resolve by implementation type and retain parsed defaults/transforms for consumers. */
export function resolveResultStoreConfig(config: ExtensionConfig): {
  definition: ResultStoreDefinition;
  config: ExtensionConfig;
} {
  const definition = getResultStore(config.type);
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
  const result = implementation.schema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid ${context} "${config.type}": ${result.error.message}`
    );
  }
  if (
    !result.data ||
    typeof result.data !== 'object' ||
    Array.isArray(result.data)
  ) {
    throw new Error(
      `Invalid ${context} "${config.type}": schema must return an options object.`
    );
  }
  // Keep routing metadata even when an options schema strips unknown keys.
  // Do not merge raw options back in: that would undo stripping/transforms.
  return {
    ...result.data,
    type: config.type,
    ...(typeof config.name === 'string' ? { name: config.name } : {}),
  } as T;
}

const SuiteControlsSchema = z
  .object({
    iterations: z.number().int().positive().optional(),
    maxCases: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
    filterTags: z.array(z.string().min(1)).optional(),
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
  configs: ExtensionConfig[] | undefined
): ExtensionConfig[] | undefined {
  // resolveMetric runs the spec's `metric` key when it has one, so validate that.
  return configs?.map((config) =>
    parseConfig(
      config,
      getMetric(
        typeof config.metric === 'string' ? config.metric : config.type
      ),
      'metric options'
    )
  );
}

function parseJudges(
  configs: ExtensionConfig[] | undefined
): ExtensionConfig[] | undefined {
  return configs?.map((config) => {
    const parsed = parseConfig(config, getJudge(config.type), 'judge options');
    // These belong to the framework assertion, not the judge's policy schema.
    // A stripping or transforming policy must not change the requested verdict.
    for (const key of ['threshold', 'reference'] as const) {
      if (config[key] !== undefined) parsed[key] = config[key];
    }
    return parsed;
  });
}

export function parseHostConfig(
  config: HostConfig,
  defaults?: EvalManifest
): HostConfig {
  const options = { ...config };
  for (const key of ['model', 'provider', 'maxToolCalls', 'timeout'] as const) {
    if (options[key] === undefined && defaults?.[key] !== undefined)
      options[key] = defaults[key];
  }
  return parseConfig(options, getHost(config.type), 'host options');
}

function effectiveHost(
  manifest: EvalManifest,
  host: HostConfig | undefined
): HostConfig | undefined {
  return host ? parseHostConfig(host, manifest) : undefined;
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

/** Every extension reference (`type`) a manifest declares. */
function manifestReferences(manifest: EvalManifest): string[] {
  const metrics = [
    ...(manifest.metrics ?? []),
    ...(manifest.arms ?? []).flatMap((arm) => arm.metrics ?? []),
  ];
  const blocks: Array<{ type?: unknown } | undefined> = [
    ...manifest.datasets,
    manifest.host,
    ...metrics,
    ...(manifest.judges ?? []),
    manifest.results?.store,
    ...(manifest.arms ?? []).flatMap((arm) => [
      arm.host,
      ...(arm.judges ?? []),
    ]),
  ];
  // A metric spec's `metric` key wins over `type` when it is resolved.
  return [
    ...blocks.map((block) => block?.type),
    ...metrics.map((metric) => metric.metric),
  ].filter((reference): reference is string => typeof reference === 'string');
}

/**
 * Reject references to plugin namespaces the suite didn't load. The extension
 * table is shared by every suite in a process (a batch), so without this a
 * suite could pass only because another one loaded the plugin (ADR-0001).
 */
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
 * Validate registered schemas and return parsed options, including effective arm
 * inheritance. Callers must use the returned manifest to retain defaults and
 * transforms. The input is not mutated, and each effective config is parsed once.
 */
export function validateManifestRegistrations(
  manifest: EvalManifest,
  options: ValidateManifestOptions = {}
): EvalManifest {
  manifest = normalizeSuiteControls(manifest);
  if (options.namespaces)
    assertListedNamespaces(manifestReferences(manifest), options.namespaces);
  validateLabels(manifest.servers ?? [], 'the manifest');
  const datasets = manifest.datasets.map((config) =>
    parseConfig(config, getDatasetSource(config.type), 'dataset options')
  );
  const host = effectiveHost(manifest, manifest.host);
  const metrics = parseMetrics(manifest.metrics);
  const judges = parseJudges(manifest.judges);
  const results = manifest.results
    ? {
        ...manifest.results,
        store: parseConfig(
          manifest.results.store,
          getResultStore(manifest.results.store.type),
          'result store options'
        ),
      }
    : undefined;
  const arms = manifest.arms?.map((arm) => {
    const servers = arm.servers ?? manifest.servers;
    validateLabels(servers ?? [], `arm "${arm.name}"`);
    return {
      ...arm,
      servers,
      host: arm.host
        ? effectiveHost(manifest, {
            ...manifest.host,
            ...arm.host,
            type: arm.host.type ?? manifest.host?.type ?? 'claude-cli',
          })
        : host,
      metrics: arm.metrics ? parseMetrics(arm.metrics) : metrics,
      judges: arm.judges ? parseJudges(arm.judges) : judges,
    };
  });
  return { ...manifest, datasets, host, metrics, judges, results, arms };
}
