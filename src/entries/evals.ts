/**
 * @gleanwork/mcp-server-tester/evals
 *
 * The evaluation framework: manifests, suites and batches, extension definition types,
 * metrics, plugins, result stores, comparisons, variant experiments, and MCP
 * host simulation.
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
  ExperimentMetric,
  VariantExperimentReason,
  VariantRecommendation,
  VariantCandidateResult,
  VariantExperimentRound,
  ProposeVariantsContext,
  VariantImprovementProposal,
  VariantExperimentOptions,
  VariantExperimentResult,
  SuiteVariantExperimentOptions,
  VariantExperimentSuite,
} from '../types/index.js';
export {
  EvalManifestSchema,
  loadEvalManifest,
  loadEvalManifestFromObject,
  resolveDatasetPaths,
} from '../evals/evalManifest.js';
export type {
  DatasetConfig,
  EvalArm,
  EvalManifest,
  EvalManifestInput,
  ExtensionConfig,
  ClientConfig,
  ClientConfigPatch,
  TaggedConfig,
} from '../evals/evalManifest.js';
export type {
  DatasetSource,
  DatasetSourceContext,
  EvaluationArmResult,
  EvaluationBatchOptions,
  EvaluationBatchItem,
  EvaluationBatchResult,
  EvaluationSuiteOptions,
  EvaluationSuiteResult,
  EvaluationSummary,
  ClientDefinition,
  ClientRunOptions,
  ClientBatchRequest,
  ClientRunResult,
  ClientRunInput,
  ClientRunContext as EvaluationHostRunContext,
  MetricDefinition,
  MetricKind,
  MetricValue,
  ResultStoreDefinition,
  RunSummary,
  RunTelemetry,
  EvalSummaryGenerator,
} from '../evals/evalFrameworkTypes.js';
export {
  resolveResultStoreConfig,
  validateManifest,
} from '../evals/manifestValidation.js';
export { resolveManifestExtends } from '../evals/manifestExtends.js';
export type { ValidateManifestOptions } from '../evals/manifestValidation.js';
export {
  BUILT_IN_METRICS,
  computeMetrics,
  resolveMetric,
} from '../evals/metrics.js';
export { buildEvalDataset } from '../evals/buildEvalDataset.js';
export { getBuiltinHostConfig } from '../evals/builtinHosts.js';
export { runEvalSuite } from '../evals/runEvalSuite.js';
export type {
  RunEvalSuiteOptions,
  RunEvalSuiteResult,
} from '../evals/runEvalSuite.js';
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
export { runVariantExperiment } from '../evals/variantExperiment.js';
export {
  simulateMCPHost,
  isProviderAvailable,
  getMissingDependencyMessage,
} from '../evals/mcpHost/index.js';
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
  PairwiseCaseVerdict,
  PairwiseComparisonResult,
  PairwiseJudgeSpec,
  PairwiseJudgeSummary,
} from '../evals/pairwiseComparison.js';
export type {
  PairwiseDimension,
  PairwiseJudgeDefinition,
  PairwiseJudgeInput,
  PairwisePreference,
  PairwiseVerdict,
} from '../judge/pairwiseContract.js';
