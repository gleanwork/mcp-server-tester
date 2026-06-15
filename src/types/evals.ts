export type {
  EvalCase,
  EvalDataset,
  EvalExpectBlock,
  JudgeExpectConfig,
  SerializedEvalDataset,
  EvalMode,
} from '../evals/datasetTypes.js';

export type { LoadDatasetOptions } from '../evals/datasetLoader.js';

export type {
  EvalContext,
  EvalRunnerResult,
  EvalRunnerOptions,
  EvalCaseOptions,
  StoredEvalResultLoadOptions,
  StoredEvalResultRef,
  StoredEvalResultSaveOptions,
  ToolMetadataOverride,
  ToolOverrideVariant,
} from '../evals/evalRunner.js';

export type {
  ComparisonOutcome,
  CaseComparisonResult,
  ServerComparisonResult,
  ServerComparisonOptions,
  SaveServerComparisonOptions,
} from '../evals/serverComparison.js';

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
  BrowserCookie,
  BrowserConfig,
  MCPHostConfig,
  LLMToolCall,
  MCPHostSimulationResult,
  MCPHostSimulator,
} from '../evals/mcpHost/index.js';
