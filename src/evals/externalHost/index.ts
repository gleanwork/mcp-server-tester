export { runExternalHostScenario } from './runtime.js';
export {
  getBuiltinDriverConfig,
  listBuiltinDriverSlugs,
} from './builtinDrivers.js';
export {
  CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
  driverToSlug,
  normalizeHostDriver,
  parseDriverSlug,
} from './driverIdentity.js';
export {
  getExternalHostConfigJsonSchema,
  getExternalHostReference,
  listExternalHostDriverReferences,
} from './schema.js';
export type { ExternalHostDriverReference } from './schema.js';
export type {
  EvidenceSource,
  ExternalHostCapabilityBinding,
  ExternalHostCapabilitiesConfig,
  ExternalHostConfig,
  ExternalHostFailureKind,
  ExternalHostMetadata,
  ExternalHostRunResult,
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
