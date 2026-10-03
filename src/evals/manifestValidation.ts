import { z, type ZodType } from 'zod';
import type {
  DatasetSource,
  HostDefinition,
  JudgeDefinition,
  MetricDefinition,
  ResultStoreDefinition,
} from './evalFrameworkTypes.js';
import { getDatasetSource } from './builtinDatasetSources.js';
import { getHost } from './builtinHosts.js';
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

export function parseHostConfig(
  config: HostConfig,
  defaults?: EvalManifest,
  lookups: ManifestLookups = manifestLookups()
): HostConfig {
  const options = { ...config };
  for (const key of ['model', 'provider', 'maxToolCalls', 'timeout'] as const) {
    if (options[key] === undefined && defaults?.[key] !== undefined)
      options[key] = defaults[key];
  }
  return parseConfig(options, lookups.host(config.type), 'host options');
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
 * transforms. The input is not mutated, and each effective config is parsed once.
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
  const arms = manifest.arms?.map((arm) => {
    const servers = arm.servers ?? manifest.servers;
    validateLabels(servers ?? [], `arm "${arm.name}"`);
    return {
      ...arm,
      servers,
      host: arm.host
        ? effectiveHost(
            manifest,
            {
              ...manifest.host,
              ...arm.host,
              type: arm.host.type ?? manifest.host?.type ?? 'claude-cli',
            },
            lookups
          )
        : host,
      metrics: arm.metrics ? parseMetrics(arm.metrics, lookups) : metrics,
      judges: arm.judges ? parseJudges(arm.judges, lookups) : judges,
    };
  });
  return { ...manifest, datasets, host, metrics, judges, results, arms };
}
