import { z } from 'zod';
import { installedPlugin } from './extensions.js';
import {
  BUILTIN_NAMESPACE,
  parseExtensionOptions,
  parseExtensionReference,
} from './plugin.js';

/**
 * Plugin settings as written, by plugin namespace (ADR 0008): the sections of
 * `mst.config.json` and an eval config's `settings`.
 */
export type SettingsSections = Record<string, Record<string, unknown>>;

/** A namespace's section: an object, which the plugin's schema parses. */
export const SettingsSectionsSchema = z.record(
  z.string().min(1),
  z.record(z.string(), z.unknown())
);

/**
 * The settings an eval config runs with: the file's sections, each replaced
 * by the eval config's own section for the same namespace (never merged key
 * by key). Undefined when neither has any.
 */
export function mergeSettings(
  file: SettingsSections | undefined,
  own: SettingsSections | undefined
): SettingsSections | undefined {
  const merged = { ...file, ...own };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The sections of the plugins an eval loads, checked: a loaded plugin that
 * takes no settings can't have a section, and each plugin that takes them
 * must accept its section (or `{}` when it has none). Sections for plugins
 * the eval doesn't load are dropped, as a repo's `mst.config.json` holds
 * every plugin's. Plugins must be installed first.
 */
export function evalSettings(
  sections: SettingsSections | undefined,
  namespaces: readonly string[]
): SettingsSections | undefined {
  const kept = Object.fromEntries(
    Object.entries(sections ?? {}).filter(([namespace]) =>
      namespaces.includes(namespace)
    )
  );
  for (const namespace of Object.keys(kept)) {
    const plugin = installedPlugin(namespace);
    if (plugin && !plugin.settings)
      throw new Error(
        `Settings "${namespace}": plugin "${plugin.meta.name}" takes no settings.`
      );
  }
  const dropped = Object.keys(kept).length < Object.keys(sections ?? {}).length;
  const result = !dropped
    ? sections
    : Object.keys(kept).length > 0
      ? kept
      : undefined;
  for (const namespace of namespaces) settingsOfNamespace(result, namespace);
  return result;
}

const NO_SECTIONS: SettingsSections = {};
const parsedSettings = new WeakMap<
  SettingsSections,
  Map<string, Record<string, unknown> | undefined>
>();

function settingsOfNamespace(
  sections: SettingsSections | undefined,
  namespace: string
): Record<string, unknown> | undefined {
  const key = sections ?? NO_SECTIONS;
  let byNamespace = parsedSettings.get(key);
  if (!byNamespace) {
    byNamespace = new Map<string, Record<string, unknown> | undefined>();
    parsedSettings.set(key, byNamespace);
  }
  if (byNamespace.has(namespace)) return byNamespace.get(namespace);
  const schema = installedPlugin(namespace)?.settings?.schema;
  const parsed = schema
    ? parseExtensionOptions(
        schema,
        key[namespace] ?? {},
        `settings "${namespace}"`
      )
    : undefined;
  byNamespace.set(namespace, parsed);
  return parsed;
}

/**
 * What the extension `reference` names receives as `settings`: its plugin's
 * section of `sections`, parsed by the plugin's schema. Undefined for a
 * built-in, or a plugin that takes no settings.
 */
export function settingsFor(
  sections: SettingsSections | undefined,
  reference: string
): Record<string, unknown> | undefined {
  const { namespace } = parseExtensionReference(reference);
  if (namespace === undefined || namespace === BUILTIN_NAMESPACE)
    return undefined;
  return settingsOfNamespace(sections, namespace);
}
