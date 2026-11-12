/**
 * @gleanwork/mcp-server-tester/evals
 *
 * The evaluation framework: eval configs, evals and batches, extension definition types,
 * metrics, plugins, result stores, comparisons, tool optimizations, and MCP
 * client simulation.
 *
 * @packageDocumentation
 */

export type {
  StoredEvalResultLoadOptions,
  StoredEvalResultRef,
  StoredEvalResultSaveOptions,
  SaveBaselineOptions,
  CompareEvalRunsOptions,
  EvalCaseComparison,
  EvalCaseComparisonOutcome,
  EvalRunComparisonLabels,
  EvalRunComparisonResult,
  SaveEvalRunComparisonOptions,
  StoredEvalRunRef,
  OptimizationMetric,
  ToolOptimizationReason,
  VariantRecommendation,
  VariantCandidateResult,
  ToolOptimizationRound,
  ProposeVariantsContext,
  VariantImprovementProposal,
  ToolOptimizationOptions,
  ToolOptimizationResult,
  EvalToolOptimizationOptions,
  ToolOptimizationEval,
  BaselineMeasurement,
  RegressionCheck,
  VariantGroupStats,
  PairedChange,
  ChangeAssessment,
  VariantGrouping,
} from '../types/index.js';
export {
  EvalConfigSchema,
  loadEvalConfig,
  loadEvalConfigFromObject,
  resolveDatasetPaths,
  variantToolMetadata,
} from '../evals/evalConfig.js';
export type {
  DatasetConfig,
  EvalVariant,
  EvalConfig,
  EvalConfigInput,
  ExtensionConfig,
  ClientConfig,
  TaggedConfig,
  ToolMetadata,
} from '../evals/evalConfig.js';
export type { ClientFields, ClientOptions } from '../evals/clientFields.js';
export type {
  DatasetSource,
  DatasetSourceContext,
  DatasetRequest,
  DatasetSummary,
  EvaluationVariantResult,
  EvaluationBatchOptions,
  EvaluationBatchItem,
  EvaluationBatchResult,
  EvaluationRunOptions,
  EvaluationRunResult,
  EvaluationSummary,
  ClientDefinition,
  ClientOS,
  ClientRequirements,
  ClientRunOptions,
  ClientBatchRequest,
  ClientRunResult,
  ClientContinuation,
  ClientSession,
  ClientSessionOptions,
  ClientSessionTrial,
  ClientSessionResult,
  ClientSessionReadiness,
  HostTelemetry,
  HostTelemetryEvent,
  HostTelemetryMetric,
  HostTelemetrySpan,
  HostAttributeValue,
  ClientRunInput,
  ClientRunContext as EvaluationClientRunContext,
  MetricDefinition,
  MetricKind,
  MetricValue,
  ResultStoreDefinition,
  RunnerDefinition,
  Runner,
  RunnerContext,
  RunnerKeep,
  Machine,
  WorkerChannel,
  CoordinatorMachine,
  CoordinatorContext,
  ShardSpec,
  ShardWork,
  ShardEvents,
  ShardOutcome,
  ShardProgress,
  RunSelection,
  RunSummary,
  RunTelemetry,
  EvalSummaryGenerator,
} from '../evals/evalFrameworkTypes.js';
export type { RunStore } from '../evals/runStore.js';
export type {
  CredentialStore,
  CredentialStoreDefinition,
  StoredGrant,
} from '../auth/grants/types.js';
export type { DetachStatus } from '../evals/detach/status.js';
export type { GradeKey } from '../evals/gradingSource.js';
export {
  resolveResultStoreConfig,
  validateEvalConfig,
} from '../evals/configValidation.js';
export { machineRunner } from '../evals/runners/channel.js';
export type { ShardChannelOptions } from '../evals/runners/channel.js';
export { dockerRunner, createDockerRunner } from '../evals/runners/docker.js';
export type {
  DockerRunnerOptions,
  DockerRuntimeContext,
  DockerRuntimeCleanup,
} from '../evals/runners/docker.js';
export { readShardBundle } from '../evals/runners/protocol.js';
export type {
  ShardBundle,
  ShardTokens,
  TrialKey,
} from '../evals/runners/protocol.js';
export { resolveConfigExtends } from '../evals/configExtends.js';
export type { ValidateEvalConfigOptions } from '../evals/configValidation.js';
export {
  BUILT_IN_METRICS,
  computeMetrics,
  resolveMetric,
} from '../evals/metrics.js';
export { buildEvalDataset } from '../evals/buildEvalDataset.js';
export { runEval } from '../evals/runEval.js';
export { ClientUnavailableError } from '../evals/clientUnavailable.js';
export type { RunEvalOptions, RunEvalResult } from '../evals/runEval.js';
export { runEvalBatch } from '../evals/runEvalBatch.js';
export type {
  EvalBatchItem,
  RunEvalBatchOptions,
  RunEvalBatchResult,
} from '../evals/runEvalBatch.js';
export {
  FileEvalResultStore,
  GCSEvalResultStore,
  createDefaultArtifactId,
  createEvalResultStore,
  createStoredEvalArtifact,
  defaultEnvironmentMetadata,
  isEvalResultStore,
  resolveEvalResultStore,
} from '../evals/resultStore.js';
export type {
  EvalResultStore,
  EvalResultStoreConfig,
  EvalResultStoreLike,
  FileEvalResultStoreConfig,
  GCSEvalResultStoreConfig,
  ListStoredArtifactsOptions,
  StoredArtifactKind,
  StoredArtifactSummary,
  StoredEvalArtifact,
  StoredEvalArtifactMetadata,
} from '../evals/resultStore.js';
export { saveBaseline, loadBaseline } from '../evals/baseline.js';
export {
  compareEvalRuns,
  loadStoredEvalRunnerResult,
  saveEvalRunComparison,
} from '../evals/evalRunComparison.js';
export { runToolOptimization } from '../evals/toolOptimization.js';
export {
  isProviderAvailable,
  getMissingDependencyMessage,
} from '../evals/mstClient/index.js';
export { buildToolSurface } from '../evals/toolSurface.js';
export type {
  ListedServerTools,
  SurfaceTool,
  ToolSurface,
} from '../evals/toolSurface.js';
export {
  comparePairwise,
  getPairwiseJudge,
} from '../evals/pairwiseComparison.js';
export type {
  ComparePairwiseOptions,
  PairwiseCaseResult,
  PairwiseCasePreference,
  PairwiseComparisonResult,
  PairwiseJudgeSpec,
  PairwiseJudgeSummary,
} from '../evals/pairwiseComparison.js';
export type {
  PairwiseDimension,
  PairwiseJudgeDefinition,
  PairwiseJudgeInput,
  PreferredSide,
  PairwisePreference,
} from '../judge/pairwiseContract.js';

// Dry-run proxy: blocks writes to an HTTP MCP server a connector launches.
export {
  dryRunProxyServer,
  PLANNED_WRITE_KEY,
} from '../proxy/dryRunProxyServer.js';
export type {
  DryRunProxyServerOptions,
  ProxyWrites,
} from '../proxy/dryRunProxyServer.js';

// Connectors: a plugin's vendor MCP servers, signed in to with `mst auth`.
export type {
  ConnectorAuth,
  ConnectorDefinition,
  ConnectorLaunchContext,
  OAuthClient,
} from '../auth/grants/types.js';
export type {
  ConnectorServerConfig,
  EvalServerConfig,
} from '../evals/evalConfig.js';
// Agentic judges: an agent (Claude Agent SDK, or Codex) grades over a
// workspace of the trial's evidence.
export * from '../judge/agentic/index.js';

// The host's own OpenTelemetry (`telemetry.host`): a plugin client points
// its host at the process's receiver and collects each trial's records.
export {
  hostTelemetryReceiver,
  claudeCodeOtelEnv,
  claudeDesktopOtlpSettings,
} from '../evals/telemetry/hostReceiver.js';
export type {
  CollectOptions as HostTelemetryCollectOptions,
  HostTelemetryReceiver,
} from '../evals/telemetry/hostReceiver.js';
export type { HostTelemetryConfig } from '../evals/evalConfig.js';

// A stored run's traces, as `telemetry.otlp` sends them: for sending a
// finished run to a collector, re-encoded or re-batched as it needs.
export { readRunDirectory } from '../evals/runFormat.js';
export type { StoredRun } from '../evals/runFormat.js';
export { storedRunTraces } from '../evals/telemetry/runTraces.js';
export type { StoredRunTraceOptions } from '../evals/telemetry/runTraces.js';
export type { OtlpSpan, OtlpTraceRequest } from '../evals/telemetry/otlp.js';
