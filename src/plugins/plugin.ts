import type { ZodType } from 'zod';
import type {
  DatasetSource,
  ClientDefinition,
  JudgeDefinition,
  MetricDefinition,
  MetricKind,
  ResultStoreDefinition,
  EnvironmentDefinition,
} from '../evals/evalFrameworkTypes.js';
import type { PairwiseJudgeDefinition } from '../judge/pairwiseContract.js';
import type { PluginConfig } from '../evals/evalConfig.js';
import type {
  ConnectorDefinition,
  CredentialStoreDefinition,
} from '../auth/grants/types.js';

/** Identifies a plugin. Its extensions are named `<namespace>/<kind>/<name>`. */
export interface PluginMeta {
  /** The plugin's package name, used in error messages. */
  readonly name: string;
  readonly version?: string;
  /** Lowercase; `@scope/name` is allowed. `mst` is reserved for MST's built-ins. */
  readonly namespace: string;
}

/**
 * The settings a plugin takes: values that belong to the repo that runs
 * evals, not to one extension (a project ID, an endpoint), as in ESLint's
 * `settings`. They are written in `mst.config.json` or an eval config's
 * `settings`, under the plugin's namespace (ADR 0008).
 */
export interface PluginSettingsDefinition {
  /**
   * Parses the plugin's section. It is parsed even when the section is
   * absent (as `{}`), so required settings fail before a run starts. It must
   * produce an object: that object is what every extension of the plugin
   * receives as `settings`.
   */
  readonly schema: ZodType;
}

/**
 * What every extension is given beside its own options: its plugin's
 * settings, parsed by the plugin's `settings.schema` (ADR 0008). Undefined
 * for a built-in, a plugin that takes no settings, or a call made without an
 * eval config (such as `mst runs` reading a result store by `--results`).
 */
export interface SettingsContext {
  readonly settings?: Readonly<Record<string, unknown>>;
}

/**
 * An MST plugin: a plain object, the default export of its module, in the
 * shape ESLint uses. MST reads it; a plugin never calls into MST to register.
 * Each map key is the extension's name within the plugin's namespace.
 */
export interface Plugin {
  readonly meta: PluginMeta;
  /**
   * The settings the plugin takes. A plugin without them can't be given a
   * settings section.
   */
  readonly settings?: PluginSettingsDefinition;
  readonly datasetSources?: Readonly<Record<string, DatasetSource>>;
  readonly clients?: Readonly<Record<string, ClientDefinition>>;
  readonly judges?: Readonly<Record<string, JudgeDefinition>>;
  /** Judges that compare two runs of one case (a baseline and a candidate). */
  readonly pairwiseJudges?: Readonly<Record<string, PairwiseJudgeDefinition>>;
  readonly metrics?: Readonly<Record<string, MetricDefinition>>;
  readonly resultStores?: Readonly<Record<string, ResultStoreDefinition>>;
  /**
   * Vendor MCP servers as this organization uses them: URL, how to sign in,
   * and how a client reaches them. An eval config uses one as
   * `{ "connector": "<namespace>/connector/<name>" }`; `mst auth` signs in to it.
   */
  readonly connectors?: Readonly<Record<string, ConnectorDefinition>>;
  /**
   * Where a run's trials can be collected: `--env <namespace>/env/<name>`
   * (ADR 0004).
   */
  readonly environments?: Readonly<Record<string, EnvironmentDefinition>>;
  /**
   * Where connector sign-ins (refresh grants) are kept, beside MST's local
   * directory: `--store <namespace>/credential-store/<name>`. A detached run
   * needs one its coordinator machine can reach (ADR 0007).
   */
  readonly credentialStores?: Readonly<
    Record<string, CredentialStoreDefinition>
  >;
  /**
   * Shared eval config settings. An eval config that lists this plugin applies one
   * with `extends: ["namespace/config/name"]`. A config may use only this plugin's
   * extensions and built-ins.
   */
  readonly configs?: Readonly<Record<string, PluginConfig>>;
}

export const EXTENSION_KINDS = [
  'datasetSources',
  'clients',
  'judges',
  'pairwiseJudges',
  'metrics',
  'resultStores',
  'connectors',
  'environments',
  'credentialStores',
] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

/**
 * The kind segment of an extension name, `<namespace>/<kind>/<name>`, for
 * each plugin key. Shared configs are the `config` kind.
 */
export const KIND_SEGMENTS = {
  datasetSources: 'dataset',
  clients: 'client',
  judges: 'judge',
  pairwiseJudges: 'pairwise-judge',
  metrics: 'metric',
  resultStores: 'result-store',
  connectors: 'connector',
  environments: 'env',
  credentialStores: 'credential-store',
} as const satisfies Record<ExtensionKind, string>;
export type KindSegment = (typeof KIND_SEGMENTS)[ExtensionKind] | 'config';

const KIND_SEGMENT_SET = new Set<string>([
  ...Object.values(KIND_SEGMENTS),
  'config',
]);

/** The namespace of MST's built-ins: `mst/judge/rubric` is `rubric`. */
export const BUILTIN_NAMESPACE = 'mst';

/** The extension definitions each kind holds. */
export interface ExtensionsByKind {
  datasetSources: DatasetSource;
  clients: ClientDefinition;
  judges: JudgeDefinition;
  pairwiseJudges: PairwiseJudgeDefinition;
  metrics: MetricDefinition;
  resultStores: ResultStoreDefinition;
  connectors: ConnectorDefinition;
  environments: EnvironmentDefinition;
  credentialStores: CredentialStoreDefinition;
}

const NAMESPACE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXTENSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOP_LEVEL_KEYS = new Set<string>([
  'meta',
  'settings',
  'configs',
  ...EXTENSION_KINDS,
]);

/** The functions an extension of each kind must provide (any one of them). */
const REQUIRED_FUNCTIONS: Record<ExtensionKind, readonly string[]> = {
  datasetSources: ['load'],
  clients: ['run', 'runBatch'],
  judges: ['evaluate'],
  pairwiseJudges: ['compare'],
  metrics: ['compute'],
  resultStores: ['create'],
  // A connector is data plus optional functions; checked in extensionProblem.
  connectors: [],
  environments: ['open'],
  credentialStores: ['create'],
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
  // A connector has no options, so no schema.
  if (kind === 'connectors') return connectorProblem(label, definition);
  // Nor has a credential store: `create` takes none.
  if (kind === 'credentialStores')
    return typeof definition.create === 'function'
      ? definition.shared === undefined ||
        typeof definition.shared === 'boolean'
        ? undefined
        : `${label}: shared must be a boolean`
      : `${label} needs a create function`;
  const schema = definition.schema as { safeParse?: unknown } | undefined;
  if (typeof schema?.safeParse !== 'function')
    return `${label} needs a Zod schema`;
  const required = REQUIRED_FUNCTIONS[kind];
  if (!required.some((fn) => typeof definition[fn] === 'function'))
    return `${label} needs ${describeFunctions(required)}`;
  if (kind === 'datasetSources') {
    if (
      definition.description !== undefined &&
      typeof definition.description !== 'string'
    )
      return `${label}: description must be a string`;
    if (
      definition.describe !== undefined &&
      typeof definition.describe !== 'function'
    )
      return `${label}: describe must be a function`;
    if (
      definition.snapshots !== undefined &&
      typeof definition.snapshots !== 'boolean'
    )
      return `${label}: snapshots must be true or false`;
  }
  if (
    (kind === 'judges' || kind === 'pairwiseJudges') &&
    definition.description !== undefined &&
    typeof definition.description !== 'string'
  )
    return `${label}: description must be a string`;
  if (
    (kind === 'judges' || kind === 'pairwiseJudges') &&
    definition.version !== undefined &&
    (typeof definition.version !== 'string' || definition.version === '')
  )
    return `${label}: version must be a non-empty string`;
  if (kind === 'clients' && 'toolOverrides' in definition)
    return `${label}: \`toolOverrides\` is now \`toolMetadata\``;
  if (
    kind === 'metrics' &&
    !(typeof definition.kind === 'string' && definition.kind in METRIC_KINDS)
  )
    return `${label} needs a kind: ${Object.keys(METRIC_KINDS).join(', ')}`;
  if (
    kind === 'environments' &&
    definition.maxShards !== undefined &&
    !(
      Number.isInteger(definition.maxShards) && Number(definition.maxShards) > 0
    )
  )
    return `${label}: maxShards must be a positive integer`;
  return undefined;
}

const CONNECTOR_AUTH_TYPES: Record<string, readonly string[]> = {
  none: [],
  static: ['token'],
  'client-credentials': ['client'],
  oauth: [],
};

function connectorProblem(
  label: string,
  definition: Record<string, unknown>
): string | undefined {
  if (typeof definition.url !== 'string') return `${label} needs a url`;
  try {
    const url = new URL(definition.url);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1')
      return `${label}: url must be https`;
  } catch {
    return `${label}: url is not a URL`;
  }
  if (
    definition.grant !== undefined &&
    (typeof definition.grant !== 'string' ||
      !EXTENSION_NAME.test(definition.grant))
  )
    return `${label}: grant must be a name (letters, digits, ".", "_" or "-")`;
  const auth = definition.auth;
  if (!isRecord(auth) || typeof auth.type !== 'string')
    return `${label} needs auth: { type: ${Object.keys(CONNECTOR_AUTH_TYPES).join(' | ')} }`;
  const functions = CONNECTOR_AUTH_TYPES[auth.type];
  if (!functions) return `${label}: unknown auth type "${auth.type}"`;
  for (const fn of functions)
    if (typeof auth[fn] !== 'function')
      return `${label}: auth type "${auth.type}" needs ${describeFunctions([fn])}`;
  if (
    auth.type === 'client-credentials' &&
    typeof auth.tokenEndpoint !== 'string'
  )
    return `${label}: auth type "client-credentials" needs a tokenEndpoint`;
  if (auth.type === 'oauth') {
    if (
      auth.flow !== undefined &&
      auth.flow !== 'authorization-code' &&
      auth.flow !== 'device'
    )
      return `${label}: auth.flow must be "authorization-code" or "device"`;
    if (auth.client !== undefined && typeof auth.client !== 'function')
      return `${label}: auth.client must be a function`;
    if (auth.flow === 'device' && typeof auth.client !== 'function')
      return `${label}: device sign-in needs auth.client`;
  }
  if (
    definition.launch !== undefined &&
    typeof definition.launch !== 'function'
  )
    return `${label}: launch must be a function`;
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
  if (meta.namespace === BUILTIN_NAMESPACE)
    fail('meta.namespace "mst" is reserved for MST\'s built-ins');
  for (const key of Object.keys(value)) {
    if (key === 'hosts') fail('`hosts` is now `clients`');
    if (!TOP_LEVEL_KEYS.has(key)) fail(`unknown key "${key}"`);
  }
  if (value.settings !== undefined) {
    const schema = isRecord(value.settings)
      ? (value.settings.schema as { safeParse?: unknown } | undefined)
      : undefined;
    if (typeof schema?.safeParse !== 'function')
      fail('settings needs a Zod schema: settings: { schema }');
    for (const key of Object.keys(value.settings as object))
      if (key !== 'schema') fail(`settings: unknown key "${key}"`);
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
      // The eval config schema checks a config's settings when an eval config extends it.
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

/** A parsed extension name: `<namespace>/<kind>/<name>`, or a bare built-in name. */
export interface ExtensionReference {
  /** Absent for a bare name, which is a built-in. */
  namespace?: string;
  /** The kind segment. Absent for a bare name, or a two-part `namespace/name`. */
  kind?: string;
  name: string;
}

/**
 * Split `<namespace>/<kind>/<name>`. A bare name is a built-in. The
 * namespace may be scoped (`@scope/pkg/judge/x`). A two-part
 * `namespace/name` has no kind; lookups reject it, naming the full name.
 */
export function parseExtensionReference(reference: string): ExtensionReference {
  const parts = reference.split('/');
  if (parts.length === 1) return { name: reference };
  const namespaceParts = parts[0]!.startsWith('@') ? 2 : 1;
  const namespace = parts.slice(0, namespaceParts).join('/');
  const rest = parts.slice(namespaceParts);
  if (rest.length === 2 && KIND_SEGMENT_SET.has(rest[0]!))
    return { namespace, kind: rest[0]!, name: rest[1]! };
  if (rest.length === 1) return { namespace, name: rest[0]! };
  // An unknown kind segment, or too many parts: keep what was given so the
  // lookup can say what is wrong.
  return {
    namespace,
    kind: rest.slice(0, -1).join('/'),
    name: rest.at(-1) ?? '',
  };
}

/** The full name of an extension of `kind` named `name` in `namespace`. */
export function extensionName(
  namespace: string,
  kind: KindSegment,
  name: string
): string {
  return `${namespace}/${kind}/${name}`;
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
