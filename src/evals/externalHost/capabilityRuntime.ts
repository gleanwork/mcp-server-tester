import {
  REQUIRED_HOST_CAPABILITIES,
  validateHostCapabilities,
} from './capabilities.js';
import {
  getBuiltinDriverConfig,
  getBuiltinDriverDisplayName,
} from './builtinDrivers.js';
import { resolveBuiltinExternalHostCapability } from './builtinCapabilities.js';
import {
  driverToSlug,
  hostTypeFromDriver,
  normalizeHostDriver,
} from './driverIdentity.js';
import type {
  ExternalHostCapabilityBinding,
  ExternalHostCapabilityContext,
  ExternalHostCapabilityImplementation,
  ExternalHostCapabilitiesConfig,
  ExternalHostConfig,
  ExternalHostRunResult,
  ExternalHostRunState,
  ExternalHostRunner,
  HostCapability,
  HostDriverId,
  HostRunContext,
} from './types.js';

interface LoadedExternalHostCapability {
  capability: HostCapability;
  binding: ExternalHostCapabilityBinding;
  implementation: ExternalHostCapabilityImplementation;
}

export interface LoadedExternalHostConfig {
  config: ExternalHostConfig;
  driver: HostDriverId;
  driverSlug: string;
  displayName: string;
  loadedCapabilities: LoadedExternalHostCapability[];
  capabilitiesUsed: HostCapability[];
}

/**
 * Finds the implementation a binding's `uses` names. Capabilities are built
 * in; tests pass their own lookup. A custom host is a plugin host, not a
 * capability.
 */
export type CapabilityLookup = (
  uses: string
) => ExternalHostCapabilityImplementation | undefined;

export function createExternalHostRunner(
  loaded: LoadedExternalHostConfig
): ExternalHostRunner {
  return {
    async run(context: HostRunContext): Promise<ExternalHostRunResult> {
      return runLoadedExternalHost(loaded, context);
    },
  };
}

export function loadExternalHostConfig(
  config: ExternalHostConfig,
  lookup: CapabilityLookup = resolveBuiltinExternalHostCapability
): LoadedExternalHostConfig {
  const driver = normalizeHostDriver(config.driver);
  const driverSlug = driverToSlug(driver);
  const builtinConfig = getBuiltinDriverConfig(driverSlug);
  const effectiveConfig = mergeExternalHostConfig(config, builtinConfig);
  const capabilitiesConfig = effectiveConfig.capabilities;

  if (!capabilitiesConfig) {
    throw new Error(
      `External host ${driverSlug} does not declare capabilities and has no built-in defaults.`
    );
  }

  const loadedCapabilities: LoadedExternalHostCapability[] = [];
  const providedCapabilities = new Set<HostCapability>();

  for (const capability of REQUIRED_HOST_CAPABILITIES) {
    const bindings = normalizeCapabilityBindings(
      capabilitiesConfig[capability]
    );
    for (const binding of bindings) {
      const implementation = lookup(binding.uses);
      if (!implementation) throw unavailableCapability(binding.uses);

      loadedCapabilities.push({
        capability,
        binding,
        implementation,
      });
      providedCapabilities.add(capability);
      for (const provided of [
        ...implementation.capabilities,
        ...(binding.provides ?? []),
      ]) {
        providedCapabilities.add(provided);
      }
    }
  }

  const capabilitiesUsed = Array.from(providedCapabilities);
  const missingCapabilities = validateHostCapabilities(capabilitiesUsed);
  if (missingCapabilities.length > 0) {
    throw new Error(
      `External host ${driverSlug} is missing capabilities: ${missingCapabilities.join(', ')}`
    );
  }

  return {
    config: effectiveConfig,
    driver,
    driverSlug,
    displayName:
      effectiveConfig.name ??
      getBuiltinDriverDisplayName(driverSlug) ??
      driverSlug,
    loadedCapabilities,
    capabilitiesUsed,
  };
}

async function runLoadedExternalHost(
  loaded: LoadedExternalHostConfig,
  context: HostRunContext
): Promise<ExternalHostRunResult> {
  const state: ExternalHostRunState = {
    driver: loaded.driver,
    driverSlug: loaded.driverSlug,
    displayName: loaded.displayName,
    capabilitiesUsed: loaded.capabilitiesUsed,
    data: {},
  };

  let result: ExternalHostRunResult | undefined;
  let executionError: unknown;
  const enteredCapabilities: LoadedExternalHostCapability[] = [];
  try {
    result = await runExternalHostCapabilityPipeline(
      loaded,
      context,
      state,
      enteredCapabilities
    );
  } catch (err) {
    executionError = err;
  }

  const cleanupErrors: unknown[] = [];
  for (const loadedCapability of [...enteredCapabilities].reverse()) {
    try {
      await loadedCapability.implementation.teardown?.(
        capabilityContext(loaded, context, state, loadedCapability)
      );
    } catch (err) {
      cleanupErrors.push(err);
    }
  }

  if (executionError !== undefined) {
    const failure = runtimeFailure(
      loaded,
      context,
      `External host capability failed: ${formatError(executionError)}`
    );
    return cleanupErrors.length > 0
      ? cleanupFailure(failure, cleanupErrors)
      : failure;
  }

  if (!result) {
    return runtimeFailure(
      loaded,
      context,
      `External host ${loaded.driverSlug} did not produce a result.`
    );
  }

  return cleanupErrors.length > 0
    ? cleanupFailure(result, cleanupErrors)
    : result;
}

async function runExternalHostCapabilityPipeline(
  loaded: LoadedExternalHostConfig,
  context: HostRunContext,
  state: ExternalHostRunState,
  enteredCapabilities: LoadedExternalHostCapability[]
): Promise<ExternalHostRunResult> {
  for (const loadedCapability of loaded.loadedCapabilities) {
    enteredCapabilities.push(loadedCapability);
    const result = await loadedCapability.implementation.setup?.(
      capabilityContext(loaded, context, state, loadedCapability)
    );
    if (result) {
      return result;
    }
    if (state.result) {
      return state.result;
    }
  }

  for (const loadedCapability of loaded.loadedCapabilities) {
    const result = await loadedCapability.implementation.run?.(
      capabilityContext(loaded, context, state, loadedCapability)
    );
    if (result) {
      return result;
    }
    if (state.result) {
      return state.result;
    }
  }

  return runtimeFailure(
    loaded,
    context,
    `External host ${loaded.driverSlug} completed without producing a result.`
  );
}

function capabilityContext(
  loaded: LoadedExternalHostConfig,
  run: HostRunContext,
  state: ExternalHostRunState,
  loadedCapability: LoadedExternalHostCapability
): ExternalHostCapabilityContext {
  return {
    config: loaded.config,
    run,
    capability: loadedCapability.capability,
    binding: loadedCapability.binding,
    state,
  };
}

function mergeExternalHostConfig(
  config: ExternalHostConfig,
  builtin: Partial<ExternalHostConfig> | undefined
): ExternalHostConfig {
  if (!builtin) {
    return config;
  }

  return {
    ...builtin,
    ...config,
    capabilities: mergeCapabilities(builtin.capabilities, config.capabilities),
    correlation: {
      ...builtin.correlation,
      ...config.correlation,
    },
    options: {
      ...builtin.options,
      ...config.options,
    },
  };
}

function mergeCapabilities(
  base: ExternalHostCapabilitiesConfig | undefined,
  override: ExternalHostCapabilitiesConfig | undefined
): ExternalHostCapabilitiesConfig | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
  };
}

function normalizeCapabilityBindings(
  binding:
    | ExternalHostCapabilityBinding
    | ExternalHostCapabilityBinding[]
    | undefined
): ExternalHostCapabilityBinding[] {
  if (!binding) {
    return [];
  }
  return Array.isArray(binding) ? binding : [binding];
}

const CUSTOM_HOST_HINT =
  "External-host capabilities are built in; to run a custom host, provide it from a plugin's hosts (docs/evaluation-framework.md#hosts).";

function unavailableCapability(uses: string): Error {
  return new Error(
    uses.startsWith('module:')
      ? `External host capability "${uses}": module: capabilities were removed. ${CUSTOM_HOST_HINT}`
      : `External host capability implementation is not available: ${uses}. ${CUSTOM_HOST_HINT}`
  );
}

function cleanupFailure(
  result: ExternalHostRunResult,
  errors: unknown[]
): ExternalHostRunResult {
  const cleanupMessage = `External host cleanup failed: ${errors
    .map(formatError)
    .join('; ')}`;
  return {
    ...result,
    success: false,
    toolCalls: result.toolCalls,
    error: result.success
      ? cleanupMessage
      : `${result.error}; ${cleanupMessage}`,
    externalHost: {
      ...result.externalHost,
      traceLimitations: [
        ...(result.externalHost.traceLimitations ?? []),
        cleanupMessage,
      ],
      failureKind: 'cleanup_failed',
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeFailure(
  loaded: LoadedExternalHostConfig,
  context: HostRunContext,
  error: string
): ExternalHostRunResult {
  return {
    success: false,
    toolCalls: [],
    error,
    externalHost: {
      driver: loaded.driver,
      driverSlug: loaded.driverSlug,
      displayName: loaded.displayName,
      hostName: loaded.displayName,
      hostType: loaded.config.hostType ?? hostTypeFromDriver(loaded.driver),
      hostVariant: loaded.config.variant,
      capabilitiesUsed: loaded.capabilitiesUsed,
      traceSource: 'none',
      traceConfidence: 'unknown',
      traceLimitations: [
        'The external host capability runner did not produce a result.',
      ],
      artifacts: [],
      session: { runMarker: context.marker },
      correlation: context.correlation,
      failureKind: 'host_run_failed',
    },
  };
}
