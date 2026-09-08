import type {
  DatasetSource,
  HostDefinition,
  JudgeDefinition,
  MetricDefinition,
  ResultStoreDefinition,
} from './evalFrameworkTypes.js';
import type { EvalManifest, ExtensionConfig } from './evalManifest.js';

interface NamedImplementation {
  readonly name: string;
}

interface Registry<T extends NamedImplementation> {
  register(implementation: T): void;
  get(name: string): T;
  list(): T[];
  clear(): void;
}

function createRegistry<T extends NamedImplementation>(
  kind: string
): Registry<T> {
  const implementations = new Map<string, T>();
  return {
    register(implementation) {
      const existing = implementations.get(implementation.name);
      if (existing && existing !== implementation) {
        throw new Error(
          `${kind} "${implementation.name}" is already registered.`
        );
      }
      implementations.set(implementation.name, implementation);
    },
    get(name) {
      const implementation = implementations.get(name);
      if (!implementation) {
        const available = [...implementations.keys()].sort().join(', ');
        throw new Error(
          `${kind} "${name}" is not registered.${
            available ? ` Available: ${available}.` : ''
          }`
        );
      }
      return implementation;
    },
    list() {
      return [...implementations.values()].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    },
    clear() {
      implementations.clear();
    },
  };
}

const datasetSources = createRegistry<DatasetSource>('Dataset source');
const hosts = createRegistry<HostDefinition>('Host');
const judges = createRegistry<JudgeDefinition>('Judge');
const metrics = createRegistry<MetricDefinition>('Metric');
const resultStores = createRegistry<ResultStoreDefinition>('Result store');

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

function extensionName(extension: ExtensionConfig): string {
  return extension.name ?? extension.type;
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

/** Validate manifest references against the currently registered extensions. */
export function validateManifestRegistrations(manifest: EvalManifest): void {
  for (const dataset of manifest.datasets) getDatasetSource(dataset.type);
  if (manifest.host) getHost(manifest.host.type);
  for (const metric of manifest.metrics ?? []) getMetric(extensionName(metric));
  for (const judge of manifest.judges ?? []) getJudge(extensionName(judge));
  if (manifest.results?.store) {
    getResultStore(extensionName(manifest.results.store));
  }
  validateLabels(manifest.servers ?? [], 'the manifest');
  for (const arm of manifest.arms ?? []) {
    if (arm.host) getHost(arm.host.type);
    for (const metric of arm.metrics ?? []) getMetric(extensionName(metric));
    for (const judge of arm.judges ?? []) getJudge(extensionName(judge));
    validateLabels(arm.servers ?? [], `arm "${arm.name}"`);
  }
}
