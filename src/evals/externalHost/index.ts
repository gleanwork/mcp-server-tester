export { runExternalHostScenario } from './runtime.js';
export {
  REQUIRED_HOST_CAPABILITIES,
  validateHostCapabilities,
} from './capabilities.js';
export {
  getRegisteredExternalHostConfig,
  getRegisteredExternalHostDescription,
  getRegisteredExternalHostDisplayName,
  listRegisteredExternalHostSlugs,
} from './hostRegistry.js';
export {
  listBuiltinExternalHostCapabilities,
  resolveBuiltinExternalHostCapability,
} from './builtinCapabilities.js';
export {
  listExternalHostCapabilities,
  loadExternalHostConfig,
  loadExternalHostRunner,
  registerExternalHostCapability,
  resolveExternalHostCapability,
} from './capabilityRuntime.js';
export type {
  LoadedExternalHostCapability,
  LoadedExternalHostConfig,
} from './capabilityRuntime.js';
export {
  CLAUDE_CHAT_DESKTOP_MACOS_DRIVER,
  CLAUDE_CODE_CLI_MACOS_DRIVER,
  CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
  driverToSlug,
  hostTypeFromDriver,
  normalizeHostDriver,
  parseDriverSlug,
} from './driverIdentity.js';
export {
  ExternalHostCapabilityBindingSchema,
  ExternalHostConfigSchema,
  ExternalHostCorrelationSchema,
  getExternalHostConfigJsonSchema,
  getExternalHostReference,
  HostCapabilitySchema,
  HostDriverIdSchema,
  listExternalHostDriverReferences,
} from './schema.js';
export type { ExternalHostDriverReference } from './schema.js';
export type {
  EvidenceSource,
  ExternalHostCapabilityBinding,
  ExternalHostCapabilityContext,
  ExternalHostCapabilityImplementation,
  ExternalHostCapabilitiesConfig,
  ExternalHostConfig,
  ExternalHostFailureKind,
  ExternalHostMetadata,
  ExternalHostRunState,
  ExternalHostRunResult,
  ExternalHostRunner,
  ExternalHostSession,
  ExternalHostSimulationResult,
  ExternalHostType,
  HostArtifact,
  HostCapability,
  HostDriverConfig,
  HostDriverId,
  HostRunContext,
  ObservationConfidence,
  TraceSource,
} from './types.js';
