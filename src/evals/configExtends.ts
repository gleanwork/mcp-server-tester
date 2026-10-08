import { getSharedConfig } from '../plugins/extensions.js';
import {
  BUILTIN_NAMESPACE,
  parseExtensionReference,
} from '../plugins/plugin.js';
import {
  parsePluginConfig,
  type EvalConfig,
  type ParsedPluginConfig,
} from './evalConfig.js';
import {
  assertListedNamespaces,
  normalizeEvalControls,
} from './configValidation.js';

/**
 * Apply the shared configs an eval config `extends`, in order, under the
 * eval config's own settings. Each top-level key is replaced, never merged: a
 * later config's `judges` replaces an earlier one's, and the eval config's
 * replaces both, as a variant's settings replace the eval config's. An eval config that
 * extends nothing is returned as is, so its identity doesn't change.
 *
 * Plugins must be installed first; `namespaces` are the ones the eval loads.
 */
export function resolveConfigExtends(
  evalConfig: EvalConfig,
  namespaces: readonly string[]
): EvalConfig {
  const references = evalConfig.extends ?? [];
  if (references.length === 0) return evalConfig;
  const repeated = references.find(
    (reference, index) => references.indexOf(reference) !== index
  );
  if (repeated !== undefined) {
    throw new Error(`The eval config extends "${repeated}" more than once.`);
  }
  for (const reference of references) {
    if (parseExtensionReference(reference).namespace === undefined) {
      throw new Error(
        `The eval config extends "${reference}", but MST has no built-in configs. Name a plugin's config: "<namespace>/config/${reference}".`
      );
    }
  }
  assertListedNamespaces(references, namespaces);
  // `run.trials` and friends are the eval config's too, so lift them to the
  // keys a config sets; otherwise they would conflict with the config's.
  const own = Object.fromEntries(
    Object.entries(normalizeEvalControls(evalConfig)).filter(
      ([, value]) => value !== undefined
    )
  );
  // `client` and `clientOptions` go together: an eval config that sets either
  // replaces the shared config's client, so one client's options never
  // apply to another.
  const ownsClient = 'client' in own || 'clientOptions' in own;
  return Object.assign(
    {},
    ...references.map(sharedConfig).map((config) => {
      if (!ownsClient) return config;
      const { client: _client, clientOptions: _options, ...rest } = config;
      return rest;
    }),
    own
  ) as EvalConfig;
}

/** A shared config, parsed, after checking it uses only its own plugin. */
function sharedConfig(reference: string): Record<string, unknown> {
  const label = `Shared config "${reference}"`;
  const config = parsePluginConfig(getSharedConfig(reference), label);
  const { namespace } = parseExtensionReference(reference);
  for (const used of configReferences(config)) {
    const owner = parseExtensionReference(used).namespace;
    if (
      owner !== undefined &&
      owner !== BUILTIN_NAMESPACE &&
      owner !== namespace
    ) {
      throw new Error(
        `${label} references "${used}". A shared config may use only its own plugin's extensions ("${namespace}/<kind>/...") and built-ins.`
      );
    }
  }
  return config;
}

/** The extension types a config names. */
function configReferences(config: ParsedPluginConfig): string[] {
  return [
    config.client,
    config.results?.store.type,
    ...(config.judges ?? []).map((judge) => judge.type),
    ...(config.pairwiseJudges ?? []).map((judge) => judge.type),
    // A metric names its definition in `metric`, or by its `type`.
    ...(config.metrics ?? []).map((metric) =>
      typeof metric.metric === 'string' ? metric.metric : metric.type
    ),
    ...(config.servers ?? []).map((server) =>
      'connector' in server ? server.connector : undefined
    ),
  ].filter((type): type is string => typeof type === 'string');
}
