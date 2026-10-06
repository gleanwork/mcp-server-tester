import type { ZodType } from 'zod';
import type {
  DatasetSource,
  HostDefinition,
  JudgeDefinition,
  MetricDefinition,
  MetricKind,
  ResultStoreDefinition,
} from '../evals/evalFrameworkTypes.js';
import type { PairwiseJudgeDefinition } from '../judge/pairwiseContract.js';
import type { PluginConfig } from '../evals/evalManifest.js';

/** Identifies a plugin. `namespace` prefixes its extensions: `namespace/name`. */
export interface PluginMeta {
  /** The plugin's package name, used in error messages. */
  readonly name: string;
  readonly version?: string;
  /** Lowercase; `@scope/name` is allowed. Manifests reference `namespace/extension`. */
  readonly namespace: string;
}

/**
 * An MST plugin: a plain object, the default export of its module, in the
 * shape ESLint uses. MST reads it; a plugin never calls into MST to register.
 * Each map key is the extension's name within the plugin's namespace.
 */
export interface Plugin {
  readonly meta: PluginMeta;
  readonly datasetSources?: Readonly<Record<string, DatasetSource>>;
  readonly hosts?: Readonly<Record<string, HostDefinition>>;
  readonly judges?: Readonly<Record<string, JudgeDefinition>>;
  /** Judges that compare two runs of one case (a baseline and a candidate). */
  readonly pairwiseJudges?: Readonly<Record<string, PairwiseJudgeDefinition>>;
  readonly metrics?: Readonly<Record<string, MetricDefinition>>;
  readonly resultStores?: Readonly<Record<string, ResultStoreDefinition>>;
  /**
   * Shared manifest settings. A manifest that lists this plugin applies one
   * with `extends: ["namespace/name"]`. A config may use only this plugin's
   * extensions and built-ins.
   */
  readonly configs?: Readonly<Record<string, PluginConfig>>;
}

export const EXTENSION_KINDS = [
  'datasetSources',
  'hosts',
  'judges',
  'pairwiseJudges',
  'metrics',
  'resultStores',
] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

/** The extension definitions each kind holds. */
export interface ExtensionsByKind {
  datasetSources: DatasetSource;
  hosts: HostDefinition;
  judges: JudgeDefinition;
  pairwiseJudges: PairwiseJudgeDefinition;
  metrics: MetricDefinition;
  resultStores: ResultStoreDefinition;
}

const NAMESPACE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXTENSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOP_LEVEL_KEYS = new Set<string>(['meta', 'configs', ...EXTENSION_KINDS]);

/** The functions an extension of each kind must provide (any one of them). */
const REQUIRED_FUNCTIONS: Record<ExtensionKind, readonly string[]> = {
  datasetSources: ['load'],
  hosts: ['run', 'runBatch', 'createConfig'],
  judges: ['evaluate'],
  pairwiseJudges: ['compare'],
  metrics: ['compute'],
  resultStores: ['create'],
};

/** Every metric kind; a Record so a new MetricKind must be added here. */
const METRIC_KINDS: Record<MetricKind, true> = {
  binary: true,
  continuous: true,
  categorical: true,
  object: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeFunctions(names: readonly string[]): string {
  const article = /^[aeiou]/.test(names[0]!) ? 'an' : 'a';
  if (names.length === 1) return `${article} ${names[0]} function`;
  return `a ${names.slice(0, -1).join(', ')} or ${names.at(-1)} function`;
}

function extensionProblem(
  kind: ExtensionKind,
  name: string,
  definition: unknown
): string | undefined {
  const label = EXTENSION_NAME.test(name)
    ? `${kind}.${name}`
    : `${kind}."${name}"`;
  if (!EXTENSION_NAME.test(name)) return `${label} is not a valid name`;
  if (!isRecord(definition)) return `${label} must be an object`;
  const schema = definition.schema as { safeParse?: unknown } | undefined;
  if (typeof schema?.safeParse !== 'function')
    return `${label} needs a Zod schema`;
  const required = REQUIRED_FUNCTIONS[kind];
  if (!required.some((fn) => typeof definition[fn] === 'function'))
    return `${label} needs ${describeFunctions(required)}`;
  if (
    kind === 'metrics' &&
    !(typeof definition.kind === 'string' && definition.kind in METRIC_KINDS)
  )
    return `${label} needs a kind: ${Object.keys(METRIC_KINDS).join(', ')}`;
  return undefined;
}

/**
 * Check that `value` is a plugin object and return it. `source` names where it
 * came from (a path, package, or `"inline"`) in error messages.
 */
export function assertPlugin(value: unknown, source: string): Plugin {
  if (
    typeof value === 'function' ||
    (isRecord(value) && typeof value.register === 'function')
  ) {
    throw new Error(
      `Plugin at ${source} exports a function. MST 2.0 plugins are objects: ` +
        'export default { meta: { name, namespace }, judges: { ... } }. ' +
        'See docs/migrations/2.0-prereleases.md#plugins-are-objects.'
    );
  }
  if (!isRecord(value) || !isRecord(value.meta)) {
    throw new Error(
      `Plugin at ${source} must default-export an object with a meta field.`
    );
  }
  const meta = value.meta;
  const label = typeof meta.name === 'string' && meta.name ? meta.name : source;
  const fail = (problem: string): never => {
    throw new Error(`Invalid plugin "${label}": ${problem}.`);
  };
  if (typeof meta.name !== 'string' || !meta.name)
    fail('meta.name is required');
  if (meta.version !== undefined && typeof meta.version !== 'string')
    fail('meta.version must be a string');
  if (meta.namespace === undefined) fail('meta.namespace is required');
  if (typeof meta.namespace !== 'string' || !NAMESPACE.test(meta.namespace))
    fail(
      'meta.namespace must be lowercase letters, digits, ".", "_" or "-", optionally scoped as "@scope/name"'
    );
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`unknown key "${key}"`);
  }
  if (value.configs !== undefined) {
    if (!isRecord(value.configs)) fail('configs must be an object');
    for (const [name, config] of Object.entries(
      value.configs as Record<string, unknown>
    )) {
      if (!EXTENSION_NAME.test(name))
        fail(
          `config name "${name}" must start with a letter or digit and use only letters, digits, ".", "_" or "-"`
        );
      // The manifest schema checks a config's settings when a manifest extends it.
      if (!isRecord(config)) fail(`configs.${name} must be an object`);
    }
  }
  for (const kind of EXTENSION_KINDS) {
    const extensions = value[kind];
    if (extensions === undefined) continue;
    if (!isRecord(extensions)) fail(`${kind} must be an object`);
    for (const [name, definition] of Object.entries(
      extensions as Record<string, unknown>
    )) {
      const problem = extensionProblem(kind, name, definition);
      if (problem) fail(problem);
    }
  }
  return value as unknown as Plugin;
}

/** Split `namespace/name`; a bare name is a built-in. */
export function parseExtensionReference(reference: string): {
  namespace?: string;
  name: string;
} {
  const slash = reference.lastIndexOf('/');
  if (slash === -1) return { name: reference };
  return {
    namespace: reference.slice(0, slash),
    name: reference.slice(slash + 1),
  };
}

/**
 * Parse an extension's options with its schema. The schema must produce an
 * object: that object is what the extension receives. `label` names the
 * options in errors, e.g. `judge options "acme/quality"`.
 */
export function parseExtensionOptions(
  schema: ZodType,
  raw: unknown,
  label: string
): Record<string, unknown> {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new Error(`Invalid ${label}: ${result.error.message}`);
  const data: unknown = result.data;
  if (!isRecord(data))
    throw new Error(`Invalid ${label}: schema must return an options object.`);
  return data;
}
