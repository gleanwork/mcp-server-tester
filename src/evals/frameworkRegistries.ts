import { z, type ZodType } from 'zod';
import type {
  DatasetSource,
  MetricDefinition,
  HostDefinition,
  JudgeDefinition,
  ResultStoreDefinition,
} from './evalFrameworkTypes.js';
import type {
  EvalManifest,
  ExtensionConfig,
  HostConfig,
  TaggedConfig,
} from './evalManifest.js';

interface NamedImplementation {
  readonly name: string;
}

interface Registry<T extends NamedImplementation> {
  register(implementation: T): void;
  get(name: string): T;
  list(): T[];
  clear(): void;
}

interface RegistryState {
  datasets: Map<string, NamedImplementation>;
  hosts: Map<string, NamedImplementation>;
  judges: Map<string, NamedImplementation>;
  metrics: Map<string, NamedImplementation>;
  resultStores: Map<string, NamedImplementation>;
}

const REGISTRY_STATE_KEY = Symbol.for(
  'mcp-server-tester.framework-registry-state'
);
const globalRegistry = globalThis as unknown as Record<symbol, unknown>;
const existingRegistryState = globalRegistry[REGISTRY_STATE_KEY] as
  | RegistryState
  | undefined;
const registryState: RegistryState = existingRegistryState ?? {
  datasets: new Map<string, NamedImplementation>(),
  hosts: new Map<string, NamedImplementation>(),
  judges: new Map<string, NamedImplementation>(),
  metrics: new Map<string, NamedImplementation>(),
  resultStores: new Map<string, NamedImplementation>(),
};
if (!existingRegistryState) globalRegistry[REGISTRY_STATE_KEY] = registryState;

function createRegistry<T extends NamedImplementation>(
  kind: string,
  implementations: Map<string, NamedImplementation>
): Registry<T> {
  const typedImplementations = implementations as Map<string, T>;
  return {
    register(implementation) {
      const existing = typedImplementations.get(implementation.name);
      if (existing && existing !== implementation) {
        throw new Error(
          `${kind} "${implementation.name}" is already registered.`
        );
      }
      typedImplementations.set(implementation.name, implementation);
    },
    get(name) {
      const implementation = typedImplementations.get(name);
      if (!implementation) {
        const available = [...typedImplementations.keys()].sort().join(', ');
        throw new Error(
          `${kind} "${name}" is not registered.${
            available ? ` Available: ${available}.` : ''
          }`
        );
      }
      return implementation;
    },
    list() {
      return [...typedImplementations.values()].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    },
    clear() {
      typedImplementations.clear();
    },
  };
}

const datasetSources = createRegistry<DatasetSource>(
  'Dataset source',
  registryState.datasets
);
const hosts = createRegistry<HostDefinition>('Host', registryState.hosts);
const judges = createRegistry<JudgeDefinition>('Judge', registryState.judges);
const metrics = createRegistry<MetricDefinition>(
  'Metric',
  registryState.metrics
);
const resultStores = createRegistry<ResultStoreDefinition>(
  'Result store',
  registryState.resultStores
);

export const registerDatasetSource = (source: DatasetSource): void =>
  datasetSources.register(source);
export const getDatasetSource = (name: string): DatasetSource =>
  datasetSources.get(name);
export const listDatasetSources = (): DatasetSource[] => datasetSources.list();
export const clearDatasetSources = (): void => datasetSources.clear();

export const registerHost = (host: HostDefinition): void =>
  hosts.register(host);
export const getHost = (name: string): HostDefinition => hosts.get(name);
export const listHosts = (): HostDefinition[] => hosts.list();
export const clearHosts = (): void => hosts.clear();

export const registerJudge = (judge: JudgeDefinition): void =>
  judges.register(judge);
export const getJudge = (name: string): JudgeDefinition => judges.get(name);
export const listJudges = (): JudgeDefinition[] => judges.list();
export const clearJudges = (): void => judges.clear();

export const registerMetric = (metric: MetricDefinition): void =>
  metrics.register(metric);
export const getMetric = (name: string): MetricDefinition => metrics.get(name);
export const listMetrics = (): MetricDefinition[] => metrics.list();
export const clearMetrics = (): void => metrics.clear();

export const registerResultStore = (store: ResultStoreDefinition): void =>
  resultStores.register(store);
export const getResultStore = (name: string): ResultStoreDefinition =>
  resultStores.get(name);
export const listResultStores = (): ResultStoreDefinition[] =>
  resultStores.list();
export const clearResultStores = (): void => resultStores.clear();

function parseConfig<T extends TaggedConfig>(
  config: T,
  implementation: NamedImplementation & { schema: ZodType },
  context: string
): T {
  const result = implementation.schema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid ${context} "${implementation.name}": ${result.error.message}`
    );
  }
  if (
    !result.data ||
    typeof result.data !== 'object' ||
    Array.isArray(result.data)
  ) {
    throw new Error(
      `Invalid ${context} "${implementation.name}": schema must return an options object.`
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
  return configs?.map((config) =>
    parseConfig(config, getMetric(config.type), 'metric options')
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

/**
 * Validate registered schemas and return parsed options, including effective arm
 * inheritance. Callers must use the returned manifest to retain defaults and
 * transforms. The input is not mutated, and each effective config is parsed once.
 */
export function validateManifestRegistrations(
  manifest: EvalManifest
): EvalManifest {
  manifest = normalizeSuiteControls(manifest);
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
