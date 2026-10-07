import {
  REQUIRED_CLIENT_CAPABILITIES,
  validateClientCapabilities,
} from './capabilities.js';
import {
  getBuiltinDriverConfig,
  getBuiltinDriverDisplayName,
} from './builtinDrivers.js';
import { resolveBuiltinExternalClientCapability } from './builtinCapabilities.js';
import {
  driverToSlug,
  clientTypeFromDriver,
  normalizeClientDriver,
} from './driverIdentity.js';
import type {
  ExternalClientCapabilityBinding,
  ExternalClientCapabilityContext,
  ExternalClientCapabilityImplementation,
  ExternalClientCapabilitiesConfig,
  ExternalClientConfig,
  ExternalClientRunResult,
  ExternalClientRunState,
  ExternalClientRunner,
  ClientCapability,
  ClientDriverId,
  ClientRunContext,
} from './types.js';

interface LoadedExternalClientCapability {
  capability: ClientCapability;
  binding: ExternalClientCapabilityBinding;
  implementation: ExternalClientCapabilityImplementation;
}

export interface LoadedExternalClientConfig {
  config: ExternalClientConfig;
  driver: ClientDriverId;
  driverSlug: string;
  displayName: string;
  loadedCapabilities: LoadedExternalClientCapability[];
  capabilitiesUsed: ClientCapability[];
}

/**
 * Finds the implementation a binding's `uses` names. Capabilities are built
 * in; tests pass their own lookup. A custom client is a plugin client, not a
 * capability.
 */
export type CapabilityLookup = (
  uses: string
) => ExternalClientCapabilityImplementation | undefined;

export function createExternalClientRunner(
  loaded: LoadedExternalClientConfig
): ExternalClientRunner {
  return {
    async run(context: ClientRunContext): Promise<ExternalClientRunResult> {
      return runLoadedExternalClient(loaded, context);
    },
  };
}

export function loadExternalClientConfig(
  config: ExternalClientConfig,
  lookup: CapabilityLookup = resolveBuiltinExternalClientCapability
): LoadedExternalClientConfig {
  const driver = normalizeClientDriver(config.driver);
  const driverSlug = driverToSlug(driver);
  const builtinConfig = getBuiltinDriverConfig(driverSlug);
  const effectiveConfig = mergeExternalClientConfig(config, builtinConfig);
  const capabilitiesConfig = effectiveConfig.capabilities;

  if (!capabilitiesConfig) {
    throw new Error(
      `External client ${driverSlug} does not declare capabilities and has no built-in defaults.`
    );
  }

  const loadedCapabilities: LoadedExternalClientCapability[] = [];
  const providedCapabilities = new Set<ClientCapability>();

  for (const capability of REQUIRED_CLIENT_CAPABILITIES) {
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
  const missingCapabilities = validateClientCapabilities(capabilitiesUsed);
  if (missingCapabilities.length > 0) {
    throw new Error(
      `External client ${driverSlug} is missing capabilities: ${missingCapabilities.join(', ')}`
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

async function runLoadedExternalClient(
  loaded: LoadedExternalClientConfig,
  context: ClientRunContext
): Promise<ExternalClientRunResult> {
  const state: ExternalClientRunState = {
    driver: loaded.driver,
    driverSlug: loaded.driverSlug,
    displayName: loaded.displayName,
    capabilitiesUsed: loaded.capabilitiesUsed,
    data: {},
  };

  let result: ExternalClientRunResult | undefined;
  let executionError: unknown;
  const enteredCapabilities: LoadedExternalClientCapability[] = [];
  try {
    result = await runExternalClientCapabilityPipeline(
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
      `External client capability failed: ${formatError(executionError)}`
    );
    return cleanupErrors.length > 0
      ? cleanupFailure(failure, cleanupErrors)
      : failure;
  }

  if (!result) {
    return runtimeFailure(
      loaded,
      context,
      `External client ${loaded.driverSlug} did not produce a result.`
    );
  }

  return cleanupErrors.length > 0
    ? cleanupFailure(result, cleanupErrors)
    : result;
}

async function runExternalClientCapabilityPipeline(
  loaded: LoadedExternalClientConfig,
  context: ClientRunContext,
  state: ExternalClientRunState,
  enteredCapabilities: LoadedExternalClientCapability[]
): Promise<ExternalClientRunResult> {
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
    `External client ${loaded.driverSlug} completed without producing a result.`
  );
}

function capabilityContext(
  loaded: LoadedExternalClientConfig,
  run: ClientRunContext,
  state: ExternalClientRunState,
  loadedCapability: LoadedExternalClientCapability
): ExternalClientCapabilityContext {
  return {
    config: loaded.config,
    run,
    capability: loadedCapability.capability,
    binding: loadedCapability.binding,
    state,
  };
}

function mergeExternalClientConfig(
  config: ExternalClientConfig,
  builtin: Partial<ExternalClientConfig> | undefined
): ExternalClientConfig {
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
  base: ExternalClientCapabilitiesConfig | undefined,
  override: ExternalClientCapabilitiesConfig | undefined
): ExternalClientCapabilitiesConfig | undefined {
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
    | ExternalClientCapabilityBinding
    | ExternalClientCapabilityBinding[]
    | undefined
): ExternalClientCapabilityBinding[] {
  if (!binding) {
    return [];
  }
  return Array.isArray(binding) ? binding : [binding];
}

const CUSTOM_CLIENT_HINT =
  "External-client capabilities are built in; to run a custom client, provide it from a plugin's clients (docs/evaluation-framework.md#clients).";

function unavailableCapability(uses: string): Error {
  return new Error(
    uses.startsWith('module:')
      ? `External client capability "${uses}": module: capabilities were removed. ${CUSTOM_CLIENT_HINT}`
      : `External client capability implementation is not available: ${uses}. ${CUSTOM_CLIENT_HINT}`
  );
}

function cleanupFailure(
  result: ExternalClientRunResult,
  errors: unknown[]
): ExternalClientRunResult {
  const cleanupMessage = `External client cleanup failed: ${errors
    .map(formatError)
    .join('; ')}`;
  return {
    ...result,
    success: false,
    toolCalls: result.toolCalls,
    error: result.success
      ? cleanupMessage
      : `${result.error}; ${cleanupMessage}`,
    clientMetadata: {
      ...result.clientMetadata,
      traceLimitations: [
        ...(result.clientMetadata.traceLimitations ?? []),
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
  loaded: LoadedExternalClientConfig,
  context: ClientRunContext,
  error: string
): ExternalClientRunResult {
  return {
    success: false,
    toolCalls: [],
    error,
    clientMetadata: {
      driver: loaded.driver,
      driverSlug: loaded.driverSlug,
      displayName: loaded.displayName,
      clientName: loaded.displayName,
      clientType:
        loaded.config.clientType ?? clientTypeFromDriver(loaded.driver),
      clientVariant: loaded.config.variant,
      capabilitiesUsed: loaded.capabilitiesUsed,
      traceSource: 'none',
      traceConfidence: 'unknown',
      traceLimitations: [
        'The external client capability runner did not produce a result.',
      ],
      artifacts: [],
      session: { runMarker: context.marker },
      correlation: context.correlation,
      failureKind: 'client_run_failed',
    },
  };
}
