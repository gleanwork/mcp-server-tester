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
  EvaluationVariantResult,
  EvaluationBatchOptions,
  EvaluationBatchItem,
  EvaluationBatchResult,
  EvaluationRunOptions,
  EvaluationRunResult,
  EvaluationSummary,
  ClientDefinition,
  ClientRunOptions,
  ClientBatchRequest,
  ClientRunResult,
  ClientRunInput,
  ClientRunContext as EvaluationClientRunContext,
  MetricDefinition,
  MetricKind,
  MetricValue,
  ResultStoreDefinition,
  EnvironmentDefinition,
  Environment,
  EnvironmentContext,
  EnvironmentKeep,
  RunSelection,
  RunSummary,
  RunTelemetry,
  EvalSummaryGenerator,
} from '../evals/evalFrameworkTypes.js';
export {
  resolveResultStoreConfig,
  validateEvalConfig,
} from '../evals/configValidation.js';
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
export type { DryRunProxyServerOptions } from '../proxy/dryRunProxyServer.js';

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
// Agentic judges: an agent (Codex or Claude Agent SDK) grades over a
// workspace of the trial's evidence.
export * from '../judge/agentic/index.js';
