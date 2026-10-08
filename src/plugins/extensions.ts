import {
  BUILTIN_NAMESPACE,
  EXTENSION_KINDS,
  KIND_SEGMENTS,
  assertPlugin,
  extensionName,
  parseExtensionReference,
  type ExtensionReference,
  type KindSegment,
  type ExtensionKind,
  type ExtensionsByKind,
  type Plugin,
} from './plugin.js';

/**
 * The process-wide extension table: built-ins under bare names, plugin
 * extensions under `<namespace>/<kind>/<name>`. Eval config validation checks that an eval
 * references only namespaces it lists, so one shared table is safe even when
 * a batch runs several eval configs in one process (ADR-0001).
 *
 * The table knows no built-ins itself. Each kind's lookup lives next to that
 * kind's built-ins (`getClient` in builtinClients.ts, `getJudge` in
 * builtinJudges.ts, ...) and installs them on first use, so code that only
 * looks up judges never loads the desktop client drivers.
 */
interface ExtensionTableState {
  /** Installed plugins by namespace. */
  plugins: Map<string, Plugin>;
  /** Kinds whose built-ins are installed. */
  builtinKinds: Set<ExtensionKind>;
  extensions: { [K in ExtensionKind]: Map<string, ExtensionsByKind[K]> };
}

const KIND_LABELS: Record<ExtensionKind, string> = {
  datasetSources: 'Dataset source',
  clients: 'Client',
  judges: 'Judge',
  pairwiseJudges: 'Pairwise judge',
  metrics: 'Metric',
  resultStores: 'Result store',
  connectors: 'Connector',
};

// Shared across the CommonJS and ESM copies of this package. Versioned so a
// later MST with a different table shape doesn't read this one.
const STATE_KEY = Symbol.for('mcp-server-tester.extension-table.v1');
const globalState = globalThis as unknown as Record<symbol, unknown>;
const state = (globalState[STATE_KEY] ??= emptyState()) as ExtensionTableState;
// A table an older copy of this package created lacks kinds added since.
for (const [kind, map] of Object.entries(emptyState().extensions))
  (state.extensions as Record<string, Map<string, unknown>>)[kind] ??= map;

function emptyState(): ExtensionTableState {
  return {
    plugins: new Map(),
    builtinKinds: new Set(),
    extensions: {
      datasetSources: new Map(),
      clients: new Map(),
      judges: new Map(),
      pairwiseJudges: new Map(),
      metrics: new Map(),
      resultStores: new Map(),
      connectors: new Map(),
    },
  };
}

function extensionNames(plugin: Plugin): string[] {
  return EXTENSION_KINDS.flatMap((kind) =>
    Object.keys(plugin[kind] ?? {}).map((name) => `${kind}.${name}`)
  ).sort();
}

/**
 * Whether `b` is `a` again: the same object, or a copy with the same name and
 * version whose extensions are the same definitions (a plugin object rebuilt
 * around module-level definitions). A factory that builds differently
 * configured copies is a different plugin.
 */
function samePlugin(a: Plugin, b: Plugin): boolean {
  if (a === b) return true;
  if (a.meta.name !== b.meta.name || a.meta.version !== b.meta.version)
    return false;
  const names = extensionNames(a);
  if (names.join() !== extensionNames(b).join()) return false;
  // Configs are data, so a rebuilt copy matches when they're equal.
  if (JSON.stringify(a.configs ?? {}) !== JSON.stringify(b.configs ?? {}))
    return false;
  return EXTENSION_KINDS.every((kind) =>
    Object.entries(a[kind] ?? {}).every(
      ([name, definition]) => b[kind]?.[name] === definition
    )
  );
}

/**
 * Install plugins into the table. All are validated before any is installed.
 * Installing the same plugin again is a no-op; a different plugin claiming a
 * loaded namespace is an error.
 */
export function installPlugins(plugins: readonly Plugin[]): Plugin[] {
  const valid = plugins.map((plugin) => assertPlugin(plugin, 'inline'));
  const pending = new Map<string, Plugin>();
  for (const plugin of valid) {
    const { namespace } = plugin.meta;
    const existing = pending.get(namespace) ?? state.plugins.get(namespace);
    if (existing && !samePlugin(existing, plugin)) {
      throw new Error(
        `Plugin "${plugin.meta.name}" uses namespace "${namespace}", which "${existing.meta.name}" already uses. ` +
          'Install one plugin object per namespace.'
      );
    }
    if (!existing) pending.set(namespace, plugin);
  }
  for (const [namespace, plugin] of pending) {
    for (const kind of EXTENSION_KINDS) {
      const target = state.extensions[kind] as Map<string, unknown>;
      for (const [name, definition] of Object.entries(plugin[kind] ?? {}))
        target.set(
          extensionName(namespace, KIND_SEGMENTS[kind], name),
          definition
        );
    }
    state.plugins.set(namespace, plugin);
  }
  return valid;
}

/** Resolves one kind's references: its built-ins, then installed plugins. */
export interface ExtensionLookup<T> {
  /** The extension `reference` names. Throws a uniform error when there is none. */
  get(reference: string): T;
  /** Built-ins (short names) and installed plugins' extensions (full names), sorted. */
  list(): Array<[string, T]>;
}

/** Create the lookup for `kind`, whose built-ins `builtins` returns. */
export function extensionLookup<K extends ExtensionKind>(
  kind: K,
  builtins: () => Readonly<Record<string, ExtensionsByKind[K]>>
): ExtensionLookup<ExtensionsByKind[K]> {
  function extensions(): Map<string, ExtensionsByKind[K]> {
    const map = state.extensions[kind];
    if (!state.builtinKinds.has(kind)) {
      // From whichever package copy looks this kind up first.
      for (const [name, definition] of Object.entries(builtins()))
        map.set(name, definition);
      state.builtinKinds.add(kind);
    }
    return map;
  }
  return {
    get(reference) {
      const map = extensions();
      const segment = KIND_SEGMENTS[kind];
      const label = KIND_LABELS[kind];
      const parsed = parseExtensionReference(reference);
      checkKind(reference, parsed, segment, label);
      // `mst/<kind>/<name>` is the full name of the built-in `<name>`.
      const key =
        parsed.namespace === BUILTIN_NAMESPACE ? parsed.name : reference;
      const definition = map.get(key);
      if (definition) return definition;
      if (
        parsed.namespace !== undefined &&
        parsed.namespace !== BUILTIN_NAMESPACE &&
        !state.plugins.has(parsed.namespace)
      ) {
        throw new Error(
          `${label} "${reference}" needs the "${parsed.namespace}" plugin, which is not loaded.`
        );
      }
      if (parsed.namespace === undefined) {
        const suffix = `/${segment}/${reference}`;
        const plugins = [...map.keys()]
          .filter((name) => name.endsWith(suffix))
          .sort();
        if (plugins.length)
          throw new Error(
            `"${reference}" is not a built-in ${label.toLowerCase()}. Did you mean ${plugins.map((name) => `"${name}"`).join(' or ')}?`
          );
      }
      const available = [...map.keys()].sort().join(', ');
      throw new Error(
        `${label} "${reference}" is not available.${available ? ` Available: ${available}.` : ''}`
      );
    },
    list() {
      return [...extensions().entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      );
    },
  };
}

/**
 * A built-in written in full, `mst/<kind>/<name>`, as its short name;
 * any other reference unchanged. The full name's kind must be `kind`.
 * Configs and datasets apply this when they are read, so the rest of MST
 * sees one name per built-in.
 */
export function builtinShortName(reference: string, kind: KindSegment): string {
  const parsed = parseExtensionReference(reference);
  if (parsed.namespace !== BUILTIN_NAMESPACE) return reference;
  checkKind(reference, parsed, kind, SEGMENT_LABELS[kind] ?? kind);
  return parsed.name;
}

/**
 * Throws, saying what is wrong, unless a plugin `reference` names an
 * extension of `kind` (`<namespace>/<kind>/<name>`). Bare names pass.
 */
export function checkReferenceKind(reference: string, kind: KindSegment): void {
  const label = SEGMENT_LABELS[kind] ?? kind;
  checkKind(
    reference,
    parseExtensionReference(reference),
    kind,
    label.charAt(0).toUpperCase() + label.slice(1)
  );
}

const SEGMENT_LABELS: Record<string, string> = {
  dataset: 'dataset source',
  client: 'client',
  judge: 'judge',
  'pairwise-judge': 'pairwise judge',
  metric: 'metric',
  'result-store': 'result store',
  connector: 'connector',
  config: 'shared config',
};

/**
 * A plugin reference must name its kind, and the kind must be the one the
 * reference is used as: `acme/judge/x` is a judge, never a dataset.
 */
function checkKind(
  reference: string,
  parsed: ExtensionReference,
  segment: KindSegment,
  label: string
): void {
  if (parsed.namespace === undefined) return;
  if (!parsed.name || parsed.kind === '')
    throw new Error(
      `${label} "${reference}" is not an extension name: use "<namespace>/${segment}/<name>".`
    );
  if (parsed.kind?.includes('/'))
    throw new Error(
      `${label} "${reference}" has too many parts: use "<namespace>/${segment}/<name>".`
    );
  const full = extensionName(parsed.namespace, segment, parsed.name);
  if (parsed.kind === undefined)
    throw new Error(`${label} "${reference}" needs its kind: use "${full}".`);
  if (parsed.kind !== segment) {
    const actual = Object.hasOwn(SEGMENT_LABELS, parsed.kind)
      ? SEGMENT_LABELS[parsed.kind]
      : undefined;
    throw new Error(
      actual
        ? `"${reference}" is a ${actual}, not a ${label.toLowerCase()}.`
        : `${label} "${reference}" has an unknown kind "${parsed.kind}": use "${full}".`
    );
  }
}

/**
 * The shared config `<namespace>/config/<name>` names, from an installed
 * plugin. Throws when the plugin isn't installed or has no such config.
 */
export function getSharedConfig(reference: string): unknown {
  const parsed = parseExtensionReference(reference);
  checkKind(reference, parsed, 'config', 'Shared config');
  if (parsed.namespace === BUILTIN_NAMESPACE)
    throw new Error(
      `Shared config "${reference}": MST has no built-in configs. Name a plugin's config: "<namespace>/config/<name>".`
    );
  const { namespace, name } = parsed;
  const plugin =
    namespace === undefined ? undefined : state.plugins.get(namespace);
  if (!plugin) {
    throw new Error(
      `Shared config "${reference}" needs the "${namespace ?? reference}" plugin, which is not loaded.`
    );
  }
  const configs = plugin.configs ?? {};
  if (!Object.hasOwn(configs, name)) {
    const available = Object.keys(configs).sort().join(', ');
    throw new Error(
      `Plugin "${plugin.meta.name}" has no config "${name}".${available ? ` Available: ${available}.` : ''}`
    );
  }
  return configs[name];
}

/** Namespaces of installed plugins, sorted. */
export function loadedNamespaces(): string[] {
  return [...state.plugins.keys()].sort();
}

/** Remove every plugin, leaving only built-ins. For tests. */
export function resetPluginsForTests(): void {
  state.plugins.clear();
  state.builtinKinds.clear();
  for (const kind of EXTENSION_KINDS) state.extensions[kind].clear();
}
