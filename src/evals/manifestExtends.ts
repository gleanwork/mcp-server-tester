import { getSharedConfig } from '../plugins/extensions.js';
import { parseExtensionReference } from '../plugins/plugin.js';
import {
  parsePluginConfig,
  type EvalManifest,
  type ParsedPluginConfig,
} from './evalManifest.js';
import {
  assertListedNamespaces,
  normalizeSuiteControls,
} from './manifestValidation.js';

/**
 * Apply the shared configs a manifest `extends`, in order, under the
 * manifest's own settings. Each top-level key is replaced, never merged: a
 * later config's `judges` replaces an earlier one's, and the manifest's
 * replaces both, as an arm's settings replace the manifest's. A manifest that
 * extends nothing is returned as is, so its identity doesn't change.
 *
 * Plugins must be installed first; `namespaces` are the ones the suite loads.
 */
export function resolveManifestExtends(
  manifest: EvalManifest,
  namespaces: readonly string[]
): EvalManifest {
  const references = manifest.extends ?? [];
  if (references.length === 0) return manifest;
  const repeated = references.find(
    (reference, index) => references.indexOf(reference) !== index
  );
  if (repeated !== undefined) {
    throw new Error(`The manifest extends "${repeated}" more than once.`);
  }
  for (const reference of references) {
    if (parseExtensionReference(reference).namespace === undefined) {
      throw new Error(
        `The manifest extends "${reference}", but MST has no built-in configs. Name a plugin's config: "namespace/${reference}".`
      );
    }
  }
  assertListedNamespaces(references, namespaces);
  // `run.trials` and friends are the manifest's too, so lift them to the
  // keys a config sets; otherwise they would conflict with the config's.
  const own = Object.fromEntries(
    Object.entries(normalizeSuiteControls(manifest)).filter(
      ([, value]) => value !== undefined
    )
  );
  return Object.assign(
    {},
    ...references.map(sharedConfig),
    own
  ) as EvalManifest;
}

/** A shared config, parsed, after checking it uses only its own plugin. */
function sharedConfig(reference: string): Record<string, unknown> {
  const label = `Shared config "${reference}"`;
  const config = parsePluginConfig(getSharedConfig(reference), label);
  const { namespace } = parseExtensionReference(reference);
  for (const used of configReferences(config)) {
    const owner = parseExtensionReference(used).namespace;
    if (owner !== undefined && owner !== namespace) {
      throw new Error(
        `${label} references "${used}". A shared config may use only its own plugin's extensions ("${namespace}/...") and built-ins.`
      );
    }
  }
  return config;
}

/** The extension types a config names. */
function configReferences(config: ParsedPluginConfig): string[] {
  return [
    config.host?.type,
    config.results?.store.type,
    ...(config.judges ?? []).map((judge) => judge.type),
    // A metric names its definition in `metric`, or by its `type`.
    ...(config.metrics ?? []).map((metric) =>
      typeof metric.metric === 'string' ? metric.metric : metric.type
    ),
  ].filter((type): type is string => typeof type === 'string');
}
