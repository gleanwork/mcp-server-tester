/**
 * @gleanwork/mcp-server-tester/experimental/hosts
 *
 * Experimental desktop and external hosts: the external-host runtime and
 * capability types, Cowork settings and native-run audit, and host plugins.
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
  COWORK_HEADLESS_DISABLED_BUILTIN_TOOLS,
  coworkHeadlessSettings,
  coworkHeadlessSettingsMatch,
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
  HostPlugin,
  HostStdioPaths,
  HostStdioServer,
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
  HostRunContext,
  ObservationConfidence,
  TraceSource,
} from '../evals/externalHost/index.js';
