/**
 * @gleanwork/mcp-server-tester/evals
 *
 * The evaluation framework: manifests, suites and batches, registries,
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
  ComparisonOutcome,
  CaseComparisonResult,
  ServerComparisonResult,
  ServerComparisonOptions,
  SaveServerComparisonOptions,
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
  HostConfig,
  HostConfigPatch,
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
  HostDefinition,
  HostRunOptions,
  HostBatchRequest,
  HostRunResult,
  HostRunInput,
  HostRunContext as EvaluationHostRunContext,
  MetricDefinition,
  MetricKind,
  MetricValue,
  ResultStoreDefinition,
  RunSummary,
  RunTelemetry,
  EvalSummaryGenerator,
} from '../evals/evalFrameworkTypes.js';
export {
  clearDatasetSources,
  clearHosts,
  clearJudges,
  clearMetrics,
  clearResultStores,
  getDatasetSource,
  getHost,
  getJudge,
  getMetric,
  getResultStore,
  listDatasetSources,
  listHosts,
  listJudges,
  listMetrics,
  listResultStores,
  registerDatasetSource,
  registerHost,
  registerMetric,
  registerResultStore,
  resolveResultStoreConfig,
  validateManifestRegistrations,
} from '../evals/frameworkRegistries.js';
export {
  BUILT_IN_METRICS,
  METRIC_REGISTRY,
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
export { loadPluginModule, loadPlugins } from '../plugins/loadPlugins.js';
export type {
  EvalPluginModule,
  LoadPluginsOptions,
} from '../plugins/loadPlugins.js';
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
  runServerComparison,
  saveServerComparison,
} from '../evals/serverComparison.js';
export { runSkillsComparison } from '../evals/skillsComparison.js';
export type {
  SkillsComparisonOptions,
  SkillsComparisonResult,
  SkillsComparisonVariant,
  SkillsVariantSummary,
} from '../evals/skillsComparison.js';
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
