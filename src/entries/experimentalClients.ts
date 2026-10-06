/**
 * @gleanwork/mcp-server-tester/experimental/clients
 *
 * Experimental desktop clients: the external-host runtime and capability
 * types, Cowork settings and native-run audit, and marketplace plugins.
 * Expect breaking changes between minor versions.
 *
 * @packageDocumentation
 */

export { auditCoworkNativeRun } from '../evals/auditCoworkNativeRun.js';
export type {
  AuditCoworkNativeRunOptions,
  CoworkNativeAuditReport,
  CoworkNativeAuditCase,
  CoworkNativeAuditIssue,
  CoworkNativeAuditUsage,
  CoworkNativeAuditTiming,
  CoworkNativeAuditAttachment,
} from '../evals/auditCoworkNativeRun.js';
export { COWORK_STDIO_PLATFORMS } from '../evals/coworkHost.js';
export {
  coworkManagedPluginSettings,
  coworkMcpSettingsMatch,
  coworkPluginSettingsMatch,
} from '../evals/cowork/managedSettings.js';
export type {
  CoworkManagedPluginSettings,
  CoworkManagedStdioServer,
} from '../evals/cowork/managedSettings.js';
export {
  coworkPluginMarketplace,
  hostStdioServers,
  materializeHostStdioFiles,
  resolveHostStdioServer,
} from '../evals/hostPlugins.js';
export type {
  MarketplacePlugin,
  ClientStdioPaths,
  ClientStdioServer,
} from '../evals/hostPlugins.js';
export {
  driverToSlug,
  normalizeHostDriver,
  parseDriverSlug,
  getExternalHostConfigJsonSchema,
  getExternalHostReference,
  listExternalHostDriverReferences,
  runExternalHostScenario,
} from '../evals/externalHost/index.js';
export type {
  EvidenceSource,
  ExternalHostCapabilityBinding,
  ExternalHostCapabilitiesConfig,
  ExternalHostConfig,
  ExternalHostDriverReference,
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
  ClientRunContext,
  ObservationConfidence,
  TraceSource,
} from '../evals/externalHost/index.js';
