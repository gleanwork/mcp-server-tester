import {
  EXTENSION_KINDS,
  assertPlugin,
  parseExtensionReference,
  type ExtensionKind,
  type ExtensionsByKind,
  type Plugin,
} from './plugin.js';

/**
 * The process-wide extension table: built-ins under bare names, plugin
 * extensions under `namespace/name`. Manifest validation checks that a suite
 * references only namespaces it lists, so one shared table is safe even when
 * a batch runs several manifests in one process (ADR-0001).
 *
 * The table knows no built-ins itself. Each kind's lookup lives next to that
 * kind's built-ins (`getHost` in builtinHosts.ts, `getJudge` in
 * builtinJudges.ts, ...) and installs them on first use, so code that only
 * looks up judges never loads the desktop host drivers.
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
  hosts: 'Host',
  judges: 'Judge',
  metrics: 'Metric',
  resultStores: 'Result store',
};

// Shared across the CommonJS and ESM copies of this package. Versioned so a
// later MST with a different table shape doesn't read this one.
const STATE_KEY = Symbol.for('mcp-server-tester.extension-table.v1');
const globalState = globalThis as unknown as Record<symbol, unknown>;
const state = (globalState[STATE_KEY] ??= emptyState()) as ExtensionTableState;

function emptyState(): ExtensionTableState {
  return {
    plugins: new Map(),
    builtinKinds: new Set(),
    extensions: {
      datasetSources: new Map(),
      hosts: new Map(),
      judges: new Map(),
      metrics: new Map(),
      resultStores: new Map(),
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
        target.set(`${namespace}/${name}`, definition);
    }
    state.plugins.set(namespace, plugin);
  }
  return valid;
}

/** Resolves one kind's references: its built-ins, then installed plugins. */
export interface ExtensionLookup<T> {
  /** The extension `reference` names. Throws a uniform error when there is none. */
  get(reference: string): T;
  has(reference: string): boolean;
  /** Every name this kind resolves right now, sorted. */
  names(): string[];
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
      const definition = map.get(reference);
      if (definition) return definition;
      const label = KIND_LABELS[kind];
      const { namespace } = parseExtensionReference(reference);
      if (namespace !== undefined && !state.plugins.has(namespace)) {
        throw new Error(
          `${label} "${reference}" needs the "${namespace}" plugin, which is not loaded.`
        );
      }
      const available = [...map.keys()].sort().join(', ');
      throw new Error(
        `${label} "${reference}" is not available.${available ? ` Available: ${available}.` : ''}`
      );
    },
    has(reference) {
      return extensions().has(reference);
    },
    names() {
      return [...extensions().keys()].sort();
    },
  };
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
