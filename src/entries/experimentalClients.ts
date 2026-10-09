/**
 * @gleanwork/mcp-server-tester/experimental/clients
 *
 * Experimental desktop clients: the desktop-run metadata results carry,
 * Cowork settings and native-run audit, and marketplace plugins.
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
export { COWORK_STDIO_PLATFORMS } from '../evals/coworkClient.js';
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
  clientStdioServers,
  materializeClientStdioFiles,
  resolveClientStdioServer,
} from '../evals/clientPlugins.js';
export type {
  MarketplacePlugin,
  ClientStdioPaths,
  ClientStdioServer,
} from '../evals/clientPlugins.js';
// What a desktop client (ChatGPT) records about a run, on each result's
// `clientMetadata`.
export type {
  EvidenceSource,
  ExternalClientCorrelationMetadata,
  ExternalClientFailureKind,
  ClientMetadata,
  ExternalClientSession,
  ExternalClientTelemetry,
  ExternalClientType,
  ClientArtifact,
  ClientCapability,
  ClientDriverId,
  ObservationConfidence,
  TraceSource,
} from '../evals/externalClient/index.js';
export type {
  ComputerUseTelemetry,
  SemanticDesktopTelemetry,
} from '../evals/cowork/driver.js';
