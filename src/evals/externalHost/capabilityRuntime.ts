import {
  REQUIRED_HOST_CAPABILITIES,
  validateHostCapabilities,
} from './capabilities.js';
import {
  getRegisteredExternalHostConfig,
  getRegisteredExternalHostDisplayName,
} from './hostRegistry.js';
import {
  listBuiltinExternalHostCapabilities,
  resolveBuiltinExternalHostCapability,
} from './builtinCapabilities.js';
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

const CAPABILITIES = new Map<string, ExternalHostCapabilityImplementation>();

export interface LoadedExternalHostCapability {
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

export function registerExternalHostCapability(
  implementation: ExternalHostCapabilityImplementation
): void {
  CAPABILITIES.set(implementation.id, implementation);
}

export function listExternalHostCapabilities(): ExternalHostCapabilityImplementation[] {
  return Array.from(
    new Map(
      [...listBuiltinExternalHostCapabilities(), ...CAPABILITIES.values()].map(
        (implementation) => [implementation.id, implementation]
      )
    ).values()
  );
}

export async function resolveExternalHostCapability(
  uses: string
): Promise<ExternalHostCapabilityImplementation | undefined> {
  const registered = CAPABILITIES.get(uses);
  if (registered) {
    return registered;
  }

  const configuredBuiltin = resolveBuiltinExternalHostCapability(uses);
  if (configuredBuiltin) {
    return configuredBuiltin;
  }

  if (uses.startsWith('module:')) {
    return loadModuleCapability(uses);
  }

  return undefined;
}

export async function loadExternalHostRunner(
  config: ExternalHostConfig
): Promise<ExternalHostRunner> {
  const loaded = await loadExternalHostConfig(config);

  return createExternalHostRunner(loaded);
}

export function createExternalHostRunner(
  loaded: LoadedExternalHostConfig
): ExternalHostRunner {
  return {
    async run(context: HostRunContext): Promise<ExternalHostRunResult> {
      return runLoadedExternalHost(loaded, context);
    },
  };
}

export async function loadExternalHostConfig(
  config: ExternalHostConfig
): Promise<LoadedExternalHostConfig> {
  const driver = normalizeHostDriver(config.driver);
  const driverSlug = driverToSlug(driver);
  const registeredConfig = getRegisteredExternalHostConfig(driverSlug);
  const effectiveConfig = mergeExternalHostConfig(config, registeredConfig);
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
      const implementation = await resolveExternalHostCapability(binding.uses);
      if (!implementation) {
        throw new Error(
          `External host capability implementation is not available: ${binding.uses}`
        );
      }

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
      getRegisteredExternalHostDisplayName(driverSlug) ??
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

  for (const loadedCapability of loaded.loadedCapabilities) {
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

async function loadModuleCapability(
  uses: string
): Promise<ExternalHostCapabilityImplementation | undefined> {
  const target = uses.slice('module:'.length);
  const [specifier, exportName = 'default'] = target.split('#');
  if (!specifier) {
    throw new Error(`Invalid external host module capability id: ${uses}`);
  }

  const module = (await import(specifier)) as Record<string, unknown>;
  const implementation = module[exportName];
  if (!isExternalHostCapabilityImplementation(implementation)) {
    throw new Error(
      `External host module capability ${uses} did not export a valid implementation.`
    );
  }
  return implementation;
}

function isExternalHostCapabilityImplementation(
  value: unknown
): value is ExternalHostCapabilityImplementation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ExternalHostCapabilityImplementation).id === 'string' &&
    Array.isArray((value as ExternalHostCapabilityImplementation).capabilities)
  );
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
      failureKind: 'unsupported_host',
    },
  };
}
