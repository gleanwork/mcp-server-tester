export type {
  EvalCase,
  EvalDataset,
  EvalExpectBlock,
  JudgeExpectConfig,
  SerializedEvalDataset,
  EvalMode,
  EvalDirectRequest,
} from '../evals/datasetTypes.js';

export type { LoadDatasetOptions } from '../evals/datasetLoader.js';

export type {
  EvalCaseOptions,
  EvalContext,
  EvalRunnerResult,
  EvalRunnerOptions,
  StoredEvalResultLoadOptions,
  StoredEvalResultRef,
  StoredEvalResultSaveOptions,
  ToolMetadataOverride,
  ToolOverrideVariant,
} from '../evals/evalRunner.js';

export type {
  CompareEvalRunsOptions,
  EvalCaseComparison,
  EvalCaseComparisonOutcome,
  EvalRunComparisonLabels,
  EvalRunComparisonResult,
  SaveEvalRunComparisonOptions,
  StoredEvalRunRef,
} from '../evals/evalRunComparison.js';

export type {
  ExperimentMetric,
  VariantExperimentReason,
  VariantRecommendation,
  VariantCandidateResult,
  VariantExperimentRound,
  ProposeVariantsContext,
  VariantImprovementProposal,
  VariantExperimentOptions,
  VariantExperimentResult,
} from '../evals/variantExperiment.js';

export type { SaveBaselineOptions } from '../evals/baseline.js';

export type {
  HostType,
  CLIOutputFormat,
  CLIConfig,
  LLMProvider,
  MCPHostConfig,
  LLMToolCall,
  MCPHostSimulationResult,
  MCPHostSimulator,
} from '../evals/mcpHost/index.js';
